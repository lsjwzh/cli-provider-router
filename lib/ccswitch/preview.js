'use strict';

const { openDatabase } = require('./common');
const { discover } = require('./discover');
const { inspectChanges } = require('./operations');
const { collectTargets } = require('./plan');
const { assertSnapshotIdentity, readSnapshot } = require('./snapshot');

function preview(options = {}) {
  if (!options.proxyBaseUrl) throw new Error('proxyBaseUrl is required');
  const info = discover(options);
  if (!info.found || !info.supported) return { ...info, changes: [] };
  let sourcePath = info.dbPath;
  if (options.snapshotId) {
    const saved = readSnapshot(options.home, options.snapshotId);
    assertSnapshotIdentity(saved.manifest, info);
    sourcePath = saved.backupPath;
  }
  const source = openDatabase(sourcePath, { readonly: true, fileMustExist: true });
  let planned;
  try {
    planned = collectTargets(source, options.proxyBaseUrl, {
      requireSelection: true,
      selectedProviders: options.selectedProviders,
      allProviders: !!options.allProviders,
    });
  } finally { source.close(); }
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
    selectedProviders: planned.selectedProviders,
    allProviders: planned.allProviders,
    availableProviderCount: planned.availableProviderCount,
  };
}

module.exports = { preview };
