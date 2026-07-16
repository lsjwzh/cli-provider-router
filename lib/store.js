'use strict';

// store.js — provider config management (CRUD + cc-switch import) for
// cli-provider-router.
//
// Migrated from multicc's src/providers.js. The original was a module-level
// singleton that operated on a hard-coded STORE_FILE under the multicc project
// dir. Here it is decoupled: createStore(opts) returns an instance whose methods
// close over a configurable dataFile + cc-switch db path. All state lives in
// that one providers.json — no token stats, no sessions file (those multicc
// concerns were dropped during migration).
//
// A provider's `settingsConfig` mirrors cc-switch's shape so the spawn-env
// logic is uniform: claude → { env: { ANTHROPIC_* } }, codex → { auth,
// config(toml) }. cli-provider-router spawns one child per invocation, so a
// session routes to a different provider simply by injecting that provider's
// env into its own child — siblings stay independent.

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { createCprPaths, ensureCprPaths } = require('./paths');
const { readJson, writeJsonAtomic } = require('./atomic-json');

const {
  APP_TYPES,
  ALIAS_TIER_KEYS,
  WIRE_DEFAULT_MODEL,
  DOMESTIC_PROXY_MAP,
  RESPONSES_COMPAT_PROXY_MAP,
  resolveCcDb,
  DEFAULT_PROXY_PORT,
} = require('./constants');

// better-sqlite3 is only needed for the cc-switch import path — most users
// never touch it, so load lazily and tolerate its absence.
let Database;
try { Database = require('better-sqlite3'); } catch (_) { Database = null; }

function ensureDatabase() {
  return !!Database;
}

function nativeBuildHint() {
  switch (process.platform) {
    case 'darwin':
      return '  xcode-select --install';
    case 'win32':
      return '  npm install --global windows-build-tools\n' +
        '  (Or install Visual Studio Build Tools with "Desktop development with C++" + Python 3)';
    default:
      return '  sudo apt-get install -y build-essential python3 make g++';
  }
}

// ── pure helpers (also exported standalone for spawn-env) ────────────────────

function parseConfig(s) {
  if (s && typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (_) { return {}; }
}

function maskToken(tok) {
  if (!tok || typeof tok !== 'string') return '';
  if (tok.length <= 10) return '***';
  return tok.slice(0, 6) + '…' + tok.slice(-4);
}

function tomlValue(toml, key) {
  const m = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*"([^"]+)"`).exec(toml || '');
  return m ? m[1] : '';
}

