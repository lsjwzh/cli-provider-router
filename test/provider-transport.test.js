'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { mountCodexProxy } = require('../lib/proxy/codex');
const {
  createProviderTransport,
  httpUrl,
} = require('../lib/proxy/provider-transport');

function fakeDispatcher(origin) {
  const dispatcher = new EventEmitter();
  dispatcher.origin = origin;
  dispatcher.closeCalls = 0;
  dispatcher.close = () => { dispatcher.closeCalls += 1; };
  return dispatcher;
}

test('provider transport accepts only absolute HTTP(S) targets', () => {
  assert.equal(httpUrl('https://api.example.test/v1/responses').origin, 'https://api.example.test');
  assert.equal(httpUrl(new URL('http://127.0.0.1:3000/v1/responses')).hostname, '127.0.0.1');
  for (const value of ['/relative', 'file:///tmp/input', { url: 'https://api.example.test' }]) {
    assert.equal(httpUrl(value), null);
  }
});

test('keeps HTTP/2 enabled and isolates reusable dispatchers by origin', async () => {
  const calls = [];
  const dispatchers = [];
  let options;
  const transport = createProviderTransport({
    fetch: async (input, init) => { calls.push({ input, init }); return 'ok'; },
    createDispatcher(origin, config) {
      options = config;
      const dispatcher = fakeDispatcher(origin);
      dispatchers.push(dispatcher);
      return dispatcher;
    },
  });

  await transport.fetch('https://api.example.test/v1/responses', { method: 'POST', body: '{}' });
  await transport.fetch('https://api.example.test/v1/models');
  await transport.fetch('https://second.example.test/v1/responses');

  assert.equal(options.allowH2, true);
  assert.equal(options.pipelining, 1);
  assert.equal(options.bodyTimeout, 0);
  assert.equal(dispatchers.length, 2);
  assert.equal(dispatchers[0].origin, 'https://api.example.test');
  assert.equal(calls[0].init.dispatcher, dispatchers[0]);
  assert.equal(calls[1].init.dispatcher, dispatchers[0]);
  assert.equal(calls[2].init.dispatcher, dispatchers[1]);

  await transport.close();
  await transport.close();
  assert.deepEqual(dispatchers.map(dispatcher => dispatcher.closeCalls), [1, 1]);
  await assert.rejects(
    transport.fetch('https://api.example.test/v1/models'),
    error => error.code === 'CPR_PROVIDER_TRANSPORT_CLOSED',
  );
});

test('invalid H2 session rotates its origin and retries a replayable request once', async () => {
  const root = Object.assign(new Error('session destroyed'), { code: 'ERR_HTTP2_INVALID_SESSION' });
  const failure = new TypeError('fetch failed', { cause: root });
  const dispatchers = [];
  const rotations = [];
  let calls = 0;
  const transport = createProviderTransport({
    fetch: async (_input, init) => {
      calls += 1;
      if (calls === 1) throw failure;
      assert.equal(init.dispatcher, dispatchers[1]);
      return 'recovered';
    },
    createDispatcher(origin) {
      const dispatcher = fakeDispatcher(origin);
      dispatchers.push(dispatcher);
      return dispatcher;
    },
    onRotate: event => rotations.push(event),
  });

  assert.equal(await transport.fetch('https://api.example.test/v1/responses', {
    method: 'POST', body: '{}',
  }), 'recovered');
  assert.equal(calls, 2);
  assert.equal(dispatchers.length, 2);
  assert.deepEqual(rotations.map(event => event.reason), ['invalid_h2_session']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dispatchers[0].closeCalls, 1);
  await transport.close();
});

