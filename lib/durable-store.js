'use strict';

// durable-store.js — shared durability layer for CPR's JSON config stores
// (providers, route profiles, settings).
//
// Guarantees layered on top of atomic-json:
//   · fail-closed reads   — only a missing file yields the default payload;
//     corruption raises CorruptedStateError (with rolling-backup recovery).
//   · schema envelope     — { schema, version, revision, updatedAt, <payload> }
//     with transparent migration from the legacy bare formats.
//   · single-writer       — every read-modify-write runs under a cross-process
//     file lock (owner-stamped, timeout-bounded, stale-recovered), so a Web
//     service and concurrent `cpr add/rm/import` processes cannot lose updates.
//   · optimistic CAS      — save({ expectedRevision }) rejects with a stable
//     RevisionConflictError (HTTP 409 shape) instead of clobbering.
//
// The envelope keeps the payload under a domain key (`providers`, `profiles`,
// `settings`) so pre-envelope readers that understood `{ providers: [...] }` /
// `{ profiles: [...] }` documents still find their data.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  CorruptedStateError,
  readJsonStrict,
  writeJsonAtomic,
  loadOrRecover,
} = require('./atomic-json');

const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_STALE_MS = 30000;
const DEFAULT_BACKUPS = 2;
const LOCK_RETRY_DELAY_MS = 20;

class RevisionConflictError extends Error {
  constructor(file, expectedRevision, actualRevision) {
    super(`revision conflict on ${file}: expected ${expectedRevision}, found ${actualRevision}`);
    this.name = 'RevisionConflictError';
    this.code = 'CPR_REVISION_CONFLICT';
    this.statusCode = 409;
    this.file = file;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

class LockTimeoutError extends Error {
  constructor(lockFile, timeoutMs, holder) {
    const held = holder && holder.pid ? ` (held by pid ${holder.pid}${holder.owner ? ` / ${holder.owner}` : ''})` : '';
    super(`timed out after ${timeoutMs}ms waiting for lock ${lockFile}${held}`);
    this.name = 'LockTimeoutError';
    this.code = 'CPR_LOCK_TIMEOUT';
    this.statusCode = 503;
    this.lockFile = lockFile;
    this.timeoutMs = timeoutMs;
    this.holder = holder || null;
  }
}

// Synchronous sleep without burning CPU: Atomics.wait is permitted on Node's
// main thread and blocks the event loop for the requested duration — exactly
// what a sync CRUD path contending on a file lock needs.
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  try { Atomics.wait(sleepBuffer, 0, 0, ms); }
  catch (_) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy fallback */ }
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return !!(error && error.code === 'EPERM'); }
}

function readLockInfo(lockFile) {
  try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')); }
  catch (_) { return null; }
}

function lockIsStale(lockFile, info, staleMs) {
  // Same-host lock whose owning process is gone → stale regardless of age.
  if (info && Number.isInteger(info.pid) && info.hostname === os.hostname() && !pidAlive(info.pid)) return true;
  // Otherwise fall back to age (covers unreadable lock files and other hosts).
  try {
    const age = Date.now() - fs.statSync(lockFile).mtimeMs;
    return age > staleMs;
  } catch (error) {
    return !!(error && error.code === 'ENOENT');
  }
}

// Acquire an exclusive advisory lock via O_EXCL creation of `<file>.lock`.
// The lock file records { pid, hostname, owner, token, acquiredAt } so a
// blocked contender can report WHO holds it and detect crashed owners for
// stale recovery — a lock can therefore never wedge permanently.
function acquireFileLock(lockFile, options = {}) {
  const timeoutMs = options.timeoutMs == null ? DEFAULT_LOCK_TIMEOUT_MS : Number(options.timeoutMs);
  const staleMs = options.staleMs == null ? DEFAULT_LOCK_STALE_MS : Number(options.staleMs);
  const token = crypto.randomBytes(12).toString('hex');
  const info = {
    pid: process.pid,
    hostname: os.hostname(),
    owner: String(options.owner || 'cpr'),
    token,
    acquiredAt: Date.now(),
  };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let fd;
    try {
      fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
      fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(info));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      return {
        file: lockFile,
        token,
        release() {
          const current = readLockInfo(lockFile);
          // Only remove the lock if it is still ours — after a stale takeover
          // by another process, deleting would steal their lock.
          if (!current || current.token === token) {
            try { fs.rmSync(lockFile, { force: true }); } catch (_) {}
          }
        },
      };
    } catch (error) {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
      if (!error || error.code !== 'EEXIST') throw error;
      const holder = readLockInfo(lockFile);
      if (lockIsStale(lockFile, holder, staleMs)) {
        // TOCTOU guard: between reading `holder` and judging it stale (the
        // pid probe races the holder's release + a fresh acquire by a live
        // process whose file we must NOT delete), the lock may have been
        // replaced. Re-read immediately before breaking and only remove the
        // lock if it still carries the exact content we judged stale (or is
        // still unreadable); otherwise loop and re-evaluate the new holder.
        // The subsequent O_EXCL create arbitrates racing breakers — exactly
        // one wins, the rest loop back around.
        const current = readLockInfo(lockFile);
        const unchanged = holder ? (current && current.token === holder.token) : !current;
        if (unchanged) {
          try { fs.rmSync(lockFile, { force: true }); } catch (_) {}
        }
        continue;
      }
      if (Date.now() >= deadline) throw new LockTimeoutError(lockFile, timeoutMs, holder);
      sleepSync(LOCK_RETRY_DELAY_MS);
    }
  }
}

