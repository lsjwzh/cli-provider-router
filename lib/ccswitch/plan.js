'use strict';

const {
  SUPPORTED_APP_TYPES,
  listTomlBaseUrls,
  localProviderUrl,
  normalizeProxyBaseUrl,
  parseSettings,
  sha256,
  tableExists,
} = require('./common');

function providerKey(appType, providerId) { return `${appType}\0${providerId}`; }

function normalizeSelection(input, available, options = {}) {
  if (options.allProviders) {
    if (options.requireAllConfirmation && options.confirmAllProviders !== 'TAKE OVER ALL PROVIDERS') {
      const error = new Error('all-provider takeover requires confirmAllProviders="TAKE OVER ALL PROVIDERS"');
      error.code = 'ALL_PROVIDERS_CONFIRMATION_REQUIRED';
      throw error;
    }
    return new Set(available);
  }
  if (!Array.isArray(input) || input.length === 0) {
    const error = new Error('select at least one explicit CC-Switch provider');
    error.code = 'PROVIDER_SELECTION_REQUIRED';
    throw error;
  }
  const selected = new Set();
  for (const item of input) {
    const appType = String(item && item.appType || '').toLowerCase();
    const providerId = String(item && item.providerId || '');
    if (!SUPPORTED_APP_TYPES.has(appType) || !providerId) {
      const error = new Error('each selected provider requires appType=claude|codex and providerId');
      error.code = 'INVALID_PROVIDER_SELECTION';
      throw error;
    }
    selected.add(providerKey(appType, providerId));
  }
  const missing = [...selected].filter(key => !available.has(key));
  if (missing.length) {
    const error = new Error(`selected provider does not exist in snapshot: ${missing.map(key => key.replace('\0', ':')).join(', ')}`);
    error.code = 'PROVIDER_SELECTION_NOT_FOUND';
    error.missing = missing;
    throw error;
  }
  if (options.requireAllConfirmation && selected.size === available.size
      && options.confirmAllProviders !== 'TAKE OVER ALL PROVIDERS') {
    const error = new Error('selecting every provider requires confirmAllProviders="TAKE OVER ALL PROVIDERS"');
    error.code = 'ALL_PROVIDERS_CONFIRMATION_REQUIRED';
    throw error;
  }
  return selected;
}

function collectTargets(db, proxyBaseUrl, options = {}) {
  const changes = [];
  const warnings = [];
  const rows = db.prepare("SELECT id, app_type, settings_config FROM providers WHERE app_type IN ('claude','codex') ORDER BY app_type,id").all();
  const available = new Set(rows.map(row => providerKey(row.app_type, row.id)));
  const selected = options.requireSelection || options.selectedProviders || options.allProviders
    ? normalizeSelection(options.selectedProviders, available, options)
    : available;
  for (const row of rows) {
    if (!SUPPORTED_APP_TYPES.has(row.app_type)) continue;
    if (!selected.has(providerKey(row.app_type, row.id))) continue;
    const settings = parseSettings(row.settings_config);
    if (!settings) {
      warnings.push({ code: 'invalid-settings-json', providerId: row.id, appType: row.app_type });
      continue;
    }
    const applied = proxyBaseUrl ? localProviderUrl(proxyBaseUrl, row.app_type, row.id) : null;
    if (row.app_type === 'claude') {
      const original = settings.env && settings.env.ANTHROPIC_BASE_URL;
      if (typeof original === 'string' && original) {
        changes.push({ kind: 'provider-setting', providerId: row.id, appType: row.app_type, field: 'env.ANTHROPIC_BASE_URL', occurrence: 0, original, applied });
      }
    } else if (typeof settings.config === 'string') {
      for (const entry of listTomlBaseUrls(settings.config)) {
        changes.push({ kind: 'provider-setting', providerId: row.id, appType: row.app_type, field: 'config.base_url', occurrence: entry.occurrence, original: entry.value, applied });
      }
    }
  }

  if (tableExists(db, 'provider_endpoints')) {
    for (const row of db.prepare("SELECT id, provider_id, app_type, url FROM provider_endpoints WHERE app_type IN ('claude','codex') ORDER BY id").all()) {
      if (!selected.has(providerKey(row.app_type, row.provider_id))) continue;
      changes.push({
        kind: 'provider-endpoint', rowId: row.id, providerId: row.provider_id, appType: row.app_type,
        field: 'url', original: row.url,
        applied: proxyBaseUrl ? localProviderUrl(proxyBaseUrl, row.app_type, row.provider_id, row.id) : null,
      });
    }
  }
  if (proxyBaseUrl) {
    const localPrefix = `${normalizeProxyBaseUrl(proxyBaseUrl)}/ccswitch/`;
    for (const change of changes) {
      if (change.original === change.applied || String(change.original).startsWith(localPrefix)) {
        warnings.push({ code: 'local-upstream-loop', providerId: change.providerId, appType: change.appType, kind: change.kind, rowId: change.rowId });
      }
    }
  }
  return {
    changes,
    warnings,
    selectedProviders: [...selected].map(key => {
      const [appType, providerId] = key.split('\0');
      return { appType, providerId };
    }),
    allProviders: selected.size === available.size,
    availableProviderCount: available.size,
  };
}

function endpointMap(changes) {
  return changes.map(change => ({
    kind: change.kind,
    rowId: change.rowId,
    providerId: change.providerId,
    appType: change.appType,
    field: change.field,
    occurrence: change.occurrence,
    upstream: change.original,
    upstreamHash: sha256(change.original),
  }));
}

module.exports = { collectTargets, endpointMap, normalizeSelection, providerKey };
