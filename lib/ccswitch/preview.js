'use strict';

const { openDatabase } = require('./common');
const { discover } = require('./discover');
const { inspectChanges } = require('./operations');
const { collectTargets } = require('./plan');
const { readSnapshot } = require('./snapshot');

function preview(options = {}) {
  if (!options.proxyBaseUrl) throw new Error('proxyBaseUrl is required');
  const info = discover(options);
  if (!info.found || !info.supported) return { ...info, changes: [] };
  let sourcePath = info.dbPath;
  if (options.snapshotId) sourcePath = readSnapshot(options.home, options.snapshotId).backupPath;
  const source = openDatabase(sourcePath, { readonly: true, fileMustExist: true });
  let planned;
  try { planned = collectTargets(source, options.proxyBaseUrl); } finally { source.close(); }
  const live = openDatabase(info.dbPath, { readonly: true, fileMustExist: true });
  let changes;
  try { changes = inspectChanges(live, planned.changes); } finally { live.close(); }
  return {
    dbPath: info.dbPath,
    snapshotId: options.snapshotId || null,
    proxyBaseUrl: options.proxyBaseUrl,
    liveTakeoverActive: info.liveTakeoverActive,
    canApply: !info.liveTakeoverActive && !planned.warnings.some(item => item.code === 'local-upstream-loop') && changes.every(item => ['original', 'applied'].includes(item.condition)),
    changes,
    warnings: planned.warnings,
  };
}

module.exports = { preview };
