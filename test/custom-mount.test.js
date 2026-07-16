'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('http');
const express = require('express');
const { mountClaudeProxy, mountCodexProxy } = require('../lib');

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
  return new Promise(resolve => server.close(resolve));
}

function post(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('Claude custom mount path forwards a real Express request', async () => {
  let upstreamPath = '';
  const upstream = await listen((req, res) => {
    upstreamPath = req.url;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const app = express();
  app.use(express.json());
  mountClaudeProxy(app, {
    claudeProxyPath: '/custom-claude',
    getProvider: () => ({
      name: 'Claude Custom',
      settingsConfig: { env: { ANTHROPIC_BASE_URL: upstream.url, ANTHROPIC_API_KEY: 'key' } },
    }),
  });
  const proxy = await listen(app);
  try {
    const response = await post(proxy.port, '/custom-claude/main/session/v1/messages', {
      model: 'claude-model', messages: [], stream: false,
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamPath, '/v1/messages');
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});

test('Codex custom mount path forwards a real role-aware Express request', async () => {
  let upstreamPath = '';
  const upstream = await listen((req, res) => {
    upstreamPath = req.url;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'r', output: [], usage: { input_tokens: 2, output_tokens: 1 } }));
    });
  });
  const app = express();
  app.use(express.json());
  mountCodexProxy(app, {
    codexProxyPath: '/custom-codex',
    getProvider: () => ({
      name: 'Codex Custom',
      settingsConfig: {
        auth: { OPENAI_API_KEY: 'key' },
        config: [
          'model_provider = "custom"',
          '[model_providers.custom]',
          `base_url = "${upstream.url}/v1"`,
          'wire_api = "responses"',
        ].join('\n'),
      },
    }),
  });
  const proxy = await listen(app);
  try {
    const response = await post(proxy.port, '/custom-codex/main/session/sub/responses', {
      model: 'codex-model', input: [], stream: false,
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamPath, '/v1/responses');
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});
