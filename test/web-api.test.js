'use strict';

const assert = require('node:assert/strict');
const http = require('http');
const test = require('node:test');

const { createWebServer } = require('../lib/web-api');
const { sqliteUnavailableError } = require('../lib/sqlite-runtime');

function request(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body == null ? null : JSON.stringify(options.body);
    const req = http.request({
      host: '127.0.0.1', port, path: requestPath, method: options.method || 'GET',
      headers: { ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}), ...(options.headers || {}) },
    }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data,
        json: () => JSON.parse(data) }));
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}

function dependencies() {
  const providers = [{ id: 'p1', appType: 'claude', name: 'Safe', baseUrl: 'https://safe.example', tokenMask: 'abc…xyz' }];
  const store = {
    listProviders: appType => providers.filter(provider => !appType || provider.appType === appType),
    createProvider: input => { const provider = { id: `p${providers.length + 1}`, ...input, settingsConfig: { env: { ANTHROPIC_AUTH_TOKEN: input.authToken } } }; providers.push(provider); return provider; },
    getProviderSummary: (appType, id) => { const p = providers.find(item => item.appType === appType && item.id === id); return p && { id: p.id, appType: p.appType, name: p.name, baseUrl: p.baseUrl, tokenMask: p.authToken ? '***' : p.tokenMask }; },
    deleteProvider: (appType, id) => { const index = providers.findIndex(item => item.appType === appType && item.id === id); if (index < 0) return false; providers.splice(index, 1); return true; },
  };
  const profileRows = [];
  const routeProfiles = {
    list: () => profileRows,
    get: id => profileRows.find(row => row.id === id),
    create: input => { const row = { id: 'r1', createdAt: 1, updatedAt: 1, ...input }; profileRows.push(row); return row; },
    update: (id, input) => Object.assign(profileRows.find(row => row.id === id), input),
    remove: id => { const index = profileRows.findIndex(row => row.id === id); if (index < 0) return false; profileRows.splice(index, 1); return true; },
  };
  const calls = [];
  const ccSwitch = {
    discover: () => ({ found: true, supported: true, liveTakeoverActive: false }),
    status: () => ({ takeover: 'inactive', managed: false }),
    preview: () => ({ canApply: true, changes: [{ appType: 'claude', providerId: 'p1', field: 'env.ANTHROPIC_BASE_URL', original: 'https://safe.example', applied: 'http://127.0.0.1:4567/ccswitch/claude/p1', condition: 'original' }] }),
    snapshot: async () => ({ snapshotId: 's1' }),
    apply: async options => { calls.push(['apply', options]); return { changed: 1, snapshotId: 's1' }; },
    restore: options => { calls.push(['restore', options]); return { changed: 1 }; },
  };
  const directCliConfig = {
    detect: ({ cli }) => [{ cli, configPath: `/home/test/.${cli}/config`, exists: true, active: false, drifted: false, files: [] }],
    status: ({ cli }) => ({ cli, active: false, drifted: false, files: [] }),
    preview: input => ({ cli: input.cli, profileId: input.profileId, proxyBaseUrl: 'http://127.0.0.1:4567', files: [{ path: `/home/test/.${input.cli}/config`, changed: true, beforeSha256: null, afterSha256: 'safe-hash' }] }),
    snapshot: input => { calls.push(['cli-snapshot', input]); return { id: 'native-s1', cli: input.cli, profileId: input.profileId, files: [{ path: '/safe/path', sha256: 'safe-hash' }] }; },
    apply: input => { calls.push(['cli-apply', input]); return { cli: input.cli, profileId: input.profileId, snapshotId: input.snapshotId || 'native-s1' }; },
    restore: input => {
      if (input.snapshotId === 'historical' && !input.force) {
        const error = new Error('historical snapshots require force restore'); error.code = 'RESTORE_FORCE_REQUIRED'; throw error;
      }
      calls.push(['cli-restore', input]); return { cli: input.cli, restored: true, snapshotId: input.snapshotId || 'native-s1', forced: input.force };
    },
  };
  const settings = { value: { port: 4567, adminToken: 'must-not-leak' }, getAll() { return this.value; }, update(patch) { this.value = { ...this.value, ...patch }; return this.value; } };
  return { store, routeProfiles, ccSwitch, directCliConfig, settings, calls };
}

