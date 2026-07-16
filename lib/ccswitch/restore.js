'use strict';

const fs = require('fs');
const path = require('path');
const { appendAudit } = require('./audit');
const { discover } = require('./discover');
const { mutate } = require('./operations');
const { openDatabase, readJson, statePath, writePrivateJson } = require('./common');
const { readSnapshot, snapshot } = require('./snapshot');

function restore(options = {}) {
  if (!options.dbPath) throw new Error('dbPath is required');
  const state = readJson(statePath(options.home));
  if (!state || !state.changes) return { alreadyRestored: true, changed: 0, managed: false };
  if (state.dbPath && path.resolve(state.dbPath) !== path.resolve(options.dbPath)) {
    const error = new Error('The active takeover belongs to a different CC-Switch database');
    error.code = 'DATABASE_MISMATCH';
    throw error;
  }
  const info = discover(options);
  if (!info.found || !info.supported) throw Object.assign(new Error('Unsupported CC-Switch database'), { code: 'UNSUPPORTED_SCHEMA', discovery: info });
  const db = openDatabase(info.dbPath, { fileMustExist: true });
  let result;
  try { result = mutate(db, state.changes, 'restore', { force: !!options.force }); } finally { db.close(); }
  const next = { ...state, status: 'restored', restoredAt: new Date().toISOString(), forcedRestore: !!options.force };
  writePrivateJson(statePath(options.home), next);
  appendAudit(options.home, 'takeover.restored', { snapshotId: state.snapshotId, dbPath: info.dbPath, changed: result.changed, forced: !!options.force });
  return { ...result, alreadyRestored: result.changed === 0, managed: true, state: next };
}

async function fullRestore(options = {}) {
  if (options.confirm !== 'FULL_RESTORE') {
    const error = new Error('Disaster restore requires confirm="FULL_RESTORE"');
    error.code = 'CONFIRMATION_REQUIRED';
    throw error;
  }
  if (!options.dbPath) throw new Error('dbPath is required');
  if (!options.snapshotId) throw new Error('snapshotId is required');
  const source = readSnapshot(options.home, options.snapshotId);
  const before = await snapshot({ ...options, snapshotId: undefined });
  const dbPath = path.resolve(options.dbPath);
  const temp = `${dbPath}.cpr-restore-${process.pid}`;
  const backupDb = openDatabase(source.backupPath, { readonly: true, fileMustExist: true });
  try { await backupDb.backup(temp); } finally { backupDb.close(); }
  try { fs.chmodSync(temp, 0o600); } catch (_) {}
  const displaced = `${dbPath}.cpr-displaced-${Date.now()}`;
  try {
    fs.renameSync(dbPath, displaced);
    for (const suffix of ['-wal', '-shm']) {
      try { fs.rmSync(`${dbPath}${suffix}`); } catch (_) {}
    }
    fs.renameSync(temp, dbPath);
    try { fs.chmodSync(dbPath, 0o600); } catch (_) {}
    fs.rmSync(displaced, { force: true });
  } catch (error) {
    try { if (!fs.existsSync(dbPath) && fs.existsSync(displaced)) fs.renameSync(displaced, dbPath); } catch (_) {}
    try { fs.rmSync(temp, { force: true }); } catch (_) {}
    throw error;
  }
  const state = readJson(statePath(options.home), {});
  writePrivateJson(statePath(options.home), { ...state, status: 'full-restored', restoredAt: new Date().toISOString(), restoredSnapshotId: options.snapshotId });
  appendAudit(options.home, 'takeover.full-restored', { snapshotId: options.snapshotId, safetySnapshotId: before.snapshotId, dbPath });
  return { restoredSnapshotId: options.snapshotId, safetySnapshotId: before.snapshotId, dbPath };
}

module.exports = { fullRestore, restore };
