'use strict';

// Downstream-disconnect handling for the codex proxy.
//
// Same incident shape as the claude proxy: the Codex CLI is the proxy's only
// downstream consumer, and when it is cancelled or killed mid-turn the proxy
// must (a) reach a terminal state exactly once so a host's per-provider producer
// accounting drains instead of wedging, and (b) release the provider connection
// so we stop paying for a stream nobody reads.
//
// Codex has three streaming paths and they failed differently:
//   · direct-responses  — no close detection at all. `while (true)` drained a
//     dead socket, and a stalled provider left `reader.read()` pending forever.
//   · chat-to-responses — noticed the close but only broke the loop; the undici
//     body stayed unconsumed, so the provider socket stayed open.
//   · responses-compat  — released the upstream correctly, but recorded the
//     abandoned turn as a plain 'success'.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const { mountCodexProxy } = require('../lib/proxy/codex');
const { createHopCredentialStore } = require('../lib/proxy/hop-credentials');

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function close(server) {
  // Destroy lingering sockets first. A leaked provider connection — precisely
  // what a regression here would produce — otherwise keeps server.close() from
  // ever resolving, turning a clean failure into a hung suite.
  try { server.closeAllConnections(); } catch (_) {}
  return new Promise(resolve => server.close(resolve));
}

// A fake provider upstream. `seen` records one entry per request with `closed`
// flipped when the upstream side observes its socket go away — direct evidence
// that the proxy actually released the provider connection.
function upstream(behaviour) {
  const seen = [];
  return listen((req, res) => {
    const entry = { req, res, closed: false };
    seen.push(entry);
    res.on('close', () => { entry.closed = true; });
    req.resume();
    req.on('end', () => behaviour({ req, res, entry }));
  }).then(handle => Object.assign(handle, { seen }));
}

function clientRequest({ port, path: pathname, body, abort = null }) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body || {}));
    let settled = false;
    let received = 0;
    let status = null;
    let text = '';
    const finish = (aborted) => {
      if (settled) return;
      settled = true;
      resolve({ aborted, status, received, text });
    };
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: pathname,
      headers: {
        'content-type': 'application/json',
        'content-length': String(payload.length),
        authorization: 'Bearer multicc-local',
      },
    }, (res) => {
      status = res.statusCode;
      res.on('data', (chunk) => {
        received += chunk.length;
        text += chunk.toString('utf8');
        if (abort && abort.afterBytes != null && received >= abort.afterBytes) {
          req.destroy();
          finish(true);
        }
      });
      res.on('end', () => finish(false));
      res.on('error', () => finish(true));
    });
    req.on('error', () => finish(true));
    if (abort && abort.afterMs != null) {
      setTimeout(() => { req.destroy(); finish(true); }, abort.afterMs);
    }
    req.write(payload);
    req.end();
  });
}

async function waitFor(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// `wire_api` picks the path: "responses" on an ordinary host -> direct-responses,
// "chat" -> chat-to-responses. responses-compat is host-pinned in the resolver,
// so it is reached through the explicit proxyTarget form instead.
function tomlProvider({ name, baseUrl, wireApi }) {
  return {
    name,
    settingsConfig: {
      auth: { OPENAI_API_KEY: 'provider-secret' },
      config: [
        'model_provider = "custom"',
        'model = "test-model"',
        '[model_providers.custom]',
        'name = "custom"',
        `base_url = "${baseUrl}"`,
        `wire_api = "${wireApi}"`,
        'requires_openai_auth = true',
        '',
      ].join('\n'),
    },
  };
}

function compatProvider({ name, url }) {
  return {
    name,
    settingsConfig: {
      auth: { OPENAI_API_KEY: 'provider-secret' },
      proxyTarget: { baseUrl: url, mode: 'responses-compat', apiKey: 'provider-secret' },
    },
  };
}

function responsesSse() {
  const response = {
    id: 'resp_mock', object: 'response', status: 'completed', model: 'test-model',
    output: [{
      type: 'message', id: 'msg_mock', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'hello', annotations: [], logprobs: [] }],
    }],
    usage: { input_tokens: 30, input_tokens_details: { cached_tokens: 10 }, output_tokens: 5 },
  };
  return [
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
  ].join('');
}

