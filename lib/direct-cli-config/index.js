'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TOML = require('@iarna/toml');
const { createCprPaths, ensureCprPaths, secureDirectory, FILE_MODE } = require('../paths');
const { atomicWriteFile, writeJsonAtomic, readJson } = require('../atomic-json');
const { ANTHROPIC_ALIAS_MODEL_PRIORITY, CLAUDE_MANAGED_ENV_KEYS } = require('../constants');
const { parseConfig, tomlValue } = require('../store');
const { DEFAULT_CODEX_AGENT_ROLES } = require('../routing');
const { createHopCredentialStore, normalizeRole } = require('../proxy/hop-credentials');
const { resolveProviderTarget } = require('../proxy/codex');
const { createTakeoverStateStore } = require('../takeover-state');

const SNAPSHOT_VERSION = 2;
const DIRECT_PROVIDER_PREFIX = 'cpr_direct_';
const LOCAL_BEARER_TOKEN = 'cpr-managed-hop-credential';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function profileHash(profile) {
  return sha256(JSON.stringify(canonical({
    id: profile.id,
    cli: profile.cli,
    enabled: profile.enabled !== false,
    main: profile.main || null,
    subagent: profile.subagent || null,
    roles: profile.roles || {},
  })));
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
    const aliasModel = ANTHROPIC_ALIAS_MODEL_PRIORITY
      .map(key => env[key])
      .find(Boolean);
    return String(env.ANTHROPIC_MODEL || aliasModel || '');
  }
  return String(tomlValue(cfg.config, 'model') || '');
}

