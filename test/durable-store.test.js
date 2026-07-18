'use strict';

// Fault-injection coverage for the durable config-store layer: fail-closed
// reads, schema-envelope migration, rolling-backup recovery, cross-process
// locking (stale recovery + timeout) and revision CAS. Everything runs inside
// throwaway temp directories — no real CPR_HOME or user config is touched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const {
  CorruptedStateError,
  RevisionConflictError,
  LockTimeoutError,
  acquireFileLock,
  createDurableStore,
} = require('../lib/durable-store');
const { readJsonStrict, loadOrRecover, writeJsonAtomic, backupFilePath } = require('../lib/atomic-json');
const { createStore } = require('../lib/store');
const { createRouteProfileStore } = require('../lib/route-profile-store');
const { createSettingsStore } = require('../lib/settings-store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-durable-'));
}

function makeDurable(dir, overrides = {}) {
  return createDurableStore({
    file: path.join(dir, 'data.json'),
    schemaName: 'cpr.test',
    payloadKey: 'items',
    defaultPayload: [],
    migrateLegacy(raw) {
      if (raw === null) return [];
      if (Array.isArray(raw)) return raw;
      if (raw && typeof raw === 'object' && Array.isArray(raw.items)) return raw.items;
      return undefined;
    },
    ...overrides,
  });
}

// ── readJsonStrict / loadOrRecover primitives ────────────────────────────────

test('readJsonStrict: only ENOENT maps to the fallback', t => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'x.json');
  assert.equal(readJsonStrict(file, 'absent'), 'absent');

  fs.writeFileSync(file, '{"ok":true}');
  assert.deepEqual(readJsonStrict(file, null), { ok: true });

  fs.writeFileSync(file, '{"truncated": tr');
  assert.throws(() => readJsonStrict(file, null), err => err instanceof CorruptedStateError && err.reason === 'parse' && err.code === 'CPR_CORRUPTED_STATE');

  fs.writeFileSync(file, '   \n');
  assert.throws(() => readJsonStrict(file, null), err => err instanceof CorruptedStateError && err.reason === 'truncated');
});

test('readJsonStrict: permission errors fail closed instead of returning defaults', t => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return t.skip('running as root');
  const dir = tmpDir();
  t.after(() => { fs.chmodSync(path.join(dir, 'x.json'), 0o600); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'x.json');
  fs.writeFileSync(file, '{"secret":1}');
  fs.chmodSync(file, 0o000);
  assert.throws(() => readJsonStrict(file, 'fallback'), err => err instanceof CorruptedStateError && err.reason === 'permission');
});

test('loadOrRecover: recovers from the newest parseable backup and preserves the corrupt bytes', t => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'x.json');
  writeJsonAtomic(file, { generation: 1 }, { backups: 2 });
  writeJsonAtomic(file, { generation: 2 }, { backups: 2 }); // bak1 = generation 1
  fs.writeFileSync(file, '{"generation": 2, "oops'); // simulate interrupted/corrupting writer

  const result = loadOrRecover(file, { backups: 2 });
  assert.equal(result.recovered, true);
  assert.equal(result.source, 'backup:1');
  assert.deepEqual(result.value, { generation: 1 });
  // Primary re-materialized from backup, corrupt original kept for forensics.
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { generation: 1 });
  assert.ok(fs.existsSync(`${file}.corrupt`));
});

test('loadOrRecover: with no usable backup the original corruption error is rethrown', t => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'x.json');
  fs.writeFileSync(file, 'not json at all');
  fs.writeFileSync(backupFilePath(file, 1), 'also not json');
  assert.throws(() => loadOrRecover(file, { backups: 2 }), err => err instanceof CorruptedStateError && err.recoveryAttempted === true);
});

// ── durable store envelope, migration, CAS ───────────────────────────────────

test('durable store: envelope round-trip with monotonically increasing revisions', t => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = makeDurable(dir);

  assert.deepEqual(store.load(), { payload: [], revision: 0, version: 1, exists: false, recovered: false, source: 'fallback' });
  assert.equal(store.save(['a']).revision, 1);
  assert.equal(store.save(['a', 'b']).revision, 2);

  const doc = JSON.parse(fs.readFileSync(store._file, 'utf8'));
  assert.equal(doc.schema, 'cpr.test');
  assert.equal(doc.version, 1);
  assert.equal(doc.revision, 2);
  assert.deepEqual(doc.items, ['a', 'b']);
  assert.ok(fs.existsSync(backupFilePath(store._file, 1)), 'rolling backup written');
});

