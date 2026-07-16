'use strict';

const fs = require('fs');
const { openDatabase, tableColumns, tableExists } = require('./common');

function discover(options = {}) {
  const dbPath = options.dbPath;
  if (!dbPath) throw new Error('dbPath is required');
  const resolved = require('path').resolve(dbPath);
  if (!fs.existsSync(resolved)) return { found: false, dbPath: resolved, supported: false, issues: ['database-not-found'] };
  const db = openDatabase(resolved, { readonly: true, fileMustExist: true });
  try {
    const providersColumns = tableColumns(db, 'providers');
    const endpointColumns = tableColumns(db, 'provider_endpoints');
    const proxyColumns = tableColumns(db, 'proxy_config');
    const issues = [];
    for (const col of ['id', 'app_type', 'settings_config']) {
      if (!providersColumns.includes(col)) issues.push(`providers.${col}-missing`);
    }
    const hasProviderEndpoints = ['id', 'provider_id', 'app_type', 'url'].every(col => endpointColumns.includes(col));
    if (tableExists(db, 'provider_endpoints') && !hasProviderEndpoints) issues.push('provider_endpoints-schema-unsupported');
    const hasTakeoverFlag = proxyColumns.includes('live_takeover_active');
    if (!hasTakeoverFlag) issues.push('proxy_config.live_takeover_active-missing');
    const liveTakeover = hasTakeoverFlag
      ? db.prepare("SELECT app_type, live_takeover_active FROM proxy_config WHERE app_type IN ('claude','codex') AND live_takeover_active <> 0").all()
      : [];
    const counts = tableExists(db, 'providers') && issues.length === 0
      ? db.prepare("SELECT app_type, COUNT(*) AS count FROM providers WHERE app_type IN ('claude','codex') GROUP BY app_type").all()
      : [];
    return {
      found: true,
      dbPath: resolved,
      supported: issues.length === 0,
      issues,
      schema: { providersColumns, endpointColumns, proxyColumns, hasProviderEndpoints, hasTakeoverFlag },
      liveTakeoverActive: liveTakeover.length > 0,
      liveTakeoverApps: liveTakeover.map(row => row.app_type),
      providerCounts: Object.fromEntries(counts.map(row => [row.app_type, row.count])),
    };
  } finally { db.close(); }
}

module.exports = { discover };
