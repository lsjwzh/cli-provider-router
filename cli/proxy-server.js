#!/usr/bin/env node
'use strict';

const express = require('express');
const cpr = require('../lib/index');
const { createCprPaths, ensureCprPaths, DEFAULT_PROXY_PORT } = require('../lib/paths');
const { atomicWriteFile, writeJsonAtomic, removeFile } = require('../lib/atomic-json');

function argOf(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function startServer(options = {}) {
  const paths = ensureCprPaths(options.paths || createCprPaths({ home: options.home || argOf('home') }));
  const port = Number(options.port || argOf('port') || process.env.CPR_PORT || DEFAULT_PROXY_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be between 1 and 65535');
  const dataFile = options.dataFile || process.env.CPR_DATA_FILE || paths.providersFile;
  const ccDb = options.ccSwitchDb || process.env.CPR_CC_SWITCH_DB || undefined;
  const store = cpr.createStore({ dataFile, ccSwitchDb: ccDb, paths });
  const getProvider = (type, id) => store.getProvider(type, id);
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.get('/health', (_req, res) => res.json({ ok: true, pid: process.pid, port, home: paths.home, startedAt }));
  cpr.mountCodexProxy(app, { getProvider, getPort: () => port });
  cpr.mountClaudeProxy(app, { getProvider, onUsage: options.onUsage || (() => {}) });

  const startedAt = Date.now();
  const server = app.listen(port, '127.0.0.1', () => {
    atomicWriteFile(paths.servicePidFile, `${process.pid}\n`);
    const state = { status: 'running', pid: process.pid, port, home: paths.home, dataFile, startedAt };
    writeJsonAtomic(paths.serviceStateFile, state);
    writeJsonAtomic(paths.serviceHealthFile, { ...state, ok: true, checkedAt: Date.now() });
    console.log(`cli-provider-router listening on http://127.0.0.1:${port}`);
    console.log(`  codex:  POST /codex-proxy/:providerId/:sessionId/:role/responses`);
    console.log(`  claude: POST /claude-proxy/:providerId/:sessionId/v1/messages`);
    console.log(`  store:  ${dataFile}`);
  });
  const heartbeat = setInterval(() => {
    writeJsonAtomic(paths.serviceHealthFile, { ok: true, status: 'running', pid: process.pid, port, checkedAt: Date.now() });
  }, 10000);
  heartbeat.unref();

  let closing = false;
  function close(signal) {
    if (closing) return;
    closing = true;
    clearInterval(heartbeat);
    server.close(() => {
      removeFile(paths.servicePidFile);
      removeFile(paths.serviceHealthFile);
      writeJsonAtomic(paths.serviceStateFile, { status: 'stopped', pid: null, port, home: paths.home, startedAt, stoppedAt: Date.now(), signal });
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 3000).unref();
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => close(signal));
  server.cpr = { paths, port, close };
  return server;
}

if (require.main === module) {
  try { startServer(); }
  catch (error) { console.error(`[cli-provider-router] ${error.stack || error.message}`); process.exit(1); }
}

module.exports = { startServer };