test('standalone Web serves seven sections and enforces loopback, Origin and admin token', async t => {
  const deps = dependencies();
  const web = await createWebServer({ ...deps, ccSwitchOptions: { dbPath: '/fixture/cc-switch.db', proxyBaseUrl: 'http://127.0.0.1:4567' } });
  t.after(() => web.close());

  const page = await request(web.port, '/');
  assert.equal(page.status, 200);
  for (const label of ['Dashboard', 'Providers', 'CLI Config', 'CC-Switch', 'Agent Routing', 'Usage', 'Settings']) assert.match(page.text, new RegExp(label));
  assert.match(page.text, /Works without CC-Switch/);
  assert.match(page.text, /separate from CC-Switch takeover/);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  assert.doesNotMatch(page.text, /<script[^>]*>[^<]/);
  assert.equal((await request(web.port, '/app.js')).status, 200);

  const badHost = await request(web.port, '/api/bootstrap', { headers: { host: 'attacker.example' } });
  assert.equal(badHost.status, 421);
  const badOrigin = await request(web.port, '/api/bootstrap', { headers: { origin: 'https://attacker.example' } });
  assert.equal(badOrigin.status, 403);

  const bootstrap = (await request(web.port, '/api/bootstrap')).json();
  assert.equal(bootstrap.adminToken, web.adminToken);
  assert.ok(bootstrap.adminToken.length >= 32);
  assert.equal((await request(web.port, '/api/providers')).status, 401);
  const auth = { 'x-cpr-admin-token': web.adminToken };
  assert.equal((await request(web.port, '/api/providers', { headers: auth })).json().providers.length, 1);

  const created = await request(web.port, '/api/providers', { method: 'POST', headers: auth, body: { appType: 'claude', name: 'Secret provider', baseUrl: 'https://new.example', authToken: 'top-secret-value' } });
  assert.equal(created.status, 201);
  assert.doesNotMatch(created.text, /top-secret-value/);
  assert.match(created.text, /tokenMask/);

  const settings = await request(web.port, '/api/settings', { headers: auth });
  assert.equal(settings.json().settings.adminToken, '<redacted>');
  const usage = await request(web.port, '/api/usage', { headers: auth });
  assert.deepEqual(usage.json(), { available: false, reason: 'usage-ledger-not-configured' });
});

test('native CLI config APIs work without CC-Switch and require exact confirmations', async t => {
  const deps = dependencies();
  delete deps.ccSwitch;
  const web = await createWebServer({ ...deps, proxyBaseUrl: 'http://127.0.0.1:4567' });
  t.after(() => web.close());
  const auth = { 'x-cpr-admin-token': web.adminToken };

  const bootstrap = (await request(web.port, '/api/bootstrap')).json();
  assert.equal(bootstrap.capabilities.ccSwitch, false);
  assert.equal(bootstrap.capabilities.directCliConfig, true);
  assert.equal((await request(web.port, '/api/cli-config/detect?cli=claude', { headers: auth })).status, 200);
  assert.equal((await request(web.port, '/api/cli-config/status?cli=bad', { headers: auth })).status, 400);

  const route = await request(web.port, '/api/routes', { method: 'POST', headers: auth, body: {
    name: 'Native Claude', cli: 'claude', routes: { main: { providerId: 'p1' } },
  } });
  const profileId = route.json().profile.id;
  const preview = await request(web.port, '/api/cli-config/preview', { method: 'POST', headers: auth, body: { cli: 'claude', profileId } });
  assert.equal(preview.status, 200);
  assert.doesNotMatch(preview.text, /contentBase64|top-secret|ANTHROPIC_AUTH_TOKEN/);

  for (const endpoint of ['snapshot', 'apply', 'restore']) {
    const denied = await request(web.port, `/api/cli-config/${endpoint}`, { method: 'POST', headers: auth, body: { cli: 'claude', profileId } });
    assert.equal(denied.status, 400);
  }
  const snapshot = await request(web.port, '/api/cli-config/snapshot', { method: 'POST', headers: auth, body: { cli: 'claude', profileId, confirmation: 'CREATE CLI SNAPSHOT' } });
  assert.equal(snapshot.status, 201);
  assert.doesNotMatch(snapshot.text, /contentBase64|token/i);
  const applied = await request(web.port, '/api/cli-config/apply', { method: 'POST', headers: auth, body: { cli: 'claude', profileId, snapshotId: 'native-s1', confirmation: 'APPLY CLI TAKEOVER' } });
  assert.equal(applied.status, 200);
  const forceWrong = await request(web.port, '/api/cli-config/restore', { method: 'POST', headers: auth, body: { cli: 'claude', force: true, confirmation: 'RESTORE CLI CONFIG' } });
  assert.equal(forceWrong.status, 400);
  const forceRequired = await request(web.port, '/api/cli-config/restore', { method: 'POST', headers: auth, body: { cli: 'claude', snapshotId: 'historical', confirmation: 'RESTORE CLI CONFIG' } });
  assert.equal(forceRequired.status, 409);
  assert.match(forceRequired.json().message, /require force restore/);
  const forced = await request(web.port, '/api/cli-config/restore', { method: 'POST', headers: auth, body: { cli: 'claude', force: true, confirmation: 'FORCE RESTORE CLI CONFIG' } });
  assert.equal(forced.status, 200);
  assert.equal(deps.calls.some(call => call[0] === 'cli-apply'), true);
  assert.equal(deps.calls.some(call => call[0] === 'cli-restore' && call[1].force), true);
});

