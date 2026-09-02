'use strict';

// Multi-account official OAuth routing: a provider marked with
// settingsConfig.officialAccount.id takes the official branch and resolves its
// credential through the host-injected readOfficialCredential(context) —
// never the shared Keychain login.

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('http');
const {
  createHandler,
  officialAccountIdFromProvider,
} = require('../lib/proxy/claude');

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

const ACCOUNT_ID = 'abcdef0123456789';

function accountProvider(accountId) {
  return {
    name: 'Claude 官方 · 工作号',
    settingsConfig: { env: {}, officialAccount: { id: accountId } },
  };
}

async function withEnv(value, fn) {
  const prev = process.env.CLAUDE_OFFICIAL_VIA_PROXY;
  if (value == null) delete process.env.CLAUDE_OFFICIAL_VIA_PROXY;
  else process.env.CLAUDE_OFFICIAL_VIA_PROXY = value;
  try { return await fn(); } finally {
    if (prev == null) delete process.env.CLAUDE_OFFICIAL_VIA_PROXY;
    else process.env.CLAUDE_OFFICIAL_VIA_PROXY = prev;
  }
}

async function main() {
  console.log('\nClaude official-account routing tests');

  await test('marker parsing is strict', () => {
    assert.strictEqual(officialAccountIdFromProvider(accountProvider(ACCOUNT_ID)), ACCOUNT_ID);
    assert.strictEqual(officialAccountIdFromProvider(accountProvider('../../etc')), null);
    assert.strictEqual(officialAccountIdFromProvider({ settingsConfig: { env: {} } }), null);
    assert.strictEqual(officialAccountIdFromProvider({
      settingsConfig: JSON.stringify({ officialAccount: { id: ACCOUNT_ID } }),
    }), ACCOUNT_ID);
    assert.strictEqual(officialAccountIdFromProvider(null), null);
  });

  await withEnv('1', async () => {
    await test('marked provider routes through the injected account credential', async () => {
      const upstreamRequests = [];
      const upstream = await listen((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          upstreamRequests.push({ req, body: Buffer.concat(chunks).toString('utf8') });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }));
        });
      });

      const contexts = [];
      const provider = accountProvider(ACCOUNT_ID);
      const proxy = await listen(createHandler({
        getProvider: () => provider,
        officialBaseUrl: upstreamUrl(upstream.port),
        // ASYNC resolver — the host refreshes-on-read, so the branch must await.
        readOfficialCredential: async (ctx) => {
          contexts.push(ctx);
          return { token: 'oat-account-token' };
        },
      }));

      try {
        const response = await request({
          port: proxy.port,
          path: '/claude-proxy/claude-acct/session-9/v1/messages',
          body: { model: 'claude-sonnet-4-6', stream: false, messages: [] },
        });
        await new Promise(resolve => setImmediate(resolve));

        assert.strictEqual(response.status, 200);
        assert.strictEqual(contexts.length, 1);
        assert.strictEqual(contexts[0].accountId, ACCOUNT_ID);
        assert.strictEqual(contexts[0].providerId, 'claude-acct');
        assert.strictEqual(contexts[0].provider, provider);
        assert.ok(typeof contexts[0].keychainService === 'string');

        assert.strictEqual(upstreamRequests.length, 1);
        const seen = upstreamRequests[0];
        assert.strictEqual(seen.req.headers.authorization, 'Bearer oat-account-token');
        assert.match(String(seen.req.headers['anthropic-beta']), /oauth-2025-04-20/);
        // body passes through untouched (identity-block injection deliberately
        // omitted — it would bust the CLI's prompt-cache prefix)
        const body = JSON.parse(seen.body);
        assert.strictEqual(body.model, 'claude-sonnet-4-6');
        assert.strictEqual(body.system, undefined);
      } finally {
        await close(proxy.server);
        await close(upstream.server);
      }
    });

    await test('marked provider without an injected resolver fails loud (no Keychain borrow)', async () => {
      const provider = accountProvider(ACCOUNT_ID);
      const proxy = await listen(createHandler({
        getProvider: () => provider,
        // no readOfficialCredential — the default reader must refuse the
        // account context rather than falling back to the shared login.
      }));
      try {
        const response = await request({
          port: proxy.port,
          path: '/claude-proxy/claude-acct/session-9/v1/messages',
          body: { model: 'claude-sonnet-4-6', messages: [] },
        });
        assert.strictEqual(response.status, 502);
        assert.match(response.body, /no credential resolver/);
      } finally {
        await close(proxy.server);
      }
    });

    await test('unmarked empty-baseUrl provider still fails closed', async () => {
      const proxy = await listen(createHandler({
        getProvider: () => ({ name: 'Empty', settingsConfig: { env: {} } }),
        readOfficialCredential: () => ({ token: 'must-not-be-used' }),
      }));
      try {
        const response = await request({
          port: proxy.port,
          path: '/claude-proxy/random-empty/session-9/v1/messages',
          body: { model: 'claude-sonnet-4-6', messages: [] },
        });
        assert.strictEqual(response.status, 502);
        assert.match(response.body, /no baseUrl/);
      } finally {
        await close(proxy.server);
      }
    });
  });

  await withEnv(null, async () => {
    await test('the official branch stays gated behind CLAUDE_OFFICIAL_VIA_PROXY', async () => {
      const proxy = await listen(createHandler({
        getProvider: () => accountProvider(ACCOUNT_ID),
        readOfficialCredential: () => ({ token: 'must-not-be-used' }),
      }));
      try {
        const response = await request({
          port: proxy.port,
          path: '/claude-proxy/claude-acct/session-9/v1/messages',
          body: { model: 'claude-sonnet-4-6', messages: [] },
        });
        assert.strictEqual(response.status, 502);
        assert.match(response.body, /no baseUrl/);
      } finally {
        await close(proxy.server);
      }
    });
  });
}

function upstreamUrl(port) {
  return `http://127.0.0.1:${port}`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