function validateProfile(profile, cli, store) {
  if (!profile) throw new Error('route profile not found');
  if (profile.enabled === false) throw new Error('route profile is disabled');
  if (profile.cli !== cli) throw new Error(`route profile is for ${profile.cli}, not ${cli}`);
  if (!profile.main || !profile.main.providerId) throw new Error('route profile main provider is required');
  for (const endpoint of [profile.main, profile.subagent, ...Object.values(profile.roles || {})].filter(Boolean)) {
    const provider = store && typeof store.getProvider === 'function' && store.getProvider(cli, endpoint.providerId);
    if (!provider) {
      throw new Error(`${cli} provider not found: ${endpoint.providerId}`);
    }
    if (endpoint.model && (String(endpoint.model).length > 200 || /[\u0000-\u001f]/.test(String(endpoint.model)))) {
      throw new Error(`${cli} provider model is invalid: ${endpoint.model}`);
    }
    if (cli === 'codex') {
      const target = resolveProviderTarget(provider);
      if (target.error || !target.apiKey) throw new Error(`codex provider is not proxyable: ${endpoint.providerId} (${target.error || 'missing HTTP credential'})`);
    } else {
      const cfg = parseConfig(provider.settingsConfig);
      const baseUrl = cfg.env && cfg.env.ANTHROPIC_BASE_URL;
      if (!baseUrl && endpoint.providerId !== 'claude-official') throw new Error(`claude provider is not proxyable: ${endpoint.providerId}`);
      if (baseUrl) {
        let parsed;
        try { parsed = new URL(baseUrl); } catch (_) { throw new Error(`claude provider has invalid base URL: ${endpoint.providerId}`); }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
          throw new Error(`claude provider has unsafe base URL: ${endpoint.providerId}`);
        }
      }
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
  const hopCredentials = options.hopCredentials || createHopCredentialStore({ paths });
  const takeoverState = options.takeoverState || createTakeoverStateStore(paths);

  function stateFile(cli) { return path.join(paths.directCliConfigStateDir, `${safeId(cli, 'cli')}.json`); }
  function snapshotDir(snapshotId) { return path.join(paths.directCliConfigSnapshotsDir, safeId(snapshotId, 'snapshot id')); }
  function manifestFile(snapshotId) { return path.join(snapshotDir(snapshotId), 'manifest.json'); }
  function loadState(cli) { return takeoverState.direct(cli).state; }
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

  function credentialPlan(cli, profile) {
    const sessionId = `direct-${profile.id}`;
    if (cli === 'claude') {
      const routes = [{ cli, providerId: profile.main.providerId, sessionId, roleKind: 'main', routeName: 'main' }];
      const sub = profile.subagent || (profile.roles && profile.roles.default);
      if (sub && sub.providerId) {
        routes.push({ cli, providerId: sub.providerId, sessionId, roleKind: 'sub', agentRole: 'default', routeName: 'default' });
      }
      return routes;
    }
    const fallback = profile.subagent || profile.main;
    const roles = new Set(Object.keys(DEFAULT_CODEX_AGENT_ROLES));
    Object.keys(profile.roles || {}).forEach(role => roles.add(safeId(role, 'role')));
    return [
      { cli, providerId: profile.main.providerId, sessionId, roleKind: 'main', routeName: 'main' },
      ...[...roles].sort().map(routeName => {
        const endpoint = (profile.roles && profile.roles[routeName]) || fallback;
        const role = normalizeRole({ routeName });
        return { cli, providerId: endpoint.providerId, sessionId, roleKind: role.roleKind, agentRole: role.agentRole, routeName };
      }),
    ];
  }

  function credentialKey(route) {
    return [route.cli, route.providerId, route.sessionId, route.roleKind, route.agentRole || '', route.routeName || ''].join('|');
  }

  function issueCredentials(cli, profile, input = {}) {
    const routes = credentialPlan(cli, profile);
    if (typeof hopCredentials.issueBundle === 'function') {
      return hopCredentials.issueBundle(routes, { expiresAt: input.credentialExpiresAt }).credentials;
    }
    // Compatibility for an injected v1 store. A native Claude subagent cannot
    // carry different tokens, so fail closed rather than create an apparently
    // valid configuration whose subagent route will later receive 401.
    if (cli === 'claude' && routes.length > 1) throw new Error('hop credential store does not support route bundles');
    return routes.map(route => hopCredentials.issue({ ...route, expiresAt: input.credentialExpiresAt }));
  }

  function credentialToken(credentials, route) {
    const found = credentials.find(item => credentialKey(item) === credentialKey(route));
    if (!found || !found.token) throw new Error(`managed hop credential missing for ${route.routeName || route.roleKind}`);
    return found.token;
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
      profileHash: profileHash(profile),
      createdAt: new Date().toISOString(),
      plannedFiles: targetFiles(cli, profile).map(file => path.resolve(file)).sort(),
      files: targetFiles(cli, profile).map(readFileRecord),
    };
    writeJsonAtomic(manifestFile(id), manifest);
    return { id, cli, profileId, createdAt: manifest.createdAt, files: manifest.files.map(({ path: file, existed, sha256: hash }) => ({ path: file, existed, sha256: hash })) };
  }

  function buildClaude(profile, credentials) {
    const before = fs.existsSync(claudeSettingsFile) ? fs.readFileSync(claudeSettingsFile, 'utf8') : '{}\n';
    const settings = parseJsonObject(before, claudeSettingsFile);
    const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? { ...settings.env } : {};
    for (const key of CLAUDE_MANAGED_ENV_KEYS) delete env[key];
    const sessionId = `direct-${profile.id}`;
    env.ANTHROPIC_BASE_URL = localBase(proxyBaseUrl, 'claude-proxy', profile.main, sessionId, '');
    env.ANTHROPIC_AUTH_TOKEN = credentialToken(credentials, {
      cli: 'claude', providerId: profile.main.providerId, sessionId, roleKind: 'main', agentRole: '', routeName: 'main',
    });
    const model = providerModel(store, 'claude', profile.main);
    if (model) env.ANTHROPIC_MODEL = model;
    const sub = profile.subagent || (profile.roles && profile.roles.default);
    if (sub && sub.providerId && providerModel(store, 'claude', sub)) {
      env.CLAUDE_CODE_SUBAGENT_MODEL = `cpr:${sub.providerId}:${providerModel(store, 'claude', sub)}`;
    }
    settings.env = env;
    return new Map([[claudeSettingsFile, JSON.stringify(settings, null, 2) + '\n']]);
  }

  function providerEntry(endpoint, sessionId, role, credentials) {
    const normalized = normalizeRole({ routeName: role });
    return {
      name: `CPR direct ${role} route`,
      base_url: localBase(proxyBaseUrl, 'codex-proxy', endpoint, sessionId, role),
      wire_api: 'responses',
      // This is only a loopback hop token. Upstream credentials stay in CPR's
      // provider store and are never materialized into native Codex config.
      experimental_bearer_token: credentialToken(credentials, {
        cli: 'codex', providerId: endpoint.providerId, sessionId,
        roleKind: normalized.roleKind, agentRole: normalized.agentRole, routeName: normalized.routeName,
      }),
    };
  }

  function safeRoleName(role) { return String(role).toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 48); }

  function buildCodex(profile, credentials) {
    const configFile = path.join(codexHome, 'config.toml');
    const before = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
    const config = before.trim() ? TOML.parse(before) : {};
    config.model_providers = config.model_providers && typeof config.model_providers === 'object' ? config.model_providers : {};
    for (const key of Object.keys(config.model_providers)) if (key.startsWith(DIRECT_PROVIDER_PREFIX)) delete config.model_providers[key];
    const sessionId = `direct-${profile.id}`;
    config.model_providers.cpr_direct_main = providerEntry(profile.main, sessionId, 'main', credentials);
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
      config.model_providers[providerName] = providerEntry(endpoint, sessionId, role, credentials);
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

  function previewCredentials(cli, profile) {
    return credentialPlan(cli, profile).map((route, index) => ({ ...route, id: `preview-${index}`, token: `${LOCAL_BEARER_TOKEN}-${index}` }));
  }

  function planned(cli, profile, credentials = previewCredentials(cli, profile)) {
    return cli === 'claude' ? buildClaude(profile, credentials) : buildCodex(profile, credentials);
  }

  function preview(input = {}) {
    const cli = String(input.cli || '').toLowerCase();
    const profileId = safeId(input.profileId, 'profile id');
    const profile = validateProfile(getProfile(profileId), cli, store);
    const files = planned(cli, profile);
    return {
      cli,
      profileId,
      proxyBaseUrl,
      profileHash: profileHash(profile),
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
    const currentProfileHash = profileHash(profile);
    if (manifest.profileHash !== currentProfileHash) throw configDriftError('route profile drift detected after snapshot');
    const expectedFiles = targetFiles(cli, profile).map(file => path.resolve(file)).sort();
    if (JSON.stringify(manifest.plannedFiles || []) !== JSON.stringify(expectedFiles)) {
      throw configDriftError('planned CLI file set drift detected after snapshot');
    }
    for (const record of manifest.files) {
      if (currentHash(record.path) !== record.sha256) throw configDriftError(`source drift detected before apply: ${record.path}`);
    }
    const credentials = issueCredentials(cli, profile, input);
    const output = planned(cli, profile, credentials);
    const outputFiles = [...output.keys()].map(file => path.resolve(file)).sort();
    if (JSON.stringify(outputFiles) !== JSON.stringify(expectedFiles)) {
      hopCredentials.revoke({ ids: credentials.map(item => item.id) }, 'planned-file-set-mismatch');
      throw configDriftError('generated CLI file set does not match snapshot plan');
    }
    const state = {
      version: SNAPSHOT_VERSION,
      phase: 'applying',
      cli,
      profileId,
      snapshotId,
      profileHash: currentProfileHash,
      startedAt: new Date().toISOString(),
      proxyBaseUrl,
      requiresEnv: [],
      credentialIds: credentials.map(item => item.id),
      credentialExpiresAt: Math.min(...credentials.map(item => item.expiresAt)),
      plannedFiles: outputFiles,
      appliedFiles: [...output].map(([file, contents]) => ({
        path: file,
        sha256: sha256(contents),
        contentBase64: Buffer.from(contents).toString('base64'),
      })),
    };
    // Persist recovery intent before touching native CLI files. If the process
    // dies mid-apply, the next invocation can still find the snapshot, planned
    // contents and credential ids needed to restore safely.
    try {
      takeoverState.writeDirect(cli, state);
    } catch (error) {
      hopCredentials.revoke({ ids: credentials.map(item => item.id) }, 'direct-cli-state-write-failed');
      throw error;
    }
    try {
      for (const [file, contents] of output) {
        atomicWriteFile(file, contents);
      }
      const activeState = {
        ...state,
        phase: 'active',
        appliedAt: new Date().toISOString(),
      };
      takeoverState.writeDirect(cli, activeState);
      return activeState;
    } catch (error) {
      hopCredentials.revoke({ ids: credentials.map(item => item.id) }, 'direct-cli-apply-failed');
      const rollbackErrors = [];
      for (const record of [...manifest.files].reverse()) {
        try { restoreRecord(record); } catch (rollbackError) { rollbackErrors.push({ path: record.path, message: rollbackError.message }); }
      }
      if (rollbackErrors.length) {
        error.code = 'ROLLBACK_FAILED';
        error.rollbackErrors = rollbackErrors;
        takeoverState.writeDirect(cli, {
          ...state,
          phase: 'rollback-required',
          failedAt: new Date().toISOString(),
          rollbackErrors,
        });
      } else {
        takeoverState.removeDirect(cli);
      }
      throw error;
    }
  }

  function status(input = {}) {
    const cli = String(input.cli || '').toLowerCase();
    if (!['claude', 'codex'].includes(cli)) throw new Error('cli must be claude or codex');
    const state = loadState(cli);
    if (!state) return { cli, active: false, drifted: false, files: [] };
    const appliedFiles = Array.isArray(state.appliedFiles) ? state.appliedFiles : [];
    const files = appliedFiles.map(record => {
      const actualSha256 = currentHash(record.path);
      return { path: record.path, expectedSha256: record.sha256, actualSha256, drifted: actualSha256 !== record.sha256 };
    });
    const currentProfile = getProfile(state.profileId);
    const profileDrifted = !currentProfile || profileHash(currentProfile) !== state.profileHash;
    const credentials = new Map(hopCredentials.list({ includeRevoked: true }).map(item => [item.id, item]));
    const credentialStatus = (state.credentialIds || []).map(id => {
      const record = credentials.get(id);
      return { id, present: !!record, expired: !!(record && record.expired), revoked: !!(record && record.revokedAt) };
    });
    let recoverySafe = state.phase === 'active' || state.phase == null;
    if (!recoverySafe && state.snapshotId) {
      try {
        const manifest = loadManifest(state.snapshotId);
        const originals = new Map(manifest.files.map(record => [record.path, record.sha256]));
        recoverySafe = files.every(file => file.actualSha256 === file.expectedSha256 || file.actualSha256 === originals.get(file.path));
      } catch (_) { recoverySafe = false; }
    }
    const { appliedFiles: _privateAppliedFiles, ...publicState } = state;
    return {
      ...publicState,
      active: true,
      recoveryRequired: ['applying', 'restoring', 'recovery-required', 'rollback-required'].includes(state.phase),
      recoverySafe,
      profileDrifted,
      credentialStatus,
      drifted: profileDrifted || files.some(file => file.drifted) || credentialStatus.some(item => !item.present || item.expired || item.revoked),
      files,
    };
  }

  function restore(input = {}) {
    const cli = String(input.cli || '').toLowerCase();
    const state = loadState(cli);
    const snapshotId = input.snapshotId || (state && state.snapshotId);
    if (!snapshotId) throw new Error(`${cli} has no active direct CLI takeover or snapshotId`);
    const manifest = loadManifest(snapshotId);
    if (manifest.cli !== cli) throw new Error('snapshot does not match cli');
    if (!input.force && !state) {
      const error = new Error('restoring a historical snapshot without an active takeover requires force');
      error.code = 'RESTORE_FORCE_REQUIRED';
      throw error;
    }
    if (!input.force && state && snapshotId !== state.snapshotId) {
      const error = new Error('snapshotId does not match the active takeover; use force to restore a different snapshot');
      error.code = 'RESTORE_FORCE_REQUIRED';
      throw error;
    }
    if (state && !input.force) {
      const current = status({ cli });
      if (current.drifted && !(current.recoveryRequired && current.recoverySafe)) {
        throw configDriftError('managed CLI configuration drifted; use force to restore explicitly');
      }
    }
    if (state) {
      takeoverState.writeDirect(cli, {
        ...state,
        phase: 'restoring',
        restoreStartedAt: new Date().toISOString(),
      });
    }
    try {
      for (const record of [...manifest.files].reverse()) restoreRecord(record);
    } catch (error) {
      const rollForwardErrors = [];
      if (state && Array.isArray(state.appliedFiles)) {
        for (const record of state.appliedFiles) {
          try { atomicWriteFile(record.path, Buffer.from(record.contentBase64, 'base64')); }
          catch (rollForwardError) { rollForwardErrors.push({ path: record.path, message: rollForwardError.message }); }
        }
      }
      error.code = 'RESTORE_FAILED';
      error.rollForwardErrors = rollForwardErrors;
      error.message = `restore failed; snapshot ${snapshotId} remains available: ${error.message}`;
      if (state) {
        takeoverState.writeDirect(cli, {
          ...state,
          phase: rollForwardErrors.length ? 'rollback-required' : 'active',
          restoreFailedAt: new Date().toISOString(),
          rollForwardErrors,
        });
      }
      throw error;
    }
    if (state) {
      if (Array.isArray(state.credentialIds) && state.credentialIds.length) {
        hopCredentials.revoke({ ids: state.credentialIds }, 'direct-cli-restored');
      }
      takeoverState.removeDirect(cli);
    }
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
    paths: { claudeSettingsFile, codexHome, stateDir: paths.directCliConfigStateDir, snapshotsDir: paths.directCliConfigSnapshotsDir, hopCredentialsFile: hopCredentials.dataFile },
  };
}

module.exports = {
  SNAPSHOT_VERSION,
  DIRECT_PROVIDER_PREFIX,
  LOCAL_BEARER_TOKEN,
  CLAUDE_MANAGED_ENV_KEYS,
  profileHash,
  createDirectCliConfigManager,
};
