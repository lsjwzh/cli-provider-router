'use strict';

const { discover } = require('./discover');
const { openDatabase, readJson, statePath } = require('./common');
const { inspectChanges } = require('./operations');
const path = require('path');

function status(options = {}) {
  const state = readJson(statePath(options.home));
  const info = discover(options);
  if (!state || !state.changes) return { ...info, takeover: 'inactive', managed: false, state: null, changes: [] };
  if (state.dbPath && path.resolve(state.dbPath) !== path.resolve(options.dbPath)) {
    return { ...info, takeover: 'conflict', managed: true, state, changes: [], conflictCount: 1, dbMismatch: true };
  }
  if (!info.found || !info.supported) return { ...info, takeover: 'unavailable', managed: true, state, changes: [] };
  const db = openDatabase(info.dbPath, { readonly: true, fileMustExist: true });
  let changes;
  try { changes = inspectChanges(db, state.changes); } finally { db.close(); }
  const conditions = new Set(changes.map(item => item.condition));
  let takeover = 'conflict';
  if (changes.length === 0 || [...conditions].every(item => item === 'original')) takeover = 'restored';
  else if ([...conditions].every(item => item === 'applied')) takeover = 'active';
  return { ...info, takeover, managed: true, state, changes, conflictCount: changes.filter(item => !['original', 'applied'].includes(item.condition)).length };
}

module.exports = { status };
