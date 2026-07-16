'use strict';

const assert = require('node:assert/strict');
const http = require('http');
const test = require('node:test');

const { createWebServer } = require('../lib/web-api');

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
  const settings = { value: { port: 4567, adminToken: 'must-not-leak' }, getAll() { return this.value; }, update(patch) { this.value = { ...this.value, ...patch }; return this.value; } };
  return { store, routeProfiles, ccSwitch, settings, calls };
}

test('standalone Web serves six sections and enforces loopback, Origin and admin token', async t => {
  const deps = dependencies();
  const web = await createWebServer({ ...deps, ccSwitchOptions: { dbPath: '/fixture/cc-switch.db', proxyBaseUrl: 'http://127.0.0.1:4567' } });
  t.after(() => web.close());

  const page = await request(web.port, '/');
  assert.equal(page.status, 200);
  for (const label of ['Dashboard', 'Providers', 'CC-Switch', 'Agent Routing', 'Usage', 'Settings']) assert.match(page.text, new RegExp(label));
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
