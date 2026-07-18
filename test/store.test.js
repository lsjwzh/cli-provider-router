'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const cpr = require('../lib/index');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-test-'));
  const dataFile = path.join(dir, 'providers.json');
  return { store: cpr.createStore({ dataFile, cprHome: dir }), dir, dataFile };
}

test('createStore: CRUD round-trip for a claude provider', () => {
  const { store, dir } = tmpStore();
  const created = store.createProvider({
    appType: 'claude', name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com', authToken: 'sk-abcdef123456', model: 'deepseek-chat',
  });
  assert.ok(created.id, 'returns an id');
  assert.equal(store.listProviders('claude').length, 1);

  const summary = store.getProviderSummary('claude', created.id);
  assert.equal(summary.name, 'DeepSeek');
  assert.equal(summary.baseUrl, 'https://api.deepseek.com');
  assert.equal(summary.protocol, 'anthropic');
  assert.equal(summary.wireApi, 'messages');
  assert.equal(summary.model, 'deepseek-chat');
  assert.ok(summary.hasToken);
  assert.notEqual(summary.tokenMask, 'sk-abcdef123456', 'token is masked');

  store.updateProvider('claude', created.id, { name: 'DeepSeek-Renamed' });
  assert.equal(store.getProvider('claude', created.id).name, 'DeepSeek-Renamed');

  store.deleteProvider('claude', created.id);
  assert.equal(store.listProviders('claude').length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildChildEnv: claude injects ANTHROPIC_* and strips inherited routing keys', () => {
  const { store, dir } = tmpStore();
  const { id } = store.createProvider({
    appType: 'claude', name: 'Relay',
    baseUrl: 'https://relay.example.com', authToken: 'sk-xyz', model: 'some-model',
  });
  // A stale inherited routing key should be stripped before injection.
  const base = { ANTHROPIC_BASE_URL: 'https://stale.example.com', PATH: '/usr/bin' };
  const r = cpr.buildChildEnv(base, { cli: 'claude', providerId: id, store });
  assert.equal(r.env.ANTHROPIC_BASE_URL, 'https://relay.example.com', 'provider base URL wins');
  assert.equal(r.env.ANTHROPIC_AUTH_TOKEN, 'sk-xyz');
  assert.equal(r.env.ANTHROPIC_MODEL, 'some-model');
  assert.equal(r.env.PATH, '/usr/bin', 'unrelated env preserved');
  assert.equal(r.skipDefaultModel, true, 'custom base URL -> skipDefaultModel');
  assert.equal(r.providerModel, 'some-model');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildChildEnv: codex gets a per-provider CODEX_HOME', () => {
  const { store, dir } = tmpStore();
  const { id } = store.createProvider({
    appType: 'codex', name: 'CodexRelay',
    baseUrl: 'https://api.deepseek.com', authToken: 'sk-codex', model: 'deepseek-chat',
  });
  const r = cpr.buildChildEnv({}, { cli: 'codex', providerId: id, store });
  assert.ok(r.env.CODEX_HOME, 'CODEX_HOME is set');
  assert.ok(r.env.CODEX_HOME.includes(id), 'CODEX_HOME is scoped to the provider id');
  assert.ok(r.env.CODEX_HOME.startsWith(dir), 'CODEX_HOME honors the injected CPR home');
  assert.equal(r.codexHome, r.env.CODEX_HOME);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildChildEnv: unknown provider yields an empty (no-op) env delta', () => {
  const { store, dir } = tmpStore();
  const r = cpr.buildChildEnv({ FOO: 'bar' }, { cli: 'claude', providerId: 'does-not-exist', store });
  assert.equal(r.env.FOO, 'bar');
  assert.equal(r.providerModel, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveCodexDirectHttp: chat-only provider resolves a /chat/completions target', () => {
  const { store, dir } = tmpStore();
  const { id } = store.createProvider({
    appType: 'codex', name: 'DS',
    baseUrl: 'https://api.deepseek.com', authToken: 'sk-x', model: 'deepseek-chat',
  });
  const d = store.resolveCodexDirectHttp(id);
  assert.equal(d.canDirect, true);
  assert.match(d.url, /\/chat\/completions$/);
  const summary = store.getProviderSummary('codex', id);
  assert.equal(summary.protocol, 'openai');
  assert.equal(summary.wireApi, 'responses');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ProviderSummary reports the CLI-facing wire API for bridged Codex providers', () => {
  const { store, dir } = tmpStore();
  const { id } = store.createProvider({
    appType: 'codex', name: 'Chat bridge', baseUrl: 'https://api.deepseek.com',
    authToken: 'sk-chat', model: 'deepseek-chat', useChatResponsesProxy: true,
  });
  const summary = store.getProviderSummary('codex', id);
  assert.equal(summary.protocol, 'openai');
  assert.equal(summary.wireApi, 'responses');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('appTypeForCli maps non-codex CLIs to the claude pool', () => {
  assert.equal(cpr.appTypeForCli('codex'), 'codex');
  assert.equal(cpr.appTypeForCli('claude'), 'claude');
  assert.equal(cpr.appTypeForCli('opencode'), 'claude');
  assert.equal(cpr.appTypeForCli('zcode'), 'claude');
});
