'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { execFileSync } = require('child_process');
const { test } = require('node:test');

const cpr = require('../lib');

function temporaryHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-usage-')); }
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

test('usage ledger is idempotent, private, queryable, and never persists content', () => {
  const home = temporaryHome();
  try {
    const ledger = cpr.createUsageLedger({ cprHome: home });
    const common = {
      eventId: 'evt-1',
      occurredAt: Date.parse('2026-07-15T10:00:00Z'),
      externalSessionId: 'external-session',
      role: 'sub',
      providerId: 'provider-1',
      providerName: 'Provider One',
      model: 'model-1',
      protocol: 'anthropic-messages',
      tokens: { input: 10, output: 4, cacheRead: 3, cacheWrite: 2 },
      latencyMs: 125,
      status: 'success',
      source: 'exact',
      prompt: 'must never persist',
      response: 'must never persist',
    };
    assert.strictEqual(ledger.append(common).inserted, true);
    assert.strictEqual(ledger.append(common).inserted, false);
    ledger.append({ ...common, eventId: 'evt-2', role: 'main', providerId: 'provider-2', model: 'model-2', source: 'reconciled' });
    const events = ledger.query({ from: '2026-07-15', to: '2026-07-15', session: 'external-session' });
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].prompt, undefined);
    assert.strictEqual(events[0].response, undefined);
    assert.deepStrictEqual(events[0].tokens, { input: 10, output: 4, cacheRead: 3, cacheWrite: 2, total: 14 });
    assert.strictEqual(ledger.query({ role: 'sub', provider: 'provider-1', model: 'model-1' }).length, 1);
    const total = ledger.rollup({}, [])[0];
    assert.strictEqual(total.events, 2);
    assert.strictEqual(total.totalTokens, 28);
    assert.strictEqual(total.exactEvents, 1);
    assert.strictEqual(total.reconciledEvents, 1);
    const byDateAndRole = ledger.rollup({}, ['date', 'role']);
    assert.deepStrictEqual(byDateAndRole.map(row => [row.date, row.role]), [['2026-07-15', 'sub'], ['2026-07-15', 'main']]);
    const shard = fs.readdirSync(path.join(home, 'data', 'usage')).find(name => name.endsWith('.jsonl'));
    const shardPath = path.join(home, 'data', 'usage', shard);
    assert.strictEqual(fs.statSync(shardPath).mode & 0o777, 0o600);
    assert.doesNotMatch(fs.readFileSync(shardPath, 'utf8'), /must never persist/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('unobservable direct usage has no fabricated tokens and reconciled usage is explicit', () => {
  const home = temporaryHome();
  try {
    const ledger = cpr.createUsageLedger({ cprHome: home });
    ledger.recordUnobservable({
      eventId: 'official-direct', externalSessionId: 's1', role: 'main',
      providerId: 'claude-official', model: 'opus', protocol: 'official-direct', latencyMs: 0,
    });
    const direct = ledger.query()[0];
    assert.strictEqual(direct.status, 'unobservable');
    assert.strictEqual(direct.tokens, null);
    assert.throws(() => ledger.append({
      eventId: 'bad', externalSessionId: 's1', role: 'main', providerId: 'official',
      protocol: 'official-direct', status: 'unobservable', tokens: { input: 1 },
    }), /must not contain token counts/);
    ledger.append({
      eventId: 'reconciled', externalSessionId: 's1', role: 'main', providerId: 'official',
      model: 'opus', protocol: 'official-direct', status: 'success', source: 'reconciled',
      tokens: { input: 5, output: 2 }, latencyMs: 0,
    });
    const total = ledger.rollup({})[0];
    assert.strictEqual(total.unobservableEvents, 1);
    assert.strictEqual(total.totalTokens, 7);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('retention policy prunes only complete expired daily shards', () => {
  const home = temporaryHome();
  try {
    const ledger = cpr.createUsageLedger({ cprHome: home });
    const base = { externalSessionId: 's', role: 'aux', providerId: 'p', model: 'm', protocol: 'openai-responses', tokens: { input: 1, output: 1 }, latencyMs: 1 };
    ledger.append({ ...base, eventId: 'old', occurredAt: Date.parse('2026-01-01T12:00:00Z') });
    ledger.append({ ...base, eventId: 'new', occurredAt: Date.parse('2026-01-10T12:00:00Z') });
    assert.strictEqual(ledger.setRetentionDays(5).retentionDays, 5);
    const dry = ledger.prune({ now: Date.parse('2026-01-12T12:00:00Z'), dryRun: true });
    assert.strictEqual(dry.removedCount, 1);
    assert.strictEqual(ledger.query().length, 2);
    ledger.prune({ now: Date.parse('2026-01-12T12:00:00Z') });
    assert.deepStrictEqual(ledger.query().map(event => event.eventId), ['new']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('usage CLI returns JSON summaries and manages retention', () => {
  const home = temporaryHome();
  try {
    const ledger = cpr.createUsageLedger({ cprHome: home });
    ledger.append({
      eventId: 'cli-event', externalSessionId: 'cli-session', role: 'main',
      providerId: 'cli-provider', model: 'cli-model', protocol: 'anthropic-messages',
      tokens: { input: 8, output: 3, cacheRead: 2, cacheWrite: 1 }, latencyMs: 20,
    });
    const cli = path.join(__dirname, '..', 'cli', 'index.js');
    const env = { ...process.env, CPR_HOME: home };
    const summary = JSON.parse(execFileSync(process.execPath, [cli, 'usage', 'summary', '--session', 'cli-session', '--json'], { env, encoding: 'utf8' }));
    assert.strictEqual(summary.total.totalTokens, 11);
    assert.strictEqual(summary.byProvider[0].providerId, 'cli-provider');
    const policy = JSON.parse(execFileSync(process.execPath, [cli, 'usage', 'retention', '--days', '30', '--json'], { env, encoding: 'utf8' }));
    assert.strictEqual(policy.retentionDays, 30);
    const cleaned = JSON.parse(execFileSync(process.execPath, [cli, 'usage', 'clean', '--dry-run', '--json'], { env, encoding: 'utf8' }));
    assert.strictEqual(cleaned.dryRun, true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('standalone proxy records exact usage and survives a service restart', async () => {
  const home = temporaryHome();
  const paths = cpr.ensureCprPaths(cpr.createCprPaths({ home }));
  const upstreamPort = await freePort();
  const servicePort = await freePort();
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg', type: 'message', model: 'wire-model', usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 }, content: [] }));
  });
  await new Promise((resolve, reject) => upstream.listen(upstreamPort, '127.0.0.1', error => error ? reject(error) : resolve()));
  const store = cpr.createStore({ paths });
  const provider = store.createProvider({ appType: 'claude', name: 'Usage Relay', baseUrl: `http://127.0.0.1:${upstreamPort}`, authToken: 'secret', model: 'wire-model' });
  const controller = cpr.createServiceController({ paths, runner: path.join(__dirname, '..', 'cli', 'proxy-server.js'), port: servicePort });
  const hop = cpr.createHopCredentialStore({ paths });
  const credential = hop.issue({
    cli: 'claude', providerId: provider.id, sessionId: 'external-42',
    roleKind: 'main', routeName: 'main',
  });
  try {
    await controller.start({ port: servicePort, timeoutMs: 8000 });
    const response = await fetch(`http://127.0.0.1:${servicePort}/claude-proxy/${provider.id}/external-42/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${credential.token}` },
      body: JSON.stringify({ model: 'wire-model', messages: [], max_tokens: 1 }),
    });
    assert.strictEqual(response.status, 200);
    await response.text();
    await new Promise(resolve => setTimeout(resolve, 100));
    await controller.restart({ port: servicePort, timeoutMs: 8000 });
    await controller.stop({ timeoutMs: 8000 });
    const events = cpr.createUsageLedger({ paths }).query({ session: 'external-42' });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].source, 'exact');
    assert.strictEqual(events[0].protocol, 'anthropic-messages');
    assert.deepStrictEqual(events[0].tokens, { input: 12, output: 7, cacheRead: 4, cacheWrite: 2, total: 19 });
    assert.ok(events[0].latencyMs >= 0);
  } finally {
    await controller.stop({ timeoutMs: 8000 }).catch(() => {});
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
