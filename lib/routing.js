'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const TOML = require('@iarna/toml');
const { parseConfig, tomlValue } = require('./store');
const { atomicWriteFile, writeJsonAtomic } = require('./atomic-json');

const DEFAULT_CODEX_SUBAGENT_PROVIDER = 'cpr_subagent';
const LEGACY_CODEX_SUBAGENT_PROVIDER = 'multicc_subagent';
const DEFAULT_CODEX_AGENT_ROLES = {
  default: {
    description: 'General-purpose subagent routed by CLI Provider Router.',
    instructions: 'Complete the delegated task and return a concise result to the parent agent.',
  },
  worker: {
    description: 'Execution-focused subagent routed by CLI Provider Router.',
    instructions: 'Implement or verify the delegated task within the scope assigned by the parent agent.',
  },
  explorer: {
    description: 'Read-heavy codebase explorer routed by CLI Provider Router.',
    instructions: 'Inspect only the requested scope and return concrete findings with file references.',
  },
};

function providerResolver(options = {}) {
  if (typeof options.getProvider === 'function') return options.getProvider;
  if (options.store && typeof options.store.getProvider === 'function') {
    return options.store.getProvider.bind(options.store);
  }
  return null;
}

function materializeCodexAuth(home, cfg, options = {}) {
  const globalAuthPath = options.globalAuthPath || path.join(os.homedir(), '.codex', 'auth.json');
  const authPath = path.join(home, 'auth.json');
  const baseUrl = tomlValue(cfg && cfg.config, 'base_url');
  if (!baseUrl) {
    if (fs.existsSync(globalAuthPath)) {
      fs.copyFileSync(globalAuthPath, authPath);
      return 'global';
    }
    if (cfg && cfg.auth) {
      writeJsonAtomic(authPath, cfg.auth);
      return 'provider-fallback';
    }
    fs.rmSync(authPath, { force: true });
    return 'none';
  }
  if (cfg && cfg.auth) {
    writeJsonAtomic(authPath, cfg.auth);
    return 'provider';
  }
  fs.rmSync(authPath, { force: true });
  return 'none';
}

