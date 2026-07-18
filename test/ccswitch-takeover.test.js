'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const Database = require('better-sqlite3');

const takeover = require('../lib/ccswitch');

const HEALTH_NONCE = 'fixture-health-nonce-0123456789';

function healthyProbe({ expectedNonce }) {
  return Promise.resolve({
    ok: true,
    product: 'cli-provider-router-proxy',
    pid: process.pid,
    takeoverNonce: expectedNonce,
  });
}

function applyAll(ctx, extra = {}) {
  return takeover.apply({
    ...ctx,
    proxyBaseUrl: 'http://127.0.0.1:4567',
    healthNonce: HEALTH_NONCE,
    healthProbe: healthyProbe,
    allProviders: true,
    confirmAllProviders: 'TAKE OVER ALL PROVIDERS',
    ...extra,
  });
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-ccswitch-'));
  const home = path.join(root, 'cpr-home');
  const dbPath = path.join(root, 'cc-switch.db');
  const db = new Database(dbPath);
  db.exec(`
    PRAGMA user_version = 11;
    CREATE TABLE providers (
      id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
      settings_config TEXT NOT NULL, website_url TEXT, category TEXT,
      created_at INTEGER, sort_index INTEGER, notes TEXT, icon TEXT,
      icon_color TEXT, meta TEXT NOT NULL DEFAULT '{}',
      is_current BOOLEAN NOT NULL DEFAULT 0,
      in_failover_queue BOOLEAN NOT NULL DEFAULT 0,
      cost_multiplier TEXT NOT NULL DEFAULT '1.0', limit_daily_usd TEXT,
      limit_monthly_usd TEXT, provider_type TEXT, PRIMARY KEY (id, app_type)
    );
    CREATE TABLE provider_endpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id TEXT NOT NULL,
      app_type TEXT NOT NULL, url TEXT NOT NULL, added_at INTEGER
    );
    CREATE TABLE proxy_config (
      app_type TEXT PRIMARY KEY, proxy_enabled INTEGER NOT NULL DEFAULT 0,
      listen_address TEXT NOT NULL DEFAULT '127.0.0.1',
      listen_port INTEGER NOT NULL DEFAULT 15721,
      enable_logging INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 0,
      auto_failover_enabled INTEGER NOT NULL DEFAULT 0, max_retries INTEGER NOT NULL DEFAULT 3,
      streaming_first_byte_timeout INTEGER NOT NULL DEFAULT 60,
      streaming_idle_timeout INTEGER NOT NULL DEFAULT 120,
      non_streaming_timeout INTEGER NOT NULL DEFAULT 600,
      circuit_failure_threshold INTEGER NOT NULL DEFAULT 4,
      circuit_success_threshold INTEGER NOT NULL DEFAULT 2,
      circuit_timeout_seconds INTEGER NOT NULL DEFAULT 60,
      circuit_error_rate_threshold REAL NOT NULL DEFAULT 0.6,
      circuit_min_requests INTEGER NOT NULL DEFAULT 10,
      default_cost_multiplier TEXT NOT NULL DEFAULT '1',
      pricing_model_source TEXT NOT NULL DEFAULT 'response',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      live_takeover_active INTEGER NOT NULL DEFAULT 0
    );
  `);
  const claude = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://claude.example/v1', ANTHROPIC_AUTH_TOKEN: 'secret' }, other: 'keep' });
  const codex = JSON.stringify({ auth: { OPENAI_API_KEY: 'secret' }, config: '[model_providers.custom]\nbase_url = "https://codex.example/v1" # keep-comment\nwire_api = "responses"\n' });
  db.prepare('INSERT INTO providers(id,app_type,name,settings_config) VALUES (?,?,?,?)').run('claude-one', 'claude', 'Claude One', claude);
  db.prepare('INSERT INTO providers(id,app_type,name,settings_config) VALUES (?,?,?,?)').run('codex-one', 'codex', 'Codex One', codex);
  db.prepare('INSERT INTO provider_endpoints(provider_id,app_type,url) VALUES (?,?,?)').run('claude-one', 'claude', 'https://claude-backup.example/v1');
  db.prepare('INSERT INTO provider_endpoints(provider_id,app_type,url) VALUES (?,?,?)').run('codex-one', 'codex', 'https://codex-backup.example/v1');
  db.prepare('INSERT INTO proxy_config(app_type,live_takeover_active) VALUES (?,?)').run('claude', options.liveTakeover ? 1 : 0);
  db.prepare('INSERT INTO proxy_config(app_type,live_takeover_active) VALUES (?,?)').run('codex', 0);
  db.close();
  return { root, home, dbPath };
}

function readProvider(dbPath, id, appType) {
  const db = new Database(dbPath, { readonly: true });
  try { return JSON.parse(db.prepare('SELECT settings_config FROM providers WHERE id=? AND app_type=?').get(id, appType).settings_config); }
  finally { db.close(); }
}

function endpointUrls(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try { return db.prepare('SELECT id,url FROM provider_endpoints ORDER BY id').all(); }
  finally { db.close(); }
}

