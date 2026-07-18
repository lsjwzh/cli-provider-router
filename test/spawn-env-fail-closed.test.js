'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const cpr = require('../lib');
const constants = require('../lib/constants');
const directCliConfig = require('../lib/direct-cli-config');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-fail-closed-'));
  const paths = cpr.createCprPaths({ home: path.join(root, 'cpr') });
  const store = cpr.createStore({ dataFile: paths.providersFile, paths });
  return { root, paths, store };
}

function cleanup(f) {
  fs.rmSync(f.root, { recursive: true, force: true });
}

function addCodex(store, name = 'Codex relay') {
  return store.createProvider({
    appType: 'codex',
    name,
    baseUrl: 'https://codex.example/v1',
    authToken: `${name}-upstream-secret`,
    model: 'gpt-wire',
  });
}

test('Claude managed and routing keys derive every alias tier from ALIAS_TIER_KEYS', () => {
  assert.deepEqual(constants.ANTHROPIC_ALIAS_MODEL_KEYS, Object.values(constants.ALIAS_TIER_KEYS));
  assert.deepEqual(
    new Set(constants.ANTHROPIC_ALIAS_MODEL_PRIORITY),
    new Set(constants.ANTHROPIC_ALIAS_MODEL_KEYS),
  );
  assert.ok(constants.ANTHROPIC_ROUTING_KEYS.includes('ANTHROPIC_DEFAULT_FABLE_MODEL'));
  assert.ok(constants.CLAUDE_MANAGED_ENV_KEYS.includes('CLAUDE_CODE_SUBAGENT_MODEL'));
  assert.ok(constants.CLAUDE_ROUTING_KEYS.includes('CLAUDE_CODE_SUBAGENT_MODEL'));
  assert.strictEqual(directCliConfig.CLAUDE_MANAGED_ENV_KEYS, constants.CLAUDE_MANAGED_ENV_KEYS);
  assert.strictEqual(cpr.CLAUDE_MANAGED_ENV_KEYS, constants.CLAUDE_MANAGED_ENV_KEYS);
});

test('Claude provider switches scrub stale fable, subagent, and extra routing selectors', () => {
  const f = fixture();
  try {
    const first = f.store.createProvider({
      appType: 'claude', name: 'Fable relay', baseUrl: 'https://first.example',
      authToken: 'first-secret', aliasMap: { fable: { model: 'fable-wire' } },
    });
    const second = f.store.createProvider({
      appType: 'claude', name: 'Second relay', baseUrl: 'https://second.example',
      authToken: 'second-secret', model: 'second-wire',
    });
    const firstEnv = cpr.buildChildEnv({}, { cli: 'claude', providerId: first.id, store: f.store });
    assert.equal(firstEnv.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'fable-wire');

    const switched = cpr.buildChildEnv(
      { ...firstEnv.env, CLAUDE_CODE_SUBAGENT_MODEL: 'stale-subagent' },
      { cli: 'claude', providerId: second.id, store: f.store },
      { ANTHROPIC_DEFAULT_FABLE_MODEL: 'stale-extra-fable', CLAUDE_CODE_SIMPLE: '1' },
    );
    assert.equal(switched.env.ANTHROPIC_BASE_URL, 'https://second.example');
    assert.equal(switched.env.ANTHROPIC_MODEL, 'second-wire');
    assert.equal(switched.env.ANTHROPIC_DEFAULT_FABLE_MODEL, undefined);
    assert.equal(switched.env.CLAUDE_CODE_SUBAGENT_MODEL, undefined);
    assert.equal(switched.env.CLAUDE_CODE_SIMPLE, undefined);
  } finally { cleanup(f); }
});

test('Codex provider switches scrub inherited and extra global routing credentials', () => {
  const f = fixture();
  try {
    const first = addCodex(f.store, 'First');
    const second = addCodex(f.store, 'Second');
    const firstEnv = cpr.buildChildEnv({}, { cli: 'codex', providerId: first.id, store: f.store });
    const switched = cpr.buildChildEnv(
      { ...firstEnv.env, OPENAI_API_KEY: 'global-key', OPENAI_BASE_URL: 'https://global.example' },
      { cli: 'codex', providerId: second.id, store: f.store },
      { CODEX_HOME: path.join(f.root, 'stale-home'), OPENAI_API_KEY: 'extra-key' },
    );
    assert.notEqual(switched.env.CODEX_HOME, firstEnv.env.CODEX_HOME);
    assert.ok(switched.env.CODEX_HOME.endsWith(second.id));
    assert.equal(switched.env.OPENAI_API_KEY, undefined);
    assert.equal(switched.env.OPENAI_BASE_URL, undefined);

    const defaultLogin = cpr.buildChildEnv(
      { CODEX_HOME: path.join(f.root, 'global-home'), OPENAI_API_KEY: 'global-key' },
      { cli: 'codex', store: f.store },
    );
    assert.equal(defaultLogin.routingStatus, 'default');
    assert.equal(defaultLogin.env.CODEX_HOME, undefined);
    assert.equal(defaultLogin.env.OPENAI_API_KEY, undefined);
  } finally { cleanup(f); }
});

