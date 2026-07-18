'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const { normalizeProxyBaseUrl } = require('./common');

function isLoopback(hostname) {
  const value = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (value === 'localhost' || value === '::1') return true;
  if (net.isIP(value) === 4) return Number(value.split('.')[0]) === 127;
  return value.startsWith('::ffff:127.');
}

function defaultProbe(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.get(url, { timeout: timeoutMs, headers: { accept: 'application/json' } }, response => {
      const chunks = [];
      response.on('data', chunk => {
        if (chunks.reduce((sum, item) => sum + item.length, 0) < 16384) chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`health endpoint returned HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { reject(new Error(`health endpoint returned invalid JSON: ${error.message}`)); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('health probe timed out')));
    request.on('error', reject);
  });
}

async function assertProxyHealthy(options = {}) {
  const proxyBaseUrl = normalizeProxyBaseUrl(options.proxyBaseUrl);
  const parsed = new URL(proxyBaseUrl);
  if (!isLoopback(parsed.hostname)) {
    throw Object.assign(new Error('CC-Switch takeover proxy must bind to loopback'), { code: 'PROXY_NOT_LOOPBACK' });
  }
  const expectedNonce = String(options.healthNonce || '');
  if (expectedNonce.length < 16) {
    throw Object.assign(new Error('a service-generated health nonce is required before takeover'), { code: 'PROXY_HEALTH_NONCE_REQUIRED' });
  }
  const healthUrl = new URL('/health', `${proxyBaseUrl}/`);
  let health;
  try {
    health = options.healthProbe
      ? await options.healthProbe({ url: healthUrl, expectedNonce, timeoutMs: options.healthTimeoutMs || 1500 })
      : await defaultProbe(healthUrl, options.healthTimeoutMs || 1500);
  } catch (cause) {
    throw Object.assign(new Error(`CPR proxy health check failed: ${cause.message}`), { code: 'PROXY_HEALTH_FAILED', cause });
  }
  if (!health || health.ok !== true || health.product !== 'cli-provider-router-proxy' || health.takeoverNonce !== expectedNonce) {
    throw Object.assign(new Error('CPR proxy health response or takeover nonce did not match this service instance'), {
      code: 'PROXY_HEALTH_NONCE_MISMATCH',
    });
  }
  return { proxyBaseUrl, health: { ok: true, product: health.product, pid: health.pid, takeoverNonce: expectedNonce } };
}

module.exports = { assertProxyHealthy, isLoopback };
