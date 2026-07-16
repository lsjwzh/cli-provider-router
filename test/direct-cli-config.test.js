'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const TOML = require('@iarna/toml');
const { createCprPaths } = require('../lib/paths');
const { createDirectCliConfigManager, LOCAL_BEARER_TOKEN } = require('../lib/direct-cli-config');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-direct-config-'));
  const home = path.join(root, 'user');
  const cprHome = path.join(root, 'cpr');
  fs.mkdirSync(home, { recursive: true });
  const providers = {
    'claude:claude-main': {
      id: 'claude-main',
      settingsConfig: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://main.invalid', ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_MODEL: 'claude-main-model' } }),
    },
    'claude:claude-sub': {
      id: 'claude-sub',
      settingsConfig: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://sub.invalid', ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_MODEL: 'claude-sub-model' } }),
    },
    'codex:codex-main': {
      id: 'codex-main',
      settingsConfig: JSON.stringify({ config: 'model_provider = "upstream"\nmodel = "gpt-main"\n[model_providers.upstream]\nbase_url = "https://main.invalid/v1"\n' }),
    },
    'codex:codex-sub': {
      id: 'codex-sub',
      settingsConfig: JSON.stringify({ config: 'model_provider = "upstream"\nmodel = "gpt-sub"\n[model_providers.upstream]\nbase_url = "https://sub.invalid/v1"\n' }),
    },
  };
  const profiles = {
    claude: {
      id: 'claude-profile', name: 'Claude direct', cli: 'claude', enabled: true,
      main: { providerId: 'claude-main' }, subagent: { providerId: 'claude-sub', model: 'claude-sub-custom' }, roles: {},
    },
    codex: {
      id: 'codex-profile', name: 'Codex direct', cli: 'codex', enabled: true,
      main: { providerId: 'codex-main' }, subagent: { providerId: 'codex-sub', model: 'gpt-sub-custom' },
      roles: { explorer: { providerId: 'codex-main', model: 'gpt-explorer' }, reviewer: { providerId: 'codex-sub', model: 'gpt-reviewer' } },
    },
  };
  const manager = createDirectCliConfigManager({
    paths: createCprPaths({ home: cprHome }),
    home,
    proxyBaseUrl: 'http://127.0.0.1:9876',
    store: { getProvider(cli, id) { return providers[`${cli}:${id}`] || null; } },
    profiles: { get(id) { return Object.values(profiles).find(profile => profile.id === id) || null; } },
  });
  return { root, home, cprHome, manager, profiles };
}

function cleanup(value) { fs.rmSync(value.root, { recursive: true, force: true }); }

test('direct takeover discovers absent native configs without CC-Switch', () => {
  const f = fixture();
  try {
    const found = f.manager.discover();
    assert.deepEqual(found.map(item => [item.cli, item.exists, item.active]), [['claude', false, false], ['codex', false, false]]);
    assert.ok(f.manager.paths.stateDir.startsWith(f.cprHome));
    assert.ok(f.manager.paths.snapshotsDir.startsWith(f.cprHome));
  } finally { cleanup(f); }
});

