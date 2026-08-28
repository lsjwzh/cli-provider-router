'use strict';

// Downstream-disconnect handling for the claude proxy.
//
// The claude CLI is a process that can be cancelled or killed mid-turn, and it
// is the proxy's ONLY downstream consumer. When it dies the proxy must (a) reach
// its terminal state exactly once so a host's per-provider producer accounting
// drains instead of wedging forever, and (b) release the upstream socket so we
// stop paying for a stream nobody reads.
//
// The traps these tests pin down:
//   · `activityEnded` / `usageEventEmitted` are NOT terminal markers — both
//     emitters early-return when their callback is absent or sessionId is empty,
//     so a disconnect check keyed off them reports every normal completion of a
//     callback-less host as a client disconnect. See the standalone tests.
//   · res 'close' fires on NORMAL completion too, so the handler has to be
//     guarded rather than merely registered.
//   · destroying the upstream makes it emit 'aborted'/'error', which re-enters
//     the terminal path — it must stay exactly-once.

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('http');
const { createHandler } = require('../lib/proxy/claude');

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function close(server) {
  // Destroy lingering sockets first. A leaked upstream connection — precisely
  // what a regression here would produce — otherwise keeps server.close() from
  // ever resolving, turning a clean failure into a hung suite.
  try { server.closeAllConnections(); } catch (_) {}
  return new Promise(resolve => server.close(resolve));
}

function makeProvider(name, baseUrl, env) {
  return { name, settingsConfig: { env: { ANTHROPIC_BASE_URL: baseUrl, ...env } } };
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

// A fake provider upstream. `behaviour({ req, res, entry })` decides what to
// send; `seen` records one entry per request with `closed` flipped when the
// upstream side observes its socket go away — that is the direct evidence that
// the proxy actually released the provider connection.
function upstream(behaviour) {
  const seen = [];
  return listen((req, res) => {
    const chunks = [];
    const entry = { req, res, closed: false, body: '' };
    seen.push(entry);
    res.on('close', () => { entry.closed = true; });
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      entry.body = Buffer.concat(chunks).toString('utf8');
      behaviour({ req, res, entry });
    });
  }).then(handle => Object.assign(handle, { seen }));
}

