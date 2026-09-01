#!/usr/bin/env node
'use strict';

/**
 * Tool-call flow demo.
 *
 * Sends a request that declares tools (get_weather / get_time). The human can
 * answer in the web UI with plain text OR with tool calls — both are valid
 * OpenAI responses. Whatever the human emits is printed here.
 *
 * To see the full round trip, respond with a tool call, then run this again
 * with the tool result appended (the `--with-tool-result` flag does that).
 *
 * Usage:
 *   node examples/toolcall.js                      # ask the question
 *   node examples/toolcall.js --with-tool-result   # continue after a tool call
 */

const BASE = process.env.API_BASE || 'http://127.0.0.1:8787/v1';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: 'Get the current local time for a city.',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  },
];

async function main() {
  const withToolResult = process.argv.includes('--with-tool-result');

  const messages = [
    { role: 'system', content: 'You can use tools. Decide whether to call a tool or answer directly.' },
    { role: 'user', content: 'What is the weather in Paris right now?' },
  ];

  if (withToolResult) {
    messages.push(
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_demo_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city": "Paris"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_demo_1', content: '{"city":"Paris","temp_c":22,"condition":"sunny"}' }
    );
  }

  console.log(`→ sending to ${BASE}/chat/completions … (waiting for a human)`);
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'human-proxy', messages, tools: TOOLS }),
  });

  const data = await res.json();
  console.log(`← HTTP ${res.status}`);
  console.log(JSON.stringify(data, null, 2));

  const msg = data.choices?.[0]?.message;
  if (msg?.tool_calls?.length) {
    console.log('\n🤖 Assistant wants to call tools:');
    for (const tc of msg.tool_calls) {
      console.log(`  - ${tc.function.name}(${tc.function.arguments})`);
    }
    console.log('\nNext step: run `node examples/toolcall.js --with-tool-result`');
  }
}

main().catch((err) => {
  console.error('✗', err.message);
  process.exit(1);
});
