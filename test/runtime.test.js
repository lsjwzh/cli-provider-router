'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');
const { test } = require('node:test');

const cpr = require('../lib');

function temporaryHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-runtime-')); }
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

function occupyPort(port) {
  const server = net.createServer();
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.testSockets = sockets;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server); });
  });
}

function closeServer(server) {
  for (const socket of server.testSockets || []) socket.destroy();
  return new Promise(resolve => server.close(() => resolve()));
}

test('CPR_HOME paths and atomic JSON are isolated and private', () => {
  const home = temporaryHome();
  try {
    const paths = cpr.ensureCprPaths(cpr.createCprPaths({ home }));
    assert.strictEqual(paths.home, home);
    assert.strictEqual(paths.providersFile, path.join(home, 'data', 'providers.json'));
    for (const dir of [paths.home, paths.dataDir, paths.configDir, paths.runDir, paths.logsDir]) {
      assert.strictEqual(mode(dir), 0o700);
    }
    cpr.writeJsonAtomic(paths.settingsFile, { port: 4567 });
    assert.deepStrictEqual(cpr.readJson(paths.settingsFile), { port: 4567 });
    assert.strictEqual(mode(paths.settingsFile), 0o600);
    assert.deepStrictEqual(fs.readdirSync(paths.configDir), ['settings.json']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('provider store copies the legacy CPR_HOME file without deleting it', () => {
  const home = temporaryHome();
  try {
    const legacyFile = path.join(home, 'providers.json');
    fs.writeFileSync(legacyFile, JSON.stringify([{ id: 'old', appType: 'claude', name: 'Legacy', settingsConfig: {} }]));
    const store = cpr.createStore({ cprHome: home });
    assert.strictEqual(store.listProviders('claude')[0].name, 'Legacy');
    assert.ok(fs.existsSync(legacyFile));
    assert.ok(fs.existsSync(path.join(home, 'data', 'providers.json')));
    assert.strictEqual(mode(path.join(home, 'data', 'providers.json')), 0o600);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('route profiles persist host-independent routing DTOs', () => {
  const home = temporaryHome();
  try {
    const routes = cpr.createRouteProfileStore({ cprHome: home });
    const created = routes.create({
      name: 'Daily coding',
      cli: 'claude',
      main: { providerId: 'main-provider', model: 'main-model' },
      subagent: { providerId: 'sub-provider', model: 'sub-model' },
      roles: { explorer: { providerId: 'read-provider', model: 'read-model' } },
      metadata: { owner: 'standalone' },
    });
    assert.strictEqual(routes.resolve('claude', created.id).roles.explorer.providerId, 'read-provider');
    const updated = routes.update(created.id, { enabled: false, name: 'Paused' });
    assert.strictEqual(updated.name, 'Paused');
    assert.strictEqual(routes.resolve('claude', created.id), null);
    assert.strictEqual(mode(routes._dataFile), 0o600);
    assert.strictEqual(routes.remove(created.id), true);
    assert.deepStrictEqual(routes.list(), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('new routing identifiers are CPR-owned while legacy model prefix still decodes', () => {
  assert.strictEqual(cpr.DEFAULT_CODEX_SUBAGENT_PROVIDER, 'cpr_subagent');
  assert.deepStrictEqual(cpr.decodeClaudeRoutedModel('cpr:p1:model-a'), { providerId: 'p1', realModel: 'model-a' });
  assert.deepStrictEqual(cpr.decodeClaudeRoutedModel('ccfw:p2:model-b'), { providerId: 'p2', realModel: 'model-b' });
  const env = {};
  const store = { getProvider: () => ({ settingsConfig: { env: { ANTHROPIC_BASE_URL: 'https://example.test' } } }) };
  assert.strictEqual(cpr.applyClaudeProxyEnv(env, {
    enabled: true,
    providerId: 'main',
    sessionId: 'session',
    port: 4567,
    store,
    subagent: { providerId: 'sub', model: 'model' },
  }), true);
  assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, 'cpr-session');
  assert.strictEqual(env.CLAUDE_CODE_SUBAGENT_MODEL, 'cpr:sub:model');
});

test('standalone service supports start, health, restart, and stop', async () => {
  const home = temporaryHome();
  const paths = cpr.ensureCprPaths(cpr.createCprPaths({ home }));
  const runner = path.join(__dirname, '..', 'cli', 'proxy-server.js');
  const port = await freePort();
  const controller = cpr.createServiceController({ paths, runner, port });
  try {
    const started = await controller.start({ port, timeoutMs: 8000 });
    assert.strictEqual(started.running, true);
    assert.strictEqual(started.health.home, home);
    assert.strictEqual(mode(paths.servicePidFile), 0o600);
    assert.strictEqual(mode(paths.serviceStateFile), 0o600);
    assert.ok(fs.existsSync(paths.serviceLogFile));
    const oldPid = started.pid;
    const restarted = await controller.restart({ port, timeoutMs: 8000 });
    assert.strictEqual(restarted.running, true);
    assert.notStrictEqual(restarted.pid, oldPid);
    const status = await controller.status();
    assert.strictEqual(status.healthy, true);
  } finally {
    await controller.stop({ timeoutMs: 8000 }).catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('CLI exposes the managed service lifecycle', async () => {
  const home = temporaryHome();
  const port = await freePort();
  const cli = path.join(__dirname, '..', 'cli', 'index.js');
  const env = { ...process.env, CPR_HOME: home };
  const paths = cpr.ensureCprPaths(cpr.createCprPaths({ home }));
  const cleanup = cpr.createServiceController({ paths, runner: path.join(__dirname, '..', 'cli', 'proxy-server.js') });
  try {
    const started = execFileSync(process.execPath, [cli, 'start', '--port', String(port)], { env, encoding: 'utf8' });
    assert.match(started, /service started/);
    const status = execFileSync(process.execPath, [cli, 'status'], { env, encoding: 'utf8' });
    assert.match(status, new RegExp(`127\\.0\\.0\\.1:${port}`));
    const restarted = execFileSync(process.execPath, [cli, 'restart'], { env, encoding: 'utf8' });
    assert.match(restarted, new RegExp(`port ${port}`));
    const stopped = execFileSync(process.execPath, [cli, 'stop'], { env, encoding: 'utf8' });
    assert.match(stopped, /service stopped/);
  } finally {
    await cleanup.stop({ timeoutMs: 8000 }).catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('CLI exposes read-only native config detect/status without CC-Switch', () => {
  const home = temporaryHome();
  const nativeHome = temporaryHome();
  const cli = path.join(__dirname, '..', 'cli', 'index.js');
  const env = { ...process.env, CPR_HOME: home, HOME: nativeHome, CPR_CC_SWITCH_DB: path.join(home, 'missing-cc-switch.db') };
  try {
    const detected = JSON.parse(execFileSync(process.execPath, [cli, 'cli-config', 'detect', '--cli', 'claude', '--json'], { env, encoding: 'utf8' }));
    assert.strictEqual(detected[0].cli, 'claude');
    assert.strictEqual(detected[0].exists, false);
    assert.strictEqual(detected[0].active, false);
    const status = JSON.parse(execFileSync(process.execPath, [cli, 'cli-config', 'status', '--cli', 'codex', '--json'], { env, encoding: 'utf8' }));
    assert.strictEqual(status.cli, 'codex');
    assert.strictEqual(status.active, false);
    assert.strictEqual(fs.existsSync(path.join(nativeHome, '.claude', 'settings.json')), false);
    assert.strictEqual(fs.existsSync(path.join(nativeHome, '.codex', 'config.toml')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(nativeHome, { recursive: true, force: true });
  }
});

test('managed service fails fast when either proxy or Web port is occupied', async t => {
  const runner = path.join(__dirname, '..', 'cli', 'proxy-server.js');
  for (const blocked of ['proxy', 'web']) {
    const home = temporaryHome();
    const paths = cpr.ensureCprPaths(cpr.createCprPaths({ home }));
    const proxyPort = await freePort();
    let webPort = await freePort();
    while (webPort === proxyPort) webPort = await freePort();
    const blockedPort = blocked === 'proxy' ? proxyPort : webPort;
    const blocker = await occupyPort(blockedPort);
    const controller = cpr.createServiceController({ paths, runner, port: proxyPort, webPort });
    const startedAt = Date.now();
    try {
      await assert.rejects(
        controller.start({ port: proxyPort, webPort, timeoutMs: 8000 }),
        /service failed to become healthy/,
        `${blocked} port conflict should reject start`,
      );
      assert.ok(Date.now() - startedAt < 3000, `${blocked} port conflict should fail before the normal startup timeout`);
      assert.strictEqual(blocker.listening, true, 'CPR must not stop or replace the process owning the port');
      const status = await controller.status();
      assert.strictEqual(status.running, false);
      assert.strictEqual(status.processRunning, false);
    } finally {
      await controller.stop({ timeoutMs: 1000 }).catch(() => {});
      await closeServer(blocker);
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});
