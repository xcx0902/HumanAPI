#!/usr/bin/env node
'use strict';

/**
 * Human API — an OpenAI-compatible endpoint where a human plays the model.
 *
 *  - POST /v1/chat/completions  OpenAI Chat Completions (messages, tools, stream).
 *  - POST /v1/responses         OpenAI Responses API (input, tools, stream).
 *      Requests are parked ("kept alive") until a human answers them in the UI.
 *  - GET  /v1/models             fake model list so OpenAI clients are happy.
 *  - GET  /api/requests          admin: list all requests.
 *  - GET  /api/events            admin: SSE feed of live changes (drives the UI).
 *  - POST /api/requests/:id/respond   admin: human answer {content, tool_calls}.
 *  - POST /api/requests/:id/error     admin: reject the request with an error.
 *  - POST /api/requests/:id/dismiss   admin: drop the request with a 503.
 *  - POST /api/requests/clear         admin: wipe finished requests (history).
 *  - GET  /*                     static web UI.
 *
 * Zero dependencies: `node server.js` is all you need.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const store = require('./store');
const { buildStreamChunks, buildResponsesStreamEvents } = require('./response');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '8787', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MODELS = {
  object: 'list',
  data: [
    { id: 'human-proxy', object: 'model', created: 0, owned_by: 'human' },
  ],
};

/** id -> { res, stream } for every parked HTTP response */
const pending = new Map();

/** SSE connections currently watching /api/events (used for broadcasts) */
const eventClients = new Set();

// ---------------------------------------------------------------- helpers

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sseWrite(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** Push a terminal record to its parked client and close the connection. */
function deliver(record) {
  const parked = pending.get(record.id);
  if (!parked) return;
  pending.delete(record.id);

  const { res, stream } = parked;
  if (res.destroyed || res.writableEnded) return;

  const isResponses = record.api === 'responses';

  if (record.status === 'rejected' || record.status === 'dismissed') {
    const status = record.status === 'rejected' ? 500 : 503;
    const payload = { error: record.error };
    if (stream) {
      if (isResponses) {
        // Responses API reports failures as an `error` SSE event.
        sseWrite(res, 'error', { type: 'error', error: record.error });
      } else {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
      res.end();
    } else {
      sendJson(res, status, payload);
    }
    return;
  }

  if (stream) {
    if (isResponses) {
      for (const ev of buildResponsesStreamEvents(record, record.response)) {
        sseWrite(res, ev.event, ev.data);
      }
    } else {
      for (const chunk of buildStreamChunks(record, record.response)) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write('data: [DONE]\n\n');
    }
    res.end();
    return;
  }

  sendJson(res, 200, record.response);
}

// Deliver answers to parked clients as soon as the human responds.
store.onChange((record) => {
  if (record.status !== 'pending') deliver(record);
});

// ---------------------------------------------------------------- routes

async function handleIncoming(req, res, api) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, {
      error: {
        message: 'Request body is not valid JSON',
        type: 'invalid_request_error',
        param: null,
        code: null,
      },
    });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendJson(res, 400, {
      error: { message: 'Request body must be a JSON object', type: 'invalid_request_error' },
    });
  }

  if (api === 'chat') {
    if (!Array.isArray(body.messages)) {
      return sendJson(res, 400, {
        error: {
          message: '"messages" must be an array',
          type: 'invalid_request_error',
          param: 'messages',
          code: null,
        },
      });
    }
  } else {
    // Responses API: input is an array of items, or a plain text string.
    const input = body.input;
    if (input != null && typeof input !== 'string' && !Array.isArray(input)) {
      return sendJson(res, 400, {
        error: {
          message: '"input" must be a string or an array of items',
          type: 'invalid_request_error',
          param: 'input',
          code: null,
        },
      });
    }
  }

  const stream = body.stream === true;
  const record = store.create({ body, stream, api });

  if (stream) {
    // Send headers immediately so the client sees a live 200 response.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
  }

  pending.set(record.id, { res, stream });
  res.on('close', () => {
    if (!res.writableEnded) store.markClientGone(record.id);
  });

  // From here on the request just hangs. The human answers via the admin API,
  // store.respond()/reject()/dismiss() fires the onChange listener above, and
  // deliver() resolves this connection.
}