test('CC-Switch dangerous writes require preview-oriented confirmation and route roles are constrained', async t => {
  const deps = dependencies();
  const usageLedger = { query: async filters => [{ role: filters.role, protocol: 'openai-responses', tokens: { input: 12, output: 3, total: 15 } }], rollup: async () => [{ inputTokens: 12 }] };
  const web = await createWebServer({ ...deps, usageLedger, ccSwitchOptions: { dbPath: '/fixture/cc-switch.db', proxyBaseUrl: 'http://127.0.0.1:4567' } });
  t.after(() => web.close());
  const auth = { 'x-cpr-admin-token': web.adminToken };

  assert.equal((await request(web.port, '/api/ccswitch/preview', { method: 'POST', headers: auth, body: {} })).json().canApply, true);
  assert.equal((await request(web.port, '/api/ccswitch/apply', { method: 'POST', headers: auth, body: {} })).status, 400);
  const applied = await request(web.port, '/api/ccswitch/apply', { method: 'POST', headers: auth, body: { confirmation: 'APPLY TAKEOVER' } });
  assert.equal(applied.status, 200);
  assert.equal(deps.calls[0][0], 'apply');

  const claude = await request(web.port, '/api/routes', { method: 'POST', headers: auth, body: {
    name: 'Claude split', cli: 'claude', routes: { main: { providerId: 'p1' }, sub: { providerId: 'p2', model: 'sonnet' } },
  } });
  assert.equal(claude.status, 201);
  assert.equal(claude.json().profile.routes.sub.providerId, 'p2');
  const codex = await request(web.port, '/api/routes', { method: 'POST', headers: auth, body: {
    name: 'Codex roles', cli: 'codex', routes: { main: { providerId: 'p1' }, default: { providerId: 'p2' }, worker: { providerId: 'p3' }, explorer: { providerId: 'p4' } },
  } });
  assert.equal(codex.status, 201);
  assert.deepEqual(Object.keys(codex.json().profile.routes), ['main', 'default', 'worker', 'explorer']);
  const invalid = await request(web.port, '/api/routes', { method: 'POST', headers: auth, body: {
    name: 'Bad', cli: 'codex', routes: { arbitrary: { providerId: 'p1' } },
  } });
  assert.equal(invalid.status, 400);
  const usage = await request(web.port, '/api/usage?role=worker', { headers: auth });
  assert.deepEqual(usage.json(), { available: true, data: [{ role: 'worker', protocol: 'openai-responses', tokens: { input: 12, output: 3, total: 15 } }] });
  const summary = await request(web.port, '/api/usage/summary', { headers: auth });
  assert.deepEqual(summary.json(), { available: true, data: [{ inputTokens: 12 }] });
});

test('CC-Switch Web status sanitizes a lazy SQLite binding failure and exposes repair guidance', async t => {
  const deps = dependencies();
  const fail = () => { throw sqliteUnavailableError('native-binding-unavailable'); };
  deps.ccSwitch = { discover: fail, status: fail, preview: fail, snapshot: fail, apply: fail, restore: fail };
  const web = await createWebServer({ ...deps, ccSwitchOptions: { dbPath: '/fixture/cc-switch.db', proxyBaseUrl: 'http://127.0.0.1:4567' } });
  t.after(() => web.close());
  const auth = { 'x-cpr-admin-token': web.adminToken };

  for (const endpoint of ['/api/ccswitch/detect', '/api/ccswitch/status']) {
    const response = await request(web.port, endpoint, { headers: auth });
    assert.equal(response.status, 200);
    assert.equal(response.json().available, false);
    assert.equal(response.json().error, 'SQLITE_UNAVAILABLE');
    assert.equal(response.json().repair, 'npm rebuild better-sqlite3');
    assert.doesNotMatch(response.text, /bindings file|better_sqlite3\.node|node_modules/i);
  }

  const dashboard = await request(web.port, '/api/dashboard', { headers: auth });
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.json().ccSwitch.error, 'SQLITE_UNAVAILABLE');
  assert.equal(dashboard.json().ccSwitch.repair, 'npm rebuild better-sqlite3');
  assert.doesNotMatch(dashboard.text, /bindings file|better_sqlite3\.node|node_modules/i);

  const snapshot = await request(web.port, '/api/ccswitch/snapshot', {
    method: 'POST', headers: auth, body: { confirmation: 'CREATE SNAPSHOT' },
  });
  assert.equal(snapshot.status, 503);
  assert.equal(snapshot.json().error, 'SQLITE_UNAVAILABLE');
  assert.equal(snapshot.json().repair, 'npm rebuild better-sqlite3');
  assert.doesNotMatch(snapshot.text, /bindings file|better_sqlite3\.node|node_modules/i);
});
