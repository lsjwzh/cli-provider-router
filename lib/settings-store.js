'use strict';

const { createCprPaths, ensureCprPaths } = require('./paths');
const { readJson, writeJsonAtomic } = require('./atomic-json');

function createSettingsStore(options = {}) {
  const paths = ensureCprPaths(options.paths || createCprPaths({ home: options.cprHome }));
  const dataFile = options.dataFile || paths.settingsFile;
  const defaults = { ...(options.defaults || {}) };
  function getAll() {
    const value = readJson(dataFile, {});
    return { ...defaults, ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {}) };
  }
  function update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('settings patch must be an object');
    const next = { ...getAll(), ...patch };
    writeJsonAtomic(dataFile, next);
    return next;
  }
  return { getAll, get: getAll, update, setAll: value => update(value), _dataFile: dataFile };
}

module.exports = { createSettingsStore };
