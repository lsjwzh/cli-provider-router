'use strict';

const fs = require('fs');
const path = require('path');
const { openDatabase, sha256, tableColumns, tableExists } = require('./common');

// CPR intentionally supports only schemas we have verified against CC-Switch.
// New CC-Switch migrations must be reviewed and explicitly added here before
// CPR is allowed to write to their database.
const SUPPORTED_SCHEMAS = Object.freeze([{
  id: 'cc-switch-v11',
  userVersion: 11,
  tables: {
    providers: [
      'id', 'app_type', 'name', 'settings_config', 'website_url', 'category',
      'created_at', 'sort_index', 'notes', 'icon', 'icon_color', 'meta',
      'is_current', 'in_failover_queue', 'cost_multiplier', 'limit_daily_usd',
      'limit_monthly_usd', 'provider_type',
    ],
    provider_endpoints: ['id', 'provider_id', 'app_type', 'url', 'added_at'],
    proxy_config: [
      'app_type', 'proxy_enabled', 'listen_address', 'listen_port',
      'enable_logging', 'enabled', 'auto_failover_enabled', 'max_retries',
      'streaming_first_byte_timeout', 'streaming_idle_timeout',
      'non_streaming_timeout', 'circuit_failure_threshold',
      'circuit_success_threshold', 'circuit_timeout_seconds',
      'circuit_error_rate_threshold', 'circuit_min_requests',
      'default_cost_multiplier', 'pricing_model_source', 'created_at',
      'updated_at', 'live_takeover_active',
    ],
  },
}]);

function sameColumns(actual, expected) {
  return actual.length === expected.length
    && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function schemaFingerprint(userVersion, tables) {
  const normalized = Object.fromEntries(Object.entries(tables)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, columns]) => [name, [...columns].sort()]));
  return sha256(JSON.stringify({ userVersion, tables: normalized }));
}

function databaseIdentity(dbPath, schema) {
  const realpath = fs.realpathSync.native ? fs.realpathSync.native(dbPath) : fs.realpathSync(dbPath);
  const stat = fs.statSync(realpath);
  return {
    realpath,
    device: stat.dev,
    inode: stat.ino,
    schemaProfile: schema.profile,
    userVersion: schema.userVersion,
    schemaFingerprint: schema.fingerprint,
  };
}

function identityMatches(expected, actual) {
  if (!expected || !actual) return false;
  return path.resolve(expected.realpath) === path.resolve(actual.realpath)
    && Number(expected.device) === Number(actual.device)
    && Number(expected.inode) === Number(actual.inode)
    && expected.schemaProfile === actual.schemaProfile
    && Number(expected.userVersion) === Number(actual.userVersion)
    && expected.schemaFingerprint === actual.schemaFingerprint;
}

function discover(options = {}) {
  const dbPath = options.dbPath;
  if (!dbPath) throw new Error('dbPath is required');
  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved)) return { found: false, dbPath: resolved, supported: false, issues: ['database-not-found'] };
  const db = openDatabase(resolved, { readonly: true, fileMustExist: true });
  try {
    const tables = {
      providers: tableColumns(db, 'providers'),
      provider_endpoints: tableColumns(db, 'provider_endpoints'),
      proxy_config: tableColumns(db, 'proxy_config'),
    };
    const userVersion = Number(db.pragma('user_version', { simple: true }));
    const matched = SUPPORTED_SCHEMAS.find(profile => profile.userVersion === userVersion
      && Object.entries(profile.tables).every(([name, columns]) => sameColumns(tables[name], columns)));
    const issues = [];
    if (!matched) issues.push(`schema-version-${userVersion}-not-allowlisted`);
    for (const name of Object.keys(tables)) if (!tableExists(db, name)) issues.push(`${name}-missing`);
    const hasTakeoverFlag = tables.proxy_config.includes('live_takeover_active');
    const liveTakeover = matched && hasTakeoverFlag
      ? db.prepare("SELECT app_type, live_takeover_active FROM proxy_config WHERE app_type IN ('claude','codex') AND live_takeover_active <> 0").all()
      : [];
    const counts = matched
      ? db.prepare("SELECT app_type, COUNT(*) AS count FROM providers WHERE app_type IN ('claude','codex') GROUP BY app_type").all()
      : [];
    const providers = matched
      ? db.prepare("SELECT id AS providerId, app_type AS appType, name FROM providers WHERE app_type IN ('claude','codex') ORDER BY app_type,name,id").all()
      : [];
    const schema = {
      profile: matched ? matched.id : null,
      userVersion,
      fingerprint: schemaFingerprint(userVersion, tables),
      tables,
      providersColumns: tables.providers,
      endpointColumns: tables.provider_endpoints,
      proxyColumns: tables.proxy_config,
      hasProviderEndpoints: !!matched,
      hasTakeoverFlag,
    };
    const result = {
      found: true,
      dbPath: resolved,
      supported: !!matched && issues.length === 0,
      issues,
      schema,
      liveTakeoverActive: liveTakeover.length > 0,
      liveTakeoverApps: liveTakeover.map(row => row.app_type),
      providerCounts: Object.fromEntries(counts.map(row => [row.app_type, row.count])),
      providers,
    };
    if (result.supported) result.databaseIdentity = databaseIdentity(resolved, schema);
    return result;
  } finally { db.close(); }
}

module.exports = {
  SUPPORTED_SCHEMAS,
  databaseIdentity,
  discover,
  identityMatches,
  schemaFingerprint,
};
