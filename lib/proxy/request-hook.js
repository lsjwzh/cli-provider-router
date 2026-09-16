'use strict';
// Local request hooks — the embedder's data-correction stage ON the hop.
// 本机请求钩子：把宿主的数据修正逻辑挂在转发链路上，而不是散在 spawn 之前。
//
// Why a hook and not a spawn-time filter: the proxy is the last thing to see a
// request before the upstream, and the only thing that ever sees the upstream
// REJECT it. Some bodies are valid for one provider and invalid for the next —
// history a previous upstream accepted (assistant reasoning traces, encrypted
// blobs, response ids that no longer resolve), content shapes one model family
// refuses — and that is data only the HOST knows about. So the router hands the
// host two moments, without giving up any guarantee of the forwarded turn:
//
//   onRequest(ctx)            before the dial; may return a replacement body
//   onUpstreamRejected(ctx)   after a non-2xx; may return {retry:true, body}
//
// Contract, deliberately narrow:
//
//   · ctx.body is the body in the CLIENT's protocol — the shape the CLI itself
//     sent (Anthropic messages for claude, a Responses object for codex), even
//     when the router has to translate it on the way upstream. The host repairs
//     the shape it owns; translation re-runs on the repaired body afterwards.
//   · ctx.body is the parsed object when the body is JSON, otherwise the raw
//     string; ctx.bodyText is always the raw text. Return the replacement as
//     `{ body }` — an object (re-serialized) or a string (used verbatim).
//   · Returning nothing, null, undefined or `{ retry: false }` leaves the
//     request ALONE, and the original bytes are forwarded untouched: an
//     untouched turn keeps a byte-exact, prompt-cache-friendly body and pays
//     nothing for the hook merely being installed.
//   · Retries are bounded by `hookRetryMax` (default 1) and counted here, not by
//     the caller's own attempt counter, so a hook that always asks to retry
//     cannot keep a turn alive.
//   · Every call is bounded by `hookTimeoutMs` (default 5000) and swallows its
//     own errors. Hook code is HOST code running inside the router process: a
//     buggy, slow or wedged hook must never take the router down, wedge a turn,
//     or change the answer the client gets.

const DEFAULT_HOOK_TIMEOUT_MS = 5000;
const DEFAULT_HOOK_RETRY_MAX = 1;
// An error body is only ever read to (a) show the client and (b) hand to the
// host. Both are bounded: 64 KiB is far more than any provider's error JSON and
// small enough that a provider streaming an endless error body cannot turn a
// rejection into a memory leak.
const MAX_ERROR_BODY_BYTES = 64 * 1024;

function isBodyObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function serializeBody(value) {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value && typeof value === 'object') {
    try { return JSON.stringify(value); } catch (_) { return null; }
  }
  return null;
}

function parseBodyObject(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const value = JSON.parse(text);
    return isBodyObject(value) ? value : null;
  } catch (_) { return null; }
}

