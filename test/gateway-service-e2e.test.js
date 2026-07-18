'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const cpr = require('../lib');

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function temporaryHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-gateway-')); }
function mode(file) { return fs.statSync(file).mode & 0o777; }
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
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); });
  });
}
function close(server) { return new Promise(resolve => server.close(() => resolve())); }

function request(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const req = http.request({
      host: '127.0.0.1', port, path: requestPath, method: options.method || 'GET', headers: options.headers || {},
    }, res => {
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, chunks, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function writeSnapshot(home, endpoints, state = {}) {
  const snapshotId = 'fixture-snapshot';
  const dir = path.join(home, 'ccswitch', 'snapshots', snapshotId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const backup = Buffer.from('immutable-fixture');
  fs.writeFileSync(path.join(dir, 'cc-switch.db'), backup, { mode: 0o600 });
  const endpointPayload = { version: 1, snapshotId, endpoints, warnings: [] };
  const endpointSerialized = `${JSON.stringify(endpointPayload, null, 2)}\n`;
  fs.writeFileSync(path.join(dir, 'endpoints.json'), endpointSerialized, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({
    version: 1, snapshotId, backupSha256: sha256(backup), endpointMapSha256: sha256(endpointSerialized),
  }, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'ccswitch', 'state.json'), `${JSON.stringify({
    version: 1, status: 'active', snapshotId, proxyBaseUrl: 'http://127.0.0.1:4567', ...state,
  }, null, 2)}\n`, { mode: 0o600 });
}

test('CC-Switch gateway streams immutable snapshot upstream and fails closed on loops/inactive state', async t => {
  const home = temporaryHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const received = {};
  const upstream = http.createServer((req, res) => {
    received.path = req.url;
    received.authorization = req.headers.authorization;
    const body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', () => {
      received.body = Buffer.concat(body).toString('utf8');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream': 'mock' });
      res.write('data: first\n\n');
      setTimeout(() => res.end('data: second\n\n'), 40);
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  writeSnapshot(home, [
    { kind: 'provider-setting', appType: 'claude', providerId: 'safe', upstream: `http://upstream.invalid:${upstreamPort}/api/base` },
    { kind: 'provider-endpoint', appType: 'claude', providerId: 'safe', rowId: 7, upstream: `http://upstream.invalid:${upstreamPort}/endpoint-base` },
    { kind: 'provider-setting', appType: 'claude', providerId: 'loop', upstream: `http://127.0.0.1:${upstreamPort}/self` },
  ]);

  const app = express();
  cpr.mountCcSwitchGateway(app, {
    home,
    requestFactory(target, options, callback) {
      return http.request({ ...options, hostname: '127.0.0.1', port: upstreamPort, protocol: 'http:', path: target.pathname + target.search }, callback);
    },
  });
  app.use(express.json());
  const gateway = http.createServer(app);
  const gatewayPort = await listen(gateway);
  t.after(() => close(gateway));

  const streamed = await request(gatewayPort, '/ccswitch/claude/safe/v1/messages?beta=true', {
    method: 'POST', body: '{"stream":true}',
    headers: { authorization: 'Bearer snapshot-auth', 'content-type': 'application/json', 'content-length': '15' },
  });
  assert.equal(streamed.status, 200);
  assert.equal(streamed.headers['x-upstream'], 'mock');
  assert.ok(streamed.chunks.length >= 2, 'response should be forwarded incrementally');
  assert.equal(streamed.text, 'data: first\n\ndata: second\n\n');
  assert.equal(received.path, '/api/base/v1/messages?beta=true');
  assert.equal(received.authorization, 'Bearer snapshot-auth');
  assert.equal(received.body, '{"stream":true}');

  const endpoint = await request(gatewayPort, '/ccswitch/claude/safe/endpoint/7/responses?mode=row', {
    method: 'POST', body: '{}', headers: { authorization: 'Bearer row-auth', 'content-length': '2' },
  });
  assert.equal(endpoint.status, 200);
  assert.equal(received.path, '/endpoint-base/responses?mode=row');
  assert.equal(received.authorization, 'Bearer row-auth');

  const loop = await request(gatewayPort, '/ccswitch/claude/loop/v1/messages');
  assert.equal(loop.status, 508);
  assert.match(loop.text, /UPSTREAM_LOOP/);

  const stateFile = path.join(home, 'ccswitch', 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, status: 'restored' }));
  const inactive = await request(gatewayPort, '/ccswitch/claude/safe/v1/messages');
  assert.equal(inactive.status, 503);
  assert.match(inactive.text, /TAKEOVER_NOT_ACTIVE/);
});

test('managed service starts proxy and Web together, preserves token across restart, and stops both', async t => {
  const home = temporaryHome();
  const paths = cpr.ensureCprPaths(cpr.createCprPaths({ home }));
  const runner = path.join(__dirname, '..', 'cli', 'proxy-server.js');
  const proxyPort = await freePort();
  let webPort = await freePort();
  while (webPort === proxyPort) webPort = await freePort();
  const controller = cpr.createServiceController({ paths, runner, port: proxyPort, webPort });
  t.after(async () => {
    await controller.stop({ timeoutMs: 8000 }).catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  });

  const started = await controller.start({ port: proxyPort, webPort, timeoutMs: 8000 });
  assert.equal(started.running, true);
  assert.equal(started.webPort, webPort);
  assert.equal(started.health.webUrl, `http://127.0.0.1:${webPort}`);
  if (process.platform !== 'win32') assert.equal(mode(paths.adminTokenFile), 0o600);
  const token = fs.readFileSync(paths.adminTokenFile, 'utf8').trim();
  assert.ok(token.length >= 32);

  const bootstrap = await request(webPort, '/api/bootstrap');
  assert.equal(bootstrap.status, 200);
  assert.equal(JSON.parse(bootstrap.text).adminToken, token);
  const providers = await request(webPort, '/api/providers', { headers: { 'x-cpr-admin-token': token } });
  assert.equal(providers.status, 200);
  assert.ok(Array.isArray(JSON.parse(providers.text).providers));

  const restarted = await controller.restart({ port: proxyPort, webPort, timeoutMs: 8000 });
  assert.notEqual(restarted.pid, started.pid);
  assert.equal(fs.readFileSync(paths.adminTokenFile, 'utf8').trim(), token);
  assert.equal((await request(proxyPort, '/health')).status, 200);
  assert.equal((await request(webPort, '/health')).status, 200);

  await controller.stop({ timeoutMs: 8000 });
  await assert.rejects(request(proxyPort, '/health'));
  await assert.rejects(request(webPort, '/health'));
});