// Drive one request through the proxy. `abort.afterBytes` kills the client
// socket once that many response bytes have arrived (mid-stream disconnect);
// `abort.afterMs` kills it on a timer regardless of whether the upstream ever
// answered (pre-first-byte disconnect).
function clientRequest({ port, path, body, headers = {}, abort = null }) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body));
    let settled = false;
    let received = 0;
    let status = null;
    const finish = (aborted) => {
      if (settled) return;
      settled = true;
      resolve({ aborted, status, received });
    };
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path,
      headers: {
        'content-type': 'application/json',
        'content-length': String(payload.length),
        ...headers,
      },
    }, (res) => {
      status = res.statusCode;
      res.on('data', (chunk) => {
        received += chunk.length;
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

const SSE = sseBody({ input: 11, output: 7, cacheWrite: 13, cacheRead: 17 });

async function main() {
  console.log('\nClaude proxy downstream-disconnect tests');

  // ---------------------------------------------------------------- 1
  await test('client disconnect BEFORE first byte settles once and aborts the hung upstream', async () => {
    // The incident shape: the upstream accepts the request and then never
    // answers. Before the fix nothing on the proxy noticed the dead client, so
    // no terminal event was emitted and the provider socket hung forever.
    const up = await upstream(() => { /* deliberately never responds */ });
    const activity = [];
    const usage = [];
    const proxy = await listen(createHandler({
      getProvider: () => makeProvider('Hung Provider', `http://127.0.0.1:${up.port}/base`, {
        ANTHROPIC_AUTH_TOKEN: 'hung-secret',
      }),
      onActivity: event => activity.push(event),
      onUsageEvent: event => usage.push(event),
    }));
    try {
      await clientRequest({
        port: proxy.port,
        path: '/claude-proxy/main/session-1/v1/messages',
        body: { model: 'm', stream: true, messages: [] },
        abort: { afterMs: 80 },
      });
      await waitFor(() => usage.length > 0, 'terminal usage event');

      assert.deepStrictEqual(activity.map(e => e.phase), ['request', 'end'],
        'no first_byte — the upstream never produced one');
      assert.strictEqual(activity[1].status, 'error');
      assert.strictEqual(usage.length, 1);
      assert.strictEqual(usage[0].status, 'error', 'status stays inside the success|error contract');
      assert.strictEqual(usage[0].errorCode, 'CLIENT_DISCONNECTED');
      assert.strictEqual(usage[0].isStream, true, 'derived from the client\'s own stream flag');
      assert.strictEqual(usage[0].statusCode, undefined, 'no upstream status was ever observed');
      assert.strictEqual(usage[0].usage, null);
      assert.strictEqual(usage[0].coverage, 'unobservable');

      await waitFor(() => up.seen[0] && up.seen[0].closed, 'upstream socket released');
    } finally {
      await close(proxy.server);
      await close(up.server);
    }
  });

  // ---------------------------------------------------------------- 2
  await test('client disconnect mid-SSE settles once and aborts the streaming upstream', async () => {
    let ticker = null;
    const up = await upstream(({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(SSE.slice(0, 60));
      // keep the stream alive so the upstream is genuinely still in flight
      ticker = setInterval(() => { try { res.write(': keepalive\n\n'); } catch (_) {} }, 10);
      res.on('close', () => clearInterval(ticker));
    });
    const activity = [];
    const usage = [];
    const proxy = await listen(createHandler({
      getProvider: () => makeProvider('Streaming Provider', `http://127.0.0.1:${up.port}/base`, {
        ANTHROPIC_AUTH_TOKEN: 'stream-secret',
      }),
      onActivity: event => activity.push(event),
      onUsageEvent: event => usage.push(event),
    }));
    try {
      const result = await clientRequest({
        port: proxy.port,
        path: '/claude-proxy/main/session-1/v1/messages',
        body: { model: 'm', stream: true, messages: [] },
        abort: { afterBytes: 40 },
      });
      assert.strictEqual(result.aborted, true);
      assert.strictEqual(result.status, 200, 'the client had already received a 2xx and partial SSE');
      await waitFor(() => usage.length > 0, 'terminal usage event');
      // Let our own destroy() drive the upstream into 'aborted'/'error', which
      // re-enters the terminal path — exactly-once must survive that.
      await new Promise(resolve => setTimeout(resolve, 60));

      assert.deepStrictEqual(activity.map(e => e.phase), ['request', 'first_byte', 'end']);
      assert.strictEqual(activity[2].status, 'error');
      assert.strictEqual(usage.length, 1, 'exactly one terminal usage event');
      assert.strictEqual(usage[0].errorCode, 'CLIENT_DISCONNECTED',
        'the disconnect is the cause, not the UPSTREAM_STREAM_ABORTED our destroy provokes');
      assert.strictEqual(usage[0].isStream, true, 'derived from the SSE response content-type');
      assert.strictEqual(usage[0].statusCode, 200, 'the observed upstream status is reported');

      await waitFor(() => up.seen[0] && up.seen[0].closed, 'upstream socket released');
    } finally {
      if (ticker) clearInterval(ticker);
      await close(proxy.server);
      await close(up.server);
    }
  });

  // ---------------------------------------------------------------- 3
  await test('normal completions never report a disconnect and settle exactly once', async () => {
    const up = await upstream(({ req, res }) => {
      const wantsSse = JSON.parse(req.headers['x-test-body'] || '{}').stream !== false;
      if (wantsSse) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(SSE.slice(0, 37));
        res.end(SSE.slice(37));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 5 } }));
      }
    });
    const activity = [];
    const usage = [];
    const proxy = await listen(createHandler({
      getProvider: () => makeProvider('Good Provider', `http://127.0.0.1:${up.port}/base`, {
        ANTHROPIC_AUTH_TOKEN: 'good-secret',
      }),
      onActivity: event => activity.push(event),
      onUsageEvent: event => usage.push(event),
    }));
    try {
      // streaming
      const streamed = await clientRequest({
        port: proxy.port,
        path: '/claude-proxy/main/session-1/v1/messages',
        body: { model: 'm', stream: true, messages: [] },
        headers: { 'x-test-body': JSON.stringify({ stream: true }) },
      });
      await waitFor(() => usage.length === 1, 'streaming terminal event');
      // res 'close' fires on normal completion too — give it a chance to misfire
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.strictEqual(streamed.aborted, false);
      assert.strictEqual(streamed.status, 200);
      assert.strictEqual(usage.length, 1, 'res close on a healthy turn must not add an event');
      assert.strictEqual(usage[0].status, 'success');
      assert.strictEqual(usage[0].errorCode, undefined);
      assert.strictEqual(usage[0].isStream, true);
      assert.deepStrictEqual(activity.map(e => e.phase), ['request', 'first_byte', 'end']);
      assert.strictEqual(activity[2].status, 'success');

      // non-streaming
      activity.length = 0;
      usage.length = 0;
      const plain = await clientRequest({
        port: proxy.port,
        path: '/claude-proxy/main/session-1/v1/messages',
        body: { model: 'm', stream: false, messages: [] },
        headers: { 'x-test-body': JSON.stringify({ stream: false }) },
      });
      await waitFor(() => usage.length === 1, 'non-stream terminal event');
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.strictEqual(plain.aborted, false);
      assert.strictEqual(usage.length, 1);
      assert.strictEqual(usage[0].status, 'success');
      assert.strictEqual(usage[0].errorCode, undefined);
      assert.strictEqual(usage[0].isStream, false, 'derived from a JSON response content-type');
    } finally {
      await close(proxy.server);
      await close(up.server);
    }
  });

  // ---------------------------------------------------------------- 4
  await test('non-2xx and upstream connect failure keep their own errorCode', async () => {
    const up = await upstream(({ res }) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'slow down' } }));
    });
    const activity = [];
    const usage = [];
    const providers = {
      bad: makeProvider('Bad Provider', `http://127.0.0.1:${up.port}/base`, { ANTHROPIC_AUTH_TOKEN: 'bad-secret' }),
      // port 1 is closed, so lib.request errors before any response
      dead: makeProvider('Dead Provider', 'http://127.0.0.1:1/base', { ANTHROPIC_AUTH_TOKEN: 'dead-secret' }),
    };
    const proxy = await listen(createHandler({
      getProvider: (_appType, id) => providers[id] || null,
      onActivity: event => activity.push(event),
      onUsageEvent: event => usage.push(event),
    }));
    try {
      const rejected = await clientRequest({
        port: proxy.port,
        path: '/claude-proxy/bad/session-1/v1/messages',
        body: { model: 'm', stream: true, messages: [] },
      });
      await waitFor(() => usage.length === 1, 'non-2xx terminal event');
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.strictEqual(rejected.status, 429);
      assert.strictEqual(usage.length, 1);
      assert.strictEqual(usage[0].errorCode, 'UPSTREAM_HTTP_ERROR');
      assert.strictEqual(usage[0].statusCode, 429);
      assert.strictEqual(usage[0].isStream, false, 'the error body is JSON, not SSE');
      assert.strictEqual(activity.filter(e => e.phase === 'end').length, 1);

      activity.length = 0;
      usage.length = 0;
      const dead = await clientRequest({
        port: proxy.port,
        path: '/claude-proxy/dead/session-1/v1/messages',
        body: { model: 'm', stream: true, messages: [] },
      });
      await waitFor(() => usage.length === 1, 'connect-failure terminal event');
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.strictEqual(dead.status, 502);
      assert.strictEqual(usage.length, 1);
      assert.strictEqual(usage[0].errorCode, 'UPSTREAM_CONNECT_FAILED');
      assert.strictEqual(activity.filter(e => e.phase === 'end').length, 1);
    } finally {
      await close(proxy.server);
      await close(up.server);
    }
  });

  // ---------------------------------------------------------------- 5
  await test('close racing upstream end stays exactly-once across repeated rounds', async () => {
    // The disconnect and the upstream's own completion are deliberately pushed
    // into the same few milliseconds, repeatedly, so neither ordering is
    // assumed. Whoever wins, the invariant holds: one usage event, one activity
    // 'end', and a status consistent with the errorCode.
    const up = await upstream(({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(SSE.slice(0, 60));
      setTimeout(() => { try { res.end(SSE.slice(60)); } catch (_) {} }, 8);
    });
    const proxy = await listen(createHandler({
      getProvider: () => makeProvider('Racy Provider', `http://127.0.0.1:${up.port}/base`, {
        ANTHROPIC_AUTH_TOKEN: 'racy-secret',
      }),
      onActivity: event => rounds.at(-1).activity.push(event),
      onUsageEvent: event => rounds.at(-1).usage.push(event),
    }));
    const rounds = [];
    try {
      for (let i = 0; i < 12; i += 1) {
        rounds.push({ activity: [], usage: [] });
        const round = rounds.at(-1);
        await clientRequest({
          port: proxy.port,
          path: '/claude-proxy/main/session-1/v1/messages',
          body: { model: 'm', stream: true, messages: [] },
          // sweep the abort across the window in which the upstream ends
          abort: { afterMs: 4 + i },
        });
        await waitFor(() => round.usage.length > 0, `round ${i} terminal event`);
        await new Promise(resolve => setTimeout(resolve, 40));

        assert.strictEqual(round.usage.length, 1, `round ${i}: exactly one usage event`);
        assert.strictEqual(round.activity.filter(e => e.phase === 'end').length, 1,
          `round ${i}: exactly one activity end`);
        const event = round.usage[0];
        assert.ok(event.status === 'success' || event.status === 'error',
          `round ${i}: status stayed inside the success|error contract`);
        if (event.status === 'success') {
          assert.strictEqual(event.errorCode, undefined, `round ${i}: success carries no errorCode`);
        } else {
          assert.ok(
            ['CLIENT_DISCONNECTED', 'UPSTREAM_STREAM_ABORTED', 'UPSTREAM_STREAM_FAILED'].includes(event.errorCode),
            `round ${i}: unexpected errorCode ${event.errorCode}`
          );
        }
        const endActivity = round.activity.find(e => e.phase === 'end');
        assert.strictEqual(endActivity.status, event.status,
          `round ${i}: activity and usage agree on the terminal status`);
      }
    } finally {
      await close(proxy.server);
      await close(up.server);
    }
  });

  // ---------------------------------------------------------------- 6
  await test('standalone handler (no callbacks) completes normally and still aborts on disconnect', async () => {
    // The regression that a naive `if (activityEnded) return` guard introduces:
    // with no onActivity wired, activityEnded is never set, so every healthy
    // turn would be misread as a client disconnect and its upstream destroyed
    // mid-stream — truncating the response the client is still reading.
    const good = await upstream(({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(SSE.slice(0, 37));
      res.end(SSE.slice(37));
    });
    const hung = await upstream(() => { /* never responds */ });
    const providers = {
      good: makeProvider('Good', `http://127.0.0.1:${good.port}/base`, { ANTHROPIC_AUTH_TOKEN: 's1' }),
      hung: makeProvider('Hung', `http://127.0.0.1:${hung.port}/base`, { ANTHROPIC_AUTH_TOKEN: 's2' }),
    };
    // ONLY getProvider — no onActivity, no onUsageEvent, no onUsage.
    const proxy = await listen(createHandler({
      getProvider: (_appType, id) => providers[id] || null,
    }));
    try {
      const chunks = [];
      const body = Buffer.from(JSON.stringify({ model: 'm', stream: true, messages: [] }));
      const complete = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1', port: proxy.port, method: 'POST',
          path: '/claude-proxy/good/session-1/v1/messages',
          headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
        }, (res) => {
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end(body);
      });
      assert.strictEqual(complete.status, 200);
      assert.strictEqual(complete.body, SSE, 'SSE bytes intact — the turn was not misread as a disconnect');

      // …and the disconnect handling itself still works without any callback.
      await clientRequest({
        port: proxy.port,
        path: '/claude-proxy/hung/session-1/v1/messages',
        body: { model: 'm', stream: true, messages: [] },
        abort: { afterMs: 80 },
      });
      await waitFor(() => hung.seen[0] && hung.seen[0].closed,
        'upstream released even with no callbacks wired');
    } finally {
      await close(proxy.server);
      await close(good.server);
      await close(hung.server);
    }
  });

  // ---------------------------------------------------------------- 7
  await test('an empty sessionId still aborts the upstream on disconnect', async () => {
    // sessionId gates both callbacks, so it is the other way `activityEnded`
    // silently stays false. Teardown must not depend on it.
    const hung = await upstream(() => {});
    const proxy = await listen(createHandler({
      getProvider: () => makeProvider('Hung', `http://127.0.0.1:${hung.port}/base`, { ANTHROPIC_AUTH_TOKEN: 's' }),
      onActivity: () => {},
      onUsageEvent: () => {},
    }));
    try {
      await clientRequest({
        port: proxy.port,
        // no session segment → sessionId is empty
        path: '/claude-proxy/main/v1/messages',
        body: { model: 'm', stream: true, messages: [] },
        abort: { afterMs: 80 },
      });
      await waitFor(() => hung.seen[0] && hung.seen[0].closed, 'upstream released without a sessionId');
    } finally {
      await close(proxy.server);
      await close(hung.server);
    }
  });

  // ---------------------------------------------------------------- 8
  await test('throwing callbacks do not stop convergence or the upstream abort', async () => {
    const hung = await upstream(() => {});
    const proxy = await listen(createHandler({
      getProvider: () => makeProvider('Hung', `http://127.0.0.1:${hung.port}/base`, { ANTHROPIC_AUTH_TOKEN: 's' }),
      onActivity: () => { throw new Error('activity handler exploded'); },
      onUsageEvent: () => { throw new Error('usage handler exploded'); },
    }));
    try {
      await clientRequest({
        port: proxy.port,
        path: '/claude-proxy/main/session-1/v1/messages',
        body: { model: 'm', stream: true, messages: [] },
        abort: { afterMs: 80 },
      });
      await waitFor(() => hung.seen[0] && hung.seen[0].closed,
        'upstream released despite both callbacks throwing');
    } finally {
      await close(proxy.server);
      await close(hung.server);
    }
  });

  // ---------------------------------------------------------------- 9
  await test('healthy turns leave the upstream keep-alive pool intact', async () => {
    // Node's globalAgent defaults to keepAlive:true. The disconnect teardown
    // must stay strictly off the healthy path — this pins that sequential turns
    // still reuse upstream connections rather than burning one per request, so
    // a future change to the guard cannot start tearing down live pooled
    // sockets without a test noticing.
    const sockets = new Set();
    const up = await upstream(({ req, res }) => {
      sockets.add(req.socket.remotePort);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(SSE.slice(0, 37));
      res.end(SSE.slice(37));
    });
    const proxy = await listen(createHandler({
      getProvider: () => makeProvider('Pooled', `http://127.0.0.1:${up.port}/base`, {
        ANTHROPIC_AUTH_TOKEN: 'pool-secret',
      }),
    }));
    try {
      const turns = 12;
      for (let i = 0; i < turns; i += 1) {
        const result = await clientRequest({
          port: proxy.port,
          path: '/claude-proxy/main/session-1/v1/messages',
          body: { model: 'm', stream: true, messages: [] },
        });
        assert.strictEqual(result.aborted, false, `turn ${i} completed`);
        assert.strictEqual(result.status, 200, `turn ${i} status`);
      }
      // Let any stray post-completion teardown land before counting.
      await new Promise(resolve => setTimeout(resolve, 80));
      assert.strictEqual(up.seen.length, turns);
      assert.ok(sockets.size < turns,
        `expected upstream connection reuse, but ${turns} turns opened ${sockets.size} sockets`);
    } finally {
      await close(proxy.server);
      await close(up.server);
    }
  });

  // ---------------------------------------------------------------- 10
  await test('the disconnect terminal event carries metadata only', async () => {
    const hung = await upstream(() => {});
    const activity = [];
    const usage = [];
    const proxy = await listen(createHandler({
      getProvider: () => makeProvider('Hung Provider', `http://127.0.0.1:${hung.port}/base`, {
        ANTHROPIC_AUTH_TOKEN: 'top-secret-token',
      }),
      onActivity: event => activity.push(event),
      onUsageEvent: event => usage.push(event),
    }));
    try {
      await clientRequest({
        port: proxy.port,
        path: '/claude-proxy/main/session-secret/v1/messages',
        body: { model: 'm', stream: true, messages: [{ role: 'user', content: 'classified prompt text' }] },
        headers: { authorization: 'Bearer downstream-virtual-key' },
        abort: { afterMs: 80 },
      });
      await waitFor(() => usage.length > 0, 'terminal usage event');

      // The activity payload is a closed metadata set — a new terminal cause
      // must not smuggle a new key into it (see claude-routing.test.js).
      const allowed = ['sessionId', 'role', 'providerId', 'providerName', 'phase', 'at', 'latencyMs', 'status'];
      for (const event of activity) {
        for (const key of Object.keys(event)) {
          assert.ok(allowed.includes(key), `unexpected activity payload key: ${key}`);
        }
      }
      const flat = JSON.stringify({ activity, usage });
      // Credentials and prompt content must not appear anywhere. (`messages` is
      // deliberately NOT part of this pattern: the usage event legitimately
      // carries protocol:'anthropic-messages'. The request body is pinned by the
      // prompt-text check instead.)
      assert.doesNotMatch(flat, /top-secret-token|downstream-virtual-key|classified prompt text/);
      for (const event of usage) {
        assert.strictEqual(event.messages, undefined);
        assert.strictEqual(event.body, undefined);
        assert.strictEqual(event.headers, undefined);
      }
    } finally {
      await close(proxy.server);
      await close(hung.server);
    }
  });
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
