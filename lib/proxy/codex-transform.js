'use strict';

// ── Codex Responses API ↔ Chat Completions 协议转换 ──
// 纯函数模块。让 codex CLI（只支持 wire_api="responses"）能连只提供
// /chat/completions 的国产 LLM 服务商（DeepSeek/GLM/Qwen 等）。

// ── UUID 工具 ───────────────────────────────────────────────────────────────
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
function shortId(prefix, n) { return `${prefix}_${n}`; }

// ═══════════════════════════════════════════════════════════════════════════════
// 模块 A：请求转换 — Responses API body → Chat Completions body
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 把 codex 发来的 Responses API 请求体转成 Chat Completions 请求体。
 * @param {object} responsesBody  codex 的 POST /responses 请求体
 * @returns {object} Chat Completions body
 */
function responsesToChat(responsesBody) {
  const messages = [];

  // 1. instructions → system message 首条
  if (responsesBody.instructions) {
    messages.push({ role: 'system', content: responsesBody.instructions });
  }

  // 2. input[] → messages
  const input = responsesBody.input || [];
  for (const item of input) {
    switch (item.type) {
      case 'message': {
        // role: developer → system（DeepSeek 不认 developer）
        const role = item.role === 'developer' ? 'system' : item.role;
        const sourceParts = Array.isArray(item.content) ? item.content : [];
        const parts = sourceParts.map(c => {
          if (c.type === 'input_text' || c.type === 'output_text') return { type: 'text', text: c.text || '' };
          if (c.type === 'input_image') {
            const url = c.image_url || c.url || (c.file_id ? `file://${c.file_id}` : '');
            return url ? { type: 'image_url', image_url: { url, ...(c.detail ? { detail: c.detail } : {}) } } : null;
          }
          if (c.type === 'input_file') {
            const file = {};
            if (c.file_id) file.file_id = c.file_id;
            if (c.filename) file.filename = c.filename;
            if (c.file_data) file.file_data = c.file_data;
            return Object.keys(file).length ? { type: 'file', file } : null;
          }
          return null;
        }).filter(Boolean);
        const textOnly = parts.every(part => part.type === 'text');
        messages.push({ role, content: textOnly ? parts.map(part => part.text).join('') : parts });
        break;
      }
      case 'function_call': {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: item.call_id,
            type: 'function',
            function: { name: item.name, arguments: item.arguments || '' },
          }],
        });
        break;
      }
      case 'function_call_output': {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: item.output || '',
        });
        break;
      }
      // 忽略未知 type
    }
  }

  // 3. tools: Responses 扁平格式 → Chat 嵌套格式
  //    Responses API 有非 function 类型的内置工具（web_search、namespace 等），
  //    国产 chat/completions API 只认 type:'function'。跳过非 function 工具，
  //    避免 function.name 缺失导致 400 "'name' is a required property"。
  const tools = (responsesBody.tools || [])
    .filter(tool => !tool.type || tool.type === 'function')
    .map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));

  // 4. 构建 Chat body
  const chatBody = {
    model: responsesBody.model || 'deepseek-chat',
    messages,
    stream: true,
  };

  if (tools.length > 0) chatBody.tools = tools;
  if (responsesBody.tool_choice != null) chatBody.tool_choice = responsesBody.tool_choice;
  if (responsesBody.parallel_tool_calls != null) {
    chatBody.parallel_tool_calls = responsesBody.parallel_tool_calls;
  }
  // 5. 丢弃: reasoning, store, include, prompt_cache_key, client_metadata

  return chatBody;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 模块 B：流式响应转换 — Chat SSE → Responses SSE 状态机
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 创建 Chat Completions SSE 流 → Responses SSE 事件的转换器。
 *
 * 用法：
 *   const tx = chatStreamToResponses((sse) => upstreamResponse.write(sse));
 *   for (const line of chatSseLines) tx.pushLine(line);
 *   tx.end();
 *
 * @param {(sseText:string)=>void} emit  把构造好的 SSE 文本写出
 * @param {(delta:{type:'text'|'tool'|'reasoning', text?:string, tool?:{name:string, arguments:string}, toolId?:string})=>void} [onDelta]
 *        可选旁路回调：把上游原始 delta（未经 Responses 转换）推给宿主。这是 multicc
 *        拿到 token 级流量的旁路点——不经 codex CLI，proxy 直接透传 text/tool/reasoning
 *        delta，宿主可增量渲染（像 opencode 那样）。缺省无操作，不影响 Responses 转换。
 * @returns {{ pushLine: (line:string)=>void, end: (errorMsg?:string)=>void }}
 */
