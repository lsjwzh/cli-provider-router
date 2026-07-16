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

function collectTargets(db, proxyBaseUrl) {
  const changes = [];
  const warnings = [];
  const rows = db.prepare("SELECT id, app_type, settings_config FROM providers WHERE app_type IN ('claude','codex') ORDER BY app_type,id").all();
  for (const row of rows) {
    if (!SUPPORTED_APP_TYPES.has(row.app_type)) continue;
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
  return { changes, warnings };
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

module.exports = { collectTargets, endpointMap };