test('durable store: legacy bare documents migrate and unrecognized shapes fail closed', t => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = makeDurable(dir);

  fs.writeFileSync(store._file, JSON.stringify(['legacy-item']));
  let loaded = store.load();
  assert.deepEqual(loaded.payload, ['legacy-item']);
  assert.equal(loaded.revision, 0);

  fs.writeFileSync(store._file, JSON.stringify({ items: ['wrapped'] }));
  loaded = store.load();
  assert.deepEqual(loaded.payload, ['wrapped']);

  // Valid JSON but a shape neither the envelope nor migrateLegacy recognizes
  // must NOT silently become the default payload (that would erase data on the
  // next write).
  fs.writeFileSync(store._file, JSON.stringify({ compltely: 'different' }));
  assert.throws(() => store.load(), err => err instanceof CorruptedStateError && err.reason === 'invalid');
});

test('durable store: a newer schema version on disk fails closed', t => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = makeDurable(dir);
  fs.writeFileSync(store._file, JSON.stringify({ schema: 'cpr.test', version: 99, revision: 5, items: [] }));
  assert.throws(() => store.load(), err => err instanceof CorruptedStateError);
});

test('durable store: save({ expectedRevision }) rejects stale writers with a 409-shaped error', t => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = makeDurable(dir);
  store.save(['base']);
  const { revision } = store.load();

  // Writer B commits first…
  store.save(['base', 'b'], { expectedRevision: revision });
  // …so writer A's snapshot revision is now stale.
  assert.throws(
    () => store.save(['base', 'a'], { expectedRevision: revision }),
    err => err instanceof RevisionConflictError && err.statusCode === 409 && err.code === 'CPR_REVISION_CONFLICT'
  );
  assert.deepEqual(store.load().payload, ['base', 'b'], 'stale write did not clobber');
});

test('durable store: corrupt primary recovers from rolling backup transparently on load', t => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = makeDurable(dir);
  store.save(['gen1']);
  store.save(['gen2']); // bak1 = gen1 envelope
  fs.writeFileSync(store._file, JSON.stringify({ schema: 'cpr.test', revision: 3 }).slice(0, 20)); // torn write

  const loaded = store.load();
  assert.equal(loaded.recovered, true);
  assert.deepEqual(loaded.payload, ['gen1']);
  // And the store keeps working after recovery.
  assert.equal(store.save([...loaded.payload, 'gen3']).revision, 2);
});

test('durable store: leftover tmp files from an interrupted writer are ignored', t => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = makeDurable(dir);
  store.save(['ok']);
  fs.writeFileSync(path.join(dir, '.data.json.12345.deadbeef.tmp'), '{"partial":');
  assert.deepEqual(store.load().payload, ['ok']);
});

// ── locking ──────────────────────────────────────────────────────────────────

test('file lock: stale lock from a dead process is recovered, not wedged forever', t => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = makeDurable(dir, { lockTimeoutMs: 2000 });
  // Fabricate a lock owned by a dead pid on this host.
  fs.writeFileSync(store._lockFile, JSON.stringify({ pid: 999999999, hostname: os.hostname(), owner: 'crashed', token: 'x', acquiredAt: Date.now() }));
  assert.equal(store.save(['recovered']).revision, 1);
  assert.ok(!fs.existsSync(store._lockFile), 'lock released after use');
});

test('file lock: unreadable/foreign lock falls back to age-based staleness', t => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = makeDurable(dir, { lockTimeoutMs: 2000, lockStaleMs: 50 });
  fs.writeFileSync(store._lockFile, 'garbage not json');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(store._lockFile, past, past);
  assert.equal(store.save(['stole-stale-garbage-lock']).revision, 1);
});

test('file lock: a live holder makes contenders time out with holder identity', t => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = makeDurable(dir, { lockTimeoutMs: 150, lockStaleMs: 60_000 });
  const lock = acquireFileLock(store._lockFile, { owner: 'holder-test' });
  try {
    assert.throws(
      () => store.save(['blocked']),
      err => err instanceof LockTimeoutError && err.code === 'CPR_LOCK_TIMEOUT' && err.statusCode === 503
        && err.holder && err.holder.pid === process.pid && err.holder.owner === 'holder-test'
    );
  } finally { lock.release(); }
  assert.equal(store.save(['after-release']).revision, 1, 'lock usable after release');
});

test('file lock: release only removes a lock this handle still owns', t => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lockFile = path.join(dir, 'x.lock');
  const lock = acquireFileLock(lockFile, { owner: 'a' });
  // Simulate a stale takeover: another process replaced the lock content.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, hostname: os.hostname(), owner: 'b', token: 'other', acquiredAt: Date.now() }));
  lock.release();
  assert.ok(fs.existsSync(lockFile), 'foreign lock left intact');
  fs.rmSync(lockFile);
});

// ── cross-process concurrency (real child processes) ─────────────────────────