function chatStreamToResponses(emit, onDelta) {
  const _onDelta = typeof onDelta === 'function' ? onDelta : null;
  const RESPONSE_ID = 'resp_' + uuid().replace(/-/g, '').slice(0, 12);

  // ── 状态 ──
  let _finished = false;
  let _headerSent = false;         // response.created 已发？
  let _textStarted = false;        // output_item.added (message) 已发？
  let _textPartStarted = false;    // content_part.added 已发？
  let _textContentIndex = 0;       // content_index（同一 message 内第几个 output_text）
  let _textItemFinished = false;   // output_item.done (message) 已发？
  let _textAcc = '';               // completed.output 中必须保留所有流式 delta

  let _toolIndex = 0;              // 已创建的 function_call 数
  const _toolItems = new Map();    // Chat tool index -> {id,name,arguments,outputIndex,done}

  const _outputItems = [];         // 所有 output item（用于 response.completed）
  let _lastUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let _model = '';

  // ── 发送 SSE 事件 ──
  function sse(eventType, data) {
    emit(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // ── 确保文本 item 已打开 ──
  function ensureTextItem(contentSoFar) {
    if (_textItemFinished) return; // 文本项已关闭，不再新建
    if (!_textStarted) {
      const itemId = shortId('msg', 0);
      const item = { type: 'message', id: itemId, role: 'assistant', content: [] };
      _outputItems.push(item);
      sse('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: _outputItems.length - 1,
        item,
      });
      _textStarted = true;
    }
    if (!_textPartStarted) {
      const part = { type: 'output_text', text: '' };
      const itemId = shortId('msg', 0);
      sse('response.content_part.added', {
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: 0,
        content_index: _textContentIndex,
        part,
      });
      _textPartStarted = true;
    }
  }

  // ── 关闭文本 item ──
  function finishTextItem(fullText) {
    if (_textItemFinished) return;
    const itemId = shortId('msg', 0);
    const ci = _textContentIndex;

    // output_text.done
    sse('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: itemId,
      output_index: 0,
      content_index: ci,
      text: fullText,
    });
    // content_part.done
    sse('response.content_part.done', {
      type: 'response.content_part.done',
      item_id: itemId,
      output_index: 0,
      content_index: ci,
      part: { type: 'output_text', text: fullText },
    });
    // output_item.done
    const msgItem = { type: 'message', id: itemId, role: 'assistant',
      content: [{ type: 'output_text', text: fullText }] };
    sse('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: msgItem,
    });
    // Update stored item
    if (_outputItems.length > 0 && _outputItems[0].type === 'message') {
      _outputItems[0].content = [{ type: 'output_text', text: fullText }];
    }
    _textItemFinished = true;
  }

  // ── 确保当前 tool call item 已打开 ──
  function ensureToolItem(chatIndex, name, callId) {
    const key = Number.isInteger(chatIndex) ? chatIndex : 0;
    let state = _toolItems.get(key);
    if (state) {
      if (name && !state.name) state.name = name;
      if (callId && !state.id) state.id = callId;
      return state;
    }
    state = {
      id: callId || shortId('fc', _toolIndex),
      name: name || '',
      arguments: '',
      outputIndex: _outputItems.length,
      done: false,
    };
    _toolItems.set(key, state);

    const item = {
      type: 'function_call',
      id: state.id,
      call_id: state.id,
      name: state.name,
      arguments: '',
    };
    _outputItems.push(item);

    sse('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: state.outputIndex,
      item,
    });
    _toolIndex++;
    return state;
  }

  // ── 关闭指定 tool call item ──
  function finishToolItem(state) {
    if (!state || state.done) return;
    sse('response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      item_id: state.id,
      output_index: state.outputIndex,
      arguments: state.arguments,
    });
    const fcItem = { type: 'function_call', id: state.id,
      call_id: state.id, name: state.name, arguments: state.arguments };
    sse('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: state.outputIndex,
      item: fcItem,
    });
    _outputItems[state.outputIndex] = fcItem;
    state.done = true;
  }

  function finishToolItems() {
    for (const state of _toolItems.values()) finishToolItem(state);
  }

  // ── 主入口：推送一行 ──
  function pushLine(line) {
    if (_finished) return;

    const s = line.trim();
    if (!s) return;           // 空行
    if (!s.startsWith('data:')) return;  // 非 data 行

    const payload = s.slice(5).trim();

    // [DONE]
    if (payload === '[DONE]') { end(); return; }

    let obj;
    try { obj = JSON.parse(payload); }
    catch (_) { return; }     // 非 JSON 行忽略

    // 记录 model
    if (obj.model) _model = obj.model;
    if (obj.usage) _lastUsage = {
      input_tokens: obj.usage.prompt_tokens || obj.usage.input_tokens || 0,
      output_tokens: obj.usage.completion_tokens || obj.usage.output_tokens || 0,
      total_tokens: obj.usage.total_tokens || 0,
      input_tokens_details: {
        cached_tokens: (obj.usage.prompt_tokens_details && obj.usage.prompt_tokens_details.cached_tokens)
          || (obj.usage.input_tokens_details && obj.usage.input_tokens_details.cached_tokens)
          || 0,
      },
    };

    const choice = (obj.choices && obj.choices.length > 0) ? obj.choices[0] : null;
    if (!choice) return;

    const delta = choice.delta || {};
    const finishReason = choice.finish_reason;

    // ── 发 header（首次有内容时） ──
    if (!_headerSent) {
      _headerSent = true;
      sse('response.created', {
        type: 'response.created',
        response: {
          id: RESPONSE_ID,
          object: 'response',
          status: 'in_progress',
          model: _model || '',
          output: [],
        },
      });
    }

    // ── tool_calls ──
    if (delta.tool_calls && delta.tool_calls.length > 0) {
      // tool_calls 来时，如果文本 item 还在进行中，先关闭它
      if (_textStarted && !_textItemFinished) {
        finishTextItem(_textAcc);
      }

      for (const tc of delta.tool_calls) {
        const tcId = tc.id || '';
        const fn = tc.function || {};
        const state = ensureToolItem(tc.index, fn.name || '', tcId);

        // 累积 arguments
        if (fn.arguments) {
          state.arguments += fn.arguments;
          if (_onDelta) {
            try { _onDelta({ type: 'tool', tool: { name: state.name, arguments: fn.arguments }, toolId: state.id }); } catch (_) {}
          }
          sse('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: state.id,
            output_index: state.outputIndex,
            delta: fn.arguments,
          });
        }
      }
      return;
    }

    // ── reasoning_content（思维链 delta）── DeepSeek/GLM/Qwen 等国产 provider 的思维链。
    // codex Responses 协议没有官方 reasoning delta（只在 done 时一次性给），所以这里
    // 不往 Responses 流写、只旁路给宿主——宿主可据此实时展示推理过程（codex CLI 自己看不到）。
    const reasoning = delta.reasoning_content || delta.reasoning;
    if (reasoning !== undefined && reasoning !== null && reasoning !== '') {
      const text = typeof reasoning === 'string' ? reasoning : String(reasoning);
      if (_onDelta) {
        try { _onDelta({ type: 'reasoning', text }); } catch (_) {}
      }
    }

    // ── 文本 delta ──
    const content = delta.content;
    if (content !== undefined && content !== null) {
      // 如果正在累积 tool，先关闭
      finishToolItems();

      ensureTextItem(content);
      _textAcc += typeof content === 'string' ? content : String(content);
      const itemId = shortId('msg', 0);
      if (_onDelta) {
        try { _onDelta({ type: 'text', text: typeof content === 'string' ? content : String(content) }); } catch (_) {}
      }
      sse('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: itemId,
        output_index: 0,
        content_index: _textContentIndex,
        delta: typeof content === 'string' ? content : String(content),
      });
      return;
    }

    // ── finish_reason: stop → 关闭文本 item ──
    if (finishReason === 'stop' || finishReason === 'length') {
      finishToolItems();
      if (_textStarted && !_textItemFinished) { finishTextItem(_textAcc); }
    }
  }

  // ── 结束 ──
  function end(errorMsg) {
    if (_finished) return;
    _finished = true;

    if (errorMsg) {
      sse('response.failed', {
        type: 'response.failed',
        response: { status: 'failed', error: { message: errorMsg } },
      });
      return;
    }

    // 关闭任何还在进行中的 item
    finishToolItems();
    if (_textStarted && !_textItemFinished) { finishTextItem(_textAcc); }

    // response.completed
    sse('response.completed', {
      type: 'response.completed',
      response: {
        id: RESPONSE_ID,
        status: 'completed',
        output: _outputItems,
        usage: _lastUsage,
      },
    });
  }

  return { pushLine, end };
}

module.exports = { responsesToChat, chatStreamToResponses };
