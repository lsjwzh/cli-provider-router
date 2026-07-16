'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TOML = require('@iarna/toml');
const { createCprPaths, ensureCprPaths, secureDirectory, FILE_MODE } = require('../paths');
const { atomicWriteFile, writeJsonAtomic, readJson } = require('../atomic-json');
const { parseConfig, tomlValue } = require('../store');
const { DEFAULT_CODEX_AGENT_ROLES } = require('../routing');

const SNAPSHOT_VERSION = 1;
const DIRECT_PROVIDER_PREFIX = 'cpr_direct_';
const LOCAL_BEARER_TOKEN = 'cpr-local';
const CLAUDE_MANAGED_ENV_KEYS = Object.freeze([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function configDriftError(message) {
  const error = new Error(message);
  error.code = 'CONFIG_DRIFT';
  return error;
}

function readFileRecord(file) {
  if (!fs.existsSync(file)) return { path: file, existed: false, sha256: null, contentBase64: null };
  const content = fs.readFileSync(file);
  return { path: file, existed: true, sha256: sha256(content), contentBase64: content.toString('base64') };
}

function currentHash(file) {
  return fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
}

function safeId(value, label) {
  const id = String(value || '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw new Error(`invalid ${label}`);
  return id;
}

function atomicRemove(file) {
  if (!fs.existsSync(file)) return;
  const tombstone = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.removed`);
  fs.renameSync(file, tombstone);
  fs.rmSync(tombstone, { force: true });
}

function restoreRecord(record) {
  if (record.existed) atomicWriteFile(record.path, Buffer.from(record.contentBase64, 'base64'));
  else atomicRemove(record.path);
}

function profileGetter(profiles) {
  if (profiles && typeof profiles.get === 'function') return profiles.get.bind(profiles);
  if (typeof profiles === 'function') return profiles;
  return () => null;
}

function providerModel(store, cli, endpoint) {
  if (!endpoint || !endpoint.providerId) return '';
  if (endpoint.model) return String(endpoint.model);
  const provider = store && store.getProvider && store.getProvider(cli, endpoint.providerId);
  if (!provider) return '';
  const cfg = parseConfig(provider.settingsConfig);
  if (cli === 'claude') {
    const env = cfg.env || {};
    return String(env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || env.ANTHROPIC_DEFAULT_OPUS_MODEL || '');
  }
  return String(tomlValue(cfg.config, 'model') || '');
}

function validateProfile(profile, cli, store) {
  if (!profile) throw new Error('route profile not found');
  if (profile.enabled === false) throw new Error('route profile is disabled');
  if (profile.cli !== cli) throw new Error(`route profile is for ${profile.cli}, not ${cli}`);
  if (!profile.main || !profile.main.providerId) throw new Error('route profile main provider is required');
  for (const endpoint of [profile.main, profile.subagent, ...Object.values(profile.roles || {})].filter(Boolean)) {
    if (!store || typeof store.getProvider !== 'function' || !store.getProvider(cli, endpoint.providerId)) {
      throw new Error(`${cli} provider not found: ${endpoint.providerId}`);
    }
  }
  return profile;
}

function localBase(proxyBaseUrl, mount, endpoint, sessionId, role) {
  const origin = String(proxyBaseUrl).replace(/\/+$/, '');
  return `${origin}/${mount}/${encodeURIComponent(endpoint.providerId)}/${encodeURIComponent(sessionId)}${role ? `/${encodeURIComponent(role)}` : ''}`;
}

function parseJsonObject(source, file) {
  if (!source.trim()) return {};
  const value = JSON.parse(source);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} must contain a JSON object`);
  return value;
}

function createDirectCliConfigManager(options = {}) {
  const paths = ensureCprPaths(options.paths || createCprPaths({ home: options.cprHome }));
  const store = options.store;
  const getProfile = profileGetter(options.profiles);
  const proxyBaseUrl = String(options.proxyBaseUrl || 'http://127.0.0.1:4567').replace(/\/+$/, '');
  const userHome = path.resolve(options.home || os.homedir());
  const claudeSettingsFile = path.resolve(options.claudeSettingsFile || path.join(userHome, '.claude', 'settings.json'));
  const codexHome = path.resolve(options.codexHome || path.join(userHome, '.codex'));

  function stateFile(cli) { return path.join(paths.directCliConfigStateDir, `${safeId(cli, 'cli')}.json`); }
  function snapshotDir(snapshotId) { return path.join(paths.directCliConfigSnapshotsDir, safeId(snapshotId, 'snapshot id')); }
  function manifestFile(snapshotId) { return path.join(snapshotDir(snapshotId), 'manifest.json'); }
  function loadState(cli) { return readJson(stateFile(cli), null); }
  function loadManifest(snapshotId) {
    const manifest = readJson(manifestFile(snapshotId), null);
    if (!manifest || manifest.version !== SNAPSHOT_VERSION) throw new Error('snapshot not found or unsupported');
    return manifest;
  }

  function targetFiles(cli, profile) {
    if (cli === 'claude') return [claudeSettingsFile];
    if (cli !== 'codex') throw new Error('cli must be claude or codex');
    const roles = new Set(Object.keys(DEFAULT_CODEX_AGENT_ROLES));
    Object.keys(profile.roles || {}).forEach(role => roles.add(safeId(role, 'role')));
    return [path.join(codexHome, 'config.toml'), ...[...roles].sort().map(role => path.join(codexHome, 'agents', `${role}.toml`))];
  }

  function snapshot(input = {}) {
    const cli = String(input.cli || '').toLowerCase();
    const profileId = safeId(input.profileId, 'profile id');
    const profile = validateProfile(getProfile(profileId), cli, store);
    const existing = loadState(cli);
    if (existing && !input.force) throw new Error(`${cli} direct CLI takeover is already active`);
    const id = crypto.randomUUID();
    const dir = snapshotDir(id);
    secureDirectory(dir);
    const manifest = {
      version: SNAPSHOT_VERSION,
      id,
      cli,
      profileId,
      createdAt: new Date().toISOString(),
      files: targetFiles(cli, profile).map(readFileRecord),
    };
    writeJsonAtomic(manifestFile(id), manifest);
    return { id, cli, profileId, createdAt: manifest.createdAt, files: manifest.files.map(({ path: file, existed, sha256: hash }) => ({ path: file, existed, sha256: hash })) };
  }

  function buildClaude(profile) {
    const before = fs.existsSync(claudeSettingsFile) ? fs.readFileSync(claudeSettingsFile, 'utf8') : '{}\n';
    const settings = parseJsonObject(before, claudeSettingsFile);
    const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? { ...settings.env } : {};
    for (const key of CLAUDE_MANAGED_ENV_KEYS) delete env[key];
    const sessionId = `direct-${profile.id}`;
    env.ANTHROPIC_BASE_URL = localBase(proxyBaseUrl, 'claude-proxy', profile.main, sessionId, '');
    env.ANTHROPIC_AUTH_TOKEN = `cpr-${sessionId}`;
    const model = providerModel(store, 'claude', profile.main);
    if (model) env.ANTHROPIC_MODEL = model;
    const sub = profile.subagent || (profile.roles && profile.roles.default);
    if (sub && sub.providerId && providerModel(store, 'claude', sub)) {
      env.CLAUDE_CODE_SUBAGENT_MODEL = `cpr:${sub.providerId}:${providerModel(store, 'claude', sub)}`;
    }
    settings.env = env;
    return new Map([[claudeSettingsFile, JSON.stringify(settings, null, 2) + '\n']]);
  }

  function providerEntry(endpoint, sessionId, role) {
    return {
      name: `CPR direct ${role} route`,
      base_url: localBase(proxyBaseUrl, 'codex-proxy', endpoint, sessionId, role),
      wire_api: 'responses',
      // This is only a loopback hop token. Upstream credentials stay in CPR's
      // provider store and are never materialized into native Codex config.
      experimental_bearer_token: LOCAL_BEARER_TOKEN,
    };
  }

  function safeRoleName(role) { return String(role).toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 48); }

  function buildCodex(profile) {
    const configFile = path.join(codexHome, 'config.toml');
    const before = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
    const config = before.trim() ? TOML.parse(before) : {};
    config.model_providers = config.model_providers && typeof config.model_providers === 'object' ? config.model_providers : {};
    for (const key of Object.keys(config.model_providers)) if (key.startsWith(DIRECT_PROVIDER_PREFIX)) delete config.model_providers[key];
    const sessionId = `direct-${profile.id}`;
    config.model_providers.cpr_direct_main = providerEntry(profile.main, sessionId, 'main');
    config.model_provider = 'cpr_direct_main';
    const mainModel = providerModel(store, 'codex', profile.main);
    if (mainModel) config.model = mainModel;
    config.features = config.features && typeof config.features === 'object' ? config.features : {};
    config.features.multi_agent = true;
    const output = new Map([[configFile, TOML.stringify(config)]]);
    const fallback = profile.subagent || profile.main;
    const roles = { ...DEFAULT_CODEX_AGENT_ROLES };
    for (const role of Object.keys(profile.roles || {})) if (!roles[role]) roles[role] = { description: `CPR ${role} agent route.`, instructions: 'Complete the delegated task and report the result.' };
    for (const [role, meta] of Object.entries(roles)) {
      const endpoint = (profile.roles && profile.roles[role]) || fallback;
      const providerName = role === 'default' ? 'cpr_direct_sub' : `cpr_direct_role_${safeRoleName(role)}`;
      config.model_providers[providerName] = providerEntry(endpoint, sessionId, role);
      const agent = {
        name: role,
        description: meta.description,
        developer_instructions: meta.instructions,
        model_provider: providerName,
      };
      const model = providerModel(store, 'codex', endpoint);
      if (model) agent.model = model;
      output.set(path.join(codexHome, 'agents', `${role}.toml`), TOML.stringify(agent));
    }
    output.set(configFile, TOML.stringify(config));
    return output;
  }

  function planned(cli, profile) { return cli === 'claude' ? buildClaude(profile) : buildCodex(profile); }

  function preview(input = {}) {
    const cli = String(input.cli || '').toLowerCase();
    const profileId = safeId(input.profileId, 'profile id');
    const profile = validateProfile(getProfile(profileId), cli, store);
    const files = planned(cli, profile);
    return {
      cli,
      profileId,
      proxyBaseUrl,
      requiresEnv: [],
      files: [...files].map(([file, contents]) => ({ path: file, exists: fs.existsSync(file), beforeSha256: currentHash(file), afterSha256: sha256(contents), changed: currentHash(file) !== sha256(contents) })),
    };
  }

  function apply(input = {}) {
    const cli = String(input.cli || '').toLowerCase();
    const profileId = safeId(input.profileId, 'profile id');
    const profile = validateProfile(getProfile(profileId), cli, store);
    let snapshotId = input.snapshotId;
    const active = loadState(cli);
    if (active) {
      if (active.profileId === profileId && !status({ cli }).drifted) return { ...active, idempotent: true };
      throw new Error(`${cli} direct CLI takeover is already active; restore it first`);
    }
    if (!snapshotId) {
      if (input.createSnapshot === false) throw new Error('snapshotId is required before apply');
      snapshotId = snapshot({ cli, profileId }).id;
    }
    const manifest = loadManifest(snapshotId);
    if (manifest.cli !== cli || manifest.profileId !== profileId) throw new Error('snapshot does not match cli/profile');
    for (const record of manifest.files) {
      if (currentHash(record.path) !== record.sha256) throw configDriftError(`source drift detected before apply: ${record.path}`);
    }
    const output = planned(cli, profile);
    const written = [];
    try {
      for (const [file, contents] of output) {
        atomicWriteFile(file, contents);
        written.push(file);
      }
      const state = {
        version: SNAPSHOT_VERSION,
        cli,
        profileId,
        snapshotId,
        appliedAt: new Date().toISOString(),
        proxyBaseUrl,
        requiresEnv: [],
        appliedFiles: [...output.keys()].map(file => ({ path: file, sha256: currentHash(file) })),
      };
      writeJsonAtomic(stateFile(cli), state);
      return state;
    } catch (error) {
      for (const record of [...manifest.files].reverse()) {
        try { restoreRecord(record); } catch (_) {}
      }
      throw error;
    }
  }

  function status(input = {}) {
    const cli = String(input.cli || '').toLowerCase();
    if (!['claude', 'codex'].includes(cli)) throw new Error('cli must be claude or codex');
    const state = loadState(cli);
    if (!state) return { cli, active: false, drifted: false, files: [] };
    const files = state.appliedFiles.map(record => {
      const actualSha256 = currentHash(record.path);
      return { path: record.path, expectedSha256: record.sha256, actualSha256, drifted: actualSha256 !== record.sha256 };
    });
    return { ...state, active: true, drifted: files.some(file => file.drifted), files };
  }

  function restore(input = {}) {
    const cli = String(input.cli || '').toLowerCase();
    const state = loadState(cli);
    const snapshotId = input.snapshotId || (state && state.snapshotId);
    if (!snapshotId) throw new Error(`${cli} has no active direct CLI takeover or snapshotId`);
    const manifest = loadManifest(snapshotId);
    if (manifest.cli !== cli) throw new Error('snapshot does not match cli');
    if (state && !input.force) {
      const current = status({ cli });
      if (current.drifted) throw configDriftError('managed CLI configuration drifted; use force to restore explicitly');
    }
    try {
      for (const record of [...manifest.files].reverse()) restoreRecord(record);
    } catch (error) {
      throw new Error(`restore failed; snapshot ${snapshotId} remains available: ${error.message}`);
    }
    if (state) atomicRemove(stateFile(cli));
    return { cli, restored: true, snapshotId, forced: !!input.force };
  }

  function discover(input = {}) {
    const selected = input.cli ? [String(input.cli).toLowerCase()] : ['claude', 'codex'];
    return selected.map(cli => {
      if (!['claude', 'codex'].includes(cli)) throw new Error('cli must be claude or codex');
      const configPath = cli === 'claude' ? claudeSettingsFile : path.join(codexHome, 'config.toml');
      return { cli, configPath, exists: fs.existsSync(configPath), ...status({ cli }) };
    });
  }

  return {
    discover,
    detect: discover,
    snapshot,
    preview,
    apply,
    status,
    restore,
    paths: { claudeSettingsFile, codexHome, stateDir: paths.directCliConfigStateDir, snapshotsDir: paths.directCliConfigSnapshotsDir },
  };
}

module.exports = {
  SNAPSHOT_VERSION,
  DIRECT_PROVIDER_PREFIX,
  LOCAL_BEARER_TOKEN,
  CLAUDE_MANAGED_ENV_KEYS,
  createDirectCliConfigManager,
};
