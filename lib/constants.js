'use strict';

// constants.js — shared constants and tiny helpers for cli-provider-router.
//
// Extracted from multicc's src/providers.js so the router has no hard dependency
// on a multicc install. Everything here is side-effect-free (modulo fs.existsSync
// in resolveCcDb/ccSwitchAvailable, which only reads). Importable from store.js,
// spawn-env.js, and the proxy entry points.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { createCprPaths, DEFAULT_PROXY_PORT } = require('./paths');

// ── app types ────────────────────────────────────────────────────────────────

const APP_TYPES = ['claude', 'codex'];

// Map a session's cli to its provider pool (appType). codex owns its own pool;
// every other cli (claude, opencode, zcode, …) shares the Anthropic-compatible
// 'claude' pool. opencode/zcode honor ANTHROPIC_* env when using an anthropic
// provider, so a chosen claude-pool provider routes correctly for them.
function appTypeForCli(cli) {
  return cli === 'codex' ? 'codex' : 'claude';
}

// ── wire model ───────────────────────────────────────────────────────────────

// Safe wire model used when a provider is "alias-only" — it declares only
// ANTHROPIC_DEFAULT_*_MODEL alias targets (no canonical ANTHROPIC_MODEL). Such
// relays serve their OWN real model ids through the tier vars (e.g. iFlytek's
// "astron-code-latest", Sub2API's "deepseek-v4-pro") and REJECT claude-* wire
// names — iFlytek returns 10404 PathDomainError:Model Not Found for
// claude-sonnet-4-5. So the correct fix is to PROMOTE the relay's own alias
// target to ANTHROPIC_MODEL (so the main --model arg lands on a model the relay
// accepts) and LEAVE the tier vars untouched. Only an alias-only relay with NO
// tier target at all (a pure claude-* passthrough, e.g. CrazyRouter) falls back
// to this claude-* wire name. Override via env if a relay prefers otherwise.
const WIRE_DEFAULT_MODEL = process.env.CLAUDE_WIRE_DEFAULT_MODEL || 'claude-sonnet-4-5';

// ── codex homes ──────────────────────────────────────────────────────────────

// Per-provider CODEX_HOME dirs materialized on demand so codex sessions can
// point at different auth/config without clobbering the global ~/.codex.
// Under cli-provider-router's own data dir (was ~/.multicc/codex-homes).
const CODEX_HOMES_DIR = createCprPaths().codexHomesDir;

// ── cc-switch db ─────────────────────────────────────────────────────────────

// cc-switch stores its data at ~/.cc-switch/ on all platforms (Rust dirs::home_dir).
// On Windows the default is C:\Users\<name>\.cc-switch\. However, Git Bash / Cygwin
// users may have a HOME env var pointing elsewhere, and cc-switch has a legacy
// fallback for that. For cli-provider-router we also check that secondary location.
const CC_DB_DEFAULT = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');

// resolveCcDb(ccSwitchDb?) — accept an explicit override path; otherwise fall
// back to the default ~/.cc-switch/cc-switch.db (plus the Windows Git Bash
// legacy fallback). Returns a path even if the file is absent — callers should
// use ccSwitchAvailable() to check existence.
function resolveCcDb(ccSwitchDb) {
  if (ccSwitchDb) return ccSwitchDb;
  if (fs.existsSync(CC_DB_DEFAULT)) return CC_DB_DEFAULT;
  // Windows Git Bash legacy fallback — cc-switch does the same (see its config.rs)
  if (process.platform === 'win32' && process.env.HOME) {
    const legacy = path.join(process.env.HOME, '.cc-switch', 'cc-switch.db');
    if (fs.existsSync(legacy)) return legacy;
  }
  return CC_DB_DEFAULT; // return default path even if absent (caller checks)
}

// `function ccSwitchAvailable(ccDb) { return fs.existsSync(ccDb); }`
// Accepts the resolved path from resolveCcDb() (or the default if omitted).
function ccSwitchAvailable(ccDb) {
  return fs.existsSync(ccDb || resolveCcDb());
}

// ── domestic / responses-compat proxy maps ──────────────────────────────────

