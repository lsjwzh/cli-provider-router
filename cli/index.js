#!/usr/bin/env node
'use strict';

// cpr — cli-provider-router command line.
//
// Zero runtime dependencies: a tiny hand-rolled arg parser + the library.
// Subcommands:
//   add / list / show / rm / import / doctor   — manage the provider store
//   use <provider> -- <cmd...>                 — run a CLI routed to a provider
//   proxy start|stop|status                    — local Responses<->Chat proxy
//
// The store lives at ~/.cli-provider-router/providers.json (override with
// CPR_DATA_FILE); cc-switch import source at ~/.cc-switch/cc-switch.db
// (override with CPR_CC_SWITCH_DB).

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const cpr = require('../lib/index');
const { createCprPaths, ensureCprPaths, DEFAULT_PROXY_PORT } = require('../lib/paths');
const { createServiceController } = require('../lib/service');

const PATHS = ensureCprPaths(createCprPaths());
const DATA_FILE = process.env.CPR_DATA_FILE || PATHS.providersFile;
const CC_DB = process.env.CPR_CC_SWITCH_DB || undefined;
const PROXY_RUNNER = path.join(__dirname, 'proxy-server.js');

function store() {
  return cpr.createStore({ dataFile: DATA_FILE, ccSwitchDb: CC_DB, paths: PATHS });
}

