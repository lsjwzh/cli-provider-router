'use strict';

// better-sqlite3 loads its native binding lazily. A successful require() is
// therefore not proof that the package can open a database for the current
// Node ABI. Keep all probing and error sanitisation here so callers never leak
// node-gyp/bindings search paths to CLI or Web users.

const REPAIR_COMMAND = 'npm rebuild better-sqlite3';
const SAFE_MESSAGE = 'SQLite support is unavailable for this Node.js runtime. Reinstall optional dependencies or rebuild better-sqlite3, then retry.';

function sqliteUnavailableError(reason = 'native-binding-unavailable') {
  const error = new Error(SAFE_MESSAGE);
  error.code = 'SQLITE_UNAVAILABLE';
  error.statusCode = 503;
  error.reason = reason;
  error.repair = REPAIR_COMMAND;
  return error;
}

function unavailableStatus(reason) {
  return {
    available: false,
    code: 'SQLITE_UNAVAILABLE',
    reason,
    message: SAFE_MESSAGE,
    repair: REPAIR_COMMAND,
  };
}

function createSqliteRuntime(options = {}) {
  const load = options.load || (() => require('better-sqlite3'));
  let Database;

  function loadDatabase() {
    if (Database) return Database;
    try {
      const loaded = load();
      if (typeof loaded !== 'function') throw new TypeError('invalid better-sqlite3 export');
      Database = loaded;
      return Database;
    } catch (_) {
      throw sqliteUnavailableError('module-unavailable');
    }
  }

  function probe() {
    let DB;
    try { DB = loadDatabase(); }
    catch (error) { return unavailableStatus(error.reason || 'module-unavailable'); }

    let db;
    try {
      db = new DB(':memory:');
      db.prepare('SELECT 1 AS ok').get();
      return { available: true, code: null, reason: null, message: null, repair: null };
    } catch (_) {
      return unavailableStatus('native-binding-unavailable');
    } finally {
      try { if (db) db.close(); } catch (_) {}
    }
  }

  function requireDatabase() {
    const status = probe();
    if (!status.available) throw sqliteUnavailableError(status.reason);
    return Database;
  }

  function openDatabase(filename, openOptions = {}) {
    let DB;
    try { DB = loadDatabase(); }
    catch (error) { throw sqliteUnavailableError(error.reason || 'module-unavailable'); }

    try {
      return new DB(filename, openOptions);
    } catch (error) {
      // Opening a missing, locked or malformed database is a database error,
      // not an installation failure. Probe an in-memory database to distinguish
      // those cases from a lazy native-binding failure.
      const status = probe();
      if (!status.available) throw sqliteUnavailableError(status.reason);
      throw error;
    }
  }

  return { openDatabase, probe, requireDatabase };
}

const runtime = createSqliteRuntime();

module.exports = {
  REPAIR_COMMAND,
  SAFE_MESSAGE,
  createSqliteRuntime,
  openSqliteDatabase: runtime.openDatabase,
  requireSqliteDatabase: runtime.requireDatabase,
  sqliteRuntimeStatus: runtime.probe,
  sqliteUnavailableError,
};
