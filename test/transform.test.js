'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { chatStreamToResponses, responsesToChat } = require('../lib/proxy/codex-transform');
const { normalizeResponsesUsage } = require('../lib/proxy/codex');

function parseEvents(chunks) {
  return chunks.join('').split('\n\n').filter(Boolean).map(block => {
    const lines = block.split('\n');
    const event = lines.find(line => line.startsWith('event: '));
    const data = lines.find(line => line.startsWith('data: '));
    return { type: event && event.slice(7), data: data && JSON.parse(data.slice(6)) };
  });
}

test('Responses input converts tool calls and preserves request controls', () => {
  const result = responsesToChat({
    model: 'chat-model', instructions: 'system', parallel_tool_calls: true,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{"x":1}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'done' },
    ],
  });
  assert.equal(result.messages[0].content, 'system');
  assert.equal(result.messages[2].tool_calls[0].function.name, 'lookup');
  assert.equal(result.messages[3].tool_call_id, 'call-1');
  assert.equal(result.parallel_tool_calls, true);
});

test('Chat SSE completion accumulates every text delta and cached token details', () => {
  const chunks = [];
  const transform = chatStreamToResponses(chunk => chunks.push(chunk));
  transform.pushLine(`data: ${JSON.stringify({ id: 'chat-1', model: 'm', choices: [{ index: 0, delta: { content: 'full ' }, finish_reason: null }] })}`);
  transform.pushLine(`data: ${JSON.stringify({ id: 'chat-1', model: 'm', choices: [{ index: 0, delta: { content: 'stream text' }, finish_reason: null }] })}`);
  transform.pushLine(`data: ${JSON.stringify({ id: 'chat-1', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, prompt_tokens_details: { cached_tokens: 12 }, completion_tokens: 4, total_tokens: 34 } })}`);
  transform.pushLine('data: [DONE]');
  const completed = parseEvents(chunks).find(event => event.type === 'response.completed').data.response;
  assert.equal(completed.output[0].content[0].text, 'full stream text');
  assert.equal(completed.usage.input_tokens_details.cached_tokens, 12);
  assert.deepEqual(normalizeResponsesUsage(completed.usage), {
    inputTokens: 18, outputTokens: 4, cacheWrite: 0, cacheRead: 12,
  });
});
