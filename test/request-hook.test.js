'use strict';

// Local request hooks (lib/proxy/request-hook.js) — the embedder's
// data-correction stage on the hop. Two claims are under test, and they are
// independent of each other:
//
//   1. With no hook installed (or a hook that throws/hangs/returns nonsense) the
//      forwarded request is byte-for-byte what it was before this feature
//      existed. A host that never opts in must not be able to tell it is there.
//   2. With a hook installed, the host sees the CLIENT's protocol body, its
//      replacement is what the upstream receives, and a rejected body can be
//      repaired for one bounded retry that the client never sees as a failure.

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const {
  createRequestHooks,
  createRequestStage,
  readErrorBody,
  DEFAULT_HOOK_RETRY_MAX,
  DEFAULT_HOOK_TIMEOUT_MS,
} = require('../lib/proxy/request-hook');
const { createHandler: createClaudeHandler } = require('../lib/proxy/claude');
const { createCodexHandler } = require('../lib/proxy/codex');

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      url: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function post({ port, path, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path,
      headers: { 'content-type': 'application/json', 'content-length': String(payload.length), ...headers },
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
    req.write(payload);
    req.end();
  });
}

const claudeSse = [
  'event: message_start\n',
  `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } })}\n\n`,
  'event: content_block_delta\n',
  `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } })}\n\n`,
  'event: message_stop\n',
  'data: {"type":"message_stop"}\n\n',
].join('');

const codexSse = [
  'event: response.output_text.delta\n',
  `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n`,
  'event: response.completed\n',
  `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [] } })}\n\n`,
].join('');

// ── the module on its own ───────────────────────────────────────────────────

test('an un-hooked request keeps its original bytes, not a re-encoded copy', async () => {
  const hooks = createRequestHooks({});
  assert.equal(hooks.active, false);
  // Deliberately pretty-printed: a re-serialization would be observable.
  const original = Buffer.from('{\n  "model": "m",\n  "messages": []\n}\n', 'utf8');
  const stage = createRequestStage(hooks, { protocol: 'anthropic-messages', body: original });
  assert.equal(stage.text, original.toString('utf8'));
  assert.equal(await stage.prepare(), false);
  assert.equal(await stage.repair({ status: 400 }), false);
  assert.equal(stage.repairs, 0);
  assert.equal(stage.buffer(original), original, 'the same buffer instance is forwarded');
});

test('a pre-dial replacement is what would be forwarded, and it is offered to the hook first', async () => {
  const seen = [];
  const hooks = createRequestHooks({
    onRequest: (ctx) => {
      seen.push({ protocol: ctx.protocol, mode: ctx.mode, providerId: ctx.providerId, model: ctx.model, body: ctx.body, bodyText: ctx.bodyText });
      return { body: { ...ctx.body, messages: ['repaired'] } };
    },
  });
  const stage = createRequestStage(hooks, {
    protocol: 'anthropic-messages', mode: 'anthropic-messages',
    providerId: 'p1', model: 'wire-model', body: { model: 'wire-model', messages: ['poisoned'] },
  });
  assert.equal(await stage.prepare(), true);
  assert.equal(stage.changed, true);
  assert.deepEqual(stage.body.messages, ['repaired']);
  assert.deepEqual(JSON.parse(stage.text).messages, ['repaired']);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].protocol, 'anthropic-messages');
  assert.equal(seen[0].providerId, 'p1');
  assert.equal(seen[0].model, 'wire-model');
  assert.equal(seen[0].bodyText, '{"model":"wire-model","messages":["poisoned"]}');
  // A hook that returns the same body must not count as a change (no re-encode).
  const same = createRequestStage(createRequestHooks({ onRequest: ctx => ({ body: ctx.body }) }), {
    protocol: 'anthropic-messages', body: { a: 1 },
  });
  assert.equal(await same.prepare(), false);
  assert.equal(same.changed, false);
});