// Domestic providers that only expose /chat/completions (no /responses).
// When a codex provider's baseUrl hits one of these, we rewrite config.toml's
// base_url to the local codex-proxy endpoint and stash the real chat/completions
// URL + apiKey in settingsConfig.proxyTarget for the proxy to read at request
// time. See docs/codex-proxy-contract.md (模块 C).
const DOMESTIC_PROXY_MAP = [
  { host: 'api.deepseek.com', target: 'https://api.deepseek.com/chat/completions' },
  { host: 'open.bigmodel.cn', target: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' },
  { host: 'dashscope.aliyuncs.com', target: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' },
  { hostRe: /^api\.minimax/i, target: 'https://api.minimaxi.com/v1/chat/completions' },
];

// Providers that expose /responses but need a local compatibility hop for Codex
// streaming. XFYun MaaS Coding returns a Responses-shaped stream, but long Codex
// turns can close before Codex observes response.completed; the proxy keeps the
// wire stable and injects only the missing terminal event.
const RESPONSES_COMPAT_PROXY_MAP = [
  { host: 'maas-coding-api.cn-huabei-1.xf-yun.com', target: 'https://maas-coding-api.cn-huabei-1.xf-yun.com/v1/responses' },
];

// ── alias tier keys ──────────────────────────────────────────────────────────

// Tier → env key for the per-tier model-mapping UI (settings screen). Lets a
// user point Claude Code's internal opus/sonnet/haiku/fable resolution at
// specific wire models for a relay, instead of only the single ANTHROPIC_MODEL.
const ALIAS_TIER_KEYS = Object.freeze({
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
});
const ANTHROPIC_ALIAS_MODEL_KEYS = Object.freeze(Object.values(ALIAS_TIER_KEYS));
// Prefer Sonnet as the canonical main-model alias while automatically carrying
// every other tier added to ALIAS_TIER_KEYS in the future.
const ANTHROPIC_ALIAS_MODEL_PRIORITY = Object.freeze([
  ALIAS_TIER_KEYS.sonnet,
  ...ANTHROPIC_ALIAS_MODEL_KEYS.filter(key => key !== ALIAS_TIER_KEYS.sonnet),
]);

// Source-of-truth regex for "is this an alias tier?" — derived from
// ALIAS_TIER_KEYS plus the synthetic 'default' tier, so the vocabulary lives in
// one place. Used by resolveSessionWireModel in spawn-env.js.
const ALIAS_TIER_REGEX = new RegExp('^(?:' + [...Object.keys(ALIAS_TIER_KEYS), 'default'].join('|') + ')$', 'i');

// ── anthropic routing keys ───────────────────────────────────────────────────

// Env vars that select the model and route the endpoint for a claude session.
// cli-provider-router must own these COMPLETELY: a value leaked into the
// router's OWN environment (e.g. a process started from a shell where cc-switch
// had exported ANTHROPIC_DEFAULT_OPUS_MODEL=… + ANTHROPIC_BASE_URL=… for
// DeepSeek) would otherwise be inherited by every spawned `claude` child and
// silently override the per-session provider choice — so switching a session
// back to "default login" or "Claude Official" would have no effect.  We strip
// all of these from the inherited env first, then re-apply only what the chosen
// provider supplies.
// ANTHROPIC_* env keys that route claude to a specific provider/model. If one
// of these leaks into this server's own env (e.g. from the shell that ran the
// process after a cc-switch), every spawned child inherits it and routes
// / bills against the wrong provider, so they are stripped both at startup AND
// in buildChildEnv. Single source of truth — callers import this list instead of
// re-inline-ing it.
const ANTHROPIC_ROUTING_KEYS = Object.freeze([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  ...ANTHROPIC_ALIAS_MODEL_KEYS,
]);
// Values cli-provider-router may write into Claude's persistent/direct-launch
// settings.  Keep this beside the routing list so child-env scrubbing and
// direct CLI takeover cannot silently drift as Claude adds model tiers.
const CLAUDE_MANAGED_ENV_KEYS = Object.freeze([
  ...ANTHROPIC_ROUTING_KEYS,
  'CLAUDE_CODE_SUBAGENT_MODEL',
]);
// Full set stripped from a child env before re-applying the per-session
// provider. Includes CLAUDE_CODE_SIMPLE: cli-provider-router never SETS it
// (leaving it unset preserves the full tool set — Agent, TaskCreate, Workflow,
// ultracode), but the parent process often carries CLAUDE_CODE_SIMPLE=1 left
// over from an earlier setup, and without stripping it the child enters
// SDK/simple mode and its tool set collapses + per-session routing is
// overridden (domestic providers return "model not found" / 1211).
// Strip-without-set => clean child.
const CLAUDE_ROUTING_KEYS = Object.freeze([
  ...CLAUDE_MANAGED_ENV_KEYS,
  'CLAUDE_CODE_SIMPLE',
]);

// Codex routing/credential selectors that must not leak from the router's
// parent process into a provider-scoped child.  A missing CODEX_HOME combined
// with an inherited OPENAI_API_KEY would otherwise silently use a global
// account after provider materialization failed.
const CODEX_ROUTING_KEYS = Object.freeze([
  'CODEX_HOME',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
]);

module.exports = {
  APP_TYPES,
  appTypeForCli,
  WIRE_DEFAULT_MODEL,
  CODEX_HOMES_DIR,
  CC_DB_DEFAULT,
  resolveCcDb,
  ccSwitchAvailable,
  DOMESTIC_PROXY_MAP,
  RESPONSES_COMPAT_PROXY_MAP,
  ALIAS_TIER_KEYS,
  ANTHROPIC_ALIAS_MODEL_KEYS,
  ANTHROPIC_ALIAS_MODEL_PRIORITY,
  ALIAS_TIER_REGEX,
  ANTHROPIC_ROUTING_KEYS,
  CLAUDE_MANAGED_ENV_KEYS,
  CLAUDE_ROUTING_KEYS,
  CODEX_ROUTING_KEYS,
  DEFAULT_PROXY_PORT,
};
