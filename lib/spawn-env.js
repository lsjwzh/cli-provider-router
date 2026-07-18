'use strict';

// spawn-env.js — compute the process-env overrides + flags to apply when
// spawning a child for a given provider.
//
// Migrated from multicc's src/providers.js. The original took a `session`
// object (read session.provider / session.cli) and queried a module-level
// getProvider. Here it is decoupled: callers pass { cli, providerId, store }
// where `store` is a createStore() instance (or any object exposing
// getProvider(appType, id)). buildChildEnv likewise takes opts with a `store`
// field so it can resolve the provider and then call resolveSpawnEnv.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const {
  appTypeForCli,
  ANTHROPIC_ALIAS_MODEL_KEYS,
  ANTHROPIC_ALIAS_MODEL_PRIORITY,
  CLAUDE_ROUTING_KEYS,
  CODEX_ROUTING_KEYS,
  CODEX_HOMES_DIR,
} = require('./constants');
const { createCprPaths, ensureCprPaths } = require('./paths');
const { writeJsonAtomic, atomicWriteFile } = require('./atomic-json');
const { resolveWireModel } = require('./model-policy');

const { parseConfig, uniqueModels, tomlValue } = require('./store');

class ProviderRoutingError extends Error {
  constructor({ code, message, cli, providerId, stage, cause }) {
    super(message);
    this.name = 'ProviderRoutingError';
    this.code = code;
    this.cli = cli;
    this.providerId = providerId;
    this.stage = stage;
    this.details = Object.freeze({ cli, providerId, stage });
    if (cause) this.cause = cause;
  }
}

function emptySpawnResolution(overrides = {}) {
  return {
    env: {},
    skipDefaultModel: false,
    aliasOnly: false,
    providerModel: null,
    providerModels: [],
    providerName: null,
    routingStatus: 'default',
    fallback: null,
    ...overrides,
  };
}

function routingFailureState(error, reason) {
  return Object.freeze({
    type: 'provider-routing-fallback',
    status: 'default-fallback',
    reason,
    credentialFree: true,
    cli: error.cli,
    providerId: error.providerId,
    error: Object.freeze({
      name: error.name,
      code: error.code,
      message: error.message,
      stage: error.stage,
    }),
  });
}

function failOrExplicitlyFallback(error, { allowDefaultFallback, onRoutingEvent, providerName, reason }) {
  if (!allowDefaultFallback) throw error;
  const fallback = routingFailureState(error, reason);
  if (typeof onRoutingEvent === 'function') onRoutingEvent(fallback);
  return emptySpawnResolution({
    providerName: providerName || null,
    routingStatus: 'default-fallback',
    fallback,
  });
}

// Resolve the wire model id to send to the CLI for a given session + provider.
// An explicit per-session model is honored ONLY when it's an alias tier
// (opus/sonnet/haiku/fable/default) or a model the provider actually serves —
// otherwise a stale value (e.g. "astron-code-latest" left on a session after
// its provider's model changed) is dropped, because relays reject unknown ids
// (400 / 1211 / 10404). Falls back to the provider's canonical model, or to
// `defaultModel` for the default login. Single source of truth for this
// decision; called by BOTH chat-spawn paths so they cannot drift.
//
// Pure (no store lookup) — kept as a plain function taking the resolved
// provider metadata.
function resolveSessionWireModel(sessionModel, { providerModel = null, providerModels = [], skipDefaultModel = false, defaultModel = null } = {}) {
  return resolveWireModel(sessionModel, { providerModel, providerModels, skipDefaultModel, defaultModel });
}

