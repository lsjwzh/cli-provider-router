'use strict';

// Narrow host-embedding contract.  It accepts host-owned identity and storage
// primitives; it deliberately knows nothing about MultiCC sessions, CPR's Web
// app, service lifecycle, or either takeover mechanism.

const path = require('path');
const { writeJsonAtomic } = require('./atomic-json');
const { DEFAULT_PROXY_PORT } = require('./paths');
const { createStore } = require('./store');
const { buildChildEnv } = require('./spawn-env');
const {
  DEFAULT_CODEX_AGENT_ROLES,
  applyClaudeProxyEnv,
  codexProviderProxyable,
  materializeCodexRoutingHome,
} = require('./routing');
const { createHopCredentialStore } = require('./proxy/hop-credentials');

function nonEmpty(value, label) {
  const result = String(value == null ? '' : value).trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function routeSpec(value, fallback) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    providerId: String(input.providerId || (fallback && fallback.providerId) || '').trim(),
    model: String(input.model != null ? input.model : ((fallback && fallback.model) || '')).trim(),
  };
}

function usageEventSink(usage) {
  if (usage == null) return undefined;
  if (typeof usage === 'function') return usage;
  if (typeof usage.recordProxyUsage === 'function') return usage.recordProxyUsage.bind(usage);
  if (typeof usage.append === 'function') return usage.append.bind(usage);
  throw new Error('usage must be a function or expose recordProxyUsage(event) / append(event)');
}

function credentialStorage(options) {
  const injected = options.managedCredentialStore || options.credentialStore || options.hopCredentials;
  if (injected) return injected;
  const dataFile = options.managedCredentialPath
    || options.managedCredentialsPath
    || options.hopCredentialsFile;
  return createHopCredentialStore({
    ...(options.paths ? { paths: options.paths } : {}),
    ...(options.cprHome ? { cprHome: options.cprHome } : {}),
    ...(dataFile ? { dataFile } : {}),
    ...(typeof options.now === 'function' ? { now: options.now } : {}),
    ...(options.credentialTtlMs != null ? { ttlMs: options.credentialTtlMs } : {}),
  });
}

function providerStore(options) {
  if (options.store) return options.store;
  return createStore({
    ...(options.paths ? { paths: options.paths } : {}),
    ...(options.cprHome ? { cprHome: options.cprHome } : {}),
    ...(options.dataFile ? { dataFile: options.dataFile } : {}),
  });
}

function assertProvider(store, appType, providerId, label) {
  const provider = store.getProvider(appType, providerId);
  if (!provider) throw new Error(`${label} provider not found: ${providerId}`);
  return provider;
}

function credentialRoute(cli, sessionId, roleName, route) {
  const main = roleName === 'main';
  return {
    cli,
    providerId: route.providerId,
    sessionId,
    roleKind: main ? 'main' : 'sub',
    agentRole: main ? '' : (roleName === 'default' ? 'default' : roleName),
    routeName: roleName,
  };
}

function publicRoute(roleName, route) {
  return {
    role: roleName,
    roleKind: roleName === 'main' ? 'main' : 'sub',
    providerId: route.providerId,
    model: route.model,
  };
}

/**
 * Prepare one externally-owned CLI invocation for CPR routing.
 *
 * Required host identity is scalar (`externalSessionId`, with `sessionId` as
 * a compatibility alias); no host session object or database is inspected.
 * The result is intentionally small: spawn env, managed credential, effective
 * routes, a proxy-options bundle, and deterministic revocation.
 */
