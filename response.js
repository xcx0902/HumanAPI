'use strict';

/**
 * Builds OpenAI-compatible response payloads from a human's answer, for both
 * the Chat Completions API (POST /v1/chat/completions) and the Responses API
 * (POST /v1/responses). Which wire shape is produced is decided by
 * `record.api` ('chat' | 'responses'); records without an api field predate
 * Responses support and are chat requests.
 *
 * The human's answer is either plain content, one or more tool calls, or both.
 * For streaming requests we don't fake a token-by-token stream — the whole
 * assistant turn is emitted at once:
 *   - chat:      a single `chat.completion.chunk`, then `data: [DONE]`;
 *   - responses: a compact burst of real Responses SSE events
 *                (response.created → output_item events → response.completed).
 */

const crypto = require('crypto');

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Rough token estimate: ~4 chars per token. OpenAI-compatible clients only
 *  need the numbers to be present; exactness is irrelevant for a human proxy. */
function estimateTokens(text) {
  if (text == null) return 0;
  return Math.ceil(String(text).length / 4);
}

// ============================================================ chat completions

/**
 * @param {object} record store record with .body
 * @param {object} answer { content?: string|null, tool_calls?: Array<{id?, name, arguments}> }
 * @returns OpenAI chat.completion object
 */
function buildChatCompletion(record, answer = {}) {
  const content = typeof answer.content === 'string' ? answer.content : null;
  const toolCalls = Array.isArray(answer.tool_calls) ? answer.tool_calls : [];

  const message = { role: 'assistant', content };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((tc) => ({
      id: tc.id || 'call_' + randomHex(8),
      type: 'function',
      function: {
        name: tc.name,
        arguments:
          typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}),
      },
    }));
  }

  const finishReason = message.tool_calls ? 'tool_calls' : 'stop';

  const promptText = JSON.stringify(record.body.messages || []);
  const completionText =
    (content || '') + toolCalls.map((t) => (t.name || '') + (t.arguments || '')).join('');
  const promptTokens = estimateTokens(promptText);
  const completionTokens = estimateTokens(completionText);

  return {
    id: record.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: record.body.model || 'human-proxy',
    system_fingerprint: 'human-proxy',
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/**
 * @param {object} record store record with .body (needs body.stream_options)
 * @param {object} response the chat.completion built by buildChatCompletion
 * @returns array of chunk objects to serialize as `data: <json>` SSE lines
 */
function buildStreamChunks(record, response) {
  const message = response.choices[0].message;
  const delta = { role: 'assistant' };
  if (message.content != null) delta.content = message.content;
  if (message.tool_calls) {
    delta.tool_calls = message.tool_calls.map((tc, i) => ({
      index: i,
      id: tc.id,
      type: 'function',
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
  }

  const chunks = [
    {
      id: response.id,
      object: 'chat.completion.chunk',
      created: response.created,
      model: response.model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: response.choices[0].finish_reason,
        },
      ],
    },
  ];

  if (record.body.stream_options && record.body.stream_options.include_usage) {
    chunks.push({
      id: response.id,
      object: 'chat.completion.chunk',
      created: response.created,
      model: response.model,
      choices: [],
      usage: response.usage,
    });
  }

  return chunks;
}

// ================================================================= responses API

/**
 * Turn the human's answer into Responses-API output items:
 *   - text          → a `message` output item (role assistant, output_text part)
 *   - each tool call → a `function_call` output item with a fresh call_id
 */
function buildResponsesOutput(answer = {}) {
  const content = typeof answer.content === 'string' ? answer.content : '';
  const toolCalls = Array.isArray(answer.tool_calls) ? answer.tool_calls : [];
  const output = [];

  if (content.trim() !== '') {
    output.push({
      id: 'msg_' + randomHex(16),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: content, annotations: [] }],
    });
  }

  for (const tc of toolCalls) {
    output.push({
      id: 'fc_' + randomHex(16),
      call_id: tc.id || 'call_' + randomHex(8),
      type: 'function_call',
      status: 'completed',
      name: tc.name,
      arguments:
        typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}),
    });
  }

  return output;
}

