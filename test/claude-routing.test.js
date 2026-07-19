'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('http');
const {
  createHandler,
  decodeCcfwModel,
  parseProxyUrl,
} = require('../lib/proxy/claude');

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        url: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request({ port, method = 'POST', path, body = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body == null
      ? null
      : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, method, path,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function makeProvider(name, baseUrl, env) {
  return {
    name,
    settingsConfig: {
      env: { ANTHROPIC_BASE_URL: baseUrl, ...env },
    },
  };
}

function sseBody(usage) {
  return [
    'event: message_start\n',
    `data: ${JSON.stringify({ type: 'message_start', message: { usage: {
      input_tokens: usage.input,
      cache_creation_input_tokens: usage.cacheWrite,
      cache_read_input_tokens: usage.cacheRead,
    } } })}\n\n`,
    'event: content_block_delta\n',
    `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } })}\n\n`,
    'event: message_delta\n',
    `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: usage.output } })}\n\n`,
    'event: message_stop\n',
    `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ].join('');
}

async function main() {
  console.log('\nClaude subagent provider routing tests');

  await test('ccfw decoder rejects incomplete route keys', () => {
    assert.deepStrictEqual(decodeCcfwModel('ccfw:sub:model:variant'), {
      providerId: 'sub', realModel: 'model:variant',
    });
    assert.strictEqual(decodeCcfwModel('ordinary-model'), null);
    assert.strictEqual(decodeCcfwModel('ccfw::model'), null);
    assert.strictEqual(decodeCcfwModel('ccfw:sub:'), null);
  });

  await test('proxy URL keeps session, API path, and query separate', () => {
    assert.deepStrictEqual(
      parseProxyUrl('/claude-proxy/main-provider/session-1/v1/messages?beta=true'),
      {
        providerId: 'main-provider',
        sessionId: 'session-1',
        apiPath: '/v1/messages',
        query: '?beta=true',
      }
    );
  });

  const mainRequests = [];
  const subRequests = [];
  const mainSse = sseBody({ input: 11, output: 7, cacheWrite: 13, cacheRead: 17 });
  const subSse = sseBody({ input: 19, output: 23, cacheWrite: 29, cacheRead: 31 });

  const mainUpstream = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      mainRequests.push({ req, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(mainSse.slice(0, 37));
      res.end(mainSse.slice(37));
    });
  });
  const subUpstream = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      subRequests.push({ req, body: Buffer.concat(chunks).toString('utf8') });
      if (req.url.includes('json=true')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            input_tokens: 37,
            output_tokens: 41,
            cache_creation_input_tokens: 43,
            cache_read_input_tokens: 47,
          },
        }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(subSse.slice(0, 29));
      res.write(subSse.slice(29, 113));
      res.end(subSse.slice(113));
    });
  });

  const providers = {
    main: makeProvider('Main Provider', `${mainUpstream.url}/main-base`, {
      ANTHROPIC_API_KEY: 'main-secret',
    }),
    sub: makeProvider('Sub Provider', `${subUpstream.url}/sub-base`, {
      ANTHROPIC_AUTH_TOKEN: 'sub-secret',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sub-wire-model[1M]',
    }),
    // Exists in the store but has NO baseUrl and is not `claude-official` —
    // must keep failing closed even on the subagent route (never borrow the
    // subscription token for an arbitrary empty-baseUrl provider).
    'empty-base': {
      name: 'Empty Base',
      settingsConfig: { env: { ANTHROPIC_AUTH_TOKEN: 'empty-secret' } },
    },
  };
  const usageEvents = [];
  const routingEvents = [];
  const proxy = await listen(createHandler({
    getProvider: (_appType, id) => providers[id] || null,
    onUsage: info => usageEvents.push(info),
    onRoutingEvent: event => routingEvents.push(event),
  }));

  try {
    await test('HEAD connectivity probe does not hit an upstream', async () => {
      const response = await request({
        port: proxy.port,
        method: 'HEAD',
        path: '/claude-proxy/main/session-1/',
      });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(mainRequests.length, 0);
      assert.strictEqual(subRequests.length, 0);
    });

    await test('main request stays on the main provider and preserves SSE bytes', async () => {
      const response = await request({
        port: proxy.port,
        path: '/claude-proxy/main/session-1/v1/messages?beta=true',
        headers: {
          authorization: 'Bearer multicc-session-1',
          'x-api-key': 'virtual-key',
          'accept-encoding': 'gzip, br',
        },
        body: { model: 'main-wire-model', stream: true, messages: [] },
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body, mainSse);
      assert.strictEqual(mainRequests.length, 1);
      assert.strictEqual(subRequests.length, 0);
      const seen = mainRequests[0];
      assert.strictEqual(seen.req.url, '/main-base/v1/messages?beta=true');
      assert.strictEqual(seen.req.headers['x-api-key'], 'main-secret');
      assert.strictEqual(seen.req.headers.authorization, undefined);
      assert.strictEqual(seen.req.headers['accept-encoding'], undefined);
      assert.strictEqual(JSON.parse(seen.body).model, 'main-wire-model');
      assert.strictEqual(Number(seen.req.headers['content-length']), Buffer.byteLength(seen.body));
      assert.deepStrictEqual(usageEvents[0], {
        sessionId: 'session-1',
        role: 'main',
        providerId: 'main',
        providerName: 'Main Provider',
        model: 'main-wire-model',
        isStream: true,
        usage: { inputTokens: 11, outputTokens: 7, cacheWrite: 13, cacheRead: 17 },
      });
    });

    await test('subagent request switches provider, auth, and tier-mapped wire model', async () => {
      const response = await request({
        port: proxy.port,
        path: '/claude-proxy/main/session-1/v1/messages',
        body: { model: 'ccfw:sub:sonnet', stream: true, messages: [] },
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body, subSse);
      assert.strictEqual(mainRequests.length, 1);
      assert.strictEqual(subRequests.length, 1);
      const seen = subRequests[0];
      assert.strictEqual(seen.req.url, '/sub-base/v1/messages');
      assert.strictEqual(seen.req.headers.authorization, 'Bearer sub-secret');
      assert.strictEqual(seen.req.headers['x-api-key'], undefined);
      assert.strictEqual(JSON.parse(seen.body).model, 'sub-wire-model');
      assert.strictEqual(Number(seen.req.headers['content-length']), Buffer.byteLength(seen.body));
      assert.deepStrictEqual(usageEvents[1], {
        sessionId: 'session-1',
        role: 'sub',
        providerId: 'sub',
        providerName: 'Sub Provider',
        model: 'sub-wire-model',
        isStream: true,
        usage: { inputTokens: 19, outputTokens: 23, cacheWrite: 29, cacheRead: 31 },
      });
    });

    await test('non-stream subagent usage is attributed independently', async () => {
      const response = await request({
        port: proxy.port,
        path: '/claude-proxy/main/session-2/v1/messages?json=true',
        body: { model: 'ccfw:sub:custom:model', stream: false, messages: [] },
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(response.status, 200);
      assert.strictEqual(JSON.parse(subRequests[1].body).model, 'custom:model');
      assert.deepStrictEqual(usageEvents[2], {
        sessionId: 'session-2',
        role: 'sub',
        providerId: 'sub',
        providerName: 'Sub Provider',
        model: 'custom:model',
        isStream: false,
        usage: { inputTokens: 37, outputTokens: 41, cacheWrite: 43, cacheRead: 47 },
      });
    });

    await test('Aux proxy usage does not pollute the main role', async () => {
      const response = await request({
        port: proxy.port,
        path: '/claude-proxy/main/aux/v1/messages',
        body: { model: 'main-wire-model', stream: true, messages: [] },
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body, mainSse);
      assert.deepStrictEqual(usageEvents[3], {
        sessionId: 'aux',
        role: 'aux',
        providerId: 'main',
        providerName: 'Main Provider',
        model: 'main-wire-model',
        isStream: true,
        usage: { inputTokens: 11, outputTokens: 7, cacheWrite: 13, cacheRead: 17 },
      });
    });

    await test('dangling subagent provider fails open to the main provider', async () => {
      const mainSeen = mainRequests.length;
      const response = await request({
        port: proxy.port,
        path: '/claude-proxy/main/session-3/v1/messages',
        body: { model: 'ccfw:missing:sub-real-model', stream: true, messages: [] },
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(response.status, 200, 'no longer 502');
      assert.strictEqual(response.body, mainSse);
      assert.strictEqual(mainRequests.length, mainSeen + 1, 'forwarded to the MAIN upstream');
      const seen = mainRequests[mainSeen];
      assert.strictEqual(seen.req.url, '/main-base/v1/messages');
      assert.strictEqual(seen.req.headers['x-api-key'], 'main-secret', 'main creds used');
      assert.strictEqual(JSON.parse(seen.body).model, 'sub-real-model', 'decoded real model still sent');
      // Exactly one fallback event, mirroring spawn-env's shape.
      assert.strictEqual(routingEvents.length, 1);
      const event = routingEvents[0];
      assert.strictEqual(event.type, 'provider-routing-fallback');
      assert.strictEqual(event.status, 'default-fallback');
      assert.strictEqual(event.reason, 'unknown-sub-provider');
      assert.strictEqual(event.providerId, 'missing');
      assert.strictEqual(event.fallbackProviderId, 'main');
      assert.strictEqual(event.error.code, 'PROVIDER_NOT_FOUND');
      // Usage is attributed to the provider that actually served the request.
      const usage = usageEvents[usageEvents.length - 1];
      assert.strictEqual(usage.role, 'sub');
      assert.strictEqual(usage.providerId, 'main');
      assert.strictEqual(usage.providerName, 'Main Provider');
    });

    await test('subagent provider that exists with an empty baseUrl still fails closed', async () => {
      const response = await request({
        port: proxy.port,
        path: '/claude-proxy/main/session-3/v1/messages',
        body: { model: 'ccfw:empty-base:some-model', stream: true, messages: [] },
      });
      assert.strictEqual(response.status, 502);
      assert.match(response.body, /provider 'empty-base' has no baseUrl/);
      assert.strictEqual(routingEvents.length, 1, 'no fallback event for the empty-baseUrl invariant');
    });

    await test('unknown MAIN provider still fails closed (no fallback)', async () => {
      const response = await request({
        port: proxy.port,
        path: '/claude-proxy/ghost/session-3/v1/messages',
        body: { model: 'plain-model', stream: true, messages: [] },
      });
      assert.strictEqual(response.status, 502);
      assert.match(response.body, /provider 'ghost' has no baseUrl/);
      assert.strictEqual(routingEvents.length, 1, 'main route never falls back');
    });

    await test('subagent route pointing at its own missing main provider still fails closed', async () => {
      const response = await request({
        port: proxy.port,
        path: '/claude-proxy/ghost/session-3/v1/messages',
        body: { model: 'ccfw:ghost:some-model', stream: true, messages: [] },
      });
      assert.strictEqual(response.status, 502, 'sub == main and both missing → nothing to fall back to');
      assert.strictEqual(routingEvents.length, 1);
    });
  } finally {
    await close(proxy.server);
    await close(mainUpstream.server);
    await close(subUpstream.server);
  }

}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
