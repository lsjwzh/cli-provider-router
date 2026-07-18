'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const { statePath } = require('./common');
const { readStateStrict } = require('../takeover-state');
const { resolveSnapshotUpstream } = require('./upstream');

const SUPPORTED_APP_TYPES = new Set(['claude', 'codex']);
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function gatewayError(message, code, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}

function decodeSegment(value, label) {
  let decoded;
  try { decoded = decodeURIComponent(value); }
  catch (_) { throw gatewayError(`invalid ${label}`, 'INVALID_GATEWAY_PATH', 400); }
  if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
    throw gatewayError(`invalid ${label}`, 'INVALID_GATEWAY_PATH', 400);
  }
  return decoded;
}

function parseGatewayPath(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl, 'http://cpr.invalid'); }
  catch (_) { throw gatewayError('invalid gateway URL', 'INVALID_GATEWAY_PATH', 400); }
  const rawSegments = parsed.pathname.split('/').filter(Boolean);
  if (rawSegments.length < 2) throw gatewayError('gateway route requires appType and providerId', 'INVALID_GATEWAY_PATH', 404);
  const appType = decodeSegment(rawSegments.shift(), 'appType');
  if (!SUPPORTED_APP_TYPES.has(appType)) throw gatewayError('unsupported appType', 'INVALID_GATEWAY_PATH', 404);
  const providerId = decodeSegment(rawSegments.shift(), 'providerId');
  let endpointId = null;
  if (rawSegments[0] === 'endpoint') {
    rawSegments.shift();
    if (!rawSegments.length) throw gatewayError('endpoint route requires rowId', 'INVALID_GATEWAY_PATH', 404);
    endpointId = decodeSegment(rawSegments.shift(), 'rowId');
  }
  for (const segment of rawSegments) decodeSegment(segment, 'path segment');
  return { appType, providerId, endpointId, suffixPath: rawSegments.join('/'), search: parsed.search };
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (value === 'localhost' || value === 'localhost.localdomain' || value === '0.0.0.0' || value === '::1') return true;
  const family = net.isIP(value);
  if (family === 4) {
    const first = Number(value.split('.')[0]);
    return first === 127 || first === 0;
  }
  return family === 6 && (value === '::1' || value.startsWith('::ffff:127.'));
}

function buildUpstreamUrl(upstream, route, proxyBaseUrl) {
  let target;
  try { target = new URL(upstream); }
  catch (_) { throw gatewayError('snapshot upstream URL is invalid', 'INVALID_SNAPSHOT_UPSTREAM', 502); }
  if (!['http:', 'https:'].includes(target.protocol)) throw gatewayError('snapshot upstream protocol is not allowed', 'INVALID_SNAPSHOT_UPSTREAM', 502);
  if (target.username || target.password) throw gatewayError('credentials in snapshot upstream URL are not allowed', 'INVALID_SNAPSHOT_UPSTREAM', 502);
  if (isLoopbackHostname(target.hostname)) throw gatewayError('snapshot upstream resolves to a local/self endpoint', 'UPSTREAM_LOOP', 508);
  if (proxyBaseUrl) {
    let proxy;
    try { proxy = new URL(proxyBaseUrl); } catch (_) { proxy = null; }
    if (proxy && proxy.origin === target.origin && target.pathname.startsWith(proxy.pathname.replace(/\/+$/, '') + '/ccswitch/')) {
      throw gatewayError('snapshot upstream points back to CPR', 'UPSTREAM_LOOP', 508);
    }
  }
  const basePath = target.pathname.replace(/\/+$/, '');
  target.pathname = route.suffixPath ? `${basePath}/${route.suffixPath}` : (basePath || '/');
  const incoming = new URLSearchParams(route.search);
  for (const [key, value] of incoming) target.searchParams.append(key, value);
  target.hash = '';
  return target;
}

function forwardedHeaders(headers, target) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (lower === 'host' || HOP_BY_HOP.has(lower)) continue;
    out[lower] = value;
  }
  out.host = target.host;
  return out;
}

function responseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers || {}).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())));
}

function createCcSwitchGatewayHandler(options = {}) {
  const home = options.home;
  const requestFactory = options.requestFactory || ((url, requestOptions, callback) =>
    (url.protocol === 'https:' ? https : http).request(url, requestOptions, callback));

  return function ccSwitchGateway(req, res) {
    let route; let state; let target;
    try {
      route = parseGatewayPath(req.url);
      // Corrupt or unreadable lifecycle state must never degrade into an
      // unmanaged-looking gateway. Strict reads keep routing fail-closed.
      state = readStateStrict(options.stateFile || statePath(home));
      if (!state || state.status !== 'active' || !state.snapshotId) {
        throw gatewayError('CC-Switch takeover is not active', 'TAKEOVER_NOT_ACTIVE', 503);
      }
      const upstream = resolveSnapshotUpstream({ home, snapshotId: state.snapshotId, ...route });
      if (!upstream) throw gatewayError('no immutable snapshot upstream for this route', 'UPSTREAM_NOT_FOUND', 404);
      target = buildUpstreamUrl(upstream, route, state.proxyBaseUrl);
    } catch (error) {
      const status = Number(error.statusCode) || 502;
      res.statusCode = status;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify({ error: error.code || 'GATEWAY_RESOLUTION_FAILED', message: status >= 500 ? 'Gateway route unavailable' : error.message }));
      return;
    }

    const upstreamRequest = requestFactory(target, {
      method: req.method,
      headers: forwardedHeaders(req.headers, target),
      signal: undefined,
    }, upstreamResponse => {
      res.writeHead(upstreamResponse.statusCode || 502, responseHeaders(upstreamResponse.headers));
      upstreamResponse.on('error', () => { if (!res.destroyed) res.destroy(); });
      upstreamResponse.pipe(res);
    });
    upstreamRequest.setTimeout(Number(options.timeoutMs) || 120000, () => upstreamRequest.destroy(gatewayError('upstream timeout', 'UPSTREAM_TIMEOUT', 504)));
    upstreamRequest.on('error', error => {
      if (res.headersSent) { if (!res.destroyed) res.destroy(error); return; }
      res.statusCode = error.statusCode || 502;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify({ error: error.code || 'UPSTREAM_REQUEST_FAILED', message: 'Upstream request failed' }));
    });
    req.on('aborted', () => upstreamRequest.destroy());
    req.pipe(upstreamRequest);
  };
}

function mountCcSwitchGateway(app, options = {}) {
  if (!app || typeof app.use !== 'function') throw new Error('an Express-compatible app is required');
  const mountPath = options.mountPath || '/ccswitch';
  const handler = createCcSwitchGatewayHandler(options);
  app.use(mountPath, handler);
  return handler;
}

module.exports = {
  buildUpstreamUrl,
  createCcSwitchGatewayHandler,
  isLoopbackHostname,
  mountCcSwitchGateway,
  parseGatewayPath,
};