function prepareSessionRouting(options = {}) {
  const cli = nonEmpty(options.cli, 'cli').toLowerCase();
  if (cli !== 'claude' && cli !== 'codex') throw new Error('cli must be claude or codex');
  const sessionId = nonEmpty(options.externalSessionId || options.sessionId, 'externalSessionId');
  const main = routeSpec(options.main, {
    providerId: options.providerId,
    model: options.model,
  });
  main.providerId = nonEmpty(main.providerId, 'main.providerId');

  const store = providerStore(options);
  if (!store || typeof store.getProvider !== 'function') {
    throw new Error('store must expose getProvider(appType, providerId)');
  }
  assertProvider(store, cli, main.providerId, 'main');

  const rawSubagents = options.subagents && typeof options.subagents === 'object'
    ? options.subagents
    : (options.roles && typeof options.roles === 'object' ? options.roles : {});
  const defaultSubagent = routeSpec(options.subagent || rawSubagents.default, main);
  const roleNames = cli === 'codex'
    ? Array.from(new Set([
      ...Object.keys(DEFAULT_CODEX_AGENT_ROLES),
      ...Object.keys(options.agentRoles || {}),
      ...Object.keys(rawSubagents),
    ].filter(role => role !== 'main')))
    : ['default'];
  const effectiveSubagents = {};
  for (const roleName of roleNames) {
    const route = routeSpec(rawSubagents[roleName], defaultSubagent);
    route.providerId = nonEmpty(route.providerId, `subagents.${roleName}.providerId`);
    assertProvider(store, cli, route.providerId, `subagents.${roleName}`);
    effectiveSubagents[roleName] = route;
  }

  const routes = [publicRoute('main', main), ...roleNames.map(role => publicRoute(role, effectiveSubagents[role]))];
  const managedRoutes = [
    credentialRoute(cli, sessionId, 'main', main),
    ...roleNames.map(role => credentialRoute(cli, sessionId, role, effectiveSubagents[role])),
  ];
  const hopCredentials = credentialStorage(options);
  if (!hopCredentials || typeof hopCredentials.issueBundle !== 'function' || typeof hopCredentials.revoke !== 'function') {
    throw new Error('managed credential store must expose issueBundle(routes) and revoke(selector)');
  }
  const bundle = hopCredentials.issueBundle(managedRoutes, {
    ...(options.credentialExpiresAt != null ? { expiresAt: options.credentialExpiresAt } : {}),
  });
  const credentialIds = bundle.credentials.map(item => item.id);
  const credential = {
    token: bundle.token,
    issuedAt: bundle.issuedAt,
    expiresAt: bundle.expiresAt,
    bundleId: bundle.bundleId,
  };

  try {
    const envResult = buildChildEnv(options.baseEnv || options.env || process.env, {
      cli,
      providerId: main.providerId,
      store,
      ...(options.paths ? { paths: options.paths } : {}),
      ...(options.cprHome ? { cprHome: options.cprHome } : {}),
      ...(options.codexHomesDir ? { codexHomesDir: options.codexHomesDir } : {}),
    });
    const env = envResult.env;
    const proxyRouting = {
      proxyBaseUrl: options.proxyBaseUrl,
      port: options.port || DEFAULT_PROXY_PORT,
      sessionId,
      store,
      codexProxyPath: options.codexProxyPath,
      claudeProxyPath: options.claudeProxyPath,
    };

    if (cli === 'claude') {
      if (main.model) env.ANTHROPIC_MODEL = main.model;
      const sub = effectiveSubagents.default;
      const applied = applyClaudeProxyEnv(env, {
        ...proxyRouting,
        enabled: true,
        providerId: main.providerId,
        subagent: sub,
        routeToken: bundle.token,
        modelPrefix: options.modelPrefix,
        officialOAuth: options.officialOAuth,
        officialProviderId: options.officialProviderId,
      });
      if (!applied) throw new Error(`Claude provider cannot be embedded through the managed route: ${main.providerId}`);
    } else {
      if (!env.CODEX_HOME) throw new Error(`Codex provider could not be materialized: ${main.providerId}`);
      const mainProxyable = codexProviderProxyable(main.providerId, { ...proxyRouting, store });
      for (const roleName of roleNames) {
        const route = effectiveSubagents[roleName];
        if (!codexProviderProxyable(route.providerId, { ...proxyRouting, store })) {
          throw new Error(`Codex subagent provider cannot be embedded through the managed route: ${route.providerId}`);
        }
      }
      const agentRoles = {};
      for (const roleName of roleNames) {
        agentRoles[roleName] = (options.agentRoles && options.agentRoles[roleName]) || DEFAULT_CODEX_AGENT_ROLES[roleName] || {
          description: `CPR ${roleName} subagent route.`,
          instructions: `Complete the delegated ${roleName} task and return the result.`,
        };
      }
      materializeCodexRoutingHome(env.CODEX_HOME, {
        ...proxyRouting,
        mainProviderId: main.providerId,
        mainProxyable,
        mainModel: main.model,
        subProviderId: effectiveSubagents.default.providerId,
        subModel: effectiveSubagents.default.model,
        namedRoleRoutes: effectiveSubagents,
        agentRoles,
      });
      // Every model provider in the generated home points either directly at
      // its upstream or at a managed CPR route. Codex uses this auth material
      // for every proxy-backed provider, so one token authenticates exactly
      // the closed route set issued above.
      writeJsonAtomic(path.join(env.CODEX_HOME, 'auth.json'), { OPENAI_API_KEY: bundle.token });
    }

    const onUsageEvent = usageEventSink(options.usage !== undefined ? options.usage : options.usageLedger);
    const proxy = {
      store,
      getProvider: store.getProvider.bind(store),
      hopCredentials,
      requireHopCredential: true,
      ...(onUsageEvent ? { onUsageEvent } : {}),
      ...(options.claudeProxyPath ? { claudeProxyPath: options.claudeProxyPath } : {}),
      ...(options.codexProxyPath ? { codexProxyPath: options.codexProxyPath } : {}),
      ...(options.modelPrefix ? { modelPrefix: options.modelPrefix } : {}),
    };

    let revoked = false;
    return {
      env,
      credential,
      routes,
      proxy,
      revoke(reason = 'host-session-ended') {
        if (revoked) return { revoked: 0, alreadyRevoked: true };
        revoked = true;
        return hopCredentials.revoke({ ids: credentialIds }, reason);
      },
    };
  } catch (error) {
    // Preparation is transactional from the caller's perspective: a failed
    // env/config materialization must not leave a live bearer credential.
    try { hopCredentials.revoke({ ids: credentialIds }, 'prepare-failed'); } catch (_) {}
    throw error;
  }
}

module.exports = { prepareSessionRouting };