test('a hook that throws, hangs or returns nonsense is ignored, never fatal', async () => {
  const boom = createRequestStage(createRequestHooks({ onRequest: () => { throw new Error('host bug'); } }), {
    protocol: 'anthropic-messages', body: { a: 1 },
  });
  assert.equal(await boom.prepare(), false);
  assert.equal(boom.text, '{"a":1}');

  const rejectsLater = createRequestStage(createRequestHooks({
    onUpstreamRejected: async () => { throw new Error('host bug'); },
  }), { protocol: 'anthropic-messages', body: { a: 1 } });
  assert.equal(await rejectsLater.repair({ status: 400, message: 'nope' }), false);

  const started = Date.now();
  const hung = createRequestStage(createRequestHooks({
    onRequest: () => new Promise(() => {}), hookTimeoutMs: 60,
  }), { protocol: 'anthropic-messages', body: { a: 1 } });
  assert.equal(await hung.prepare(), false, 'a wedged hook must not wedge the turn');
  assert.ok(Date.now() - started >= 55, 'the timeout is what ended it');

  for (const nonsense of [42, 'a string', { body: null }, { body: 42 }, []]) {
    const stage = createRequestStage(createRequestHooks({ onRequest: () => nonsense }), {
      protocol: 'anthropic-messages', body: { a: 1 },
    });
    assert.equal(await stage.prepare(), false, JSON.stringify(nonsense));
    assert.equal(stage.text, '{"a":1}');
  }
  assert.equal(DEFAULT_HOOK_TIMEOUT_MS, 5000);
});

test('a repair is bounded by hookRetryMax and counted by the stage, not the caller', async () => {
  let calls = 0;
  const hooks = createRequestHooks({
    hookRetryMax: 2,
    onUpstreamRejected: () => { calls += 1; return { retry: true, body: { attempt: calls } }; },
  });
  const stage = createRequestStage(hooks, { protocol: 'anthropic-messages', body: { attempt: 0 } });
  // Caller-side attempt numbers are deliberately unrelated to the budget: the
  // compat path's busy-retry counter must not be able to buy extra repairs.
  assert.equal(await stage.repair({ status: 400, attempt: 99 }), true);
  assert.equal(await stage.repair({ status: 400, attempt: 99 }), true);
  assert.equal(await stage.repair({ status: 400, attempt: 99 }), false);
  assert.equal(calls, 2);
  assert.equal(stage.text, '{"attempt":2}');

  // `{retry:true}` with no body re-dials the same request (still bounded).
  let sameBodyCalls = 0;
  const same = createRequestStage(createRequestHooks({
    hookRetryMax: 1,
    onUpstreamRejected: () => { sameBodyCalls += 1; return { retry: true }; },
  }), { protocol: 'anthropic-messages', body: { a: 1 } });
  assert.equal(await same.repair({ status: 503 }), true);
  assert.equal(await same.repair({ status: 503 }), false);
  assert.equal(sameBodyCalls, 1);
  assert.equal(same.text, '{"a":1}');
  assert.equal(same.changed, false);
  assert.equal(DEFAULT_HOOK_RETRY_MAX, 1);
});

test('a rejection hook that does not ask for a retry cannot change what the client sees', async () => {
  let seen = 0;
  const hooks = createRequestHooks({
    onUpstreamRejected: () => { seen += 1; return { body: { tampered: true } }; },
  });
  const stage = createRequestStage(hooks, { protocol: 'anthropic-messages', body: { a: 1 } });
  assert.equal(await stage.repair({ status: 400, message: 'x' }), false);
  assert.equal(seen, 1);
  assert.equal(stage.text, '{"a":1}', 'a body without retry:true is ignored');
  assert.equal(stage.changed, false);

  // No rejection hook at all: the stage never even calls out.
  const none = createRequestStage(createRequestHooks({ onRequest: () => ({ body: { b: 2 } }) }), {
    protocol: 'anthropic-messages', body: { a: 1 },
  });
  assert.equal(await none.repair({ status: 400 }), false);

  // hookRetryMax: 0 is an explicit "inspect but never retry".
  const zero = createRequestStage(createRequestHooks({
    hookRetryMax: 0, onUpstreamRejected: () => ({ retry: true }),
  }), { protocol: 'anthropic-messages', body: { a: 1 } });
  assert.equal(await zero.repair({ status: 400 }), false);
});

