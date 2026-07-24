'use strict';

// Unit tests for the proxy's onDelta sidecar — the token-level delta extraction
// that lets the host render codex/claude turns incrementally. Covers both the
// Responses SSE path (direct-responses / responses-compat, via feedResponsesDelta)
// and the Anthropic SSE path (claude proxy, via _feedChunk).

const assert = require('node:assert/strict');
const test = require('node:test');
const { newResponsesDeltaTee, feedResponsesDelta } = require('../lib/proxy/codex');
const { _testNewUsageTee: newUsageTee, _testFeedChunk: _feedChunk } = require('../lib/proxy/claude');

function sseData(obj) { return `data: ${JSON.stringify(obj)}\n`; }

test('Responses SSE: feedResponsesDelta forwards text/reasoning/tool deltas', () => {
  const tee = newResponsesDeltaTee();
  const out = [];
  const onDelta = d => out.push(d);
  // output_item.added (function_call) registers the tool name → toolId
  feedResponsesDelta(tee, sseData({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', name: 'grep' } }), onDelta);
  // reasoning summary delta
  feedResponsesDelta(tee, sseData({ type: 'response.reasoning_summary_text.delta', delta: '思考' }), onDelta);
  // text delta
  feedResponsesDelta(tee, sseData({ type: 'response.output_text.delta', delta: 'hi' }), onDelta);
  // tool arguments delta (carries item_id, resolved to the name above)
  feedResponsesDelta(tee, sseData({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"q":"x"' }), onDelta);

  assert.deepEqual(out, [
    { type: 'reasoning', text: '思考' },
    { type: 'text', text: 'hi' },
    { type: 'tool', tool: { name: 'grep', arguments: '{"q":"x"' }, toolId: 'fc_1' },
  ]);
});

test('Responses SSE: ignores non-delta events and non-data lines', () => {
  const tee = newResponsesDeltaTee();
  const out = [];
  feedResponsesDelta(tee, 'event: response.created\n', d => out.push(d));   // not a data: line
  feedResponsesDelta(tee, sseData({ type: 'response.created', response: { id: 'r' } }), d => out.push(d));
  feedResponsesDelta(tee, 'data: [DONE]\n', d => out.push(d));
  feedResponsesDelta(tee, 'data: not-json\n', d => out.push(d));
  assert.deepEqual(out, []);
});

test('Responses SSE: tool delta without a prior output_item.added still forwards (name empty)', () => {
  const tee = newResponsesDeltaTee();
  const out = [];
  feedResponsesDelta(tee, sseData({ type: 'response.function_call_arguments.delta', item_id: 'orphan', delta: 'x' }), d => out.push(d));
  assert.deepEqual(out, [{ type: 'tool', tool: { name: '', arguments: 'x' }, toolId: 'orphan' }]);
});

test('Responses SSE: forwards custom, patch, code-interpreter and citation deltas', () => {
  const tee = newResponsesDeltaTee();
  const out = [];
  const emit = d => out.push(d);
  feedResponsesDelta(tee, sseData({ type: 'response.output_item.added', item: { type: 'custom_tool_call', id: 'custom_1', name: 'browser' } }), emit);
  feedResponsesDelta(tee, sseData({ type: 'response.custom_tool_call_input.delta', item_id: 'custom_1', delta: '{"url":' }), emit);
  feedResponsesDelta(tee, sseData({ type: 'response.apply_patch_call_operation_diff.delta', item_id: 'patch_1', delta: '@@ -1' }), emit);
  feedResponsesDelta(tee, sseData({ type: 'response.code_interpreter_call_code.delta', item_id: 'code_1', delta: 'print(1)' }), emit);
  feedResponsesDelta(tee, sseData({ type: 'response.output_text.annotation.added', item_id: 'msg_1', output_index: 0, annotation: { type: 'url_citation', url: 'https://example.test' } }), emit);
  assert.deepEqual(out, [
    { type: 'tool', tool: { name: 'browser', arguments: '{"url":' }, toolId: 'custom_1' },
    { type: 'tool', tool: { name: 'apply_patch_call', arguments: '@@ -1' }, toolId: 'patch_1' },
    { type: 'tool', tool: { name: 'code_interpreter_call', arguments: 'print(1)' }, toolId: 'code_1' },
    { type: 'source', source: { type: 'url_citation', url: 'https://example.test' }, itemId: 'msg_1', outputIndex: 0 },
  ]);
});

test('Responses SSE: no onDelta callback is a no-op (back-compat)', () => {
  const tee = newResponsesDeltaTee();
  // should not throw
  feedResponsesDelta(tee, sseData({ type: 'response.output_text.delta', delta: 'hi' }), null);
  assert.equal(tee.buffer.length === 0 || tee.buffer.includes('hi'), true);
});

// ── Anthropic SSE (claude proxy) ──

function makeClaudeTee(onDelta) {
  const tee = newUsageTee();
  tee.contentType = 'text/event-stream';
  tee.isSSE = true;
  if (onDelta) {
    tee.onDelta = (delta, _ctx) => onDelta(delta);
    tee.deltaCtx = {};
  }
  return tee;
}

test('Anthropic SSE: text content_block_delta → text delta', () => {
  const out = [];
  const tee = makeClaudeTee(d => out.push(d));
  _feedChunk(tee, Buffer.from(sseData({ type: 'content_block_start', index: 0, content_block: { type: 'text', id: 'b0' } })));
  _feedChunk(tee, Buffer.from(sseData({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hel' } })));
  _feedChunk(tee, Buffer.from(sseData({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } })));
  assert.deepEqual(out, [{ type: 'text', text: 'hel' }, { type: 'text', text: 'lo' }]);
});

test('Anthropic SSE: thinking block → reasoning delta', () => {
  const out = [];
  const tee = makeClaudeTee(d => out.push(d));
  _feedChunk(tee, Buffer.from(sseData({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', id: 'b1' } })));
  _feedChunk(tee, Buffer.from(sseData({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '推理' } })));
  assert.deepEqual(out, [{ type: 'reasoning', text: '推理' }]);
});

test('Anthropic-compatible SSE: legacy thinking delta.text remains supported', () => {
  const out = [];
  const tee = makeClaudeTee(d => out.push(d));
  _feedChunk(tee, Buffer.from(sseData({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', id: 'b1' } })));
  _feedChunk(tee, Buffer.from(sseData({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', text: 'legacy' } })));
  assert.deepEqual(out, [{ type: 'reasoning', text: 'legacy' }]);
});

test('Anthropic SSE: tool_use block partial_json → tool delta with name + id', () => {
  const out = [];
  const tee = makeClaudeTee(d => out.push(d));
  _feedChunk(tee, Buffer.from(sseData({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'Bash' } })));
  _feedChunk(tee, Buffer.from(sseData({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls' } })));
  _feedChunk(tee, Buffer.from(sseData({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"}' } })));
  assert.deepEqual(out, [
    { type: 'tool', tool: { name: 'Bash', arguments: '{"cmd":"ls' }, toolId: 'tu_1' },
    { type: 'tool', tool: { name: 'Bash', arguments: '"}' }, toolId: 'tu_1' },
  ]);
});

test('Anthropic SSE: content_block_stop resets the current block (no cross-block leak)', () => {
  const out = [];
  const tee = makeClaudeTee(d => out.push(d));
  _feedChunk(tee, Buffer.from(sseData({ type: 'content_block_start', index: 0, content_block: { type: 'text', id: 'b0' } })));
  _feedChunk(tee, Buffer.from(sseData({ type: 'content_block_stop', index: 0 })));
  // a delta arriving with no current block must be ignored, not crash
  _feedChunk(tee, Buffer.from(sseData({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } })));
  assert.deepEqual(out, []);
});

test('Anthropic SSE: interleaved indexed blocks, compaction and citations are preserved', () => {
  const out = [];
  const tee = makeClaudeTee(d => out.push(d));
  _feedChunk(tee, Buffer.from(sseData({ type: 'content_block_start', index: 0, content_block: { type: 'text', id: 'text_0' } })));
  _feedChunk(tee, Buffer.from(sseData({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_1', name: 'Read' } })));
  _feedChunk(tee, Buffer.from(sseData({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'still text' } })));
  _feedChunk(tee, Buffer.from(sseData({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"x"}' } })));
  _feedChunk(tee, Buffer.from(sseData({ type: 'content_block_delta', index: 0, delta: { type: 'compaction_delta', content: 'compact' } })));
  _feedChunk(tee, Buffer.from(sseData({ type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://example.test' } } })));
  assert.deepEqual(out, [
    { type: 'text', text: 'still text' },
    { type: 'tool', tool: { name: 'Read', arguments: '{"path":"x"}' }, toolId: 'tool_1' },
    { type: 'text', text: 'compact' },
    { type: 'source', source: { type: 'web_search_result_location', url: 'https://example.test' }, blockId: 'text_0' },
  ]);
});

test('Anthropic SSE: usage extraction still works alongside onDelta', () => {
  let usage = null;
  const tee = makeClaudeTee(() => {});
  _feedChunk(tee, Buffer.from(sseData({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 2 } } })));
  _feedChunk(tee, Buffer.from(sseData({ type: 'message_delta', usage: { output_tokens: 5 } })));
  // usage is finalized elsewhere; here we just assert it was merged during feed
  assert.equal(tee.usage.inputTokens, 10);
  assert.equal(tee.usage.outputTokens, 5);
});
