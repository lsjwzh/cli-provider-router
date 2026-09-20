'use strict';

const { EnvHttpProxyAgent, Pool, fetch: undiciFetch } = require('undici');

const DEFAULT_DISPATCHER_OPTIONS = Object.freeze({
  allowH2: true,
  pipelining: 1,
  bodyTimeout: 0,
  headersTimeout: 300_000,
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 60_000,
});

function httpUrl(input) {
  if (!(typeof input === 'string' || input instanceof URL)) return null;
  let url;
  try { url = new URL(input); } catch (_) { return null; }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
}

function errorChain(error, limit = 8) {
  const errors = [];
  const seen = new Set();
  for (let current = error; current && errors.length < limit && !seen.has(current); current = current.cause) {
    seen.add(current);
    errors.push(current);
  }
  return errors;
}

function isInvalidHttp2Session(error) {
  return errorChain(error).some(item => item && item.code === 'ERR_HTTP2_INVALID_SESSION');
}

function isHttp2GoAway(error) {
  return errorChain(error).some(item => {
    if (!item) return false;
    if (item.code === 'ERR_HTTP2_GOAWAY_SESSION') return true;
    return /(?:http\/2|h2).*goaway|goaway.*(?:http\/2|h2)/i.test(String(item.message || ''));
  });
}

function replayableRequest(input, init = {}) {
  if (!httpUrl(input) || init.signal?.aborted) return false;
  const body = init.body;
  if (body == null || typeof body === 'string' || Buffer.isBuffer(body)) return true;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof URLSearchParams) return true;
  return typeof Blob !== 'undefined' && body instanceof Blob;
}

function proxyConfiguration(env) {
  const all = env.all_proxy ?? env.ALL_PROXY ?? '';
  const httpProxy = env.http_proxy ?? env.HTTP_PROXY ?? all;
  const httpsProxy = env.https_proxy ?? env.HTTPS_PROXY ?? httpProxy ?? all;
  if (!httpProxy && !httpsProxy) return null;
  return { httpProxy, httpsProxy, noProxy: env.no_proxy ?? env.NO_PROXY ?? '' };
}

function createProviderTransport(options = {}) {
  const fetchImpl = options.fetch || undiciFetch;
  const env = options.env || process.env;
  const onRotate = typeof options.onRotate === 'function' ? options.onRotate : () => {};
  const dispatcherOptions = Object.freeze({
    ...DEFAULT_DISPATCHER_OPTIONS,
    ...(options.dispatcherOptions || {}),
    // HTTP/2 is intentional. HTTP/1.1 remains the negotiated fallback.
    allowH2: true,
  });
  const createDispatcher = options.createDispatcher || ((origin, config) => {
    const proxy = proxyConfiguration(env);
    return proxy ? new EnvHttpProxyAgent({ ...config, ...proxy }) : new Pool(origin, config);
  });
  if (typeof fetchImpl !== 'function') throw new TypeError('provider transport fetch is required');

  const origins = new Map();
  const closingDispatchers = new Set();
  let generation = 0;
  let closing = false;

  function retire(entry) {
    if (!entry || entry.retired) return;
    entry.retired = true;
    const pending = Promise.resolve().then(() => entry.dispatcher.close()).catch(() => {});
    closingDispatchers.add(pending);
    pending.finally(() => closingDispatchers.delete(pending));
  }

  function rotate(origin, failedEntry, reason) {
    const current = origins.get(origin);
    if (closing || (current && current !== failedEntry)) return current || null;
    let replacement;
    try { replacement = createEntry(origin); } catch (_) { return current || null; }
    origins.set(origin, replacement);
    retire(failedEntry);
    try { onRotate({ origin, reason, generation: replacement.generation }); } catch (_) {}
    return replacement;
  }

  function createEntry(origin) {
    const entry = {
      origin,
      generation: ++generation,
      dispatcher: createDispatcher(origin, dispatcherOptions),
      retired: false,
    };
    if (!entry.dispatcher || typeof entry.dispatcher.close !== 'function') {
      throw new TypeError('provider dispatcher must implement close()');
    }
    if (typeof entry.dispatcher.on === 'function') {
      entry.dispatcher.on('disconnect', (_origin, _targets, error) => {
        if (!closing && isHttp2GoAway(error)) rotate(origin, entry, 'h2_goaway');
      });
    }
    return entry;
  }

  function currentEntry(origin) {
    if (closing) {
      const error = new Error('provider transport is closed');
      error.code = 'CPR_PROVIDER_TRANSPORT_CLOSED';
      throw error;
    }
    let entry = origins.get(origin);
    if (!entry) {
      entry = createEntry(origin);
      origins.set(origin, entry);
    }
    return entry;
  }

  async function fetch(input, init) {
    const url = httpUrl(input);
    if (!url) throw new TypeError('provider transport requires an absolute HTTP(S) URL');
    const origin = url.origin;
    const entry = currentEntry(origin);
    try {
      return await fetchImpl(input, { ...(init || {}), dispatcher: entry.dispatcher });
    } catch (error) {
      if (!isInvalidHttp2Session(error)) throw error;
      const replacement = rotate(origin, entry, 'invalid_h2_session');
      if (!replacement || !replayableRequest(input, init)) throw error;

      // ERR_HTTP2_INVALID_SESSION is raised while opening a stream on a session
      // that is already destroyed, so this request was not accepted upstream.
      // Retry it exactly once on the replacement. Ambiguous failures are never
      // replayed here because their delivery state cannot be proved.
      try {
        return await fetchImpl(input, { ...(init || {}), dispatcher: replacement.dispatcher });
      } catch (retryError) {
        if (isInvalidHttp2Session(retryError)) {
          rotate(origin, replacement, 'invalid_h2_session_retry');
        }
        throw retryError;
      }
    }
  }

  async function close() {
    if (!closing) {
      closing = true;
      const active = [...origins.values()];
      origins.clear();
      active.forEach(retire);
    }
    await Promise.allSettled([...closingDispatchers]);
  }

  return Object.freeze({ fetch, close });
}

module.exports = {
  DEFAULT_DISPATCHER_OPTIONS,
  createProviderTransport,
  httpUrl,
  isHttp2GoAway,
  isInvalidHttp2Session,
  replayableRequest,
};