function codexProviderProxyable(providerOrId, options = {}) {
  let provider = providerOrId;
  if (typeof providerOrId === 'string') {
    const getProvider = providerResolver(options);
    provider = getProvider && getProvider('codex', providerOrId);
  }
  if (!provider) return false;
  const cfg = parseConfig(provider.settingsConfig);
  if (cfg.proxyTarget && cfg.proxyTarget.baseUrl) return true;
  const baseUrl = tomlValue(cfg.config, 'base_url');
  const proxyPath = options.codexProxyPath || options.mountPath || '/codex-proxy/';
  return !!baseUrl && !new RegExp(`^https?://(?:127\\.0\\.0\\.1|localhost)(?::\\d+)?${proxyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(baseUrl);
}

function localProxyBase({ providerId, sessionId, role, port, proxyBaseUrl, codexProxyPath, mountPath }) {
  const origin = (proxyBaseUrl || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  const prefix = '/' + String(codexProxyPath || mountPath || '/codex-proxy').replace(/^\/+|\/+$/g, '');
  return `${origin}${prefix}/${encodeURIComponent(providerId)}/${encodeURIComponent(sessionId)}/${role}`;
}

function materializeCodexRoutingHome(home, options) {
  const { mainProviderId, mainProxyable, sessionId, subProviderId, subModel, port } = options;
  if (!home || !mainProviderId || !sessionId || !subProviderId || (!port && !options.proxyBaseUrl)) return false;
  const configPath = options.configPath || path.join(home, 'config.toml');
  if (!fs.existsSync(configPath)) return false;
  const config = TOML.parse(fs.readFileSync(configPath, 'utf8'));
  if (options.mainModel) config.model = String(options.mainModel).trim();
  config.model_providers = config.model_providers || {};
  const routeOptions = { ...options, port };
  if (mainProxyable) {
    const activeProvider = String(config.model_provider || '');
    const active = activeProvider && config.model_providers[activeProvider];
    if (!active || typeof active !== 'object') {
      throw new Error(`Codex config has no model_providers.${activeProvider || '(unset)'}`);
    }
    active.base_url = localProxyBase({ ...routeOptions, providerId: mainProviderId, sessionId, role: 'main' });
    active.wire_api = 'responses';
    active.requires_openai_auth = true;
  }
  config.features = config.features || {};
  config.features.multi_agent = true;
  const agentsDir = options.agentsDir || path.join(home, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const roles = options.agentRoles || DEFAULT_CODEX_AGENT_ROLES;
  const namedRoleRoutes = options.namedRoleRoutes && typeof options.namedRoleRoutes === 'object'
    ? options.namedRoleRoutes
    : null;
  const subagentProvider = options.subagentProviderName || DEFAULT_CODEX_SUBAGENT_PROVIDER;
  for (const [role, meta] of Object.entries(roles)) {
    const namedRoute = namedRoleRoutes && (namedRoleRoutes[role] || namedRoleRoutes.default);
    const routeProviderId = namedRoute ? namedRoute.providerId : subProviderId;
    const routeModel = namedRoute && namedRoute.model != null ? String(namedRoute.model).trim() : subModel;
    if (!routeProviderId) continue;
    // Preserve the historical single-provider layout unless named routes were
    // explicitly requested.  Embedding hosts opt into one model provider per
    // role so the proxy path carries worker/explorer/custom identity all the
    // way into managed authorization and usage accounting.
    const roleProvider = namedRoleRoutes && role !== 'default'
      ? `${subagentProvider}_${role}`
      : subagentProvider;
    config.model_providers[roleProvider] = {
      name: namedRoleRoutes
        ? `${options.subagentProviderLabel || 'CPR subagent route'} (${role})`
        : (options.subagentProviderLabel || 'CPR subagent route'),
      base_url: localProxyBase({
        ...routeOptions,
        providerId: routeProviderId,
        sessionId,
        role: namedRoleRoutes ? role : 'sub',
      }),
      wire_api: 'responses',
      requires_openai_auth: true,
    };
    const agent = {
      name: role,
      description: meta.description,
      developer_instructions: meta.instructions,
      model_provider: roleProvider,
    };
    if (routeModel) agent.model = routeModel;
    atomicWriteFile(path.join(agentsDir, `${role}.toml`), TOML.stringify(agent));
  }
  atomicWriteFile(configPath, TOML.stringify(config));
  return true;
}

function applyCodexProxyConfig(env, options) {
  if (!env || !env.CODEX_HOME || !options.providerId || !options.sessionId || (!options.port && !options.proxyBaseUrl)) return false;
  const getProvider = providerResolver(options);
  if (!getProvider) return false;
  const mainProvider = getProvider('codex', options.providerId);
  if (!mainProvider) return false;
  const mainProxyable = codexProviderProxyable(mainProvider, options);
  const explicitSubId = options.subagent && options.subagent.providerId;
  const subProviderId = explicitSubId || (mainProxyable ? options.providerId : null);
  if (!subProviderId || !codexProviderProxyable(subProviderId, options)) return false;
  try {
    return materializeCodexRoutingHome(env.CODEX_HOME, {
      ...options,
      mainProviderId: options.providerId,
      mainProxyable,
      subProviderId,
      subModel: explicitSubId ? String(options.subagent.model || '').trim() : '',
    });
  } catch (error) {
    (options.logger || console).warn(`[cli-provider-router] failed to materialize Codex role routing: ${error.message}`);
    return false;
  }
}

function applyClaudeProxyEnv(env, options) {
  if (!options.enabled || !options.providerId || !options.sessionId || (!options.port && !options.proxyBaseUrl)) return false;
  const getProvider = providerResolver(options);
  const provider = getProvider && getProvider('claude', options.providerId);
  const cfg = provider ? parseConfig(provider.settingsConfig) : {};
  const hasBase = !!(cfg.env && cfg.env.ANTHROPIC_BASE_URL);
  const officialProviderId = options.officialProviderId || 'claude-official';
  if (!hasBase && !(options.officialOAuth && options.providerId === officialProviderId)) return false;
  const origin = (options.proxyBaseUrl || `http://127.0.0.1:${options.port}`).replace(/\/+$/, '');
  const proxyPath = '/' + String(options.claudeProxyPath || options.mountPath || '/claude-proxy').replace(/^\/+|\/+$/g, '');
  env.ANTHROPIC_BASE_URL = `${origin}${proxyPath}/${encodeURIComponent(options.providerId)}/${encodeURIComponent(options.sessionId)}`;
  env.ANTHROPIC_AUTH_TOKEN = options.routeToken || options.managedToken
    || `${options.virtualTokenPrefix || 'cpr-'}${options.sessionId}`;
  delete env.ANTHROPIC_API_KEY;
  if (options.subagent && options.subagent.providerId && options.subagent.model) {
    env.CLAUDE_CODE_SUBAGENT_MODEL = `${options.modelPrefix || 'cpr:'}${options.subagent.providerId}:${options.subagent.model}`;
  } else {
    delete env.CLAUDE_CODE_SUBAGENT_MODEL;
  }
  return true;
}

module.exports = {
  DEFAULT_CODEX_AGENT_ROLES,
  DEFAULT_CODEX_SUBAGENT_PROVIDER,
  LEGACY_CODEX_SUBAGENT_PROVIDER,
  materializeCodexAuth,
  codexProviderProxyable,
  materializeCodexRoutingHome,
  applyCodexProxyConfig,
  applyClaudeProxyEnv,
};
