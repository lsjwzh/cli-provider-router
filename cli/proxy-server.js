#!/usr/bin/env node
'use strict';

// Embedded proxy host for `cpr proxy start`. Mounts the Responses<->Chat codex
// proxy (and the claude sub-agent proxy) on a local express server, backed by
// the same provider store the CLI uses. Library hosts (e.g. multicc) mount the
// proxies on their own server instead — this is just a batteries-included
// option for CLI users.
//
// express is an optional peer dependency; `cpr proxy start` checks for it first.

const path = require('path');
const os = require('os');
const express = require('express');

const cpr = require('../lib/index');

function argOf(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const PORT = parseInt(argOf('port', '4567'), 10);
const DATA_FILE = process.env.CPR_DATA_FILE
  || path.join(os.homedir(), '.cli-provider-router', 'providers.json');
const CC_DB = process.env.CPR_CC_SWITCH_DB || undefined;

const store = cpr.createStore({ dataFile: DATA_FILE, ccSwitchDb: CC_DB });
const getProvider = (t, id) => store.getProvider(t, id);

const app = express();
app.use(express.json({ limit: '25mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, port: PORT }));

cpr.mountCodexProxy(app, { getProvider, getPort: () => PORT });
cpr.mountClaudeProxy(app, { getProvider, onUsage: () => {} });

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`cli-provider-router proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`  codex:  POST /codex-proxy/:providerId/responses`);
  console.log(`  store:  ${DATA_FILE}`);
  console.log(`  (Ctrl-C to stop)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => process.exit(0)); });
}
