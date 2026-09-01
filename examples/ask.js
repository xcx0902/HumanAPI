#!/usr/bin/env node
'use strict';

/**
 * Minimal OpenAI-compatible client: sends one chat completion request and
 * prints the reply. It will HANG until a human answers in the web UI
 * (http://127.0.0.1:8787). No OpenAI SDK needed — plain fetch.
 *
 * Usage:  node examples/ask.js "your question here"
 *         API_BASE=http://127.0.0.1:8787/v1 node examples/ask.js "hi"
 */

const BASE = process.env.API_BASE || 'http://127.0.0.1:8787/v1';

async function main() {
  const text = process.argv.slice(2).join(' ') || 'Hello there, human!';

  console.log(`→ sending to ${BASE}/chat/completions … (waiting for a human)`);
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'human-proxy',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: text },
      ],
    }),
  });

  const data = await res.json();
  console.log(`← HTTP ${res.status}`);
  console.log(JSON.stringify(data, null, 2));

  const msg = data.choices?.[0]?.message;
  if (msg?.tool_calls?.length) {
    console.log('\nAssistant emitted tool calls:');
    for (const tc of msg.tool_calls) {
      console.log(`  - ${tc.function.name}(${tc.function.arguments})`);
    }
  }
}

main().catch((err) => {
  console.error('✗', err.message);
  process.exit(1);
});
