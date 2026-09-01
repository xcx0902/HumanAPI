'use strict';

/**
 * Builds OpenAI-compatible response payloads from a human's answer.
 *
 * The human's answer is either plain content, one or more tool calls, or both.
 * For streaming requests we don't fake a token-by-token stream — the whole
 * assistant turn is emitted as a single `chat.completion.chunk`, followed by
 * `data: [DONE]`.
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

/**
 * @param {object} record store record with .body
 * @param {object} answer { content?: string|null, tool_calls?: Array<{id?, name, arguments}> }
 * @returns OpenAI chat.completion object
 */
function buildResponse(record, answer = {}) {
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
 * @param {object} response the chat.completion built by buildResponse
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

module.exports = { buildResponse, buildStreamChunks, estimateTokens };
