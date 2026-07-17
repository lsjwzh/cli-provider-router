'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createSqliteRuntime,
  openSqliteDatabase,
  sqliteRuntimeStatus,
} = require('../lib/sqlite-runtime');

test('runtime probe constructs a database and retries after a lazy-binding failure', () => {
  let attempts = 0;
  function LazyDatabase() {
    attempts += 1;
    if (attempts === 1) throw new Error('Could not locate the bindings file: /private/native/better_sqlite3.node');
    this.prepare = () => ({ get: () => ({ ok: 1 }) });
    this.close = () => {};
  }
  const runtime = createSqliteRuntime({ load: () => LazyDatabase });
  const first = runtime.probe();
  assert.equal(first.available, false);
  assert.equal(first.reason, 'native-binding-unavailable');
  assert.equal(first.repair, 'npm rebuild better-sqlite3');
  assert.doesNotMatch(first.message, /bindings file|private\/native/i);

  const second = runtime.probe();
  assert.equal(second.available, true);
  assert.equal(attempts, 2, 'a failed native probe must not be cached');
});

test('constructor failure is reported as sanitized SQLITE_UNAVAILABLE', () => {
  function BrokenDatabase() {
    throw new Error('Could not locate the bindings file: /secret/build/Release/better_sqlite3.node');
  }
  const runtime = createSqliteRuntime({ load: () => BrokenDatabase });
  assert.throws(() => runtime.openDatabase('/tmp/cc-switch.db'), error => {
    assert.equal(error.code, 'SQLITE_UNAVAILABLE');
    assert.equal(error.statusCode, 503);
    assert.equal(error.repair, 'npm rebuild better-sqlite3');
    assert.doesNotMatch(error.message, /bindings file|secret\/build/i);
    return true;
  });
});

test('real SQLite probe and open work, while ordinary database errors stay database errors', t => {
  const status = sqliteRuntimeStatus();
  if (!status.available) {
    t.skip('optional better-sqlite3 runtime is unavailable');
    return;
  }
  const db = openSqliteDatabase(':memory:');
  try { assert.deepEqual(db.prepare('SELECT 1 AS ok').get(), { ok: 1 }); }
  finally { db.close(); }

  const missing = path.join(os.tmpdir(), `cpr-missing-${process.pid}-${Date.now()}.db`);
  assert.throws(
    () => openSqliteDatabase(missing, { readonly: true, fileMustExist: true }),
    error => error.code !== 'SQLITE_UNAVAILABLE',
  );
});