function chatSse() {
  return [
    `data: ${JSON.stringify({ id: 'chat-1', choices: [{ index: 0, delta: { content: 'hello' } }] })}\n\n`,
    `data: ${JSON.stringify({
      id: 'chat-1',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 21, completion_tokens: 5, total_tokens: 26 },
    })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

// Build a proxy over a fixed provider map with recording sinks.
function mount(providers, sinks = {}) {
  const hopHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-codex-disconnect-'));
  const app = express();
  app.use(express.json());
  mountCodexProxy(app, {
    getProvider: (_appType, id) => providers[id] || null,
    getPort: () => 0,
    hopCredentials: createHopCredentialStore({ cprHome: hopHome }),
    ...sinks,
  });
  return listen(app).then(handle => Object.assign(handle, {
    cleanup: () => fs.rmSync(hopHome, { recursive: true, force: true }),
  }));
}

function recorder() {
  const usage = [];
  const activity = [];
  return {
    usage,
    activity,
    sinks: {
      onUsageEvent: info => usage.push(info),
      onActivity: event => activity.push(event),
    },
    ends: () => activity.filter(e => e.phase === 'end'),
  };
}

async function main() {
  console.log('\nCodex proxy downstream-disconnect tests');

  // ---------------------------------------------------------------- 1
  await test('direct-responses: disconnect before first byte settles once and aborts the hung upstream', async () => {
    // The incident shape. Before the fix this path had no close handling at all,
    // so `reader.read()` stayed pending against a provider that never answers and
    // the request wedged with no terminal event ever emitted.
    const up = await upstream(() => { /* deliberately never responds */ });
    const rec = recorder();
    const proxy = await mount({ p: tomlProvider({ name: 'Hung', baseUrl: `${up.url}/v1`, wireApi: 'responses' }) }, rec.sinks);
    try {
      const result = await clientRequest({
        port: proxy.port,
        path: '/codex-proxy/p/sess-1/main/responses',
        body: { model: 'test-model', input: [], stream: true },
        abort: { afterMs: 120 },
      });
      assert.equal(result.aborted, true);
      await waitFor(() => up.seen.length === 1 && up.seen[0].closed, 'upstream connection released');
      await waitFor(() => rec.usage.length === 1, 'exactly one usage event');
      assert.equal(rec.usage[0].status, 'error');
      assert.equal(rec.usage[0].errorCode, 'CLIENT_DISCONNECTED');
      assert.equal(rec.usage[0].isStream, true);
      assert.equal(rec.ends().length, 1);
      assert.equal(rec.ends()[0].status, 'error');
      // Nothing after the settle may add a second terminal event.
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(rec.usage.length, 1);
      assert.equal(rec.ends().length, 1);
    } finally {
      await close(proxy.server);
      proxy.cleanup();
      await close(up.server);
    }
  });

  // ---------------------------------------------------------------- 2
  await test('direct-responses: disconnect mid-stream releases the upstream instead of draining it', async () => {
    let written = 0;
    const up = await upstream(({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'part' })}\n\n`);
      // Keep feeding. If the proxy merely stopped writing without releasing the
      // body, this timer would keep running against a dead downstream.
      const timer = setInterval(() => {
        written += 1;
        try { res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'x' })}\n\n`); } catch (_) {}
      }, 10);
      res.on('close', () => clearInterval(timer));
    });
    const rec = recorder();
    const proxy = await mount({ p: tomlProvider({ name: 'Chatty', baseUrl: `${up.url}/v1`, wireApi: 'responses' }) }, rec.sinks);
    try {
      const result = await clientRequest({
        port: proxy.port,
        path: '/codex-proxy/p/sess-2/main/responses',
        body: { model: 'test-model', input: [], stream: true },
        abort: { afterBytes: 1 },
      });
      assert.equal(result.aborted, true);
      await waitFor(() => up.seen.length === 1 && up.seen[0].closed, 'upstream connection released');
      await waitFor(() => rec.usage.length === 1, 'exactly one usage event');
      assert.equal(rec.usage[0].errorCode, 'CLIENT_DISCONNECTED');
      assert.equal(rec.usage[0].status, 'error');
      assert.equal(rec.ends().length, 1);
      const frozen = written;
      await new Promise(resolve => setTimeout(resolve, 120));
      assert.equal(written, frozen, 'upstream kept producing after the client left');
    } finally {
      await close(proxy.server);
      proxy.cleanup();
      await close(up.server);
    }
  });

  // ---------------------------------------------------------------- 3
  await test('direct-responses: normal completions are never reported as disconnects', async () => {
    const sse = responsesSse();
    const up = await upstream(({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse);
    });
    const rec = recorder();
    const proxy = await mount({ p: tomlProvider({ name: 'Good', baseUrl: `${up.url}/v1`, wireApi: 'responses' }) }, rec.sinks);
    try {
      const result = await clientRequest({
        port: proxy.port,
        path: '/codex-proxy/p/sess-3/main/responses',
        body: { model: 'test-model', input: [], stream: true },
      });
      assert.equal(result.aborted, false);
      assert.equal(result.status, 200);
      assert.equal(result.text, sse, 'stream forwarded byte for byte');
      await waitFor(() => rec.usage.length === 1, 'usage event');
      assert.equal(rec.usage[0].status, 'success');
      assert.equal(rec.usage[0].errorCode, undefined);
      assert.deepStrictEqual(rec.usage[0].usage, {
        inputTokens: 20, outputTokens: 5, cacheWrite: 0, cacheRead: 10,
      });
      assert.deepStrictEqual(rec.activity.map(e => e.phase), ['request', 'first_byte', 'end']);
      assert.equal(rec.ends()[0].status, 'success');
    } finally {
      await close(proxy.server);
      proxy.cleanup();
      await close(up.server);
    }
  });

  // ---------------------------------------------------------------- 4
  await test('direct-responses: upstream failures keep their own errorCode', async () => {
    const up = await upstream(({ res }) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'slow down' }));
    });
    const rec = recorder();
    const proxy = await mount({ p: tomlProvider({ name: 'Busy', baseUrl: `${up.url}/v1`, wireApi: 'responses' }) }, rec.sinks);
    try {
      await clientRequest({
        port: proxy.port,
        path: '/codex-proxy/p/sess-4/main/responses',
        body: { model: 'test-model', input: [], stream: true },
      });
      await waitFor(() => rec.usage.length === 1, 'usage event');
      assert.equal(rec.usage[0].errorCode, 'UPSTREAM_HTTP_ERROR');
      assert.equal(rec.usage[0].statusCode, 429);
      assert.equal(rec.ends().length, 1);
    } finally {
      await close(proxy.server);
      proxy.cleanup();
      await close(up.server);
    }
  });

  // ---------------------------------------------------------------- 5
  await test('chat-to-responses: disconnect releases the provider body, not just the loop', async () => {
    // This path already broke its read loop on close, but abandoning an undici
    // reader without cancelling leaves the connection open — the leak this pins.
    let written = 0;
    const up = await upstream(({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'chat-1', choices: [{ index: 0, delta: { content: 'part' } }] })}\n\n`);
      const timer = setInterval(() => {
        written += 1;
        try { res.write(`data: ${JSON.stringify({ id: 'chat-1', choices: [{ index: 0, delta: { content: 'x' } }] })}\n\n`); } catch (_) {}
      }, 10);
      res.on('close', () => clearInterval(timer));
    });
    const rec = recorder();
    const proxy = await mount({ p: tomlProvider({ name: 'ChatUp', baseUrl: `${up.url}/v1`, wireApi: 'chat' }) }, rec.sinks);
    try {
      const result = await clientRequest({
        port: proxy.port,
        path: '/codex-proxy/p/sess-5/main/responses',
        body: { model: 'test-model', input: [], stream: true },
        abort: { afterBytes: 1 },
      });
      assert.equal(result.aborted, true);
      await waitFor(() => up.seen.length === 1 && up.seen[0].closed, 'upstream connection released');
      await waitFor(() => rec.usage.length === 1, 'exactly one usage event');
      assert.equal(rec.usage[0].status, 'error');
      assert.equal(rec.usage[0].errorCode, 'CLIENT_DISCONNECTED');
      assert.equal(rec.ends().length, 1);
      const frozen = written;
      await new Promise(resolve => setTimeout(resolve, 120));
      assert.equal(written, frozen, 'upstream kept producing after the client left');
    } finally {
      await close(proxy.server);
      proxy.cleanup();
      await close(up.server);
    }
  });

  // ---------------------------------------------------------------- 6
  await test('chat-to-responses: normal completion still converts and bills as success', async () => {
    const body = chatSse();
    const up = await upstream(({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(body);
    });
    const rec = recorder();
    const proxy = await mount({ p: tomlProvider({ name: 'ChatOk', baseUrl: `${up.url}/v1`, wireApi: 'chat' }) }, rec.sinks);
    try {
      const result = await clientRequest({
        port: proxy.port,
        path: '/codex-proxy/p/sess-6/main/responses',
        body: { model: 'test-model', input: [], stream: true },
      });
      assert.equal(result.aborted, false);
      assert.match(result.text, /response\.completed/);
      await waitFor(() => rec.usage.length === 1, 'usage event');
      assert.equal(rec.usage[0].status, 'success');
      assert.equal(rec.usage[0].errorCode, undefined);
      assert.equal(rec.ends().length, 1);
      assert.equal(rec.ends()[0].status, 'success');
    } finally {
      await close(proxy.server);
      proxy.cleanup();
      await close(up.server);
    }
  });

  // ---------------------------------------------------------------- 7
  await test('responses-compat: an abandoned turn is recorded as a disconnect, not a success', async () => {
    const up = await upstream(({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'part' })}\n\n`);
      // Never completes; the client gives up first.
    });
    const rec = recorder();
    const proxy = await mount({ p: compatProvider({ name: 'Compat', url: `${up.url}/v1/responses` }) }, rec.sinks);
    try {
      const result = await clientRequest({
        port: proxy.port,
        path: '/codex-proxy/p/sess-7/main/responses',
        body: { model: 'test-model', input: [], stream: true },
        abort: { afterBytes: 1 },
      });
      assert.equal(result.aborted, true);
      await waitFor(() => up.seen.length === 1 && up.seen[0].closed, 'upstream connection released');
      await waitFor(() => rec.usage.length === 1, 'exactly one usage event');
      assert.equal(rec.usage[0].status, 'error');
      assert.equal(rec.usage[0].errorCode, 'CLIENT_DISCONNECTED');
      assert.equal(rec.ends().length, 1);
      assert.equal(rec.ends()[0].status, 'error');
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(rec.usage.length, 1, 'the trailing report must not add a second terminal');
      assert.equal(rec.ends().length, 1);
    } finally {
      await close(proxy.server);
      proxy.cleanup();
      await close(up.server);
    }
  });

  // ---------------------------------------------------------------- 8
  await test('a host with no usage/activity callbacks still aborts the upstream', async () => {
    // The terminal guard lives on the request context, not on the callbacks, so
    // convergence and upstream release do not depend on a host subscribing.
    const up = await upstream(() => { /* never responds */ });
    const proxy = await mount({ p: tomlProvider({ name: 'Silent', baseUrl: `${up.url}/v1`, wireApi: 'responses' }) });
    try {
      const result = await clientRequest({
        port: proxy.port,
        path: '/codex-proxy/p/sess-8/main/responses',
        body: { model: 'test-model', input: [], stream: true },
        abort: { afterMs: 120 },
      });
      assert.equal(result.aborted, true);
      await waitFor(() => up.seen.length === 1 && up.seen[0].closed, 'upstream connection released');
    } finally {
      await close(proxy.server);
      proxy.cleanup();
      await close(up.server);
    }
  });

  // ---------------------------------------------------------------- 9
  await test('a throwing callback never blocks convergence or the upstream abort', async () => {
    const up = await upstream(() => { /* never responds */ });
    const seen = [];
    const proxy = await mount(
      { p: tomlProvider({ name: 'Throwy', baseUrl: `${up.url}/v1`, wireApi: 'responses' }) },
      {
        onActivity: () => { throw new Error('activity handler exploded'); },
        onUsageEvent: (info) => { seen.push(info); throw new Error('usage handler exploded'); },
      }
    );
    try {
      const result = await clientRequest({
        port: proxy.port,
        path: '/codex-proxy/p/sess-9/main/responses',
        body: { model: 'test-model', input: [], stream: true },
        abort: { afterMs: 120 },
      });
      assert.equal(result.aborted, true);
      await waitFor(() => up.seen.length === 1 && up.seen[0].closed, 'upstream connection released');
      await waitFor(() => seen.length === 1, 'usage event still emitted');
      assert.equal(seen[0].errorCode, 'CLIENT_DISCONNECTED');
    } finally {
      await close(proxy.server);
      proxy.cleanup();
      await close(up.server);
    }
  });

  // ---------------------------------------------------------------- 10
  await test('the disconnect terminal event carries metadata only', async () => {
    const up = await upstream(() => { /* never responds */ });
    const rec = recorder();
    const proxy = await mount(
      { p: tomlProvider({ name: 'Private', baseUrl: `${up.url}/v1`, wireApi: 'responses' }) },
      rec.sinks
    );
    try {
      await clientRequest({
        port: proxy.port,
        path: '/codex-proxy/p/sess-10/main/responses',
        body: { model: 'test-model', input: [{ role: 'user', content: 'classified prompt text' }], stream: true },
        abort: { afterMs: 120 },
      });
      await waitFor(() => rec.usage.length === 1, 'usage event');
      const serialized = JSON.stringify({ usage: rec.usage, activity: rec.activity });
      // The provider credential, the prompt, and the raw request body must never
      // reach a host sink. `protocol` legitimately mentions the wire format, so
      // the pattern targets the secret material itself.
      assert.doesNotMatch(serialized, /provider-secret|classified prompt text|multicc-local/);
      assert.equal(rec.usage[0].body, undefined);
      assert.equal(rec.usage[0].headers, undefined);
      assert.equal(rec.usage[0].input, undefined);
      // Activity stays on the closed metadata key set the routing suite pins.
      const allowed = ['sessionId', 'role', 'providerId', 'providerName', 'phase', 'at', 'latencyMs', 'status'];
      for (const event of rec.activity) {
        for (const key of Object.keys(event)) {
          assert.ok(allowed.includes(key), `unexpected activity payload key: ${key}`);
        }
      }
    } finally {
      await close(proxy.server);
      proxy.cleanup();
      await close(up.server);
    }
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