test('concurrent multi-process writers: no lost updates on the provider store', async t => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, 'providers.json');
  const script = `
    const { createStore } = require(${JSON.stringify(path.join(root, 'lib', 'store.js'))});
    const store = createStore({ dataFile: ${JSON.stringify(dataFile)}, cprHome: ${JSON.stringify(dir)} });
    const tag = process.env.CPR_TEST_WRITER_TAG;
    for (let i = 0; i < 8; i++) {
      store.createProvider({ appType: 'claude', name: 'p-' + tag + '-' + i, baseUrl: 'https://x.example', authToken: 'sk-' + tag + i });
    }
  `;
  const children = [];
  for (let w = 0; w < 5; w++) {
    children.push(new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script], {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, CPR_TEST_WRITER_TAG: `w${w}` },
      });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`writer ${w} exited ${code}`)));
    }));
  }
  await Promise.all(children);

  const store = createStore({ dataFile, cprHome: dir });
  const names = store.loadStore().map(p => p.name);
  assert.equal(names.length, 40, `expected 40 providers, got ${names.length}`);
  assert.equal(new Set(names).size, 40, 'all names distinct — no clobbered batches');
});

// ── the three config stores share the durable semantics ──────────────────────

test('provider store: corrupt providers.json fails closed and legacy shapes still load', t => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, 'providers.json');

  // Legacy bare array (0.2-era shape).
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify([{ id: 'p1', appType: 'claude', name: 'Legacy', settingsConfig: { env: {} } }]));
  const store = createStore({ dataFile, cprHome: dir });
  assert.equal(store.getProvider('claude', 'p1').name, 'Legacy');

  // First write upgrades to the envelope while keeping the provider.
  store.createProvider({ appType: 'claude', name: 'New', baseUrl: 'https://x.example', authToken: 'sk-1' });
  const doc = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(doc.schema, 'cpr.providers');
  assert.equal(doc.providers.length, 2);
  assert.ok(doc.providers.some(p => p.id === 'p1'));

  // Corruption now fails closed instead of pretending the store is empty.
  fs.writeFileSync(dataFile, '{"providers": [ {"id": "p1"');
  fs.rmSync(`${dataFile}.bak1`, { force: true });
  fs.rmSync(`${dataFile}.bak2`, { force: true });
  assert.throws(() => store.listProviders('claude'), err => err instanceof CorruptedStateError);
});

test('route profile store: legacy documents migrate, corruption fails closed, CRUD shape unchanged', t => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, 'route-profiles.json');
  fs.writeFileSync(dataFile, JSON.stringify({ version: 1, profiles: [{ id: 'rp1', name: 'Old', cli: 'claude', enabled: true, roles: {} }] }));

  const store = createRouteProfileStore({ dataFile, cprHome: dir });
  assert.equal(store.get('rp1').name, 'Old');

  const created = store.create({ name: 'Fresh', cli: 'codex', main: { providerId: 'prov-1' }, roles: {} });
  assert.ok(created.id);
  assert.equal(store.list().length, 2);
  assert.equal(store.update(created.id, { name: 'Fresh2' }).name, 'Fresh2');
  assert.equal(store.remove(created.id), true);
  assert.equal(store.remove(created.id), false);

  const doc = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(doc.schema, 'cpr.route-profiles');
  assert.ok(Array.isArray(doc.profiles));

  fs.writeFileSync(dataFile, 'garbled{{{');
  fs.rmSync(`${dataFile}.bak1`, { force: true });
  fs.rmSync(`${dataFile}.bak2`, { force: true });
  assert.throws(() => store.list(), err => err instanceof CorruptedStateError);
});

test('settings store: legacy bare object migrates, defaults still apply, corruption fails closed', t => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, 'settings.json');
  fs.writeFileSync(dataFile, JSON.stringify({ theme: 'dark' }));

  const store = createSettingsStore({ dataFile, cprHome: dir, defaults: { theme: 'light', locale: 'en' } });
  assert.deepEqual(store.getAll(), { theme: 'dark', locale: 'en' });

  const next = store.update({ locale: 'zh' });
  assert.equal(next.theme, 'dark');
  assert.equal(next.locale, 'zh');
  const doc = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(doc.schema, 'cpr.settings');
  assert.equal(doc.settings.locale, 'zh');

  fs.writeFileSync(dataFile, '[1,2,3]'); // valid JSON, invalid settings shape
  fs.rmSync(`${dataFile}.bak1`, { force: true });
  fs.rmSync(`${dataFile}.bak2`, { force: true });
  assert.throws(() => store.getAll(), err => err instanceof CorruptedStateError && err.reason === 'invalid');
});

test('settings store: backup recovery keeps settings usable after a torn write', t => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, 'settings.json');
  const store = createSettingsStore({ dataFile, cprHome: dir });
  store.update({ a: 1 });
  store.update({ b: 2 }); // bak1 = { a:1 } envelope
  fs.writeFileSync(dataFile, '{"schema": "cpr.settings", "re'); // torn write
  assert.deepEqual(store.getAll(), { a: 1 }, 'recovered previous generation');
});
