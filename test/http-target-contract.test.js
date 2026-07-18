'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_LOCAL_PROXY_PATHS,
  isLocalProxyUrl,
  resolveHttpTarget,
} = require('../lib/http-target');

function claudeProvider(settingsConfig = {}) {
  return { id: 'claude-provider', appType: 'claude', name: 'Claude relay', settingsConfig };
}

function codexProvider({ baseUrl, apiKey = 'openai-key', model = 'codex-model', wireApi = 'responses', extra = {} }) {
  return {
    id: 'codex-provider',
    appType: 'codex',
    name: 'Codex relay',
    settingsConfig: {
      auth: { OPENAI_API_KEY: apiKey },
      config: [
        'model_provider = "custom"',
        `model = "${model}"`,
        '[model_providers.custom]',
        `base_url = "${baseUrl}"`,
        `wire_api = "${wireApi}"`,
        '',
      ].join('\n'),
      modelCatalog: { models: [{ model }, { model: 'fallback-model' }] },
      ...extra,
    },
  };
}

test('resolves an Anthropic provider directly to its upstream messages endpoint', () => {
  const provider = claudeProvider({
    env: {
      ANTHROPIC_BASE_URL: 'https://claude.example/gateway',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
      ANTHROPIC_MODEL: 'primary-model',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fast-model',
    },
    modelCatalog: { models: [{ model: 'catalog-model' }] },
  });
  const before = JSON.parse(JSON.stringify(provider));
  assert.deepEqual(resolveHttpTarget(provider), {
    available: true,
    protocol: 'anthropic',
    wireApi: 'messages',
    url: 'https://claude.example/gateway/v1/messages',
    apiKey: 'anthropic-secret',
    authMode: 'bearer',
    model: 'primary-model',
    modelOptions: ['primary-model', 'fast-model', 'catalog-model'],
    providerName: 'Claude relay',
  });
  assert.deepEqual(provider, before, 'pure resolution must not mutate provider settings');
});

test('accepts the explicit protocol overload and does not duplicate endpoint suffixes', () => {
  const provider = claudeProvider({
    env: {
      ANTHROPIC_BASE_URL: 'https://claude.example/v1/messages?beta=true',
      ANTHROPIC_API_KEY: 'key',
    },
  });
  const target = resolveHttpTarget('anthropic', provider);
  assert.equal(target.url, 'https://claude.example/v1/messages?beta=true');
  assert.equal(target.authMode, 'x-api-key');
  assert.match(resolveHttpTarget('openai', provider).reason, /does not match/);
});

test('rejects loopback targets so a host-local proxy never becomes CPR upstream', () => {
  assert.deepEqual(DEFAULT_LOCAL_PROXY_PATHS, ['/claude-proxy', '/codex-proxy']);
  assert.equal(isLocalProxyUrl('http://127.0.0.1:3000/claude-proxy/p/s/v1/messages'), true);
  assert.equal(isLocalProxyUrl('http://[::1]:3000/codex-proxy/p/s/main'), true);
  assert.equal(isLocalProxyUrl('http://127.0.0.1:11434/v1'), false);

  const localProxy = claudeProvider({
    env: { ANTHROPIC_BASE_URL: 'http://localhost:3000/claude-proxy/p/s', ANTHROPIC_API_KEY: 'key' },
  });
  const rejected = resolveHttpTarget(localProxy);
  assert.equal(rejected.available, false);
  assert.match(rejected.reason, /localhost/);

  const localUpstream = resolveHttpTarget(codexProvider({ baseUrl: 'http://127.0.0.1:11434/v1' }));
  assert.equal(localUpstream.available, false);
  assert.match(localUpstream.reason, /localhost/);
});

test('supports host-defined local proxy mount paths without receiving a host proxy URL option', () => {
  const provider = codexProvider({ baseUrl: 'http://localhost:4567/host-openai/p/s/main' });
  const result = resolveHttpTarget(provider, { localProxyPaths: ['/host-openai'] });
  assert.equal(result.available, false);
  assert.match(result.reason, /localhost/);
});

test('resolves Codex responses and chat_completions providers from config.toml', () => {
  const responses = resolveHttpTarget(codexProvider({ baseUrl: 'https://openai.example/v1' }));
  assert.deepEqual(responses, {
    available: true,
    protocol: 'openai',
    wireApi: 'responses',
    url: 'https://openai.example/v1/responses',
    apiKey: 'openai-key',
    authMode: 'bearer',
    model: 'codex-model',
    modelOptions: ['codex-model', 'fallback-model'],
    providerName: 'Codex relay',
  });

  const chat = resolveHttpTarget(codexProvider({
    baseUrl: 'https://openai.example/v1/chat/completions',
    wireApi: 'chat_completions',
  }));
  assert.equal(chat.wireApi, 'chat_completions');
  assert.equal(chat.url, 'https://openai.example/v1/chat/completions');
});

test('resolves by store + appType + providerId without coupling to a store implementation', () => {
  const provider = codexProvider({ baseUrl: 'https://openai.example/v1' });
  const calls = [];
  const store = {
    getProvider(appType, providerId) {
      calls.push([appType, providerId]);
      return providerId === provider.id ? provider : null;
    },
  };
  assert.equal(resolveHttpTarget(store, 'codex', provider.id).url, 'https://openai.example/v1/responses');
  assert.deepEqual(calls, [['codex', provider.id]]);
  assert.deepEqual(resolveHttpTarget(store, 'claude', 'missing'), {
    available: false,
    protocol: 'anthropic',
    reason: 'provider missing not found',
    wireApi: 'messages',
  });
});

test('uses proxyTarget as the real upstream instead of config.toml local proxy URL', () => {
  const provider = codexProvider({
    baseUrl: 'http://127.0.0.1:4567/codex-proxy/provider-id',
    extra: {
      proxyTarget: {
        baseUrl: 'https://api.deepseek.example/v1/chat/completions',
        apiKey: 'proxy-secret',
        mode: 'chat-to-responses',
      },
    },
  });
  const target = resolveHttpTarget(provider);
  assert.equal(target.available, true);
  assert.equal(target.wireApi, 'chat_completions');
  assert.equal(target.url, 'https://api.deepseek.example/v1/chat/completions');
  assert.equal(target.apiKey, 'proxy-secret');
  assert.equal(target.authMode, 'bearer');
});

test('maps a responses compatibility proxyTarget to the responses wire API', () => {
  const provider = codexProvider({
    baseUrl: 'http://localhost:4567/codex-proxy/provider-id',
    extra: {
      proxyTarget: {
        baseUrl: 'https://responses.example/v1/responses',
        mode: 'responses-compat',
      },
    },
  });
  const target = resolveHttpTarget(provider);
  assert.equal(target.available, true);
  assert.equal(target.wireApi, 'responses');
  assert.equal(target.url, 'https://responses.example/v1/responses');
});

test('returns stable unavailable results for missing credentials and malformed targets', () => {
  const officialClaude = claudeProvider({ env: {} });
  assert.deepEqual(resolveHttpTarget(officialClaude), {
    available: false,
    protocol: 'anthropic',
    reason: 'provider has no base URL',
    wireApi: 'messages',
    model: '',
    modelOptions: [],
    providerName: 'Claude relay',
  });

  const oauthCodex = codexProvider({ baseUrl: 'https://openai.example/v1', apiKey: '' });
  assert.equal(resolveHttpTarget(oauthCodex).reason, 'OAuth provider has no API key');

  const malformed = codexProvider({ baseUrl: 'not-a-url' });
  assert.match(resolveHttpTarget(malformed).reason, /absolute HTTP\(S\) URL/);
});