async function callHook(fn, payload, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(() => fn(payload)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    console.warn(`[cpr] ${label} hook ignored: ${(error && error.message) || error}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Normalize the hook options a mount/handler was given.
 * @param {{ onRequest?:Function, onUpstreamRejected?:Function, hookRetryMax?:number, hookTimeoutMs?:number }} options
 */
function createRequestHooks(options = {}) {
  const onRequest = typeof options.onRequest === 'function' ? options.onRequest : null;
  const onUpstreamRejected = typeof options.onUpstreamRejected === 'function' ? options.onUpstreamRejected : null;
  const retryMax = Number.isInteger(options.hookRetryMax) && options.hookRetryMax >= 0
    ? options.hookRetryMax
    : DEFAULT_HOOK_RETRY_MAX;
  const timeoutMs = Number.isInteger(options.hookTimeoutMs) && options.hookTimeoutMs > 0
    ? options.hookTimeoutMs
    : DEFAULT_HOOK_TIMEOUT_MS;
  return Object.freeze({
    hasRequest: !!onRequest,
    hasRejected: !!onUpstreamRejected,
    retryMax,
    timeoutMs,
    active: !!(onRequest || onUpstreamRejected),
    request: onRequest
      ? payload => callHook(onRequest, payload, timeoutMs, 'onRequest')
      : async () => null,
    rejected: onUpstreamRejected
      ? payload => callHook(onUpstreamRejected, payload, timeoutMs, 'onUpstreamRejected')
      : async () => null,
  });
}

/**
 * One request's hook bookkeeping: owns the current body, applies hook decisions,
 * and counts repairs. Callers keep their own dial loop and only ask
 * `prepare()` / `repair()` whether the body changed.
 *
 * @param {ReturnType<typeof createRequestHooks>} hooks
 * @param {object} base routing context; `body` is the client-protocol body
 */
function createRequestStage(hooks, base) {
  const originalText = serializeBody(base.body);
  let text = originalText;
  let body = isBodyObject(base.body) ? base.body : parseBodyObject(originalText);
  let repairs = 0;
  const { body: _ignored, ...context } = base;
  const hooked = !!hooks && hooks.active && typeof text === 'string';

  // A hook's returned body wins over the current one; `body` stays an object
  // whenever the replacement can be parsed as one, so callers that need the
  // structured shape (protocol translation) never re-parse by hand, while
  // `text` keeps the exact bytes the hook returned.
  const apply = result => {
    if (!result || typeof result !== 'object') return false;
    if (!Object.prototype.hasOwnProperty.call(result, 'body')) return false;
    const next = serializeBody(result.body);
    if (typeof next !== 'string' || next === text) return false;
    text = next;
    body = isBodyObject(result.body) ? result.body : parseBodyObject(next);
    return true;
  };

  return {
    get text() { return text; },
    get body() { return body; },
    get changed() { return text !== originalText; },
    get repairs() { return repairs; },
    get retryMax() { return hooks ? hooks.retryMax : 0; },
    // The bytes to forward. `fallback` is the untouched original buffer, kept
    // verbatim when no hook changed anything (byte-exact prompt-cache prefix).
    buffer(fallback) {
      if (text === originalText && Buffer.isBuffer(fallback)) return fallback;
      return Buffer.from(text, 'utf8');
    },
    /** Run the pre-dial hook once. @returns {Promise<boolean>} body changed */
    async prepare() {
      if (!hooked || !hooks.hasRequest) return false;
      return apply(await hooks.request({ ...context, body, bodyText: text }));
    },
    /**
     * Offer a rejected request to the host.
     * @returns {Promise<boolean>} true ⇒ dial again with the (repaired) body
     */
    async repair({ status, message, attempt, errorCode } = {}) {
      if (!hooked || !hooks.hasRejected) return false;
      if (repairs >= hooks.retryMax) return false;
      const result = await hooks.rejected({
        ...context, body, bodyText: text,
        status, message: message || '', attempt: attempt || 1, errorCode: errorCode || 'UPSTREAM_HTTP_ERROR',
      });
      // `retry: true` is what authorizes a second dial — a body returned without
      // it is ignored, so a hook that merely inspects the rejection cannot
      // change what the client ends up seeing. `{retry:true}` with no body
      // re-dials the same request (waiting out a transient rejection); both are
      // bounded by hookRetryMax.
      if (!result || typeof result !== 'object' || result.retry !== true) return false;
      apply(result);
      repairs += 1;
      return true;
    },
  };
}

/** Read a rejection body, bounded, without ever throwing. */
async function readErrorBody(source, maxBytes = MAX_ERROR_BODY_BYTES) {
  if (!source) return '';
  try {
    // fetch Response
    if (typeof source.text === 'function' && typeof source.arrayBuffer === 'function') {
      const text = await source.text();
      return String(text || '').slice(0, maxBytes);
    }
    // node http.IncomingMessage
    const chunks = [];
    let size = 0;
    for await (const chunk of source) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const room = maxBytes - size;
      if (room <= 0) break;
      chunks.push(buf.length > room ? buf.subarray(0, room) : buf);
      size += Math.min(buf.length, room);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (_) {
    return '';
  }
}

module.exports = {
  createRequestHooks,
  createRequestStage,
  readErrorBody,
  serializeBody,
  parseBodyObject,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_HOOK_RETRY_MAX,
  MAX_ERROR_BODY_BYTES,
};
