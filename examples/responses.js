#!/usr/bin/env node
'use strict';

/**
 * OpenAI Responses API demo (POST /v1/responses).
 *
 * Sends a Responses-API request with instructions + input items + flat tool
 * definitions (the Responses wire format). The human can answer in the web UI
 * with plain text or with function calls — both are valid Responses output.
 *
 * Usage:
 *   node examples/responses.js                        # ask, non-streaming
 *   node examples/responses.js --stream               # stream (SSE events)
 *
 * If the human answers with a function call, this prints the emitted
 * function_call items; a real client would run the tool and re-ask with a
 * function_call_output item in `input`.
 */

const BASE = process.env.API_BASE || 'http://127.0.0.1:8787/v1';

const TOOLS = [
  {
    type: 'function',
    name: 'get_weather',
    description: 'Get the current weather conditions for a city.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name' },
        unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
      },
      required: ['city'],
      additionalProperties: false,
    },
    strict: true,
  },
];

/** Parse one SSE `data:` payload; returns null for keep-alive/comments. */
function parseSseChunk(chunk) {
  const lines = chunk.split('\n');
  const data = lines
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('\n');
  if (!data || data === '[DONE]') return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function main() {
  const stream = process.argv.includes('--stream');

  const body = {
    model: 'human-proxy',
    instructions: 'You can call tools. Decide whether to call a tool or answer directly.',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What is the weather in Paris right now?' }] },
    ],
    tools: TOOLS,
    stream,
  };

  console.log(`→ sending to ${BASE}/responses … (waiting for a human)`);
  const res = await fetch(`${BASE}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!stream) {
    const data = await res.json();
    console.log(`← HTTP ${res.status}`);
    console.log(JSON.stringify(data, null, 2));

    const calls = (data.output || []).filter((o) => o.type === 'function_call');
    if (calls.length) {
      console.log('\n🤖 Assistant wants to call tools:');
      for (const c of calls) {
        console.log(`  - ${c.name}(${c.arguments})   [call_id ${c.call_id}]`);
      }
      console.log('\nNext step: send a new request whose input carries a');
      console.log('function_call_output item with that call_id.');
    }
    return;
  }

  // Streaming: print the SSE events as they arrive. No `[DONE]` sentinel in
  // the Responses API — the stream closes after response.completed.
  console.log(`← HTTP ${res.status} (event stream)`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const event = parseSseChunk(part);
      if (event) {
        console.log(`\n[${event.type}]`);
        if (event.type === 'response.output_item.added') console.log(JSON.stringify(event.item, null, 2));
        else if (event.type === 'response.output_text.delta') process.stdout.write(event.delta);
        else if (event.type === 'response.function_call_arguments.delta') process.stdout.write(event.delta);
        else if (event.type === 'response.completed') console.log(JSON.stringify(event.response, null, 2));
      }
    }
  }
}

main().catch((err) => {
  console.error('✗', err.message);
  process.exit(1);
});