/**
 * @param {object} record store record with .body (the raw /v1/responses request)
 * @param {object} answer { content?, tool_calls? }
 * @returns OpenAI `response` object (object: "response")
 */
function buildResponsesResponse(record, answer = {}) {
  const body = record.body || {};
  const output = buildResponsesOutput(answer);
  const model = body.model || 'human-proxy';

  const inputText = JSON.stringify({ instructions: body.instructions, input: body.input });
  const outputText = output
    .map((o) =>
      o.type === 'message'
        ? o.content.map((p) => p.text || '').join('')
        : o.name + (o.arguments || '')
    )
    .join('');
  const inputTokens = estimateTokens(inputText);
  const outputTokens = estimateTokens(outputText);

  return {
    id: record.id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: typeof body.instructions === 'string' ? body.instructions : null,
    max_output_tokens: null,
    model,
    output,
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: body.temperature ?? null,
    text: body.text && typeof body.text === 'object' ? body.text : { format: { type: 'text' } },
    tool_choice: body.tool_choice ?? 'auto',
    tools: Array.isArray(body.tools) ? body.tools : [],
    top_p: body.top_p ?? null,
    truncation: body.truncation ?? 'disabled',
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: inputTokens + outputTokens,
    },
    user: body.user ?? null,
    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
  };
}

/**
 * The full Responses SSE event burst for a completed turn. Each element is
 * { event, data } and should be written as `event: <name>` + `data: <json>`.
 * Unlike chat completions there is no `[DONE]` sentinel — the stream just
 * closes after `response.completed`.
 *
 * @param {object} record store record with .body
 * @param {object} response the `response` object built by buildResponsesResponse
 * @returns Array<{event: string, data: object}>
 */
function buildResponsesStreamEvents(record, response) {
  const events = [];
  const output = response.output || [];

  const push = (event, data) => events.push({ event, data: { type: event, ...data } });

  // Response lifecycle: mirror the real API but with the whole turn ready.
  const progressSnapshot = { ...response, status: 'in_progress', output: [] };
  push('response.created', { response: progressSnapshot });
  push('response.in_progress', { response: progressSnapshot });

  output.forEach((item, outputIndex) => {
    if (item.type === 'message') {
      const part = (item.content && item.content[0]) || {
        type: 'output_text',
        text: '',
        annotations: [],
      };
      const text = typeof part.text === 'string' ? part.text : '';

      push('response.output_item.added', {
        output_index: outputIndex,
        item: {
          id: item.id,
          type: 'message',
          role: item.role,
          status: 'in_progress',
          content: [],
        },
      });
      push('response.content_part.added', {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
      if (text) {
        push('response.output_text.delta', {
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          delta: text,
        });
      }
      push('response.output_text.done', {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        text,
      });
      push('response.content_part.done', {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part,
      });
      push('response.output_item.done', { output_index: outputIndex, item });
    } else if (item.type === 'function_call') {
      const args = typeof item.arguments === 'string' ? item.arguments : '';

      push('response.output_item.added', {
        output_index: outputIndex,
        item: {
          id: item.id,
          call_id: item.call_id,
          type: 'function_call',
          status: 'in_progress',
          name: item.name,
          arguments: '',
        },
      });
      if (args) {
        push('response.function_call_arguments.delta', {
          item_id: item.id,
          output_index: outputIndex,
          delta: args,
        });
      }
      push('response.function_call_arguments.done', {
        item_id: item.id,
        output_index: outputIndex,
        arguments: args,
      });
      push('response.output_item.done', { output_index: outputIndex, item });
    }
  });

  push('response.completed', { response });
  return events;
}

// ===================================================================== dispatch

/**
 * Build the wire payload for a completed record, choosing the shape by the API
 * the request came in on. Records without an api field are chat completions.
 */
function buildResponse(record, answer = {}) {
  if (record.api === 'responses') return buildResponsesResponse(record, answer);
  return buildChatCompletion(record, answer);
}

module.exports = {
  buildResponse,
  buildChatCompletion,
  buildStreamChunks,
  buildResponsesStreamEvents,
  estimateTokens,
};