test('Codex auth and config materialization failures throw structured errors by default', async t => {
  for (const target of ['auth.json', 'config.toml']) {
    await t.test(target, () => {
      const f = fixture();
      try {
        const provider = addCodex(f.store, target);
        const home = path.join(f.paths.codexHomesDir, provider.id);
        fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
        fs.mkdirSync(path.join(home, target));
        assert.throws(
          () => cpr.buildChildEnv(
            { CODEX_HOME: path.join(f.root, 'global-home'), OPENAI_API_KEY: 'global-key' },
            { cli: 'codex', providerId: provider.id, store: f.store },
          ),
          error => {
            assert.ok(error instanceof cpr.ProviderRoutingError);
            assert.equal(error.code, 'CODEX_MATERIALIZATION_FAILED');
            assert.equal(error.cli, 'codex');
            assert.equal(error.providerId, provider.id);
            assert.equal(error.stage, target === 'auth.json' ? 'codex-auth' : 'codex-config');
            assert.deepEqual(error.details, {
              cli: 'codex', providerId: provider.id,
              stage: target === 'auth.json' ? 'codex-auth' : 'codex-config',
            });
            return true;
          },
        );
      } finally { cleanup(f); }
    });
  }
});

test('Codex default fallback requires opt-in and emits credential-free state/event', () => {
  const f = fixture();
  try {
    const provider = addCodex(f.store, 'Fallback');
    const home = path.join(f.paths.codexHomesDir, provider.id);
    fs.mkdirSync(path.dirname(home), { recursive: true });
    fs.writeFileSync(home, 'blocks provider home creation');
    const events = [];
    const result = cpr.buildChildEnv(
      {
        CODEX_HOME: path.join(f.root, 'global-home'),
        OPENAI_API_KEY: 'global-account-secret',
        OPENAI_BASE_URL: 'https://global.example',
        KEEP_ME: 'yes',
      },
      {
        cli: 'codex', providerId: provider.id, store: f.store,
        allowDefaultFallback: true,
        onRoutingEvent(event) { events.push(event); },
      },
    );
    assert.equal(result.routingStatus, 'default-fallback');
    assert.equal(result.env.CODEX_HOME, undefined);
    assert.equal(result.env.OPENAI_API_KEY, undefined);
    assert.equal(result.env.OPENAI_BASE_URL, undefined);
    assert.equal(result.env.KEEP_ME, 'yes');
    assert.equal(result.fallback.credentialFree, true);
    assert.equal(result.fallback.reason, 'materialization-failed');
    assert.equal(result.fallback.error.code, 'CODEX_MATERIALIZATION_FAILED');
    assert.deepEqual(events, [result.fallback]);
    const serialized = JSON.stringify({ fallback: result.fallback, events });
    assert.equal(serialized.includes('global-account-secret'), false);
    assert.equal(serialized.includes('upstream-secret'), false);
  } finally { cleanup(f); }
});

test('cpr use aborts before spawn and cannot fall through to a global Codex account', () => {
  const f = fixture();
  try {
    const provider = addCodex(f.store, 'CLI fail closed');
    const providerHome = path.join(f.paths.codexHomesDir, provider.id);
    fs.mkdirSync(path.dirname(providerHome), { recursive: true });
    fs.writeFileSync(providerHome, 'blocks provider home creation');
    const marker = path.join(f.root, 'spawned.txt');
    const cli = path.join(__dirname, '..', 'cli', 'index.js');
    const result = spawnSync(process.execPath, [
      cli, 'use', provider.id, '--app', 'codex', '--',
      process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CPR_HOME: f.paths.home,
        CPR_DATA_FILE: f.paths.providersFile,
        CODEX_HOME: path.join(f.root, 'global-codex-home'),
        OPENAI_API_KEY: 'global-account-secret',
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Failed to materialize Codex provider routing/);
    assert.equal(fs.existsSync(marker), false, 'child command must never start');
  } finally { cleanup(f); }
});