// Compute env overrides + flags to apply when spawning a child for the given
// provider. Decoupled from multicc's session object: callers pass
// { cli, providerId, store }.
//   - env: object merged into the child's process env (only this child).
//   - skipDefaultModel: claude routes elsewhere → don't force the global --model.
function resolveSpawnEnv({ cli, providerId, store, paths, cprHome, codexHomesDir, allowDefaultFallback = false, onRoutingEvent }) {
  if (!providerId) return emptySpawnResolution();
  const appType = appTypeForCli(cli);
  const p = store.getProvider(appType, providerId);
  if (!p) {
    if (appType !== 'codex') return emptySpawnResolution();
    const error = new ProviderRoutingError({
      code: 'CODEX_PROVIDER_NOT_FOUND',
      message: `Codex provider not found: ${providerId}`,
      cli: 'codex',
      providerId,
      stage: 'provider-resolution',
    });
    return failOrExplicitlyFallback(error, {
      allowDefaultFallback,
      onRoutingEvent,
      reason: 'provider-not-found',
    });
  }
  const cfg = parseConfig(p.settingsConfig);

  if (appType === 'claude') {
    const env = {};
    const src = cfg.env || {};
    for (const k of Object.keys(src)) {
      if (/^ANTHROPIC_/.test(k) && typeof src[k] === 'string') env[k] = src[k];
    }
    // Claude CLI v2.1.199+ auth precedence: when ANTHROPIC_AUTH_TOKEN is set,
    // it takes precedence over OAuth/keychain WITHOUT needing CLAUDE_CODE_SIMPLE=1.
    // (CLI prints "connectors are disabled" warning but routes to the API key.)
    // Omitting CLAUDE_CODE_SIMPLE=1 preserves the full tool set (Agent, TaskCreate,
    // Workflow, etc.) which is required for dynamic workflow / ultracode support.
    // Only set ANTHROPIC_API_KEY if the provider explicitly provided one.
    // Auto-copying AUTH_TOKEN to API_KEY forces the x-api-key header on
    // providers that don't accept it (e.g. Zhipu GLM 401s because it only
    // reads Authorization: Bearer). Leave AUTH_TOKEN as-is for Bearer auth.

    // Alias-only relay remap: a provider with a base URL but no canonical
    // ANTHROPIC_MODEL only declares alias targets (its real model id, e.g.
    // iFlytek's "astron-code-latest"). The relay ACCEPTS that id and REJECTS
    // claude-* wire names (iFlytek → 10404). Promote the first alias target
    // to ANTHROPIC_MODEL so the main --model and every tier-based sub-call
    // (background/haiku tasks, ultracode subagents) all send a model the relay
    // accepts. The tier vars are left as-is (already the real model id).
    if (env.ANTHROPIC_BASE_URL && !env.ANTHROPIC_MODEL) {
      // Promote the relay's own real model id from a tier var (e.g.
      // "astron-code-latest"). Never inject claude-* wire names — relays like
      // iFlytek reject those with 10404 PathDomainError.
      const realModel = ANTHROPIC_ALIAS_MODEL_PRIORITY
        .map(key => env[key])
        .find(Boolean);
      if (realModel) env.ANTHROPIC_MODEL = realModel;
    }
    // Canonical wire model + the set of models this provider actually serves
    // (post-remap), so the spawn path can reject stale per-session model values
    // that are no longer valid (e.g. "astron-code-latest" after import-correction).
    const providerModel = env.ANTHROPIC_MODEL || null;
    const providerModels = uniqueModels([
      env.ANTHROPIC_MODEL,
      ...ANTHROPIC_ALIAS_MODEL_KEYS.map(key => env[key]),
    ]).filter(Boolean);
    // Debug: log the model-routing env actually injected into the claude child
    // (token redacted), so relay errors like iFlytek 10404 can be traced to the
    // exact model id sent. Grep `[cli-provider-router/provider] claude env`.
    try {
      const envSummary = Object.keys(env)
        .filter(k => /^ANTHROPIC_(BASE_URL|MODEL|DEFAULT_.*_MODEL|SMALL_FAST_MODEL)$/.test(k))
        .sort()
        .reduce((o, k) => { o[k] = env[k]; return o; }, {});
      console.log(`[cli-provider-router/provider] claude env [${providerId}] provider=${p.name} aliasOnly=${!!env.ANTHROPIC_BASE_URL && !src.ANTHROPIC_MODEL} modelEnv=${JSON.stringify(envSummary)}`);
    } catch (_) {}
    return {
      env,
      skipDefaultModel: !!env.ANTHROPIC_BASE_URL,
      aliasOnly: !!env.ANTHROPIC_BASE_URL && !src.ANTHROPIC_MODEL,
      providerModel,
      providerModels,
      providerName: p.name,
      tools: src.CPR_TOOLS || src.MULTICC_TOOLS,
      routingStatus: 'routed',
      fallback: null,
    };
  }

  let stage = 'codex-home';
  try {
    // An embedding host may own the entire CODEX_HOME lifecycle.  In that
    // case, do not resolve/ensure CPR's default paths first: doing so would
    // create ~/.cli-provider-router even though every writable dependency was
    // explicitly injected by the host.
    let homesDir = codexHomesDir;
    if (!homesDir) {
      const resolvedPaths = ensureCprPaths(paths || (store && store._paths) || createCprPaths({ home: cprHome }));
      homesDir = resolvedPaths.codexHomesDir || CODEX_HOMES_DIR;
    }
    const home = path.join(homesDir, providerId);
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true, mode: 0o700 });
    stage = 'codex-auth';
    if (cfg.auth) {
      writeJsonAtomic(path.join(home, 'auth.json'), cfg.auth);
    } else {
      const baseUrl = tomlValue(cfg.config, 'base_url');
      if (!baseUrl) {
        const globalAuth = path.join(os.homedir(), '.codex', 'auth.json');
        const authPath = path.join(home, 'auth.json');
        if (fs.existsSync(globalAuth)) fs.copyFileSync(globalAuth, authPath);
        else if (fs.existsSync(authPath)) fs.rmSync(authPath, { force: true });
      }
    }
    stage = 'codex-config';
    if (cfg.config) {
      // cc-switch 导入的 config 可能带 model_catalog_json 指向 cc-switch 自己目录里的
      // 文件（codex home 里没有），导致 codex 启动时 "config could not be loaded" → exit 1。
      // 同时折叠 [model_providers] 空表头 + [model_providers.custom] 子表的写法。
      let toml = cfg.config;
      toml = toml.replace(/^model_catalog_json\s*=.*$/gm, '').replace(/\n{3,}/g, '\n\n');
      toml = toml.replace(/\[model_providers\]\s*\n\[model_providers\.custom\]/, '[model_providers.custom]');
      atomicWriteFile(path.join(home, 'config.toml'), toml);
    }
    return emptySpawnResolution({
      env: { CODEX_HOME: home },
      providerName: p.name,
      codexHome: home,
      routingStatus: 'routed',
    });
  } catch (cause) {
    const error = new ProviderRoutingError({
      code: 'CODEX_MATERIALIZATION_FAILED',
      message: `Failed to materialize Codex provider routing for ${providerId}`,
      cli: 'codex',
      providerId,
      stage,
      cause,
    });
    return failOrExplicitlyFallback(error, {
      allowDefaultFallback,
      onRoutingEvent,
      providerName: p.name,
      reason: 'materialization-failed',
    });
  }
}