async function handleAdminAction(req, res, id, action) {
  const raw = await readBody(req);
  let parsed = {};
  if (raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { error: { message: 'Body is not valid JSON' } });
    }
  }

  const record = store.get(id);
  if (!record) return sendJson(res, 404, { error: { message: 'No such request' } });
  if (record.status !== 'pending') {
    return sendJson(res, 409, {
      error: { message: `Request is already ${record.status}` },
    });
  }

  if (action === 'respond') {
    const content = typeof parsed.content === 'string' && parsed.content.trim() !== ''
      ? parsed.content
      : null;

    let toolCalls;
    if (Array.isArray(parsed.tool_calls)) {
      toolCalls = [];
      for (const t of parsed.tool_calls) {
        const name = typeof t.name === 'string' ? t.name.trim() : '';
        if (!name) continue;
        let args = t.arguments;
        if (typeof args === 'string') {
          try {
            JSON.parse(args); // validate before handing it to the client
          } catch {
            return sendJson(res, 400, {
              error: {
                message: `arguments for tool "${name}" is not valid JSON`,
              },
            });
          }
        } else {
          args = JSON.stringify(args ?? {});
        }
        toolCalls.push({
          id: typeof t.id === 'string' ? t.id : null,
          name,
          arguments: args,
        });
      }
    }

    if (content === null && (!toolCalls || toolCalls.length === 0)) {
      return sendJson(res, 400, {
        error: { message: 'Provide "content" and/or "tool_calls"' },
      });
    }

    store.respond(id, { content, tool_calls: toolCalls });
    return sendJson(res, 200, store.get(id));
  }

  if (action === 'error') {
    const message =
      typeof parsed.message === 'string' && parsed.message.trim()
        ? parsed.message
        : 'Request rejected by the human.';
    store.reject(id, message);
    return sendJson(res, 200, store.get(id));
  }

  if (action === 'dismiss') {
    store.dismiss(id);
    return sendJson(res, 200, store.get(id));
  }

  sendJson(res, 400, { error: { message: `Unknown action "${action}"` } });
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  sseWrite(res, 'snapshot', store.list());
  eventClients.add(res);
  const off = store.onChange((record) => sseWrite(res, 'update', record));
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    off();
    eventClients.delete(res);
  });
}

/** Wipe the finished-request history and tell every open UI about it. */
function handleClear(req, res) {
  const cleared = store.clearHistory();
  const remaining = store.list();
  for (const c of eventClients) {
    try {
      sseWrite(c, 'cleared', remaining);
    } catch {
      /* connection already gone; its close handler removes it */
    }
  }
  sendJson(res, 200, { cleared, remaining: remaining.length });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function handleStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: { message: 'Bad path' } });
  }
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: { message: 'Forbidden' } });
  }
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: { message: 'Not found' } });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------- router

async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'POST' && p === '/v1/chat/completions') {
    return handleIncoming(req, res, 'chat');
  }
  if (req.method === 'POST' && p === '/v1/responses') {
    return handleIncoming(req, res, 'responses');
  }
  if (req.method === 'GET' && p === '/v1/models') return sendJson(res, 200, MODELS);
  if (req.method === 'GET' && p === '/api/events') return handleEvents(req, res);
  if (req.method === 'GET' && p === '/api/requests') return sendJson(res, 200, store.list());
  if (req.method === 'POST' && p === '/api/requests/clear') return handleClear(req, res);

  const admin = p.match(/^\/api\/requests\/([^/]+)\/(respond|error|dismiss)$/);
  if (admin && req.method === 'POST') {
    return handleAdminAction(req, res, decodeURIComponent(admin[1]), admin[2]);
  }

  const single = p.match(/^\/api\/requests\/([^/]+)$/);
  if (single && req.method === 'GET') {
    const record = store.get(decodeURIComponent(single[1]));
    return record ? sendJson(res, 200, record) : sendJson(res, 404, { error: { message: 'No such request' } });
  }

  if (req.method === 'GET') return handleStatic(req, res, p);

  sendJson(res, 404, { error: { message: 'Route not found', type: 'invalid_request_error' } });
}

// ---------------------------------------------------------------- main

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('[server] handler error:', err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: { message: 'Internal server error', type: 'server_error' } });
    } else {
      res.destroy();
    }
  });
});

// A request parked waiting for a human must never be killed by a timeout.
server.requestTimeout = 0; // Node >=18 default is 300s; disable it.
server.headersTimeout = 60000;
server.keepAliveTimeout = 5000;

server.listen(PORT, HOST, () => {
  console.log('┌────────────────────────────────────────────────────────');
  console.log('│ 🧑‍💻 Human API — OpenAI-compatible endpoint, human answers');
  console.log(`│   Chat Completions:  http://${HOST}:${PORT}/v1/chat/completions`);
  console.log(`│   Responses API:     http://${HOST}:${PORT}/v1/responses`);
  console.log(`│   Web UI:            http://${HOST}:${PORT}/`);
  console.log('└────────────────────────────────────────────────────────');
});

// ------------------------------------------------------- graceful shutdown

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[server] ${signal} received — shutting down…`);

  // 1. Dismiss still-parked requests so their clients get a proper error
  //    (deliver() writes an error frame / JSON and closes the connection)
  //    instead of a silent dead connection. Dismissed records are terminal,
  //    so they are persisted like any other finished request.
  const parked = store.list().filter((r) => r.status === 'pending');
  if (parked.length > 0) {
    console.log(`[server] dismissing ${parked.length} parked request(s)…`);
    for (const r of parked) store.dismiss(r.id);
  }

  // 2. Wait for every queued file write (writes are async now) to hit disk,
  //    so the very last finished request is never lost.
  await store.flush();

  // 3. Close the listener, then exit once connections settle.
  server.close(() => {
    console.log('[server] stopped cleanly. history saved to data/requests.json');
    process.exit(0);
  });

  // Idle keep-alive / SSE connections would hold server.close() open
  // (keepAliveTimeout is 5s) — don't make shutdown wait on them.
  const force = setTimeout(() => {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    process.exit(0);
  }, 2000);
  force.unref();
}

process.on('SIGINT', () => shutdown('SIGINT (Ctrl+C)'));
process.on('SIGTERM', () => shutdown('SIGTERM (kill)'));
