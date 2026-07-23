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

test('onDelta sidecar receives reasoning/text/tool deltas verbatim from upstream', () => {
  const chunks = [];
  const deltas = [];
  const transform = chatStreamToResponses(chunk => chunks.push(chunk), d => deltas.push(d));
  // reasoning_content delta — codex Responses protocol has no reasoning stream, so
  // it must NOT appear in the Responses output, but MUST reach the onDelta sidecar.
  transform.pushLine(`data: ${JSON.stringify({ id: 'c', model: 'm', choices: [{ index: 0, delta: { reasoning_content: '思考' }, finish_reason: null }] })}`);
  transform.pushLine(`data: ${JSON.stringify({ id: 'c', model: 'm', choices: [{ index: 0, delta: { reasoning_content: '一下' }, finish_reason: null }] })}`);
  // text delta
  transform.pushLine(`data: ${JSON.stringify({ id: 'c', model: 'm', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] })}`);
  // tool_call delta
  transform.pushLine(`data: ${JSON.stringify({ id: 'c', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ id: 'tc1', function: { name: 'grep', arguments: '{"q":"x"' } }] }, finish_reason: null }] })}`);
  transform.pushLine(`data: ${JSON.stringify({ id: 'c', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`);
  transform.pushLine('data: [DONE]');

  // reasoning deltas reach the sidecar, verbatim and in order
  assert.deepEqual(deltas.filter(d => d.type === 'reasoning').map(d => d.text), ['思考', '一下']);
  // text delta reaches the sidecar
  assert.equal(deltas.find(d => d.type === 'text').text, 'hi');
  // tool delta reaches the sidecar with name + arguments fragment
  const toolDelta = deltas.find(d => d.type === 'tool');
  assert.equal(toolDelta.tool.name, 'grep');
  assert.equal(toolDelta.tool.arguments, '{"q":"x"');
  assert.equal(toolDelta.toolId, 'tc1');
  // reasoning is NOT leaked into the Responses stream (codex CLI never sees it)
  const sseText = chunks.join('');
  assert.ok(!sseText.includes('思考'), 'reasoning must not appear in the Responses SSE');
  assert.ok(sseText.includes('hi'), 'text still flows through to Responses');
});