function uniqueModels(values) {
  const seen = new Set();
  const out = [];
  for (const raw of values || []) {
    const v = String(raw || '').trim();
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

function parseModelList(models, primary) {
  const extras = Array.isArray(models)
    ? models
    : String(models || '').split(/[\n,]/);
  return uniqueModels([primary, ...extras]);
}

// If baseUrl points at a domestic chat-only service, return the real
// /chat/completions URL the proxy should fetch. Otherwise null (直连).
function detectDomesticTarget(baseUrl) {
  if (!baseUrl) return null;
  let host;
  try { host = new URL(baseUrl).host; } catch (_) { return null; }
  for (const m of DOMESTIC_PROXY_MAP) {
    if (m.host && host === m.host) return m.target;
    if (m.hostRe && m.hostRe.test(host)) return m.target;
  }
  return null;
}

function detectResponsesCompatTarget(baseUrl) {
  if (!baseUrl) return null;
  let host;
  try { host = new URL(baseUrl).host; } catch (_) { return null; }
  for (const m of RESPONSES_COMPAT_PROXY_MAP) {
    if (m.host && host === m.host) return m.target;
    if (m.hostRe && m.hostRe.test(host)) return m.target;
  }
  return null;
}

function codexProxyTarget(baseUrl) {
  const responseCompat = detectResponsesCompatTarget(baseUrl);
  if (responseCompat) return { baseUrl: responseCompat, mode: 'responses-compat' };
  const chatTarget = chatCompletionsTarget(baseUrl);
  return chatTarget ? { baseUrl: chatTarget, mode: 'chat-to-responses' } : null;
}

function chatCompletionsTarget(baseUrl) {
  if (!baseUrl) return null;
  const known = detectDomesticTarget(baseUrl);
  if (known) return known;
  try {
    const u = new URL(baseUrl);
    let p = u.pathname.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(p)) return u.toString();
    if (!p || p === '/') p = '/v1';
    u.pathname = p + '/chat/completions';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch (_) {
    return null;
  }
}

// Apply a { opus: {model, name}, sonnet: {...}, ... } map onto a claude env
// object (in place), writing/clearing ANTHROPIC_DEFAULT_*_MODEL[_NAME]. Blank
// model for a tier clears that tier's mapping.
function applyAliasMapToEnv(env, aliasMap) {
  if (!aliasMap || typeof aliasMap !== 'object') return;
  for (const [tier, key] of Object.entries(ALIAS_TIER_KEYS)) {
    const entry = aliasMap[tier];
    const model = (entry && typeof entry === 'object' ? entry.model : entry) || '';
    const name = (entry && typeof entry === 'object' ? entry.name : '') || '';
    if (String(model).trim()) {
      env[key] = String(model).trim();
      if (String(name).trim()) env[key + '_NAME'] = String(name).trim();
      else delete env[key + '_NAME'];
    } else {
      delete env[key];
      delete env[key + '_NAME'];
    }
  }
}

// Build a cc-switch-shaped settingsConfig from simple fields.
function buildSettingsConfig(appType, { baseUrl, authToken, model, models, providerId, useChatResponsesProxy, aliasMap }) {
  const modelOptions = parseModelList(models, model);
  if (appType === 'claude') {
    const env = {};
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
    if (authToken) env.ANTHROPIC_AUTH_TOKEN = authToken;
    if (model) env.ANTHROPIC_MODEL = model;
    applyAliasMapToEnv(env, aliasMap);
    return { env, modelCatalog: { models: modelOptions.map(m => ({ model: m })) } };
  }
  const provName = 'custom';
  // codex CLI (>= 0.130) only supports wire_api = "responses"; the "chat"
  // protocol was removed (see openai/codex#7782). That means codex can only
  // talk to providers that expose an OpenAI /responses endpoint. Most domestic
  // providers (DeepSeek, GLM, Qwen, MiniMax) only serve /chat/completions, so
  // codex CANNOT connect to them directly — verified empirically: chat → "no
  // longer supported", responses → 404 on /responses. The only known way to
  // bridge codex to those is a local responses↔chat proxy (what cc-switch
  // does). We therefore always emit wire_api="responses" and surface the
  // limitation in the UI rather than generating a config that fails to start.
  //
  // For domestic services, config.toml's base_url is rewritten to the local
  // proxy; the real /chat/completions URL + apiKey are stored in
  // settingsConfig.proxyTarget for lib/proxy/codex.js to read.
  const proxySpec = useChatResponsesProxy ? codexProxyTarget(baseUrl) : null;
  const port = process.env.CPR_PORT || process.env.PORT || DEFAULT_PROXY_PORT;
  const proxyBaseUrl = (proxySpec && providerId)
    ? `http://127.0.0.1:${port}/codex-proxy/${providerId}`
    : baseUrl;
  const lines = [
    `model_provider = "${provName}"`,
    model ? `model = "${model}"` : '',
    '',
    `[model_providers.${provName}]`,
    `name = "${provName}"`,
    proxyBaseUrl ? `base_url = "${proxyBaseUrl}"` : '',
    'wire_api = "responses"',
  ].filter(Boolean);
  const cfg = {
    auth: { OPENAI_API_KEY: authToken || null },
    config: lines.join('\n') + '\n',
    modelCatalog: { models: modelOptions.map(m => ({ model: m })) },
  };
  if (proxySpec) {
    cfg.proxyTarget = {
      baseUrl: proxySpec.baseUrl,
      apiKey: authToken || '',
      originalBaseUrl: baseUrl || '',
      mode: proxySpec.mode,
    };
  }
  return cfg;
}

// Public-safe summary — never leaks a full token (only masked).
function summarize(p) {
  const cfg = parseConfig(p.settingsConfig);
  let baseUrl = '', model = '', token = '', modelOptions = [], aliasOnly = false, aliasMap = {};
  if (p.appType === 'claude') {
    const env = cfg.env || {};
    baseUrl = env.ANTHROPIC_BASE_URL || '';
    model = env.ANTHROPIC_MODEL || '';
    token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '';
    // Collect all models this provider can serve: primary + DEFAULT_* overrides + catalog.
    const aliasKeys = ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL'];
    const catalog = (cfg.modelCatalog && Array.isArray(cfg.modelCatalog.models))
      ? cfg.modelCatalog.models.map(m => m && m.model).filter(Boolean)
      : [];
    modelOptions = uniqueModels([env.ANTHROPIC_MODEL, ...aliasKeys.map(k => env[k]), ...catalog]);
    // Alias-only relay: has a base URL but no canonical ANTHROPIC_MODEL — it only
    // declares per-tier alias targets (e.g. iFlytek maps opus/sonnet/haiku/fable →
    // astron-code-latest). Such relays reject those targets as literal --model
    // values, so the spawn path substitutes a safe wire default (see buildChatSpawnArgs).
    aliasOnly = !!baseUrl && !model;
    // Surface the alias↔model correspondence for the model picker, carrying cc-switch's
    // friendly *_MODEL_NAME label (e.g. opus → astron-code-latest (GLM5.2)).
    for (const k of aliasKeys) {
      const m = env[k];
      if (!m) continue;
      const tier = k.replace('ANTHROPIC_DEFAULT_', '').replace('_MODEL', '').toLowerCase();
      aliasMap[tier] = { model: m, name: env[k + '_NAME'] || '' };
    }
  } else {
    baseUrl = (cfg.proxyTarget && cfg.proxyTarget.originalBaseUrl) || tomlValue(cfg.config, 'base_url');
    model = tomlValue(cfg.config, 'model');
    token = (cfg.auth && cfg.auth.OPENAI_API_KEY) ||
            (cfg.auth && cfg.auth.tokens && cfg.auth.tokens.access_token) || '';
    // Collect models this codex provider can serve: the primary `model` from
    // config.toml plus any extras declared in `modelCatalog.models`. This lets
    // the session model auto-fill correctly when switching onto a codex
    // provider (e.g. 讯飞GLM5.2 which declares model="astron-code-latest").
    const seen = new Set();
    const ordered = [];
    const extras = (cfg.modelCatalog && Array.isArray(cfg.modelCatalog.models))
      ? cfg.modelCatalog.models.map(m => m && m.model).filter(Boolean)
      : [];
    for (const v of [model, ...extras]) {
      if (v && !seen.has(v)) { seen.add(v); ordered.push(v); }
    }
    modelOptions = ordered;
  }
  return {
    id: p.id,
    appType: p.appType,
    name: p.name,
    source: p.source || 'local', // 'local' | 'ccswitch'
    baseUrl,
    model,
    modelOptions,
    aliasOnly,
    aliasMap,
    useChatResponsesProxy: !!cfg.proxyTarget,
    tokenMask: maskToken(token),
    hasToken: !!token,
    isOfficial: !baseUrl, // no custom base url -> default login / subscription
  };
}

// ── store factory ────────────────────────────────────────────────────────────

// createStore({ dataFile, ccSwitchDb } = {}) → an instance whose methods close
// over a configurable dataFile (providers.json) + cc-switch db path. All state
// lives in that one JSON file — no module-level singletons, no hard-coded
// multicc paths. The instance exposes the methods the proxy entry points and
// spawn-env need (getProvider / listProviders / …), plus _dataFile/_ccDb for
// diagnostics.
function createStore({ dataFile, ccSwitchDb, cprHome, paths } = {}) {
  const resolvedPaths = ensureCprPaths(paths || createCprPaths({ home: cprHome }));
  const storeFile = dataFile || resolvedPaths.providersFile;
  const ccDb = resolveCcDb(ccSwitchDb);

  // v0.2 stored providers directly under CPR_HOME. Copy it forward once, but
  // leave the original untouched as an implicit rollback copy.
  if (!dataFile && !fs.existsSync(storeFile) && fs.existsSync(resolvedPaths.legacyProvidersFile)) {
    const legacy = readJson(resolvedPaths.legacyProvidersFile, null);
    if (legacy !== null) writeJsonAtomic(storeFile, legacy);
  }

  // Make sure the data dir exists up-front so loadStore/saveStore never fail
  // on a missing parent directory.
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true, mode: 0o700 });
  } catch (e) {
    console.error('[cli-provider-router] mkdir data dir failed:', e.message);
  }

  function loadStore() {
    const d = readJson(storeFile, null);
    if (Array.isArray(d)) return d;
    if (d && Array.isArray(d.providers)) return d.providers;
    return [];
  }

  function saveStore(list) {
    writeJsonAtomic(storeFile, list);
  }

  function listProviders(appType) {
    const list = loadStore().filter(p => !appType || p.appType === appType);
    return list.map(summarize);
  }

  function getProvider(appType, id) {
    // id is globally unique, so when appType is omitted match by id alone.
    // (Passing appType === undefined previously matched nothing, since every
    // stored provider has a concrete appType.)
    return loadStore().find(p => p.id === id && (!appType || p.appType === appType)) || null;
  }

  function getProviderSummary(appType, id) {
    const p = getProvider(appType, id);
    return p ? summarize(p) : null;
  }

  // Resolve a codex provider's direct-HTTP target (OpenAI /chat/completions),
  // so aux can POST straight to it without spawning the codex CLI — the codex
  // analogue of the claude direct-HTTP path.
  //
  // Three provider shapes (see providers.json):
  //   1. proxyTarget present → { baseUrl: ".../chat/completions", apiKey } is the
  //      real upstream (domestic providers bridged through codex-proxy). Use it
  //      directly and skip the local proxy hop entirely.
  //   2. real base_url in config.toml + OPENAI_API_KEY → hit <base_url>/chat/completions.
  //   3. OAuth (auth_mode=chatgpt, OPENAI_API_KEY=null) → cannot key-auth a plain
  //      POST; canDirect=false so the caller falls back to CLI spawn.
  function resolveCodexDirectHttp(providerId) {
    const p = getProvider('codex', providerId);
    if (!p) return { canDirect: false, reason: 'provider not found' };
    const cfg = parseConfig(p.settingsConfig);
    const auth = cfg.auth || {};
    const apiKey = auth.OPENAI_API_KEY || '';
    const model = tomlValue(cfg.config, 'model') || '';
    const modelOptions = (cfg.modelCatalog && Array.isArray(cfg.modelCatalog.models))
      ? cfg.modelCatalog.models.map(m => m && m.model).filter(Boolean)
      : (model ? [model] : []);

    // Shape 1: codex-proxy target carries the real /chat/completions URL + key.
    if (cfg.proxyTarget && cfg.proxyTarget.baseUrl) {
      const key = cfg.proxyTarget.apiKey || apiKey;
      if (!key) return { canDirect: false, reason: 'proxyTarget without apiKey' };
      return { canDirect: true, url: cfg.proxyTarget.baseUrl, apiKey: key, model, modelOptions };
    }

    // Shape 3: OAuth-only (no usable API key) → must use the CLI.
    if (!apiKey) return { canDirect: false, reason: 'OAuth provider (no API key) — CLI only' };

    // Shape 2: real upstream base_url from config.toml. Normalize to a
    // /chat/completions endpoint (append if the base_url is a bare host/prefix).
    let base = tomlValue(cfg.config, 'base_url') || '';
    if (!base) return { canDirect: false, reason: 'no base_url in config' };
    // A base_url pointing back at our own local codex-proxy but WITHOUT a
    // proxyTarget is unusable for direct HTTP (we'd loop through the responses
    // bridge). Treat as CLI-only.
    if (/127\.0\.0\.1|localhost/.test(base)) {
      return { canDirect: false, reason: 'base_url is local proxy without proxyTarget — CLI only' };
    }
    let url = base.replace(/\/+$/, '');
    if (!/\/chat\/completions$/.test(url)) {
      // base_url like "https://host/v1" → "https://host/v1/chat/completions"
      url = url + '/chat/completions';
    }
    return { canDirect: true, url, apiKey, model, modelOptions };
  }

  function createProvider({ appType, name, baseUrl, authToken, model, models, useChatResponsesProxy, settingsConfig, aliasMap }) {
    if (!APP_TYPES.includes(appType)) throw new Error('appType must be claude or codex');
    if (!name || !String(name).trim()) throw new Error('name required');
    // Generate id first so buildSettingsConfig can embed it in the proxy base_url.
    const id = crypto.randomUUID();
    const cfg = (settingsConfig && typeof settingsConfig === 'object')
      ? settingsConfig
      : buildSettingsConfig(appType, { baseUrl, authToken, model, models, useChatResponsesProxy, providerId: id, aliasMap });
    const p = {
      id,
      appType,
      name: String(name).trim(),
      source: 'local',
      settingsConfig: cfg,
      createdAt: Date.now(),
    };
    const list = loadStore();
    list.push(p);
    saveStore(list);
    return { id: p.id, appType, name: p.name };
  }

  function updateProvider(appType, id, { name, baseUrl, authToken, model, models, useChatResponsesProxy, settingsConfig, aliasMap }) {
    const list = loadStore();
    const p = list.find(x => x.appType === appType && x.id === id);
    if (!p) throw new Error('provider not found');
    let cfg = parseConfig(p.settingsConfig);
    if (settingsConfig && typeof settingsConfig === 'object') {
      cfg = settingsConfig;
    } else if (appType === 'claude') {
      cfg.env = cfg.env || {};
      if (baseUrl !== undefined) { if (baseUrl) cfg.env.ANTHROPIC_BASE_URL = baseUrl; else delete cfg.env.ANTHROPIC_BASE_URL; }
      if (authToken !== undefined && authToken) cfg.env.ANTHROPIC_AUTH_TOKEN = authToken;
      if (model !== undefined) { if (model) cfg.env.ANTHROPIC_MODEL = model; else delete cfg.env.ANTHROPIC_MODEL; }
      if (models !== undefined || model !== undefined) {
        cfg.modelCatalog = { models: parseModelList(models, model !== undefined ? model : cfg.env.ANTHROPIC_MODEL).map(m => ({ model: m })) };
      }
      if (aliasMap !== undefined) applyAliasMapToEnv(cfg.env, aliasMap);
    } else {
      const currentBaseUrl = (cfg.proxyTarget && cfg.proxyTarget.originalBaseUrl) || tomlValue(cfg.config, 'base_url');
      const nextProxy = useChatResponsesProxy !== undefined
        ? !!useChatResponsesProxy
        : !!cfg.proxyTarget;
      const rebuilt = buildSettingsConfig('codex', {
        baseUrl: baseUrl !== undefined ? baseUrl : currentBaseUrl,
        authToken: authToken || (cfg.auth && cfg.auth.OPENAI_API_KEY) || '',
        model: model !== undefined ? model : tomlValue(cfg.config, 'model'),
        models: models !== undefined
          ? models
          : ((cfg.modelCatalog && Array.isArray(cfg.modelCatalog.models)) ? cfg.modelCatalog.models.map(m => m && m.model).filter(Boolean) : undefined),
        useChatResponsesProxy: nextProxy,
        providerId: id,
      });
      // Drop a stale proxyTarget if the user switched to a non-domestic baseUrl.
      cfg = { ...cfg, ...rebuilt };
      if (!rebuilt.proxyTarget) delete cfg.proxyTarget;
    }
    if (name) p.name = String(name).trim();
    p.settingsConfig = cfg;
    saveStore(list);
    return { id, appType };
  }

  function deleteProvider(appType, id) {
    const list = loadStore();
    const next = list.filter(p => !(p.appType === appType && p.id === id));
    if (next.length === list.length) return false;
    saveStore(next);
    return true;
  }

  // Pull cc-switch's providers into this store. Idempotent: keyed by the
  // cc-switch id (kept as the provider id with source='ccswitch'), so re-import
  // refreshes existing entries instead of duplicating. Local providers untouched.
  function importFromCcSwitch() {
    if (!fs.existsSync(ccDb)) throw new Error('cc-switch database not found at ' + ccDb);
    if (!ensureDatabase()) {
      throw new Error(
        'cc-switch import requires the optional dependency better-sqlite3.\n' +
        'Install it in the cli-provider-router package and retry:\n' +
        '  npm install better-sqlite3\n' +
        'Native build prerequisite (when no prebuilt binary is available):\n' + nativeBuildHint()
      );
    }
    const db = new Database(ccDb, { readonly: true, fileMustExist: true, timeout: 4000 });
    let rows;
    try {
      rows = db.prepare('SELECT id, app_type, name, settings_config FROM providers ORDER BY app_type, sort_index, name').all();
    } finally { db.close(); }

    const list = loadStore();
    const byKey = new Map(list.map((p, i) => [`${p.appType}:${p.id}`, i]));
    let imported = 0, updated = 0;
    for (const r of rows) {
      if (!APP_TYPES.includes(r.app_type)) continue;
      const cfg = parseConfig(r.settings_config);
      // Keep cc-switch's REAL model ids in the stored env so the editor / model
      // picker shows e.g. glm-5.2 (not a claude-* wire name). The spawn path
      // (resolveSpawnEnv) applies the safe wire default to alias-only relays at
      // spawn time, so we deliberately do NOT overwrite the env at import.
      const entry = {
        id: r.id,
        appType: r.app_type,
        name: r.name,
        source: 'ccswitch',
        settingsConfig: cfg,
        importedAt: Date.now(),
      };
      const key = `${r.app_type}:${r.id}`;
      if (byKey.has(key)) {
        // Preserve local-only env fields that cc-switch doesn't manage
        // (ANTHROPIC_API_KEY, MULTICC_TOOLS, etc.), then merge cc-switch data.
        const prev = list[byKey.get(key)];
        const prevEnv = (prev.settingsConfig && prev.settingsConfig.env) || {};
        const prevLocalKeys = {};
        for (const k of ['ANTHROPIC_API_KEY', 'CPR_TOOLS', 'MULTICC_TOOLS']) {
          if (prevEnv[k] !== undefined) prevLocalKeys[k] = prevEnv[k];
        }
        list[byKey.get(key)] = { ...prev, ...entry };
        if (Object.keys(prevLocalKeys).length) {
          const merged = list[byKey.get(key)];
          merged.settingsConfig.env = { ...merged.settingsConfig.env, ...prevLocalKeys };
        }
        updated++;
      }
      else { list.push(entry); imported++; }
    }
    saveStore(list);
    return { imported, updated, total: rows.length };
  }

  return {
    loadStore,
    saveStore,
    listProviders,
    getProvider,
    getProviderSummary,
    resolveCodexDirectHttp,
    createProvider,
    updateProvider,
    deleteProvider,
    importFromCcSwitch,
    _dataFile: storeFile,
    _ccDb: ccDb,
    _paths: resolvedPaths,
  };
}

module.exports = {
  createStore,
  // pure helpers (no store state) — exported so spawn-env / proxy / CLI can
  // reuse them without reinstantiating a store.
  parseConfig,
  maskToken,
  tomlValue,
  uniqueModels,
  parseModelList,
  detectDomesticTarget,
  detectResponsesCompatTarget,
  codexProxyTarget,
  chatCompletionsTarget,
  applyAliasMapToEnv,
  buildSettingsConfig,
  summarize,
  // also expose the on-demand-sqlite helpers for CLI import flows
  ensureDatabase,
  nativeBuildHint,
};