// ── tiny arg parser ──────────────────────────────────────────────────────────
// Splits argv into { _: positionals, flags: {k:v|true} }, stopping at `--`
// (everything after `--` is returned verbatim in `rest`).
function parseArgs(argv) {
  const out = { _: [], flags: {}, rest: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.rest = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out.flags[key] = true; }
      else { out.flags[key] = next; i++; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// ── output helpers ───────────────────────────────────────────────────────────
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
function die(msg, code = 1) { console.error(C.red('error: ') + msg); process.exit(code); }

// Resolve a provider by id OR name (case-insensitive) within an appType, or
// across both pools when appType is omitted. Returns { appType, id, summary }.
function findProvider(st, ref, appType) {
  const pools = appType ? [appType] : cpr.APP_TYPES;
  const matches = [];
  for (const at of pools) {
    for (const p of st.listProviders(at)) {
      if (p.id === ref || String(p.name).toLowerCase() === String(ref).toLowerCase()) {
        matches.push({ appType: at, id: p.id, summary: p });
      }
    }
  }
  if (matches.length === 0) die(`provider not found: ${ref}`);
  if (matches.length > 1 && !appType) {
    die(`ambiguous provider "${ref}" — matches ${matches.length} (use --app claude|codex to disambiguate)`);
  }
  return matches[0];
}

// ── commands ─────────────────────────────────────────────────────────────────

function cmdList(args) {
  const st = store();
  const only = args.flags.app;
  const apps = only ? [only] : cpr.APP_TYPES;
  let total = 0;
  for (const app of apps) {
    const list = st.listProviders(app);
    if (!list.length) continue;
    console.log(C.bold(`\n${app}`) + C.dim(`  (${list.length})`));
    for (const p of list) {
      total++;
      const tag = p.isOfficial ? C.cyan('[official]')
        : p.aliasOnly ? C.yellow('[alias]')
        : p.useChatResponsesProxy ? C.yellow('[proxy]') : '';
      const model = p.model || C.dim('(default)');
      console.log(`  ${C.green(p.name)} ${C.dim(p.id.slice(0, 8))} ${tag}`);
      console.log(`    ${C.dim(p.baseUrl || 'default login')}  ·  ${model}`);
    }
  }
  if (!total) console.log(C.dim('no providers yet — add one with `cpr add` or `cpr import`'));
  console.log('');
}

function cmdShow(args) {
  const ref = args._[0];
  if (!ref) die('usage: cpr show <name|id> [--app claude|codex]');
  const st = store();
  const { appType, id } = findProvider(st, ref, args.flags.app);
  const p = st.getProvider(appType, id);
  const s = st.getProviderSummary(appType, id);
  console.log(C.bold(`${s.name}`) + C.dim(`  (${appType})`));
  console.log(`  id:        ${id}`);
  console.log(`  source:    ${s.source}`);
  console.log(`  baseUrl:   ${s.baseUrl || C.dim('(default login)')}`);
  console.log(`  model:     ${s.model || C.dim('(default)')}`);
  if (s.modelOptions && s.modelOptions.length > 1) console.log(`  models:    ${s.modelOptions.join(', ')}`);
  console.log(`  token:     ${s.hasToken ? s.tokenMask : C.dim('(none)')}`);
  if (s.aliasOnly) console.log(`  ${C.yellow('alias-only relay')} — wire model promoted at spawn`);
  if (s.useChatResponsesProxy) console.log(`  ${C.yellow('needs protocol proxy')} (codex → chat-only upstream)`);
  if (appType === 'codex') {
    const d = st.resolveCodexDirectHttp(id);
    console.log(`  directHTTP: ${d.canDirect ? C.green('yes') + ` (${d.url})` : C.dim('no — ' + d.reason)}`);
  }
  console.log('');
}

function cmdAdd(args) {
  const name = args._[0] || args.flags.name;
  const app = args.flags.app || 'claude';
  const baseUrl = args.flags['base-url'] || args.flags.baseUrl || '';
  const token = args.flags.token || '';
  const model = args.flags.model || '';
  const models = args.flags.models || '';
  if (!name) die('usage: cpr add <name> --app claude|codex --base-url <url> --token <tok> [--model <m>] [--models a,b,c]');
  if (!cpr.APP_TYPES.includes(app)) die(`--app must be one of: ${cpr.APP_TYPES.join(', ')}`);
  const st = store();
  const r = st.createProvider({
    appType: app, name,
    baseUrl: baseUrl || undefined,
    authToken: token || undefined,
    model: model || undefined,
    models: models || undefined,
  });
  console.log(C.green('✓ added ') + C.bold(r.name) + C.dim(`  (${app}, ${r.id.slice(0, 8)})`));
}

function cmdRm(args) {
  const ref = args._[0];
  if (!ref) die('usage: cpr rm <name|id> [--app claude|codex]');
  const st = store();
  const { appType, id, summary } = findProvider(st, ref, args.flags.app);
  st.deleteProvider(appType, id);
  console.log(C.green('✓ removed ') + C.bold(summary.name) + C.dim(`  (${appType})`));
}

function cmdImport() {
  const st = store();
  const ccDb = cpr.resolveCcDb(CC_DB);
  if (!cpr.ccSwitchAvailable(ccDb)) {
    die(`cc-switch database not found at ${ccDb}\n  Install cc-switch (https://github.com/farion1231/cc-switch) or set CPR_CC_SWITCH_DB.`);
  }
  let r;
  try { r = st.importFromCcSwitch(); }
  catch (e) { die('import failed: ' + e.message); }
  console.log(C.green('✓ imported from cc-switch'));
  console.log(`  imported: ${r.imported}   updated: ${r.updated}   total in source: ${r.total}`);
}

function cmdUse(args) {
  const ref = args._[0];
  const rest = args.rest;
  if (!ref || !rest || !rest.length) {
    die('usage: cpr use <provider> -- <command...>\n  e.g. cpr use deepseek -- claude -p "hello"');
  }
  const st = store();
  // The CLI being launched decides the appType pool. Infer from the command
  // when possible (codex → codex pool), else search both.
  const cmd = rest[0];
  const cliHint = /codex/i.test(cmd) ? 'codex' : (/claude/i.test(cmd) ? 'claude' : undefined);
  const { appType, id, summary } = findProvider(st, ref, args.flags.app || cliHint);
  const cliForEnv = appType === 'codex' ? 'codex' : 'claude';
  const built = cpr.buildChildEnv(process.env, { cli: cliForEnv, providerId: id, store: st });
  const childEnv = { ...process.env, ...built.env };
  console.error(C.dim(`→ routing ${cmd} via ${summary.name} (${appType})`));
  const child = spawn(rest[0], rest.slice(1), { env: childEnv, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code == null ? 0 : code);
  });
  child.on('error', (e) => die(`failed to spawn "${cmd}": ${e.message}`));
}

function cmdDoctor() {
  const st = store();
  console.log(C.bold('cli-provider-router doctor\n'));
  // store
  console.log(`  store file:      ${DATA_FILE} ${fs.existsSync(DATA_FILE) ? C.green('(exists)') : C.dim('(will be created)')}`);
  const nClaude = st.listProviders('claude').length;
  const nCodex = st.listProviders('codex').length;
  console.log(`  providers:       ${nClaude} claude, ${nCodex} codex`);
  // cc-switch
  const ccDb = cpr.resolveCcDb(CC_DB);
  console.log(`  cc-switch db:    ${ccDb} ${cpr.ccSwitchAvailable(ccDb) ? C.green('(found)') : C.dim('(not found)')}`);
  // codex homes
  console.log(`  CPR home:        ${PATHS.home}`);
  console.log(`  codex homes:     ${PATHS.codexHomesDir}`);
  // CLIs on PATH
  for (const bin of ['claude', 'codex']) {
    const found = onPath(bin);
    console.log(`  ${bin} on PATH:   ${found ? C.green(found) : C.red('not found')}`);
  }
  console.log('');
}

function onPath(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      const full = path.join(d, bin + ext);
      try { if (fs.existsSync(full) && fs.statSync(full).isFile()) return full; } catch (_) {}
    }
  }
  return null;
}