test('readErrorBody bounds what it reads from a stream and from a fetch response', async () => {
  const big = 'x'.repeat(200 * 1024);
  const stream = (async function* () { yield Buffer.from('{"error":"'); yield Buffer.from(big); yield Buffer.from('"}'); })();
  const bounded = await readErrorBody(stream, 1024);
  assert.equal(bounded.length, 1024);

  const fetchLike = { text: async () => big, arrayBuffer: async () => new ArrayBuffer(0) };
  assert.equal((await readErrorBody(fetchLike, 512)).length, 512);
  assert.equal(await readErrorBody(null), '');
  assert.equal(await readErrorBody({}), '');
});

// ── the claude hop ─────────────────────────────────────────────────────────

function claudeFixture(providerId, upstreamUrl) {
  return {
    getProvider: (appType, id) => (appType === 'claude' && id === providerId
      ? { name: 'Hook fixture', settingsConfig: { env: { ANTHROPIC_BASE_URL: upstreamUrl, ANTHROPIC_AUTH_TOKEN: 'k' } } }
      : null),
  };
}

test('a rejected claude turn is retried with the repaired body, invisibly to the client', async () => {
  const upstreamSeen = [];
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      upstreamSeen.push(text);
      if (upstreamSeen.length === 1) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { message: 'invalid request: reasoning content in history' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(claudeSse);
    });
  });
  const rejections = [];
  const handler = createClaudeHandler({
    ...claudeFixture('p-hook', upstream.url),
    onUpstreamRejected: (ctx) => {
      rejections.push({ status: ctx.status, attempt: ctx.attempt, message: ctx.message, sessionId: ctx.sessionId, role: ctx.role, model: ctx.model });
      return { retry: true, body: { ...ctx.body, messages: [{ role: 'user', content: 'cleaned' }] } };
    },
  });
  const proxy = await listen(handler);
  try {
    const res = await post({
      port: proxy.port,
      path: '/claude-proxy/p-hook/sess-1/v1/messages',
      body: { model: 'wire-model', stream: true, messages: [{ role: 'assistant', reasoning: 'poisoned' }] },
    });
    assert.equal(res.status, 200, 'the client sees the repaired turn, not the rejection');
    assert.match(res.body, /"text_delta"/);
    assert.equal(upstreamSeen.length, 2);
    assert.deepEqual(JSON.parse(upstreamSeen[0]).messages, [{ role: 'assistant', reasoning: 'poisoned' }]);
    assert.deepEqual(JSON.parse(upstreamSeen[1]).messages, [{ role: 'user', content: 'cleaned' }],
      'the upstream receives the host-repaired body');
    assert.equal(rejections.length, 1);
    assert.equal(rejections[0].status, 400);
    assert.equal(rejections[0].attempt, 1);
    assert.match(rejections[0].message, /reasoning content/);
    assert.equal(rejections[0].sessionId, 'sess-1');
    assert.equal(rejections[0].role, 'main');
    assert.equal(rejections[0].model, 'wire-model');
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});

test('without a rejection hook the same claude rejection reaches the client unchanged', async () => {
  const upstreamSeen = [];
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      upstreamSeen.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'poisoned history, no repair available' }));
    });
  });
  const handler = createClaudeHandler(claudeFixture('p-nohook', upstream.url));
  const proxy = await listen(handler);
  try {
    const res = await post({
      port: proxy.port,
      path: '/claude-proxy/p-nohook/sess-1/v1/messages',
      body: { model: 'wire-model', stream: true },
    });
    assert.equal(res.status, 400);
    assert.match(res.body, /poisoned history, no repair available/);
    assert.equal(upstreamSeen.length, 1, 'exactly one dial: no hook, no retry');
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});