test('ambiguous and non-replayable failures are never retried', async () => {
  for (const [failure, body, expectedDispatchers] of [
    [Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }), '{}', 1],
    [Object.assign(new Error('session destroyed'), { code: 'ERR_HTTP2_INVALID_SESSION' }), { stream: true }, 2],
  ]) {
    let calls = 0;
    const dispatchers = [];
    const transport = createProviderTransport({
      fetch: async () => { calls += 1; throw failure; },
      createDispatcher(origin) {
        const dispatcher = fakeDispatcher(origin);
        dispatchers.push(dispatcher);
        return dispatcher;
      },
    });
    await assert.rejects(
      transport.fetch('https://api.example.test/v1/responses', { method: 'POST', body }),
      error => error === failure,
    );
    assert.equal(calls, 1);
    assert.equal(dispatchers.length, expectedDispatchers);
    await transport.close();
  }
});

test('GOAWAY proactively replaces only the affected origin dispatcher', async () => {
  const dispatchers = [];
  const seen = [];
  const transport = createProviderTransport({
    fetch: async (_input, init) => { seen.push(init.dispatcher); return 'ok'; },
    createDispatcher(origin) {
      const dispatcher = fakeDispatcher(origin);
      dispatchers.push(dispatcher);
      return dispatcher;
    },
  });

  await transport.fetch('https://api.example.test/v1/responses');
  dispatchers[0].emit('disconnect', new URL('https://api.example.test'), [],
    Object.assign(new Error('HTTP/2: GOAWAY frame received'), { code: 'UND_ERR_INFO' }));
  await transport.fetch('https://api.example.test/v1/responses');

  assert.equal(dispatchers.length, 2);
  assert.deepEqual(seen, dispatchers);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dispatchers[0].closeCalls, 1);
  await transport.close();
});

test('concurrent invalid-session failures share one replacement generation', async () => {
  const failure = Object.assign(new Error('session destroyed'), { code: 'ERR_HTTP2_INVALID_SESSION' });
  const dispatchers = [];
  const rotations = [];
  const transport = createProviderTransport({
    fetch: async (_input, init) => {
      if (init.dispatcher === dispatchers[0]) throw failure;
      return 'recovered';
    },
    createDispatcher(origin) {
      const dispatcher = fakeDispatcher(origin);
      dispatchers.push(dispatcher);
      return dispatcher;
    },
    onRotate: event => rotations.push(event),
  });

  assert.deepEqual(await Promise.all([
    transport.fetch('https://api.example.test/v1/responses', { method: 'POST', body: '{"turn":1}' }),
    transport.fetch('https://api.example.test/v1/responses', { method: 'POST', body: '{"turn":2}' }),
  ]), ['recovered', 'recovered']);
  assert.equal(dispatchers.length, 2);
  assert.equal(rotations.length, 1);
  await transport.close();
});

test('a failed retry retires its poisoned replacement before surfacing the error', async () => {
  const failure = Object.assign(new Error('session destroyed'), { code: 'ERR_HTTP2_INVALID_SESSION' });
  const dispatchers = [];
  const rotations = [];
  const transport = createProviderTransport({
    fetch: async () => { throw failure; },
    createDispatcher(origin) {
      const dispatcher = fakeDispatcher(origin);
      dispatchers.push(dispatcher);
      return dispatcher;
    },
    onRotate: event => rotations.push(event),
  });

  await assert.rejects(
    transport.fetch('https://api.example.test/v1/responses', { method: 'POST', body: '{}' }),
    error => error === failure,
  );
  assert.equal(dispatchers.length, 3);
  assert.deepEqual(rotations.map(event => event.reason), [
    'invalid_h2_session', 'invalid_h2_session_retry',
  ]);
  await transport.close();
});

test('Codex proxy owns the managed transport across all three upstream branches', async () => {
  let closes = 0;
  const posts = [];
  const mounted = mountCodexProxy({ post(route, handler) { posts.push({ route, handler }); } }, {
    providerTransport: {
      async fetch() { throw new Error('not called'); },
      async close() { closes += 1; },
    },
  });
  assert.equal(posts.length, 2);
  await mounted.close();
  assert.equal(closes, 1);

  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'proxy', 'codex.js'), 'utf8');
  assert.equal((source.match(/await providerFetch\(target\.url/g) || []).length, 3);
  assert.doesNotMatch(source, /await fetch\(target\.url/);
});
