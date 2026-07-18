'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const api = require('../lib');

test('package, JavaScript API and capability versions are explicit semver contracts', () => {
  const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  assert.match(pkg.version, semver);
  assert.match(api.API_VERSION, semver);
  assert.equal(Number(api.API_VERSION.split('.')[0]), 1, 'embedding API major must remain 1');
  assert.ok(Object.isFrozen(api.CAPABILITIES));
  assert.deepEqual(Object.keys(api.CAPABILITIES).sort(), [
    'agentRouting', 'ccSwitchReadOnlyImport', 'ccSwitchTakeover',
    'directCliTakeover', 'durableConfigStore', 'hostEmbedding', 'httpTarget',
    'managedHopCredentials', 'managedRouteCredential', 'managedService',
    'modelPolicy', 'normalizedUsage', 'protocolProxy', 'providerStore',
    'spawnEnvironment', 'takeoverLifecycle', 'webConsole',
  ]);
  for (const version of Object.values(api.CAPABILITIES)) assert.match(version, /^\d+\.\d+$/);
});

test('explicit root facade retains the complete 0.2 compatibility surface', () => {
  const modules = [
    'constants', 'spawn-env', 'routing', 'paths', 'atomic-json', 'durable-store',
    'route-profile-store', 'service', 'usage-ledger', 'settings-store',
    'direct-cli-config', 'sqlite-runtime', 'proxy/codex-transform', 'web-api',
    'model-policy', 'http-target', 'host-embedding',
  ];
  const expected = new Set([
    'createStore', 'createClaudeHandler', 'parseClaudeProxyUrl',
    'decodeClaudeRoutedModel', 'CPR_MODEL_PREFIX', 'LEGACY_MODEL_PREFIXES',
    'readOfficialOAuthToken', 'createCodexHandler', 'normalizeResponsesUsage',
    'resolveCodexProviderTarget', 'mountClaudeProxy', 'mountCodexProxy',
    'ccSwitchTakeover', 'createCcSwitchGatewayHandler', 'mountCcSwitchGateway',
  ]);
  for (const moduleName of modules) {
    for (const key of Object.keys(require(path.join(root, 'lib', moduleName)))) expected.add(key);
  }
  for (const key of expected) assert.ok(Object.hasOwn(api, key), `missing compatibility export ${key}`);
});

test('every declared package export and type target exists', () => {
  assert.equal(pkg.types, 'types/index.d.ts');
  for (const [subpath, declaration] of Object.entries(pkg.exports)) {
    const targets = typeof declaration === 'string' ? { default: declaration } : declaration;
    for (const [condition, target] of Object.entries(targets)) {
      assert.equal(typeof target, 'string', `${subpath}.${condition}`);
      assert.ok(fs.existsSync(path.join(root, target.replace(/^\.\//, ''))), `missing ${subpath}.${condition}: ${target}`);
    }
  }
});

test('capability descriptor conforms to the shipped JSON schema constraints', () => {
  const schema = require('../schema/capabilities.schema.json');
  const descriptor = { apiVersion: api.API_VERSION, capabilities: api.CAPABILITIES };
  assert.deepEqual(schema.required, ['apiVersion', 'capabilities']);
  assert.deepEqual(Object.keys(descriptor).sort(), Object.keys(schema.properties).sort());
  assert.match(descriptor.apiVersion, new RegExp(schema.properties.apiVersion.pattern));
  for (const value of Object.values(descriptor.capabilities)) {
    assert.match(value, new RegExp(schema.properties.capabilities.additionalProperties.pattern));
  }
});
