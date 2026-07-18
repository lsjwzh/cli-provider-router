'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openSqliteDatabase, requireSqliteDatabase } = require('../sqlite-runtime');
const { createCprPaths } = require('../paths');

const SUPPORTED_APP_TYPES = new Set(['claude', 'codex']);

function requireDatabase() {
  return requireSqliteDatabase();
}

function resolveHome(home) {
  return path.resolve(home || process.env.CPR_HOME || path.join(os.homedir(), '.cli-provider-router'));
}

function takeoverRoot(home) {
  return createCprPaths({ home: resolveHome(home) }).ccSwitchDir;
}

function statePath(home) {
  return createCprPaths({ home: resolveHome(home) }).ccSwitchStateFile;
}

function snapshotDir(home, snapshotId) {
  return path.join(takeoverRoot(home), 'snapshots', snapshotId);
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (_) {}
  return dir;
}

function writePrivateJson(file, value) {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (_) {}
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function sha256(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function tableColumns(db, name) {
  if (!tableExists(db, name)) return [];
  return db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all().map(row => row.name);
}

function openDatabase(dbPath, options = {}) {
  return openSqliteDatabase(path.resolve(dbPath), options);
}

function makeSnapshotId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeProxyBaseUrl(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('proxyBaseUrl must use http or https');
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function localProviderUrl(proxyBaseUrl, appType, providerId, endpointId) {
  const base = normalizeProxyBaseUrl(proxyBaseUrl);
  const root = `${base}/ccswitch/${encodeURIComponent(appType)}/${encodeURIComponent(providerId)}`;
  return endpointId == null ? root : `${root}/endpoint/${encodeURIComponent(String(endpointId))}`;
}

function parseSettings(raw) {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch (_) { return null; }
}

const TOML_BASE_URL_RE = /^(\s*base_url\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*')(\s*(?:#.*)?)$/gm;

function decodeTomlString(literal) {
  if (literal.startsWith('"')) {
    try { return JSON.parse(literal); } catch (_) { return null; }
  }
  return literal.slice(1, -1).replace(/''/g, "'");
}

function listTomlBaseUrls(config) {
  const out = [];
  let occurrence = 0;
  String(config || '').replace(TOML_BASE_URL_RE, (_whole, _prefix, literal) => {
    out.push({ occurrence, value: decodeTomlString(literal) });
    occurrence += 1;
    return _whole;
  });
  return out.filter(entry => typeof entry.value === 'string');
}

function replaceTomlBaseUrl(config, occurrence, expected, replacement, force = false) {
  let index = 0;
  let found = false;
  let actual;
  const next = String(config || '').replace(TOML_BASE_URL_RE, (whole, prefix, literal, suffix) => {
    if (index++ !== occurrence) return whole;
    found = true;
    actual = decodeTomlString(literal);
    if (!force && actual !== expected) return whole;
    return `${prefix}${JSON.stringify(replacement)}${suffix}`;
  });
  return { value: next, found, actual, changed: found && (force || actual === expected) && actual !== replacement };
}

function changeKey(change) {
  if (change.kind === 'provider-endpoint') return `endpoint:${change.rowId}`;
  return `provider:${change.appType}:${change.providerId}:${change.field}:${change.occurrence || 0}`;
}

module.exports = {
  SUPPORTED_APP_TYPES,
  changeKey,
  ensurePrivateDir,
  listTomlBaseUrls,
  localProviderUrl,
  makeSnapshotId,
  normalizeProxyBaseUrl,
  openDatabase,
  parseSettings,
  readJson,
  replaceTomlBaseUrl,
  requireDatabase,
  resolveHome,
  sha256,
  snapshotDir,
  statePath,
  tableColumns,
  tableExists,
  takeoverRoot,
  writePrivateJson,
};