test('Claude takeover preserves unrelated settings and restores an existing file exactly', () => {
  const f = fixture();
  try {
    const file = path.join(f.home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = JSON.stringify({ permissions: { allow: ['Read'] }, env: { KEEP_ME: 'yes', ANTHROPIC_API_KEY: 'old-secret', ANTHROPIC_MODEL: 'old-model' } }, null, 2) + '\n';
    fs.writeFileSync(file, original);
    const snap = f.manager.snapshot({ cli: 'claude', profileId: f.profiles.claude.id });
    const preview = f.manager.preview({ cli: 'claude', profileId: f.profiles.claude.id });
    assert.equal(preview.files.length, 1);
    assert.equal(preview.files[0].changed, true);
    const applied = f.manager.apply({ cli: 'claude', profileId: f.profiles.claude.id, snapshotId: snap.id });
    assert.equal(applied.requiresEnv.length, 0);
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(settings.permissions, { allow: ['Read'] });
    assert.equal(settings.env.KEEP_ME, 'yes');
    assert.equal(settings.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(settings.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9876/claude-proxy/claude-main/direct-claude-profile');
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'cpr-direct-claude-profile');
    assert.equal(settings.env.ANTHROPIC_MODEL, 'claude-main-model');
    assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, 'cpr:claude-sub:claude-sub-custom');
    assert.equal(f.manager.status({ cli: 'claude' }).drifted, false);
    assert.equal(f.manager.apply({ cli: 'claude', profileId: f.profiles.claude.id }).idempotent, true);
    f.manager.restore({ cli: 'claude' });
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(f.manager.status({ cli: 'claude' }).active, false);
  } finally { cleanup(f); }
});

test('Claude takeover restores an originally absent settings file to absent', () => {
  const f = fixture();
  try {
    const file = path.join(f.home, '.claude', 'settings.json');
    const applied = f.manager.apply({ cli: 'claude', profileId: f.profiles.claude.id });
    assert.ok(applied.snapshotId);
    assert.equal(fs.existsSync(file), true);
    f.manager.restore({ cli: 'claude' });
    assert.equal(fs.existsSync(file), false);
  } finally { cleanup(f); }
});

test('Codex takeover preserves unrelated TOML, creates routed roles, never touches auth.json, and restores', () => {
  const f = fixture();
  try {
    const codex = path.join(f.home, '.codex');
    const configFile = path.join(codex, 'config.toml');
    const authFile = path.join(codex, 'auth.json');
    const explorerFile = path.join(codex, 'agents', 'explorer.toml');
    fs.mkdirSync(path.dirname(explorerFile), { recursive: true });
    const originalConfig = 'approval_policy = "on-request"\nmodel_provider = "old"\nmodel = "old-model"\n[model_providers.old]\nbase_url = "https://old.invalid/v1"\n';
    const originalExplorer = 'name = "my explorer"\ndeveloper_instructions = "personal"\n';
    const originalAuth = '{"OPENAI_API_KEY":"real-secret"}\n';
    fs.writeFileSync(configFile, originalConfig);
    fs.writeFileSync(explorerFile, originalExplorer);
    fs.writeFileSync(authFile, originalAuth);
    const applied = f.manager.apply({ cli: 'codex', profileId: f.profiles.codex.id });
    assert.deepEqual(applied.requiresEnv, []);
    const config = TOML.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(config.approval_policy, 'on-request');
    assert.equal(config.model_provider, 'cpr_direct_main');
    assert.equal(config.model, 'gpt-main');
    assert.equal(config.features.multi_agent, true);
    assert.equal(config.model_providers.old.base_url, 'https://old.invalid/v1');
    assert.equal(config.model_providers.cpr_direct_main.experimental_bearer_token, LOCAL_BEARER_TOKEN);
    assert.equal(config.model_providers.cpr_direct_main.env_key, undefined);
    assert.equal(config.model_providers.cpr_direct_main.base_url, 'http://127.0.0.1:9876/codex-proxy/codex-main/direct-codex-profile/main');
    assert.equal(config.model_providers.cpr_direct_role_explorer.base_url, 'http://127.0.0.1:9876/codex-proxy/codex-main/direct-codex-profile/explorer');
    assert.equal(config.model_providers.cpr_direct_role_reviewer.base_url, 'http://127.0.0.1:9876/codex-proxy/codex-sub/direct-codex-profile/reviewer');
    const explorer = TOML.parse(fs.readFileSync(explorerFile, 'utf8'));
    const reviewer = TOML.parse(fs.readFileSync(path.join(codex, 'agents', 'reviewer.toml'), 'utf8'));
    assert.equal(explorer.model_provider, 'cpr_direct_role_explorer');
    assert.equal(explorer.model, 'gpt-explorer');
    assert.equal(reviewer.model, 'gpt-reviewer');
    assert.equal(fs.readFileSync(authFile, 'utf8'), originalAuth);
    f.manager.restore({ cli: 'codex' });
    assert.equal(fs.readFileSync(configFile, 'utf8'), originalConfig);
    assert.equal(fs.readFileSync(explorerFile, 'utf8'), originalExplorer);
    assert.equal(fs.existsSync(path.join(codex, 'agents', 'reviewer.toml')), false);
    assert.equal(fs.readFileSync(authFile, 'utf8'), originalAuth);
  } finally { cleanup(f); }
});

test('restore refuses drift by default and force restores snapshot', () => {
  const f = fixture();
  try {
    const file = path.join(f.home, '.claude', 'settings.json');
    f.manager.apply({ cli: 'claude', profileId: f.profiles.claude.id });
    const changed = JSON.parse(fs.readFileSync(file, 'utf8'));
    changed.userEdit = true;
    fs.writeFileSync(file, JSON.stringify(changed, null, 2) + '\n');
    assert.equal(f.manager.status({ cli: 'claude' }).drifted, true);
    assert.throws(() => f.manager.restore({ cli: 'claude' }), error => error.code === 'CONFIG_DRIFT' && /drifted/.test(error.message));
    assert.equal(fs.existsSync(file), true);
    f.manager.restore({ cli: 'claude', force: true });
    assert.equal(fs.existsSync(file), false);
  } finally { cleanup(f); }
});

test('snapshots and state use private permissions and reject traversal ids', () => {
  const f = fixture();
  try {
    assert.throws(() => f.manager.snapshot({ cli: 'claude', profileId: '../profile' }), /invalid profile id/);
    const result = f.manager.apply({ cli: 'claude', profileId: f.profiles.claude.id });
    const manifest = path.join(f.manager.paths.snapshotsDir, result.snapshotId, 'manifest.json');
    const state = path.join(f.manager.paths.stateDir, 'claude.json');
    assert.equal(fs.statSync(path.dirname(manifest)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(manifest).mode & 0o777, 0o600);
    assert.equal(fs.statSync(state).mode & 0o777, 0o600);
  } finally { cleanup(f); }
});
