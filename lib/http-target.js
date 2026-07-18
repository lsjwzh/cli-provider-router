'use strict';

// Pure provider -> HTTP target normalization for embedding hosts. This module
// deliberately has no store, path, service, or proxy dependencies: callers
// supply one provider record and receive either a callable upstream target or
// a stable unavailable reason.

const TOML = require('@iarna/toml');

const DEFAULT_LOCAL_PROXY_PATHS = Object.freeze(['/claude-proxy', '/codex-proxy']);

function parseSettingsConfig(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch (_) { return {}; }
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const normalized = String(value || '').trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function normalizeProtocol(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'anthropic' || normalized === 'claude') return 'anthropic';
  if (normalized === 'openai' || normalized === 'codex') return 'openai';
  return '';
}

function normalizeProxyPath(value) {
  const normalized = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  return normalized ? `/${normalized}` : '';
}

function localProxyPaths(options = {}) {
  const configured = [
    options.claudeProxyPath,
    options.codexProxyPath,
    options.mountPath,
    ...(Array.isArray(options.localProxyPaths) ? options.localProxyPaths : []),
  ].map(normalizeProxyPath).filter(Boolean);
  return uniqueStrings([...DEFAULT_LOCAL_PROXY_PATHS, ...configured]);
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '127.0.0.1' || value === '::1'
    || value.startsWith('127.');
}

function isLocalProxyUrl(value, options = {}) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch (_) { return false; }
  if (!isLoopbackHostname(parsed.hostname)) return false;
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return localProxyPaths(options).some(proxyPath =>
    pathname === proxyPath || pathname.startsWith(`${proxyPath}/`)
  );
}

function isLoopbackHttpUrl(value) {
  const parsed = parseHttpUrl(value);
  return !!parsed && isLoopbackHostname(parsed.hostname);
}

function parseHttpUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); } catch (_) { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  return parsed;
}

function appendEndpoint(baseUrl, endpoint) {
  const parsed = parseHttpUrl(baseUrl);
  if (!parsed) return '';
  const current = parsed.pathname.replace(/\/+$/, '');
  if (!current.toLowerCase().endsWith(endpoint.toLowerCase())) {
    parsed.pathname = `${current}${endpoint}`.replace(/^([^/])/, '/$1');
  }
  return parsed.toString();
}

function appendAnthropicMessages(baseUrl) {
  const parsed = parseHttpUrl(baseUrl);
  if (!parsed) return '';
  const current = parsed.pathname.replace(/\/+$/, '');
  if (/\/v1\/messages$/i.test(current)) return parsed.toString();
  parsed.pathname = /\/v1$/i.test(current)
    ? `${current}/messages`
    : `${current}/v1/messages`;
  if (!parsed.pathname.startsWith('/')) parsed.pathname = `/${parsed.pathname}`;
  return parsed.toString();
}

function unavailable(protocol, reason, metadata = {}) {
  return { available: false, protocol, reason, ...metadata };
}

function providerMetadata(provider, cfg, protocol) {
  const catalog = cfg.modelCatalog && Array.isArray(cfg.modelCatalog.models)
    ? cfg.modelCatalog.models.map(item => item && item.model)
    : [];
  if (protocol === 'anthropic') {
    const env = cfg.env || {};
    const aliases = [
      env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      env.ANTHROPIC_DEFAULT_FABLE_MODEL,
    ];
    return {
      wireApi: 'messages',
      model: String(env.ANTHROPIC_MODEL || '').trim(),
      modelOptions: uniqueStrings([env.ANTHROPIC_MODEL, ...aliases, ...catalog]),
      providerName: provider.name || '',
    };
  }
  return {
    wireApi: 'responses',
    model: '',
    modelOptions: uniqueStrings(catalog),
    providerName: provider.name || '',
  };
}

function resolveAnthropicTarget(provider, cfg, options, metadata) {
  const protocol = 'anthropic';
  const env = cfg.env || {};
  const baseUrl = env.ANTHROPIC_BASE_URL || '';
  const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '';
  const authMode = env.ANTHROPIC_AUTH_TOKEN ? 'bearer' : 'x-api-key';
  if (!baseUrl) return unavailable(protocol, 'provider has no base URL', metadata);
  if (!apiKey) return unavailable(protocol, 'provider has no HTTP credential', metadata);
  if (isLoopbackHttpUrl(baseUrl)) {
    return unavailable(protocol, 'provider base URL is localhost, not an upstream target', metadata);
  }
  const url = appendAnthropicMessages(baseUrl);
  if (!url) return unavailable(protocol, 'provider base URL must be an absolute HTTP(S) URL', metadata);
  return {
    available: true,
    protocol,
    wireApi: 'messages',
    url,
    apiKey,
    authMode,
    ...metadata,
  };
}

function parseCodexConfig(cfg) {
  try { return { value: TOML.parse(cfg.config || ''), error: null }; }
  catch (error) { return { value: null, error }; }
}

function codexWireApi(value) {
  const normalized = String(value || 'responses').trim().toLowerCase();
  return normalized === 'chat' || normalized === 'chat_completions'
    ? 'chat_completions'
    : 'responses';
}

function proxyTargetWireApi(proxyTarget) {
  if (proxyTarget.wireApi) return codexWireApi(proxyTarget.wireApi);
  return String(proxyTarget.mode || '').toLowerCase().includes('chat')
    ? 'chat_completions'
    : 'responses';
}