function checkExpress() {
  try { require.resolve('express'); }
  catch (_) { die('express is required for the CPR service. Install it beside cli-provider-router and retry.'); }
}

async function cmdService(command, args) {
  checkExpress();
  const requestedPort = args.flags.port || process.env.CPR_PORT || null;
  const port = Number(requestedPort || DEFAULT_PROXY_PORT);
  if (command === 'serve') {
    const { startServer } = require('./proxy-server');
    startServer({ port, paths: PATHS, dataFile: DATA_FILE, ccSwitchDb: CC_DB });
    return;
  }
  const controller = createServiceController({ paths: PATHS, runner: PROXY_RUNNER, port: requestedPort ? port : undefined });
  if (command === 'start') {
    const result = await controller.start({ port, dataFile: DATA_FILE });
    console.log(result.alreadyRunning
      ? C.yellow(`service already running (pid ${result.pid}, port ${result.port})`)
      : C.green(`✓ service started (pid ${result.pid}, port ${result.port})`));
    return;
  }
  if (command === 'status') {
    const result = await controller.status();
    if (result.running) console.log(C.green('running') + `  pid ${result.pid}  http://127.0.0.1:${result.port}`);
    else if (result.processRunning) console.log(C.yellow('unhealthy') + `  pid ${result.pid}  port ${result.port}`);
    else console.log(C.dim('stopped'));
    if (!result.running) process.exitCode = 1;
    return;
  }
  if (command === 'stop') {
    const result = await controller.stop();
    console.log(result.alreadyStopped ? C.dim('service already stopped') : C.green(`✓ service stopped (pid ${result.pid})`));
    return;
  }
  if (command === 'restart') {
    const result = await controller.restart({ ...(requestedPort ? { port } : {}), dataFile: DATA_FILE });
    console.log(C.green(`✓ service restarted (pid ${result.pid}, port ${result.port})`));
    return;
  }
  die('usage: cpr serve|start|status|stop|restart [--port 4567]');
}

function cmdProxy(args) {
  const sub = args._.shift();
  if (!['start', 'status', 'stop', 'restart'].includes(sub)) die('usage: cpr proxy start|status|stop|restart [--port 4567]');
  return cmdService(sub, args);
}

// ── help ─────────────────────────────────────────────────────────────────────
function help() {
  console.log(`${C.bold('cpr')} — cli-provider-router

${C.bold('Manage providers')}
  cpr list [--app claude|codex]
  cpr show <name|id> [--app ...]
  cpr add <name> --app claude|codex --base-url <url> --token <tok> [--model <m>] [--models a,b,c]
  cpr rm <name|id> [--app ...]
  cpr import                         import (read-only) from cc-switch

${C.bold('Route a CLI')}
  cpr use <provider> -- <command...>   run a CLI with the provider's env injected
                                       e.g. cpr use deepseek -- claude -p "hi"
                                            cpr use xfyun -- codex exec "..."

${C.bold('Standalone service')}
  cpr serve [--port 4567]              foreground
  cpr start [--port 4567]              background
  cpr status | stop | restart
  cpr proxy <action>                    compatibility alias

${C.bold('Other')}
  cpr doctor                         environment diagnostics
  cpr --version

Store:      ${DATA_FILE}
Override:   CPR_HOME, CPR_DATA_FILE, CPR_CC_SWITCH_DB, CPR_PORT`);
}

// ── dispatch ─────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') return help();
  if (argv[0] === '--version' || argv[0] === '-v') {
    const pkg = require('../package.json');
    return console.log(pkg.version);
  }
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  switch (cmd) {
    case 'list': case 'ls': return cmdList(args);
    case 'show': return cmdShow(args);
    case 'add': return cmdAdd(args);
    case 'rm': case 'remove': case 'delete': return cmdRm(args);
    case 'import': return cmdImport(args);
    case 'use': return cmdUse(args);
    case 'doctor': return cmdDoctor(args);
    case 'serve': case 'start': case 'status': case 'stop': case 'restart': return cmdService(cmd, args);
    case 'proxy': return cmdProxy(args);
    default: die(`unknown command: ${cmd}\n  run \`cpr help\` for usage.`);
  }
}

main().catch(error => die(error && error.message ? error.message : String(error)));
