#!/usr/bin/env node
'use strict';

/**
 * Streaming client demo.
 *
 * Sends `stream: true` and parses the SSE response line by line. The server
 * does NOT fake a token stream: as soon as the human answers in the web UI,
 * the whole assistant turn arrives as one chunk, then `[DONE]`.
 *
 * Usage:  node examples/stream.js "Tell me a joke"
 */

const BASE = process.env.API_BASE || 'http://127.0.0.1:8787/v1';

async function main() {
  const text = process.argv.slice(2).join(' ') || 'Tell me a joke.';

  console.log(`→ streaming to ${BASE}/chat/completions … (waiting for a human)`);
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      model: 'human-proxy',
      stream: true,
      messages: [{ role: 'user', content: text }],
    }),
  });

  console.log(`← HTTP ${res.status}\n`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          console.log('\n[DONE]');
          return;
        }
        try {
          const chunk = JSON.parse(payload);
          if (chunk.error) {
            console.log('⚠ server error:', chunk.error.message);
            return;
          }
          const choice = chunk.choices?.[0];
          const delta = choice?.delta || {};
          if (delta.content) process.stdout.write(delta.content);
          if (delta.tool_calls) {
            console.log('\n[TOOL CALLS] ' + JSON.stringify(delta.tool_calls, null, 2));
          }
          if (choice?.finish_reason) console.log(`\n[finish_reason: ${choice.finish_reason}]`);
          if (chunk.usage) console.log(`[usage: ${JSON.stringify(chunk.usage)}]`);
        } catch {
          /* non-JSON SSE frame, ignore */
        }
      }
    }
  }
}

main().catch((err) => {
  console.error('✗', err.message);
  process.exit(1);
});
