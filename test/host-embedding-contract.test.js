'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepareSessionRouting } = require('../lib/host-embedding');

function claudeProvider(id, model = 'claude-wire') {
  return {
    id, appType: 'claude', name: id,
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: `https://${id}.example/v1`,
        ANTHROPIC_AUTH_TOKEN: `${id}-upstream-secret`,
        ANTHROPIC_MODEL: model,
      },
    },
  };
}

function codexProvider(id, model = `${id}-model`) {
  return {
    id, appType: 'codex', name: id,
    settingsConfig: {
      auth: { OPENAI_API_KEY: `${id}-upstream-secret` },
      config: [
        'model_provider = "custom"',
        `model = "${model}"`,
        '[model_providers.custom]',
        `name = "${id}"`,
        `base_url = "https://${id}.example/v1"`,
        'wire_api = "responses"',
        'requires_openai_auth = true',
        '',
      ].join('\n'),
    },
  };
}

function memoryStore(providers) {
  return {
    getProvider(appType, id) {
      const provider = providers[id];
      return provider && provider.appType === appType ? provider : null;
    },
  };
}

test('Claude preparation uses one managed bundle, the injected store, usage sink, and revoke', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-host-claude-'));
  let clock = 10_000;
  const providers = {
    main: claudeProvider('main', 'main-model'),
    delegate: claudeProvider('delegate', 'delegate-model'),
  };
  const store = memoryStore(providers);
  const usageEvents = [];
  try {
    const prepared = prepareSessionRouting({
      cli: 'claude', externalSessionId: 'host-job-42',
      main: { providerId: 'main', model: 'main-model' },
      subagent: { providerId: 'delegate', model: 'delegate-model' },
      store,
      usage: event => usageEvents.push(event),
      managedCredentialPath: path.join(root, 'credentials', 'routes.json'),
      codexHomesDir: path.join(root, 'codex-homes'),
      proxyBaseUrl: 'http://host-proxy.local:9123',
      claudeProxyPath: '/host-claude',
      modelPrefix: 'host:',
      baseEnv: { HOME: path.join(root, 'isolated-home'), ANTHROPIC_API_KEY: 'leaked' },
      now: () => clock,
      credentialTtlMs: 100,
    });

    assert.equal(prepared.env.ANTHROPIC_BASE_URL, 'http://host-proxy.local:9123/host-claude/main/host-job-42');
    assert.equal(prepared.env.ANTHROPIC_AUTH_TOKEN, prepared.credential.token);
    assert.equal(prepared.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(prepared.env.CLAUDE_CODE_SUBAGENT_MODEL, 'host:delegate:delegate-model');
    assert.deepEqual(prepared.routes.map(route => [route.role, route.providerId]), [
      ['main', 'main'], ['default', 'delegate'],
    ]);
    assert.equal(prepared.proxy.getProvider('claude', 'main'), providers.main);
    assert.equal(prepared.proxy.store, store);
    assert.equal(prepared.proxy.requireHopCredential, true);
    assert.equal(prepared.proxy.claudeProxyPath, '/host-claude');
    assert.equal(prepared.proxy.modelPrefix, 'host:');

    const mainRoute = {
      cli: 'claude', providerId: 'main', sessionId: 'host-job-42',
      roleKind: 'main', routeName: 'main',
    };
    assert.equal(prepared.proxy.hopCredentials.verify(mainRoute, prepared.credential.token).reason, 'valid');
    assert.equal(prepared.proxy.hopCredentials.verify(mainRoute, 'wrong-token').reason, 'mismatch');
    clock += 101;
    assert.equal(prepared.proxy.hopCredentials.verify(mainRoute, prepared.credential.token).reason, 'expired');

    prepared.proxy.onUsageEvent({
      externalSessionId: 'host-job-42', roleKind: 'sub', agentRole: 'default', routeName: 'default',
      providerId: 'delegate', model: 'delegate-model', protocol: 'anthropic-messages',
    });
    assert.equal(usageEvents.length, 1);
    assert.equal(usageEvents[0].externalSessionId, 'host-job-42');
    assert.equal(prepared.revoke('test-finished').revoked, 2);
    assert.equal(prepared.proxy.hopCredentials.verify(mainRoute, prepared.credential.token).reason, 'revoked');
    assert.deepEqual(prepared.revoke(), { revoked: 0, alreadyRevoked: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex preparation materializes injected CODEX_HOME and preserves named role usage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-host-codex-'));
  const codexHomesDir = path.join(root, 'owned-codex-homes');
  const providers = {
    main: codexProvider('main', 'main-provider-model'),
    general: codexProvider('general', 'general-model'),
    worker: codexProvider('worker', 'worker-model'),
    explorer: codexProvider('explorer', 'explorer-model'),
  };
  const usageEvents = [];
  try {
    const prepared = prepareSessionRouting({
      cli: 'codex', sessionId: 'host-codex-7',
      main: { providerId: 'main', model: 'main-override' },
      subagents: {
        default: { providerId: 'general', model: 'general-override' },
        worker: { providerId: 'worker', model: 'worker-override' },
        explorer: { providerId: 'explorer', model: 'explorer-override' },
      },
      store: memoryStore(providers),
      usage: { recordProxyUsage: event => usageEvents.push(event) },
      managedCredentialPath: path.join(root, 'managed', 'credentials.json'),
      codexHomesDir,
      proxyBaseUrl: 'http://host-proxy.local:9444',
      codexProxyPath: '/host-codex',
      baseEnv: { HOME: path.join(root, 'isolated-home') },
    });

    const codexHome = path.join(codexHomesDir, 'main');
    assert.equal(prepared.env.CODEX_HOME, codexHome);
    const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(config, /model = "main-override"/);
    assert.match(config, /host-proxy\.local:9444\/host-codex\/main\/host-codex-7\/main/);
    assert.match(config, /host-proxy\.local:9444\/host-codex\/general\/host-codex-7\/default/);
    assert.match(config, /host-proxy\.local:9444\/host-codex\/worker\/host-codex-7\/worker/);
    assert.match(config, /host-proxy\.local:9444\/host-codex\/explorer\/host-codex-7\/explorer/);
    assert.equal(prepared.proxy.codexProxyPath, '/host-codex');
    assert.match(fs.readFileSync(path.join(codexHome, 'agents', 'worker.toml'), 'utf8'), /model_provider = "cpr_subagent_worker"/);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8')).OPENAI_API_KEY,
      prepared.credential.token,
    );

    const workerRoute = {
      cli: 'codex', providerId: 'worker', sessionId: 'host-codex-7',
      roleKind: 'sub', agentRole: 'worker', routeName: 'worker',
    };
    assert.equal(prepared.proxy.hopCredentials.verify(workerRoute, prepared.credential.token).reason, 'valid');
    assert.equal(prepared.proxy.hopCredentials.verify({ ...workerRoute, routeName: 'explorer', agentRole: 'explorer' }, prepared.credential.token).reason, 'unmanaged-route');
    prepared.proxy.onUsageEvent({
      externalSessionId: 'host-codex-7', roleKind: 'sub', agentRole: 'worker', routeName: 'worker',
      providerId: 'worker', model: 'worker-override', protocol: 'openai-responses',
    });
    assert.equal(usageEvents[0].agentRole, 'worker');
    assert.equal(usageEvents[0].routeName, 'worker');
    assert.equal(prepared.revoke().revoked, 4);
    assert.equal(prepared.proxy.hopCredentials.verify(workerRoute, prepared.credential.token).reason, 'revoked');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fully injected embedding dependencies do not create default CPR_HOME', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-host-isolated-'));
  const isolatedHome = path.join(root, 'home');
  const owned = path.join(root, 'owned');
  fs.mkdirSync(isolatedHome, { recursive: true });
  fs.mkdirSync(owned, { recursive: true });
  const modulePath = path.join(__dirname, '..', 'lib', 'host-embedding.js');
  const storePath = path.join(__dirname, '..', 'lib', 'store.js');
  const usagePath = path.join(__dirname, '..', 'lib', 'usage-ledger.js');
  const script = `
    const fs = require('fs');
    const path = require('path');
    const { prepareSessionRouting } = require(${JSON.stringify(modulePath)});
    const { createStore } = require(${JSON.stringify(storePath)});
    const { createUsageLedger } = require(${JSON.stringify(usagePath)});
    const root = ${JSON.stringify(owned)};
    const store = createStore({ dataFile: path.join(root, 'providers.json') });
    const provider = store.createProvider({
      appType: 'codex', name: 'Codex Provider', baseUrl: 'https://provider.example/v1',
      authToken: 'upstream', model: 'wire',
    });
    const usage = createUsageLedger({ usageDir: path.join(root, 'usage') });
    const prepared = prepareSessionRouting({
      cli: 'codex', externalSessionId: 'isolated-host', providerId: provider.id,
      store, usage, codexHomesDir: path.join(root, 'codex'),
      managedCredentialPath: path.join(root, 'credentials.json'),
      proxyBaseUrl: 'http://127.0.0.1:9555', baseEnv: { HOME: process.env.HOME },
    });
    if (!prepared.env.CODEX_HOME.startsWith(path.join(root, 'codex'))) process.exit(2);
    if (fs.existsSync(path.join(process.env.HOME, '.cli-provider-router'))) process.exit(3);
  `;
  try {
    execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome },
      stdio: 'pipe',
    });
    assert.equal(fs.existsSync(path.join(isolatedHome, '.cli-provider-router')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
