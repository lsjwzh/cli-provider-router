#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const cpr = require('../lib/index');
const { createCprPaths, ensureCprPaths, DEFAULT_PROXY_PORT } = require('../lib/paths');
const { atomicWriteFile, writeJsonAtomic, removeFile } = require('../lib/atomic-json');

function argOf(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function validPort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label} must be between 1 and 65535`);
  return port;
}

function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => { server.removeListener('error', reject); resolve(server); });
  });
}

function closeHttp(server) {
  if (!server || !server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function readOrCreateAdminToken(file) {
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    if (token.length >= 32) { try { fs.chmodSync(file, 0o600); } catch (_) {} return token; }
  } catch (_) {}
  const token = crypto.randomBytes(32).toString('base64url');
  atomicWriteFile(file, `${token}\n`, { mode: 0o600 });
  return token;
}

async function startServer(options = {}) {
  const paths = ensureCprPaths(options.paths || createCprPaths({ home: options.home || argOf('home') }));
  const port = validPort(options.port || argOf('port') || process.env.CPR_PORT || DEFAULT_PROXY_PORT, 'port');
  const webPort = validPort(options.webPort || argOf('web-port') || process.env.CPR_WEB_PORT || port + 1, 'web-port');
  if (port === webPort) throw new Error('proxy port and web port must be different');
  const dataFile = options.dataFile || process.env.CPR_DATA_FILE || paths.providersFile;
  const ccDb = options.ccSwitchDb || process.env.CPR_CC_SWITCH_DB || cpr.resolveCcDb();
  const store = options.store || cpr.createStore({ dataFile, ccSwitchDb: ccDb, paths });
  const routeProfiles = options.routeProfiles || cpr.createRouteProfileStore({ paths });
  const usageLedger = options.usageLedger || cpr.createUsageLedger({ paths });
  const settings = options.settings || cpr.createSettingsStore({ paths, defaults: { proxyPort: port, webPort } });
  const hopCredentials = options.hopCredentials || cpr.createHopCredentialStore({ paths });
  const takeoverState = options.takeoverState || cpr.createTakeoverStateStore(paths);
  const directCliConfig = options.directCliConfig || cpr.createDirectCliConfigManager({
    paths,
    store,
    profiles: routeProfiles,
    proxyBaseUrl: `http://127.0.0.1:${port}`,
    hopCredentials,
    takeoverState,
  });
  const adminToken = options.adminToken || readOrCreateAdminToken(paths.adminTokenFile);
  const takeoverNonce = options.takeoverNonce || crypto.randomBytes(24).toString('base64url');
  usageLedger.prune();
  const startedAt = Date.now();
  const onUsageEvent = event => {
    try { usageLedger.recordProxyUsage(event); }
    catch (error) { console.error(`[cli-provider-router] usage ledger write failed: ${error.message}`); }
  };
  const getProvider = (type, id) => store.getProvider(type, id);
  let serviceReady = false;

  const proxyApp = express();
  proxyApp.disable('x-powered-by');
  // The takeover gateway must see the untouched incoming stream. Never move
  // this mount below express.json() or another body-consuming middleware.
  cpr.mountCcSwitchGateway(proxyApp, { home: paths.home });
  proxyApp.use(express.json({ limit: '25mb' }));
  proxyApp.get('/health', (_req, res) => res.status(serviceReady ? 200 : 503).json({
    ok: serviceReady, product: 'cli-provider-router-proxy', pid: process.pid, port, webPort,
    takeoverNonce,
    webUrl: `http://127.0.0.1:${webPort}`, adminTokenFile: paths.adminTokenFile,
    home: paths.home, startedAt,
  }));
  const requireHopCredential = options.requireHopCredential !== false;
  cpr.mountCodexProxy(proxyApp, { getProvider, getPort: () => port, onUsage: options.onUsage, onUsageEvent, hopCredentials, requireHopCredential });
  cpr.mountClaudeProxy(proxyApp, { getProvider, onUsage: options.onUsage, onUsageEvent, hopCredentials, requireHopCredential });

  let proxyServer;
  let web;
  try {
    proxyServer = await listen(proxyApp, port);
    web = await cpr.createWebServer({
      port: webPort,
      adminToken,
      store,
      routeProfiles,
      ccSwitch: cpr.ccSwitchTakeover,
      ccSwitchOptions: {
        home: paths.home,
        dbPath: ccDb,
        proxyBaseUrl: `http://127.0.0.1:${port}`,
        healthNonce: takeoverNonce,
      },
      proxyBaseUrl: `http://127.0.0.1:${port}`,
      usageLedger,
      settings,
      directCliConfig,
    });
    serviceReady = true;
  } catch (error) {
    await closeHttp(proxyServer).catch(() => {});
    throw error;
  }

  atomicWriteFile(paths.servicePidFile, `${process.pid}\n`);
  const state = {
    status: 'running', pid: process.pid, port, proxyPort: port, webPort,
    proxyUrl: `http://127.0.0.1:${port}`, webUrl: web.url,
    adminTokenFile: paths.adminTokenFile, home: paths.home, dataFile, ccSwitchDb: ccDb, startedAt,
  };
  writeJsonAtomic(paths.serviceStateFile, state);
  writeJsonAtomic(paths.serviceHealthFile, { ...state, ok: true, checkedAt: Date.now() });
  console.log(`cli-provider-router proxy listening on ${state.proxyUrl}`);
  console.log(`cli-provider-router Web console: ${state.webUrl}`);
  console.log(`  admin token: ${paths.adminTokenFile}`);
  console.log(`  CC-Switch gateway: ${state.proxyUrl}/ccswitch/:appType/:providerId`);
  console.log(`  store: ${dataFile}`);

  const heartbeat = setInterval(() => {
    writeJsonAtomic(paths.serviceHealthFile, { ...state, ok: true, checkedAt: Date.now() });
  }, 10000);
  heartbeat.unref();

  let closingPromise = null;
  function close(signal = 'programmatic') {
    if (closingPromise) return closingPromise;
    try { takeoverState.assertCanStop('stop CPR service'); }
    catch (error) { return Promise.reject(error); }
    closingPromise = (async () => {
      clearInterval(heartbeat);
      await Promise.all([closeHttp(proxyServer), web.close()]);
      removeFile(paths.servicePidFile);
      removeFile(paths.serviceHealthFile);
      writeJsonAtomic(paths.serviceStateFile, {
        ...state, status: 'stopped', pid: null, stoppedAt: Date.now(), signal,
      });
    })();
    return closingPromise;
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    // Keep the handler installed after a refused signal. With `once`, a
    // second SIGTERM would fall through to Node's default termination and
    // bypass takeover protection.
    process.on(signal, () => {
      close(signal).then(() => process.exit(0), error => {
        console.error(`[cli-provider-router] shutdown refused: ${error.message}`);
      });
    });
  }

  return { proxyApp, proxyServer, web, paths, port, webPort, adminToken, takeoverNonce, state, close, store, routeProfiles, usageLedger, settings, directCliConfig, hopCredentials, takeoverState };
}

if (require.main === module) {
  startServer().catch(error => { console.error(`[cli-provider-router] ${error.stack || error.message}`); process.exit(1); });
}

module.exports = { startServer, readOrCreateAdminToken };
