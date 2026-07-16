'use strict';

const fs = require('fs');
const path = require('path');
const { appendAudit } = require('./audit');
const { discover } = require('./discover');
const { collectTargets, endpointMap } = require('./plan');
const {
  ensurePrivateDir, makeSnapshotId, openDatabase, sha256, snapshotDir, writePrivateJson,
} = require('./common');

function assertSnapshotId(snapshotId) {
  if (typeof snapshotId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(snapshotId) || snapshotId.includes('..')) {
    const error = new Error('Invalid snapshot id');
    error.code = 'INVALID_SNAPSHOT_ID';
    throw error;
  }
  return snapshotId;
}

async function snapshot(options = {}) {
  const info = discover(options);
  if (!info.found || !info.supported) {
    const error = new Error(`Unsupported CC-Switch database: ${info.issues.join(', ')}`);
    error.code = 'UNSUPPORTED_SCHEMA';
    error.discovery = info;
    throw error;
  }
  const snapshotId = assertSnapshotId(options.snapshotId || makeSnapshotId());
  const dir = snapshotDir(options.home, snapshotId);
  if (fs.existsSync(dir)) throw new Error(`Snapshot already exists: ${snapshotId}`);
  ensurePrivateDir(dir);
  const backupPath = path.join(dir, 'cc-switch.db');
  const source = openDatabase(info.dbPath, { readonly: true, fileMustExist: true });
  try { await source.backup(backupPath); } finally { source.close(); }
  try { fs.chmodSync(backupPath, 0o600); } catch (_) {}

  const copy = openDatabase(backupPath, { readonly: true, fileMustExist: true });
  let targets;
  try { targets = collectTargets(copy); } finally { copy.close(); }
  const sourceStat = fs.statSync(info.dbPath);
  const backupStat = fs.statSync(backupPath);
  const endpointsPayload = { version: 1, snapshotId, endpoints: endpointMap(targets.changes), warnings: targets.warnings };
  const endpointsSerialized = `${JSON.stringify(endpointsPayload, null, 2)}\n`;
  const manifest = {
    version: 1,
    snapshotId,
    createdAt: new Date().toISOString(),
    sourceDbPath: info.dbPath,
    sourceDbStat: { size: sourceStat.size, mtimeMs: sourceStat.mtimeMs },
    backupFile: 'cc-switch.db',
    backupSize: backupStat.size,
    backupSha256: sha256(fs.readFileSync(backupPath)),
    endpointMapSha256: sha256(endpointsSerialized),
    supportedAppTypes: ['claude', 'codex'],
    targetCount: targets.changes.length,
    warningCount: targets.warnings.length,
    schema: info.schema,
  };
  writePrivateJson(path.join(dir, 'endpoints.json'), endpointsPayload);
  writePrivateJson(path.join(dir, 'manifest.json'), manifest);
  appendAudit(options.home, 'snapshot.created', { snapshotId, dbPath: info.dbPath, targetCount: targets.changes.length });
  return { ...manifest, dir, backupPath };
}

function readSnapshot(home, snapshotId) {
  assertSnapshotId(snapshotId);
  const dir = snapshotDir(home, snapshotId);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    const error = new Error(`Snapshot not found: ${snapshotId}`);
    error.code = 'SNAPSHOT_NOT_FOUND';
    throw error;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const backupPath = path.join(dir, 'cc-switch.db');
  const endpointsPath = path.join(dir, 'endpoints.json');
  if (!fs.existsSync(backupPath) || sha256(fs.readFileSync(backupPath)) !== manifest.backupSha256) {
    const error = new Error(`Snapshot database integrity check failed: ${snapshotId}`);
    error.code = 'SNAPSHOT_CORRUPT';
    throw error;
  }
  if (!fs.existsSync(endpointsPath) || sha256(fs.readFileSync(endpointsPath)) !== manifest.endpointMapSha256) {
    const error = new Error(`Snapshot endpoint map integrity check failed: ${snapshotId}`);
    error.code = 'SNAPSHOT_CORRUPT';
    throw error;
  }
  return { dir, manifest, backupPath, endpointsPath };
}

module.exports = { assertSnapshotId, readSnapshot, snapshot };
