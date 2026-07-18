'use strict';

const { appendAudit } = require('./audit');
const { discover } = require('./discover');
const { assertProxyHealthy } = require('./health');
const { inspectChanges, mutate } = require('./operations');
const { collectTargets } = require('./plan');
const { assertSnapshotIdentity, readSnapshot, snapshot } = require('./snapshot');
const { normalizeProxyBaseUrl, openDatabase, sha256 } = require('./common');
const { status } = require('./status');
const { createTakeoverStateStore } = require('../takeover-state');

async function inject(options, stage, context = {}) {
  if (typeof options.faultInjector === 'function') await options.faultInjector(stage, context);
}

async function apply(options = {}) {
  if (!options.dbPath) throw new Error('dbPath is required');
  if (!options.proxyBaseUrl) throw new Error('proxyBaseUrl is required');
  const proxyBaseUrl = normalizeProxyBaseUrl(options.proxyBaseUrl);
  const info = discover(options);
  if (!info.found || !info.supported) throw Object.assign(new Error('Unsupported CC-Switch database'), { code: 'UNSUPPORTED_SCHEMA', discovery: info });
  if (info.liveTakeoverActive) {
    const error = new Error(`CC-Switch Local Routing is active for: ${info.liveTakeoverApps.join(', ')}`);
    error.code = 'DOUBLE_PROXY';
    throw error;
  }

  await inject(options, 'before-health', { dbPath: info.dbPath, proxyBaseUrl });
  const health = await assertProxyHealthy(options);
  await inject(options, 'after-health', health);

  const states = createTakeoverStateStore(options.home);
  const existing = states.ccSwitch().state;
  if (existing && !['restored', 'full-restored'].includes(existing.status)) {
    const current = status(options);
    if (current.takeover === 'active' && current.state.proxyBaseUrl === proxyBaseUrl) {
      if (existing.status !== 'active') {
        const recovered = { ...existing, status: 'active', recoveredAt: new Date().toISOString() };
        states.writeCcSwitch(recovered);
        appendAudit(options.home, 'takeover.recovered', { snapshotId: existing.snapshotId, dbPath: info.dbPath });
      }
      return { alreadyActive: true, snapshotId: existing.snapshotId, changed: 0, status: current };
    }
    const error = new Error('An existing CPR takeover is active or has drifted; restore it before applying again');
    error.code = 'ACTIVE_TAKEOVER_CONFLICT';
    error.status = current;
    throw error;
  }

  const snap = options.snapshotId ? readSnapshot(options.home, options.snapshotId) : await snapshot(options);
  const manifest = snap.manifest || snap;
  assertSnapshotIdentity(manifest, info);
  await inject(options, 'after-snapshot', { snapshotId: manifest.snapshotId });

  const source = openDatabase(snap.backupPath, { readonly: true, fileMustExist: true });
  let plan;
  try {
    plan = collectTargets(source, proxyBaseUrl, {
      requireSelection: true,
      selectedProviders: options.selectedProviders,
      allProviders: !!options.allProviders,
      requireAllConfirmation: true,
      confirmAllProviders: options.confirmAllProviders,
    });
  } finally { source.close(); }
  if (plan.warnings.some(item => item.code === 'local-upstream-loop')) {
    const error = new Error('Snapshot contains CPR-local endpoints and cannot be used as upstream');
    error.code = 'UPSTREAM_LOOP';
    error.warnings = plan.warnings;
    throw error;
  }
  if (plan.changes.length === 0) {
    const error = new Error('selected providers have no supported endpoint fields');
    error.code = 'NO_MANAGED_ENDPOINTS';
    throw error;
  }

  const preflightDb = openDatabase(info.dbPath, { readonly: true, fileMustExist: true });
  let preflight;
  try { preflight = inspectChanges(preflightDb, plan.changes); } finally { preflightDb.close(); }
  const conflicts = preflight.filter(item => item.condition !== 'original');
  if (conflicts.length) {
    const error = new Error(`CC-Switch configuration changed after snapshot in ${conflicts.length} field(s)`);
    error.code = 'CONFIG_DRIFT';
    error.conflicts = conflicts;
    throw error;
  }

  const pendingState = {
    version: 2,
    status: 'applying',
    snapshotId: manifest.snapshotId,
    dbPath: info.databaseIdentity.realpath,
    databaseIdentity: info.databaseIdentity,
    proxyBaseUrl,
    healthNonceSha256: sha256(options.healthNonce),
    applyingAt: new Date().toISOString(),
    selectedProviders: plan.selectedProviders,
    allProviders: plan.allProviders,
    changes: plan.changes,
    warnings: plan.warnings,
  };
  states.writeCcSwitch(pendingState);
  await inject(options, 'before-transaction', { state: pendingState });

  const live = openDatabase(info.dbPath, { fileMustExist: true });
  let result;
  try { result = mutate(live, plan.changes, 'apply'); }
  catch (error) {
    states.writeCcSwitch({ ...pendingState, status: 'rollback-required', failedAt: new Date().toISOString(), failureCode: error.code || 'APPLY_FAILED' });
    throw error;
  } finally { live.close(); }
  await inject(options, 'after-commit', { result, state: pendingState });

  const verifyDb = openDatabase(info.dbPath, { readonly: true, fileMustExist: true });
  let verification;
  try { verification = inspectChanges(verifyDb, plan.changes); } finally { verifyDb.close(); }
  const mismatches = verification.filter(item => item.condition !== 'applied');
  if (mismatches.length) {
    const failed = { ...pendingState, status: 'rollback-required', failedAt: new Date().toISOString(), failureCode: 'POST_COMMIT_VERIFICATION_FAILED' };
    states.writeCcSwitch(failed);
    const error = new Error(`post-commit verification failed for ${mismatches.length} endpoint field(s)`);
    error.code = 'POST_COMMIT_VERIFICATION_FAILED';
    error.mismatches = mismatches;
    throw error;
  }
  await inject(options, 'after-verification', { verification });

  const state = {
    ...pendingState,
    status: 'active',
    appliedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
  };
  delete state.applyingAt;
  states.writeCcSwitch(state);
  appendAudit(options.home, 'takeover.applied', {
    snapshotId: state.snapshotId,
    dbPath: info.dbPath,
    proxyBaseUrl,
    changed: result.changed,
    selectedProviders: state.selectedProviders,
  });
  return { ...result, alreadyActive: false, snapshotId: state.snapshotId, state };
}

module.exports = { apply };