test('snapshot, preview, apply, status and field-level restore are reversible and idempotent', async t => {
  const ctx = fixture();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  const proxyBaseUrl = 'http://127.0.0.1:4567';

  const discovery = takeover.discover(ctx);
  assert.equal(discovery.supported, true);
  assert.equal(discovery.liveTakeoverActive, false);

  const snap = await takeover.snapshot(ctx);
  assert.throws(() => takeover.readSnapshot(ctx.home, '../../outside'), error => error.code === 'INVALID_SNAPSHOT_ID');
  assert.ok(fs.existsSync(snap.backupPath));
  assert.equal(fs.statSync(snap.backupPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(snap.dir, 'manifest.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(snap.dir, 'endpoints.json')).mode & 0o777, 0o600);
  const before = takeover.preview({ ...ctx, snapshotId: snap.snapshotId, proxyBaseUrl, allProviders: true });
  assert.equal(before.canApply, true);
  assert.equal(before.changes.length, 4);
  assert.ok(before.changes.every(change => change.condition === 'original'));

  const applied = await applyAll(ctx, { snapshotId: snap.snapshotId, proxyBaseUrl });
  assert.equal(applied.changed, 4);
  assert.equal(fs.statSync(path.join(ctx.home, 'ccswitch', 'state.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(ctx.home, 'ccswitch', 'audit.jsonl')).mode & 0o777, 0o600);
  const claude = readProvider(ctx.dbPath, 'claude-one', 'claude');
  const codex = readProvider(ctx.dbPath, 'codex-one', 'codex');
  assert.match(claude.env.ANTHROPIC_BASE_URL, /ccswitch\/claude\/claude-one$/);
  assert.match(codex.config, /ccswitch\/codex\/codex-one/);
  assert.match(codex.config, /# keep-comment/);
  assert.ok(endpointUrls(ctx.dbPath).every(row => row.url.includes('/ccswitch/')));
  assert.equal(takeover.resolveSnapshotUpstream({ ...ctx, snapshotId: snap.snapshotId, appType: 'claude', providerId: 'claude-one' }), 'https://claude.example/v1');
  assert.equal(takeover.status(ctx).takeover, 'active');

  const repeatedApply = await applyAll(ctx, { proxyBaseUrl: `${proxyBaseUrl}/` });
  assert.equal(repeatedApply.alreadyActive, true);
  assert.equal(repeatedApply.changed, 0);

  const restored = takeover.restore(ctx);
  assert.equal(restored.changed, 4);
  assert.equal(readProvider(ctx.dbPath, 'claude-one', 'claude').env.ANTHROPIC_BASE_URL, 'https://claude.example/v1');
  assert.match(readProvider(ctx.dbPath, 'codex-one', 'codex').config, /base_url = "https:\/\/codex\.example\/v1"/);
  assert.deepEqual(endpointUrls(ctx.dbPath).map(row => row.url), ['https://claude-backup.example/v1', 'https://codex-backup.example/v1']);
  assert.equal(takeover.status(ctx).takeover, 'restored');
  assert.equal(takeover.restore(ctx).alreadyRestored, true);
  assert.ok(takeover.readAudit(ctx.home).some(entry => entry.event === 'takeover.restored'));
});

test('drift blocks restore and force only restores managed endpoint fields', async t => {
  const ctx = fixture();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  await applyAll(ctx);
  const db = new Database(ctx.dbPath);
  const settings = JSON.parse(db.prepare("SELECT settings_config FROM providers WHERE id='claude-one' AND app_type='claude'").get().settings_config);
  settings.env.ANTHROPIC_BASE_URL = 'https://changed-elsewhere.example';
  settings.unrelatedAfterApply = 'preserve-me';
  db.prepare("UPDATE providers SET settings_config=? WHERE id='claude-one' AND app_type='claude'").run(JSON.stringify(settings));
  db.close();

  assert.equal(takeover.status(ctx).takeover, 'conflict');
  assert.throws(() => takeover.restore(ctx), error => error.code === 'CONFIG_DRIFT');
  takeover.restore({ ...ctx, force: true });
  const restored = readProvider(ctx.dbPath, 'claude-one', 'claude');
  assert.equal(restored.env.ANTHROPIC_BASE_URL, 'https://claude.example/v1');
  assert.equal(restored.unrelatedAfterApply, 'preserve-me');
});

test('CC-Switch live takeover rejects CPR double proxy', async t => {
  const ctx = fixture({ liveTakeover: true });
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  await assert.rejects(
    takeover.apply({ ...ctx, proxyBaseUrl: 'http://127.0.0.1:4567' }),
    error => error.code === 'DOUBLE_PROXY' && error.message.includes('claude'),
  );
  assert.equal(readProvider(ctx.dbPath, 'claude-one', 'claude').env.ANTHROPIC_BASE_URL, 'https://claude.example/v1');
});

test('disaster full restore is separately confirmed and keeps a safety snapshot', async t => {
  const ctx = fixture();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  const original = await takeover.snapshot(ctx);
  await applyAll(ctx);
  await assert.rejects(takeover.fullRestore({ ...ctx, snapshotId: original.snapshotId }), error => error.code === 'CONFIRMATION_REQUIRED');
  await assert.rejects(
    takeover.fullRestore({ ...ctx, snapshotId: original.snapshotId, confirm: 'FULL_RESTORE' }),
    error => error.code === 'WRITER_STOP_REQUIRED',
  );
  const result = await takeover.fullRestore({
    ...ctx, snapshotId: original.snapshotId, confirm: 'FULL_RESTORE', writerStopped: true,
  });
  assert.ok(result.safetySnapshotId);
  assert.equal(readProvider(ctx.dbPath, 'claude-one', 'claude').env.ANTHROPIC_BASE_URL, 'https://claude.example/v1');
});
