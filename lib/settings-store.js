'use strict';

const { createCprPaths, ensureCprPaths } = require('./paths');
const { createDurableStore } = require('./durable-store');

function createSettingsStore(options = {}) {
  const paths = ensureCprPaths(options.paths || createCprPaths({ home: options.cprHome }));
  const dataFile = options.dataFile || paths.settingsFile;
  const defaults = { ...(options.defaults || {}) };

  // Durable layer: fail-closed reads (corruption raises CorruptedStateError
  // instead of silently returning defaults and then overwriting user settings),
  // schema envelope, rolling backups, cross-process write lock. A legacy bare
  // settings object migrates into the envelope on the next update.
  const durable = createDurableStore({
    file: dataFile,
    schemaName: 'cpr.settings',
    schemaVersion: 1,
    payloadKey: 'settings',
    defaultPayload: {},
    owner: 'cpr:settings',
    migrateLegacy(raw) {
      if (raw === null) return {};
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
      return undefined;
    },
  });

  function getAll() {
    return { ...defaults, ...durable.load().payload };
  }
  function update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('settings patch must be an object');
    return durable.mutate(current => {
      const next = { ...defaults, ...current, ...patch };
      return { next, result: { ...next } };
    }).result;
  }
  return { getAll, get: getAll, update, setAll: value => update(value), _dataFile: dataFile };
}

module.exports = { createSettingsStore };