function withFileLock(lockFile, options, fn) {
  if (typeof options === 'function') { fn = options; options = {}; }
  const lock = acquireFileLock(lockFile, options);
  try { return fn(); }
  finally { lock.release(); }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// createDurableStore({ file, schemaName, payloadKey, defaultPayload, migrateLegacy, … })
//
// migrateLegacy(raw) receives any parsed pre-envelope document and returns the
// payload, or undefined when the shape is unrecognized — which is treated as
// corruption (fail-closed), not as "reset to defaults".
function createDurableStore(options = {}) {
  const file = options.file;
  if (!file || typeof file !== 'string') throw new Error('durable store requires a file path');
  const schemaName = options.schemaName;
  if (!schemaName || typeof schemaName !== 'string') throw new Error('durable store requires a schemaName');
  const schemaVersion = options.schemaVersion == null ? 1 : Number(options.schemaVersion);
  const payloadKey = options.payloadKey || 'payload';
  const defaultPayload = options.defaultPayload === undefined ? null : options.defaultPayload;
  const migrateLegacy = typeof options.migrateLegacy === 'function' ? options.migrateLegacy : null;
  const backups = options.backups == null ? DEFAULT_BACKUPS : Number(options.backups);
  const lockFile = options.lockFile || `${file}.lock`;
  const lockTimeoutMs = options.lockTimeoutMs == null ? DEFAULT_LOCK_TIMEOUT_MS : Number(options.lockTimeoutMs);
  const lockStaleMs = options.lockStaleMs == null ? DEFAULT_LOCK_STALE_MS : Number(options.lockStaleMs);
  const owner = options.owner || `cpr:${schemaName}`;

  function isEnvelope(raw) {
    return !!raw && typeof raw === 'object' && !Array.isArray(raw)
      && raw.schema === schemaName
      && typeof raw.revision === 'number'
      && Object.prototype.hasOwnProperty.call(raw, payloadKey);
  }

  function parseDocument(raw) {
    if (isEnvelope(raw)) {
      const version = raw.version == null ? schemaVersion : Number(raw.version);
      if (version > schemaVersion) {
        throw new CorruptedStateError(file, 'invalid',
          new Error(`schema ${schemaName}@${version} is newer than supported ${schemaVersion}`));
      }
      return { payload: raw[payloadKey], revision: raw.revision, version, legacy: false };
    }
    if (migrateLegacy) {
      const payload = migrateLegacy(raw);
      if (payload !== undefined) return { payload, revision: 0, version: schemaVersion, legacy: true };
    }
    throw new CorruptedStateError(file, 'invalid', new Error(`unrecognized ${schemaName} document shape`));
  }

  function documentParses(raw) {
    try { parseDocument(raw); return true; }
    catch (_) { return false; }
  }

  function load() {
    const { value, source, recovered } = loadOrRecover(file, {
      fallback: MISSING_DOC,
      backups,
      validate: documentParses,
    });
    if (value === MISSING_DOC) {
      return { payload: clone(defaultPayload), revision: 0, version: schemaVersion, exists: false, recovered: false, source: 'fallback' };
    }
    const doc = parseDocument(value);
    return { ...doc, exists: true, recovered, source };
  }

  function writeEnvelope(payload, revision) {
    writeJsonAtomic(file, {
      schema: schemaName,
      version: schemaVersion,
      revision,
      updatedAt: Date.now(),
      [payloadKey]: payload,
    }, { backups });
  }

  function withLock(fn) {
    return withFileLock(lockFile, { timeoutMs: lockTimeoutMs, staleMs: lockStaleMs, owner }, fn);
  }

  function save(payload, saveOptions = {}) {
    return withLock(() => {
      const current = load();
      const expected = saveOptions.expectedRevision;
      if (expected != null && Number(expected) !== current.revision) {
        throw new RevisionConflictError(file, Number(expected), current.revision);
      }
      const revision = current.revision + 1;
      writeEnvelope(payload, revision);
      return { revision };
    });
  }

  // Locked read-modify-write. fn(payload, { revision }) must return either
  // null/undefined (no write) or { next, result }; `next` becomes the new
  // payload and `result` is surfaced to the caller.
  function mutate(fn) {
    return withLock(() => {
      const current = load();
      const outcome = fn(current.payload, { revision: current.revision, exists: current.exists });
      if (outcome == null) return { changed: false, revision: current.revision, result: undefined };
      if (typeof outcome !== 'object' || !('next' in outcome)) {
        throw new Error('durable store mutate callback must return null or { next, result }');
      }
      const revision = current.revision + 1;
      writeEnvelope(outcome.next, revision);
      return { changed: true, revision, result: outcome.result };
    });
  }

  return {
    load,
    save,
    mutate,
    withLock,
    _file: file,
    _lockFile: lockFile,
    _schemaName: schemaName,
    _schemaVersion: schemaVersion,
  };
}

const MISSING_DOC = Symbol('cpr.durable.missing');

module.exports = {
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_LOCK_STALE_MS,
  DEFAULT_DURABLE_BACKUPS: DEFAULT_BACKUPS,
  CorruptedStateError,
  RevisionConflictError,
  LockTimeoutError,
  acquireFileLock,
  withFileLock,
  createDurableStore,
};