test('a pre-dial hook fixes the body before the only dial, and the client sees the fixed turn', async () => {
  const upstreamSeen = [];
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      upstreamSeen.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(claudeSse);
    });
  });
  const handler = createClaudeHandler({
    ...claudeFixture('p-pre', upstream.url),
    onRequest: ({ body, protocol, mode }) => {
      if (protocol !== 'anthropic-messages' || mode !== 'anthropic-messages') return undefined;
      return { body: { ...body, messages: (body.messages || []).filter(m => m.role !== 'assistant' || !m.reasoning) } };
    },
  });
  const proxy = await listen(handler);
  try {
    const res = await post({
      port: proxy.port,
      path: '/claude-proxy/p-pre/sess-1/v1/messages',
      body: {
        model: 'wire-model', stream: true,
        messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', reasoning: 'poisoned', content: 'old' }],
      },
    });
    assert.equal(res.status, 200);
    assert.equal(upstreamSeen.length, 1, 'the pre-dial hook never costs an extra dial');
    assert.deepEqual(JSON.parse(upstreamSeen[0]).messages, [{ role: 'user', content: 'hi' }]);
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});

test('a repair that the upstream rejects again stops after hookRetryMax and reports honestly', async () => {
  let dials = 0;
  const upstream = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      dials += 1;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'still invalid' }));
    });
  });
  let repairs = 0;
  const handler = createClaudeHandler({
    ...claudeFixture('p-forever', upstream.url),
    hookRetryMax: 2,
    // The pathological host: always asks for another try.
    onUpstreamRejected: () => { repairs += 1; return { retry: true, body: { a: repairs } }; },
  });
  const proxy = await listen(handler);
  try {
    const res = await post({
      port: proxy.port,
      path: '/claude-proxy/p-forever/sess-1/v1/messages',
      body: { model: 'wire-model', stream: true },
    });
    assert.equal(dials, 3, 'one dial plus hookRetryMax repairs');
    assert.equal(repairs, 2);
    assert.equal(res.status, 400);
    assert.match(res.body, /still invalid/, 'the client still learns why the turn failed');
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});

// ── the codex hop (responses-compat) ───────────────────────────────────────

test('a rejected codex turn is repaired and retried at the local hop too', async () => {
  const upstreamSeen = [];
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      upstreamSeen.push(Buffer.concat(chunks).toString('utf8'));
      if (upstreamSeen.length === 1) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'previous_response_id not found' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(codexSse);
    });
  });
  const rejections = [];
  const handler = createCodexHandler({
    getProvider: (appType, id) => (appType === 'codex' && id === 'c-hook'
      ? {
        name: 'Codex hook fixture',
        settingsConfig: JSON.stringify({ proxyTarget: { baseUrl: upstream.url, mode: 'responses-compat', apiKey: 'k' } }),
      }
      : null),
    onUpstreamRejected: (ctx) => {
      rejections.push({ protocol: ctx.protocol, mode: ctx.mode, status: ctx.status, providerId: ctx.providerId, role: ctx.routeName, model: ctx.model });
      return { retry: true, body: { ...ctx.body, previous_response_id: null } };
    },
  });
  // Stand in for express.json(): the codex handler reads req.body, which the
  // real mount always has parsed by the time the route runs.
  const proxy = await listen((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { req.body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { req.body = {}; }
      handler(req, res, { providerId: 'c-hook', sessionId: 'sess-c', role: 'main' });
    });
  });
  try {
    const res = await post({
      port: proxy.port,
      path: '/codex-proxy/c-hook/sess-c/main/responses',
      body: { model: 'gpt-5', stream: true, previous_response_id: 'resp_gone', input: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.status, 200);
    assert.equal(upstreamSeen.length, 2);
    assert.equal(JSON.parse(upstreamSeen[0]).previous_response_id, 'resp_gone');
    assert.equal(JSON.parse(upstreamSeen[1]).previous_response_id, null, 'the host repaired the dangling replay id');
    assert.equal(rejections.length, 1);
    assert.equal(rejections[0].protocol, 'openai-responses');
    assert.equal(rejections[0].mode, 'responses-compat');
    assert.equal(rejections[0].status, 404);
    assert.equal(rejections[0].providerId, 'c-hook');
    assert.equal(rejections[0].model, 'gpt-5');
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});