// Build the full child environment for spawning a session's CLI.
//   base   — the inherited env to start from (normally process.env)
//   opts   — { cli, providerId, model, store } (decoupled from a session object)
//   extra  — extra vars to layer on (MULTICC_*, TERM, etc.)
// For claude sessions, every routing key is stripped from `base` BEFORE the
// provider env is applied, so the chosen provider is authoritative:
//   - default login (provider=null) → none set → real OAuth login from ~/.claude
//   - a custom provider             → exactly its own ANTHROPIC_* values
// Codex sessions use CODEX_HOME as their routing selector, so inherited or
// extra CODEX_HOME values are scrubbed before a selected provider is applied.
function buildChildEnv(base, opts, extra = {}) {
  const env = { ...base, ...extra };
  const cli = opts && opts.cli;
  // Claude and Codex both scrub their routing selectors so the chosen provider
  // is authoritative. opencode/zcode keep their native config and inherited
  // env because they are outside this managed spawn contract.
  if (cli === 'claude') {
    for (const k of CLAUDE_ROUTING_KEYS) delete env[k];
  } else if (cli === 'codex') {
    for (const k of CODEX_ROUTING_KEYS) delete env[k];
  }
  const spawn = resolveSpawnEnv({
    cli: opts.cli,
    providerId: opts.providerId,
    store: opts.store,
    paths: opts.paths,
    cprHome: opts.cprHome,
    codexHomesDir: opts.codexHomesDir,
    allowDefaultFallback: opts.allowDefaultFallback === true,
    onRoutingEvent: opts.onRoutingEvent,
  });
  Object.assign(env, spawn.env);
  return {
    env,
    skipDefaultModel: spawn.skipDefaultModel,
    aliasOnly: spawn.aliasOnly,
    providerModel: spawn.providerModel,
    providerModels: spawn.providerModels,
    providerName: spawn.providerName,
    codexHome: spawn.codexHome,
    tools: spawn.tools,
    routingStatus: spawn.routingStatus,
    fallback: spawn.fallback,
  };
}

