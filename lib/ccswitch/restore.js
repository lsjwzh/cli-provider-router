'use strict';

const fs = require('fs');
const path = require('path');
const { appendAudit } = require('./audit');
const { discover, identityMatches } = require('./discover');
const { inspectChanges, mutate } = require('./operations');
const { ensurePrivateDir, makeSnapshotId, openDatabase, takeoverRoot } = require('./common');
const { assertSnapshotRecoveryTarget, readSnapshot, snapshot } = require('./snapshot');
const { createTakeoverStateStore } = require('../takeover-state');

function assertExclusiveAccess(dbPath) {
  const db = openDatabase(dbPath, { fileMustExist: true, timeout: 100 });
  try {
    db.pragma('busy_timeout = 100');
    db.exec('BEGIN EXCLUSIVE; ROLLBACK;');
  } catch (cause) {
    const error = new Error('CC-Switch database writer may still be active; stop CC-Switch before disaster restore');
    error.code = 'WRITER_ACTIVE';
    error.cause = cause;
    throw error;
  } finally { db.close(); }
}

function verifyDirection(dbPath, changes, expected, stateStore, state) {
  const db = openDatabase(dbPath, { readonly: true, fileMustExist: true });
  let verification;
  try { verification = inspectChanges(db, changes); } finally { db.close(); }
  const mismatches = verification.filter(item => item.condition !== expected);
  if (mismatches.length) {
    stateStore.writeCcSwitch({ ...state, status: 'conflict', failedAt: new Date().toISOString(), failureCode: 'RESTORE_VERIFICATION_FAILED' });
    const error = new Error(`restore verification failed for ${mismatches.length} endpoint field(s)`);
    error.code = 'RESTORE_VERIFICATION_FAILED';
    error.mismatches = mismatches;
    throw error;
  }
  return verification;
}

function verifyRestoredDatabase(dbPath, sourceManifest, options = {}) {
  const db = openDatabase(dbPath, { readonly: true, fileMustExist: true });
  let integrity;
  try { integrity = db.pragma('quick_check', { simple: true }); } finally { db.close(); }
  if (integrity !== 'ok') {
    throw Object.assign(new Error(`restored database integrity check failed: ${integrity}`), {
      code: 'FULL_RESTORE_VERIFICATION_FAILED',
    });
  }
  const restoredInfo = discover({ ...options, dbPath });
  if (!restoredInfo.supported || !sourceManifest.schema
      || restoredInfo.schema.fingerprint !== sourceManifest.schema.fingerprint) {
    throw Object.assign(new Error('restored database schema verification failed'), {
      code: 'FULL_RESTORE_VERIFICATION_FAILED',
    });
  }
  return restoredInfo;
}

function restore(options = {}) {
  if (!options.dbPath) throw new Error('dbPath is required');
  const states = createTakeoverStateStore(options.home);
  const state = states.ccSwitch().state;
  if (!state || !state.changes || ['restored', 'full-restored'].includes(state.status)) {
    return { alreadyRestored: true, changed: 0, managed: !!state };
  }
  const info = discover(options);
  if (!info.found || !info.supported) throw Object.assign(new Error('Unsupported CC-Switch database'), { code: 'UNSUPPORTED_SCHEMA', discovery: info });
  if (state.dbPath && path.resolve(state.dbPath) !== path.resolve(info.databaseIdentity.realpath)) {
    const error = new Error('The active takeover belongs to a different CC-Switch database');
    error.code = 'DATABASE_MISMATCH';
    throw error;
  }
  if (state.databaseIdentity && !identityMatches(state.databaseIdentity, info.databaseIdentity)) {
    const error = new Error('The active takeover database identity or schema changed');
    error.code = 'DATABASE_IDENTITY_MISMATCH';
    throw error;
  }
  const restoring = { ...state, status: 'restoring', restoringAt: new Date().toISOString(), forcedRestore: !!options.force };
  states.writeCcSwitch(restoring);
  const db = openDatabase(info.dbPath, { fileMustExist: true });
  let result;
  try { result = mutate(db, state.changes, 'restore', { force: !!options.force }); }
  catch (error) {
    states.writeCcSwitch({ ...restoring, status: 'conflict', failedAt: new Date().toISOString(), failureCode: error.code || 'RESTORE_FAILED' });
    throw error;
  } finally { db.close(); }
  verifyDirection(info.dbPath, state.changes, 'original', states, restoring);
  const next = { ...restoring, status: 'restored', restoredAt: new Date().toISOString(), verifiedAt: new Date().toISOString() };
  delete next.restoringAt;
  states.writeCcSwitch(next);
  appendAudit(options.home, 'takeover.restored', { snapshotId: state.snapshotId, dbPath: info.dbPath, changed: result.changed, forced: !!options.force });
  return { ...result, alreadyRestored: result.changed === 0, managed: true, state: next };
}

