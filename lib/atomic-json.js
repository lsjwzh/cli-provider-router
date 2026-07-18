'use strict';

// atomic-json.js — durable JSON file primitives.
//
// Two read disciplines coexist here:
//   readJson       — legacy/lax: any failure returns the fallback. Retained for
//                    ephemeral state (service pid/health, usage snapshots) where
//                    "treat as absent" is the right recovery.
//   readJsonStrict — fail-closed: ONLY ENOENT maps to the fallback. Permission
//                    errors, I/O errors, truncation and malformed JSON raise a
//                    stable CorruptedStateError so config stores never silently
//                    reset user data to defaults and then overwrite it.
//
// On top of the strict reader sit rolling backups (rotated on every successful
// write) and loadOrRecover, which falls back to the newest parseable backup and
// re-materializes the primary file, preserving the corrupt original beside it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DIRECTORY_MODE, FILE_MODE, secureDirectory } = require('./paths');

class CorruptedStateError extends Error {
  constructor(file, reason, cause) {
    super(`corrupted state file: ${file} (${reason})${cause && cause.message ? ': ' + cause.message : ''}`);
    this.name = 'CorruptedStateError';
    this.code = 'CPR_CORRUPTED_STATE';
    this.statusCode = 500;
    this.file = file;
    // 'permission' | 'io' | 'truncated' | 'parse' | 'invalid'
    this.reason = reason;
    if (cause) this.cause = cause;
  }
}

function resolveFallback(fallback) {
  return typeof fallback === 'function' ? fallback() : fallback;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return resolveFallback(fallback); }
}

function readJsonStrict(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return resolveFallback(fallback);
    const reason = error && (error.code === 'EACCES' || error.code === 'EPERM') ? 'permission' : 'io';
    throw new CorruptedStateError(file, reason, error);
  }
  if (!raw.trim()) throw new CorruptedStateError(file, 'truncated');
  try { return JSON.parse(raw); }
  catch (error) { throw new CorruptedStateError(file, 'parse', error); }
}

function atomicWriteFile(file, contents, options = {}) {
  const dir = path.dirname(file);
  secureDirectory(dir);
  const mode = options.mode == null ? FILE_MODE : options.mode;
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, contents, options.encoding || 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, mode); } catch (_) {}
    try {
      const dirFd = fs.openSync(dir, 'r');
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
    } catch (_) {}
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    throw error;
  }
}

function backupFilePath(file, index) {
  return `${file}.bak${index}`;
}

// Shift <file>.bak1 → .bak2 → … and copy the current primary to .bak1. Called
// just before an atomic write so bak1 always holds the last successfully
// written generation. Best-effort: a failed rotation never blocks the write.
function rotateJsonBackups(file, keep) {
  const count = Number(keep) || 0;
  if (count <= 0 || !fs.existsSync(file)) return;
  try { fs.rmSync(backupFilePath(file, count), { force: true }); } catch (_) {}
  for (let i = count - 1; i >= 1; i--) {
    try { fs.renameSync(backupFilePath(file, i), backupFilePath(file, i + 1)); } catch (_) {}
  }
  try {
    fs.copyFileSync(file, backupFilePath(file, 1));
    fs.chmodSync(backupFilePath(file, 1), FILE_MODE);
  } catch (_) {}
}

function writeJsonAtomic(file, value, options = {}) {
  if (options.backups) rotateJsonBackups(file, options.backups);
  atomicWriteFile(file, JSON.stringify(value, null, 2) + '\n', options);
}

const MISSING = Symbol('cpr.missing');

// Fail-closed load with backup recovery. Returns { value, source, recovered }
// where source is 'primary' | 'backup:<n>' | 'fallback' (file absent). When the
// primary is corrupt and a backup parses (and passes options.validate), the
// corrupt bytes are preserved as <file>.corrupt and the primary is rewritten
// from the backup. If no backup survives, the ORIGINAL CorruptedStateError is
// rethrown — absence of a good backup never degrades to defaults.
function loadOrRecover(file, options = {}) {
  const { fallback = null, backups = 0, validate } = options;
  let primaryError;
  try {
    const value = readJsonStrict(file, MISSING);
    if (value === MISSING) return { value: resolveFallback(fallback), source: 'fallback', recovered: false };
    if (validate && !validate(value)) throw new CorruptedStateError(file, 'invalid');
    return { value, source: 'primary', recovered: false };
  } catch (error) {
    if (!(error instanceof CorruptedStateError)) throw error;
    primaryError = error;
  }
  for (let i = 1; i <= (Number(backups) || 0); i++) {
    const candidate = backupFilePath(file, i);
    let value;
    try {
      value = readJsonStrict(candidate, MISSING);
    } catch (_) { continue; }
    if (value === MISSING) continue;
    if (validate && !validate(value)) continue;
    try { fs.copyFileSync(file, `${file}.corrupt`); } catch (_) {}
    writeJsonAtomic(file, value);
    return { value, source: `backup:${i}`, recovered: true };
  }
  primaryError.recoveryAttempted = true;
  throw primaryError;
}

function removeFile(file) {
  try { fs.rmSync(file, { force: true }); } catch (_) {}
}

module.exports = {
  DIRECTORY_MODE,
  FILE_MODE,
  CorruptedStateError,
  readJson,
  readJsonStrict,
  atomicWriteFile,
  writeJsonAtomic,
  backupFilePath,
  rotateJsonBackups,
  loadOrRecover,
  removeFile,
};