// ── relay probe ──────────────────────────────────────────────────────────────

// Candidate wire names probed to discover what an alias-only relay accepts.
// All Anthropic-compatible relays accept claude-* names; this confirms which.
const PROBE_CANDIDATES = ['claude-sonnet-4-5', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-sonnet-4.5', 'claude-sonnet-5'];

// Env vars that select a model — stripped from the probe child so the candidate
// `--model` is authoritative (otherwise an alias target would shadow it).
const PROBE_STRIP_KEYS = [
  'ANTHROPIC_MODEL',
  ...ANTHROPIC_ALIAS_MODEL_KEYS,
  'ANTHROPIC_SMALL_FAST_MODEL',
];

// Probe one candidate by spawning the real claude CLI with the provider's env and
// `--model <candidate>`. Raw /v1/messages probing is unreliable because picky
// relays (e.g. iFlytek) reject anything but the CLI's full request shape; the CLI
// is the ground truth for what cli-provider-router itself will send. Resolves {model, ok, sample}.
function _probeCandidate(cliCmd, baseEnv, model) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...baseEnv };
    for (const k of PROBE_STRIP_KEYS) delete env[k];
    const child = spawn(cliCmd, ['-p', '--model', model, '--max-turns', '1', '--dangerously-skip-permissions', 'hi'], { env, windowsHide: true });
    let out = '';
    const sink = (c) => { if (out.length < 2048) out += c.toString(); };
    child.stdout.on('data', sink);
    child.stderr.on('data', sink);
    const to = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 25000);
    child.on('error', () => { clearTimeout(to); resolve({ model, ok: false, reason: 'spawn failed (is the claude CLI installed?)' }); });
    child.on('close', () => {
      clearTimeout(to);
      const rejected = /1211|模型不存在|model.*(not found|不存在)|model_not_found/i.test(out);
      resolve({ model, ok: !rejected, sample: out.slice(0, 95) });
    });
  });
}

// Probe which candidate model names a relay accepts. Spawns the claude CLI per
// candidate (sequential; ~N×turn). Returns { tested:[{model,ok,...}], accepted:[model,...] }.
// Renamed from multicc's internal _probeCandidate export name to the public
// `probeRelayModels` (the caller-facing name used in the original module.exports).
async function probeRelayModels(baseEnv, candidates, cliCmd) {
  const cands = (candidates && candidates.length) ? candidates : PROBE_CANDIDATES;
  if (!baseEnv || !baseEnv.ANTHROPIC_BASE_URL) return { tested: [], accepted: [], error: 'no base url' };
  const cmd = cliCmd || 'claude';
  const tested = [];
  for (const m of cands) tested.push(await _probeCandidate(cmd, baseEnv, m));
  return { tested, accepted: tested.filter(o => o.ok).map(o => o.model) };
}

// Compatibility export for callers that historically imported this helper
// directly from spawn-env. The implementation lives in routing.js.
const { applyClaudeProxyEnv } = require('./routing');

module.exports = {
  ProviderRoutingError,
  resolveSessionWireModel,
  buildChildEnv,
  resolveSpawnEnv,
  applyClaudeProxyEnv,
  probeRelayModels,
};