async function fullRestore(options = {}) {
  if (options.confirm !== 'FULL_RESTORE') {
    const error = new Error('Disaster restore requires confirm="FULL_RESTORE"');
    error.code = 'CONFIRMATION_REQUIRED';
    throw error;
  }
  if (options.writerStopped !== true) {
    const error = new Error('Disaster restore requires writerStopped=true after CC-Switch has been stopped');
    error.code = 'WRITER_STOP_REQUIRED';
    throw error;
  }
  if (!options.dbPath) throw new Error('dbPath is required');
  if (!options.snapshotId) throw new Error('snapshotId is required');
  const info = discover(options);
  if (!info.found || !info.supported) throw Object.assign(new Error('Unsupported CC-Switch database'), { code: 'UNSUPPORTED_SCHEMA', discovery: info });
  assertExclusiveAccess(info.dbPath);
  const source = readSnapshot(options.home, options.snapshotId);
  // Disaster recovery may legitimately replace an inode, but it must never
  // cross a database path or an allowlisted schema boundary.
  assertSnapshotRecoveryTarget(source.manifest, info);
  const before = await snapshot({ ...options, snapshotId: undefined });
  const dbPath = info.databaseIdentity.realpath;
  const temp = `${dbPath}.cpr-restore-${process.pid}`;
  const backupDb = openDatabase(source.backupPath, { readonly: true, fileMustExist: true });
  try { await backupDb.backup(temp); } finally { backupDb.close(); }
  try { fs.chmodSync(temp, 0o600); } catch (_) {}

  const displacedDir = ensurePrivateDir(path.join(takeoverRoot(options.home), 'displaced', makeSnapshotId()));
  const displacedFiles = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const original = `${dbPath}${suffix}`;
    if (!fs.existsSync(original)) continue;
    const destination = path.join(displacedDir, `cc-switch.db${suffix}`);
    fs.copyFileSync(original, destination);
    try { fs.chmodSync(destination, 0o600); } catch (_) {}
    displacedFiles.push(destination);
  }

  const rollbackPath = `${dbPath}.cpr-rollback-${process.pid}`;
  let restoredInfo;
  try {
    fs.renameSync(dbPath, rollbackPath);
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    fs.renameSync(temp, dbPath);
    try { fs.chmodSync(dbPath, 0o600); } catch (_) {}
    restoredInfo = verifyRestoredDatabase(dbPath, source.manifest, options);
    fs.rmSync(rollbackPath, { force: true });
  } catch (error) {
    try { fs.rmSync(dbPath, { force: true }); } catch (_) {}
    try { if (fs.existsSync(rollbackPath)) fs.renameSync(rollbackPath, dbPath); } catch (_) {}
    // The rollback database may depend on uncheckpointed WAL contents. Put
    // every displaced sidecar back instead of silently dropping recent data.
    for (const suffix of ['-wal', '-shm']) {
      const saved = path.join(displacedDir, `cc-switch.db${suffix}`);
      try {
        fs.rmSync(`${dbPath}${suffix}`, { force: true });
        if (fs.existsSync(saved)) fs.copyFileSync(saved, `${dbPath}${suffix}`);
      } catch (_) {}
    }
    try { fs.rmSync(temp, { force: true }); } catch (_) {}
    error.displacedDir = displacedDir;
    throw error;
  }
  const states = createTakeoverStateStore(options.home);
  states.writeCcSwitch({
    version: 2,
    status: 'full-restored',
    snapshotId: options.snapshotId,
    restoredSnapshotId: options.snapshotId,
    restoredAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
    dbPath: restoredInfo.databaseIdentity.realpath,
    databaseIdentity: restoredInfo.databaseIdentity,
    changes: [],
    displacedDir,
  });
  appendAudit(options.home, 'takeover.full-restored', { snapshotId: options.snapshotId, safetySnapshotId: before.snapshotId, dbPath, displacedDir });
  return { restoredSnapshotId: options.snapshotId, safetySnapshotId: before.snapshotId, dbPath, displacedDir, displacedFiles };
}

module.exports = { assertExclusiveAccess, fullRestore, restore, verifyRestoredDatabase };