function resolveOpenAiTarget(provider, cfg, options, baseMetadata) {
  const protocol = 'openai';
  const auth = cfg.auth || {};
  const proxyTarget = cfg.proxyTarget;
  const parsedConfig = parseCodexConfig(cfg);
  if (parsedConfig.error) {
    return unavailable(protocol, `invalid provider config.toml: ${parsedConfig.error.message}`, baseMetadata);
  }
  const config = parsedConfig.value;
  const model = String(config.model || '').trim();
  const metadata = {
    ...baseMetadata,
    wireApi: proxyTarget && proxyTarget.baseUrl
      ? proxyTargetWireApi(proxyTarget)
      : codexWireApi(
        config.model_provider
        && config.model_providers
        && config.model_providers[config.model_provider]
        && config.model_providers[config.model_provider].wire_api
      ),
    model,
    modelOptions: uniqueStrings([model, ...baseMetadata.modelOptions]),
  };

  if (proxyTarget && proxyTarget.baseUrl) {
    const apiKey = proxyTarget.apiKey || auth.OPENAI_API_KEY || '';
    if (!apiKey) return unavailable(protocol, 'proxy target has no API key', metadata);
    if (isLoopbackHttpUrl(proxyTarget.baseUrl)) {
      return unavailable(protocol, 'proxy target is localhost, not an upstream target', metadata);
    }
    const wireApi = proxyTargetWireApi(proxyTarget);
    const endpoint = wireApi === 'responses' ? '/responses' : '/chat/completions';
    const url = appendEndpoint(proxyTarget.baseUrl, endpoint);
    if (!url) return unavailable(protocol, 'proxy target must be an absolute HTTP(S) URL', metadata);
    return {
      available: true,
      protocol,
      wireApi,
      url,
      apiKey,
      authMode: 'bearer',
      ...metadata,
    };
  }

  const apiKey = auth.OPENAI_API_KEY || '';
  if (!apiKey) return unavailable(protocol, 'OAuth provider has no API key', metadata);
  const providerName = config.model_provider;
  const providerConfig = providerName && config.model_providers && config.model_providers[providerName];
  const baseUrl = providerConfig && providerConfig.base_url;
  if (!baseUrl) return unavailable(protocol, 'provider has no base_url', metadata);
  if (isLoopbackHttpUrl(baseUrl)) {
    return unavailable(protocol, 'provider base_url is localhost, not an upstream target', metadata);
  }
  const wireApi = codexWireApi(providerConfig.wire_api);
  const endpoint = wireApi === 'responses' ? '/responses' : '/chat/completions';
  const url = appendEndpoint(baseUrl, endpoint);
  if (!url) return unavailable(protocol, 'provider base_url must be an absolute HTTP(S) URL', metadata);
  return {
    available: true,
    protocol,
    wireApi,
    url,
    apiKey,
    authMode: 'bearer',
    ...metadata,
  };
}

function normalizeArguments(providerOrProtocol, providerOrOptions, maybeOptions, storeOptions) {
  if (providerOrProtocol && typeof providerOrProtocol.getProvider === 'function') {
    const store = providerOrProtocol;
    const appType = providerOrOptions;
    const protocol = normalizeProtocol(appType);
    const providerId = maybeOptions;
    return {
      protocol,
      provider: protocol ? store.getProvider(appType, providerId) : null,
      options: storeOptions || {},
      providerId,
      fromStore: true,
    };
  }
  if (typeof providerOrProtocol === 'string') {
    return {
      protocol: normalizeProtocol(providerOrProtocol),
      provider: providerOrOptions,
      options: maybeOptions || {},
    };
  }
  const provider = providerOrProtocol;
  const options = providerOrOptions || {};
  return {
    protocol: normalizeProtocol(options.protocol || (provider && provider.appType)),
    provider,
    options,
  };
}

function resolveHttpTarget(providerOrProtocol, providerOrOptions, maybeOptions, storeOptions) {
  const { protocol, provider, options, providerId, fromStore } = normalizeArguments(
    providerOrProtocol,
    providerOrOptions,
    maybeOptions,
    storeOptions
  );
  if (!protocol) return unavailable('', 'protocol must be anthropic/openai or claude/codex');
  if (!provider || typeof provider !== 'object') {
    return unavailable(
      protocol,
      fromStore ? `provider ${String(providerId || '')} not found` : 'provider is required',
      { wireApi: protocol === 'anthropic' ? 'messages' : 'responses' }
    );
  }
  const providerProtocol = normalizeProtocol(provider.appType);
  if (providerProtocol && providerProtocol !== protocol) {
    return unavailable(
      protocol,
      `provider appType ${provider.appType} does not match ${protocol}`,
      { wireApi: protocol === 'anthropic' ? 'messages' : 'responses' }
    );
  }
  const cfg = parseSettingsConfig(provider.settingsConfig);
  const metadata = providerMetadata(provider, cfg, protocol);
  return protocol === 'anthropic'
    ? resolveAnthropicTarget(provider, cfg, options, metadata)
    : resolveOpenAiTarget(provider, cfg, options, metadata);
}

module.exports = {
  DEFAULT_LOCAL_PROXY_PATHS,
  isLocalProxyUrl,
  resolveHttpTarget,
};
