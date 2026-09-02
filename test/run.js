#!/usr/bin/env node
'use strict';

/**
 * Zero-dependency integration test suite for Human API.
 *
 * For every run it copies the server into a throwaway temp directory (own
 * `data/`), so your real history is never touched. It boots real server
 * processes and exercises, end to end:
 *
 *   1. Chat Completions — plain JSON, SSE stream + [DONE], tool calls
 *   2. Responses API — plain JSON, SSE event stream, tool calls
 *   3. Admin actions — respond / error (500) / dismiss (503)
 *   4. Persistence — append-only data/requests.jsonl across restarts
 *   5. Clear history — wipes finished, keeps pending, survives restart
 *   6. Migration — legacy data/requests.json → requests.jsonl on boot
 *   7. Graceful shutdown — parked clients get a proper error, history flushed
 *
 * Run locally with `node test/run.js`; GitHub Actions runs the same command.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCES = ['server.js', 'store.js', 'response.js'];
const DATA_FILE = path.join('data', 'requests.jsonl');
const LEGACY_FILE = path.join('data', 'requests.json');

const results = [];
function ok(cond, name, extra) {
  results.push({ pass: !!cond, name });
  if (cond) console.log(`  \u2713 ${name}`);
  else console.error(`  \u2717 ${name}${extra ? ' — ' + extra : ''}`);
}
async function waitFor(fn, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* keep polling */ }
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- helpers

function checkSyntax() {
  console.log('syntax checks:');
  const files = [...SOURCES, 'public/app.js', 'test/run.js'];
  let all = true;
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { cwd: ROOT });
    const pass = r.status === 0;
    ok(pass, `node --check ${f}`, pass ? '' : String(r.stderr));
    all = all && pass;
  }
  return all;
}

function makeServerDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'humanapi-test-'));
  for (const f of SOURCES) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
  return dir;
}

function randomPort() {
  return 21000 + Math.floor(Math.random() * 8000);
}

/** Boot the server in `dir` and resolve once /v1/models answers. */
async function bootServer(dir, port) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  try {
    await waitFor(
      async () => {
        if (child.exitCode !== null) throw new Error('server exited early');
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`);
        return r.ok;
      },
      'server ready',
      8000
    );
  } catch (err) {
    child.kill('SIGKILL');
    throw new Error(`${err.message}\n--- server output ---\n${output}`);
  }
  child.__out = output;
  return child;
}

/** Stop the server and resolve with its exit info. */
function stopServer(child, signal = 'SIGTERM') {
  return new Promise((resolve) => {
    let done = false;
    const finish = (info) => {
      if (!done) { done = true; resolve(info); }
    };
    child.once('exit', (code, sig) => finish({ code, signal: sig }));
    try { child.kill(signal); } catch { /* already dead */ }
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* dead */ }
      finish({ code: null, signal: 'SIGKILL-fallback' });
    }, 4000).unref();
  });
}

function makeClient(port) {
  const base = `http://127.0.0.1:${port}`;
  return {
    async admin(pathname, body) {
      const res = await fetch(base + pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const text = await res.text();
      return { status: res.status, text };
    },
    async list() {
      const res = await fetch(base + '/api/requests');
      return res.json();
    },
    async waitPending(what = 'pending request') {
      return waitFor(async () => {
        const list = await this.list();
        return list.find((r) => r.status === 'pending') || null;
      }, what);
    },
    parkChat(marker, { stream = false, tools } = {}) {
      const body = {
        model: 'ci-model',
        messages: [{ role: 'user', content: marker }],
        ...(tools ? { tools } : {}),
        ...(stream ? { stream: true } : {}),
      };
      return {
        marker,
        promise: fetch(base + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      };
    },
    parkResponses(marker, { stream = false, tools } = {}) {
      const body = {
        model: 'ci-model',
        input: marker,
        ...(tools ? { tools } : {}),
        ...(stream ? { stream: true } : {}),
      };
      return {
        marker,
        promise: fetch(base + '/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      };
    },
    async respondTo(parked, answer) {
      const rec = await waitFor(async () => {
        const list = await this.list();
        return list.find((r) => r.status === 'pending' && this._match(r, parked.marker)) || null;
      }, `pending "${parked.marker}"`);
      const action = answer.error ? '/error' : answer.dismiss ? '/dismiss' : '/respond';
      const body = answer.error
        ? { message: answer.error.message }
        : answer.dismiss
          ? {}
          : { content: answer.content, tool_calls: answer.tool_calls };
      const r = await this.admin(`/api/requests/${rec.id}${action}`, body);
      const resp = await parked.promise;
      const text = await resp.text();
      return { adminStatus: r.status, status: resp.status, text };
    },
    _match(r, marker) {
      const m = r.body && (r.body.messages || r.body.input);
      if (Array.isArray(m)) return m.some((x) => x && x.content === marker);
      return m === marker;
    },
  };
}

function fileLines(dir, file = DATA_FILE) {
  try {
    return fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------- scenarios

async function scenarioWireFormats(client) {
  console.log('wire formats:');

  // 1. chat plain
  let p = client.parkChat('chat-plain');
  let out = await client.respondTo(p, { content: 'hello human' });
  ok(out.status === 200 && out.adminStatus === 200, 'chat plain: 200 on both sides');
  const chat = JSON.parse(out.text);
  ok(chat.object === 'chat.completion' && chat.choices[0].message.content === 'hello human' &&
     chat.choices[0].finish_reason === 'stop', 'chat plain: assistant content + finish_reason stop');

  // 2. chat stream
  p = client.parkChat('chat-stream', { stream: true });
  out = await client.respondTo(p, { content: 'streamed words' });
  ok(out.status === 200, 'chat stream: HTTP 200');
  const chatEvents = out.text.split('\n\n').filter((l) => l.startsWith('data: '));
  ok(chatEvents.length >= 2 && chatEvents[chatEvents.length - 1].includes('[DONE]'),
     'chat stream: ends with data: [DONE]');
  const firstChunk = JSON.parse(chatEvents[0].slice(6));
  ok(firstChunk.object === 'chat.completion.chunk', 'chat stream: first event is a completion chunk');

  // 3. responses plain
  p = client.parkResponses('resp-plain');
  out = await client.respondTo(p, { content: 'resp answer' });
  ok(out.status === 200, 'responses plain: HTTP 200');
  const resp = JSON.parse(out.text);
  ok(resp.object === 'response' && resp.output[0].type === 'message' &&
     resp.output[0].content[0].type === 'output_text' &&
     resp.output[0].content[0].text === 'resp answer', 'responses plain: message + output_text');

  // 4. responses stream
  p = client.parkResponses('resp-stream', { stream: true });
  out = await client.respondTo(p, { content: 'resp stream answer' });
  ok(out.status === 200 && !out.text.includes('[DONE]'), 'responses stream: 200, no [DONE] sentinel');
  const need = ['response.created', 'response.in_progress', 'response.output_item.added',
                'response.output_text.delta', 'response.output_text.done', 'response.completed'];
  const have = need.filter((ev) => out.text.includes(`event: ${ev}`));
  ok(have.length === need.length, 'responses stream: full event sequence',
     `missing: ${need.filter((e) => !have.includes(e)).join(', ')}`);

  // 5. tool call (chat)
  p = client.parkChat('chat-tool', { tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }] });
  out = await client.respondTo(p, {
    tool_calls: [{ name: 'get_weather', arguments: '{"city":"paris"}' }],
  });
  const tooled = JSON.parse(out.text);
  const tc = tooled.choices[0].message.tool_calls;
  ok(Array.isArray(tc) && tc[0].function.name === 'get_weather' &&
     tc[0].function.arguments.includes('paris') && tooled.choices[0].finish_reason === 'tool_calls',
     'chat tool call: emitted with arguments + finish_reason tool_calls');

  // 6. reject → 500 human_rejected
  p = client.parkChat('chat-reject');
  out = await client.respondTo(p, { error: { message: 'no thanks' } });
  ok(out.status === 500, 'reject: HTTP 500');
  ok(JSON.parse(out.text).error.code === 'human_rejected', 'reject: error code human_rejected');

  // 7. dismiss → 503 human_dismissed
  p = client.parkChat('chat-dismiss');
  out = await client.respondTo(p, { dismiss: true });
  ok(out.status === 503, 'dismiss: HTTP 503');
  ok(JSON.parse(out.text).error.code === 'human_dismissed', 'dismiss: error code human_dismissed');
}

async function scenarioPersistence(client, dir) {
  console.log('persistence & restart:');
  const list = await client.list();
  const terminal = list.filter((r) => r.status !== 'pending').length;
  ok(terminal >= 7, `at least 7 terminal records so far (got ${terminal})`);
  await waitFor(() => fileLines(dir) === terminal, `file has ${terminal} lines`, 5000);
  ok(true, `data/requests.jsonl holds ${terminal} line(s), one per finished request`);

  // two more answers then check the file again
  let p = client.parkChat('persist-a');
  await client.respondTo(p, { content: 'a' });
  p = client.parkChat('persist-b');
  await client.respondTo(p, { content: 'b' });
  await waitFor(() => fileLines(dir) === terminal + 2, 'append of two more lines', 5000);
  const ids = fs.readFileSync(path.join(dir, DATA_FILE), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l).id);
  ok(new Set(ids).size === ids.length, 'no duplicate ids in history file');
}

async function scenarioRestart(client, dir, prevTerminal) {
  console.log('after restart:');
  await sleep(200);
  const list = await client.list();
  ok(list.filter((r) => r.status !== 'pending').length === prevTerminal,
     `history reloaded from disk (${prevTerminal} terminal records)`);
  const p = client.parkChat('after-restart');
  await client.respondTo(p, { content: 'restarted' });
  await waitFor(() => fileLines(dir) === prevTerminal + 1, 'file grew after restart', 5000);
  ok(true, 'new answers append after restart without duplicating old ones');
}

async function scenarioClear(client, dir, port) {
  console.log('clear history:');
  const finished = (await client.list()).filter((r) => r.status !== 'pending').length;
  const p = client.parkChat('keep-me-pending');
  p.promise.catch(() => {}); // its connection dies when we SIGKILL the server below
  await client.waitPending('the parked request');
  const res = await fetch(`http://127.0.0.1:${port}/api/requests/clear`, { method: 'POST' });
  const clr = await res.json();
  ok(clr.cleared === finished && clr.remaining === 1,
     `clear removed ${clr.cleared} finished, kept ${clr.remaining} pending`);
  await waitFor(() => fs.statSync(path.join(dir, DATA_FILE)).size === 0, 'file emptied', 5000);
  const after = await client.list();
  ok(after.length === 1 && after[0].status === 'pending', 'only the pending request remains in memory');
}

async function scenarioMigration(port) {
  console.log('legacy migration:');
  const dir = makeServerDir();
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const rec = (id) => ({
    id, api: 'chat', status: 'completed', stream: false, model: 'old',
    receivedAt: '2026-01-01T00:00:00.000Z', respondedAt: '2026-01-01T00:00:01.000Z',
    clientDisconnected: false,
    body: { model: 'old', messages: [{ role: 'user', content: 'legacy ' + id }] },
    response: {}, error: null,
  });
  fs.writeFileSync(path.join(dir, LEGACY_FILE), JSON.stringify([rec('old-a'), rec('old-b')], null, 2));
  const server = await bootServer(dir, port);
  const client = makeClient(port);
  await waitFor(() => fs.existsSync(path.join(dir, DATA_FILE)), 'requests.jsonl created');
  const list = await client.list();
  ok(list.length === 2 && list.every((r) => r.id.startsWith('old-')), 'legacy records loaded');
  ok(!fs.existsSync(path.join(dir, LEGACY_FILE)), 'legacy requests.json removed after migration');
  ok(fileLines(dir) === 2, 'migrated file is JSONL with 2 lines');
  const exit = await stopServer(server);
  ok(exit.code === 0, 'migrated server stops cleanly');
  fs.rmSync(dir, { recursive: true, force: true });
}

async function scenarioGracefulDismissal(port) {
  console.log('graceful shutdown:');
  const dir = makeServerDir();
  const server = await bootServer(dir, port);
  const client = makeClient(port);
  const p = client.parkChat('will-be-dismissed');
  await client.waitPending('the parked request');
  const exit = await stopServer(server); // SIGTERM
  ok(exit.code === 0, 'server exits 0 on SIGTERM');
  const resp = await p.promise;
  const text = await resp.text();
  ok(resp.status === 503 && JSON.parse(text).error.code === 'human_dismissed',
     'parked client receives 503 human_dismissed instead of a dead connection');
  await waitFor(() => fileLines(dir) === 1, 'dismissed record persisted', 5000);
  ok(true, 'dismissed record flushed to disk before exit');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------- main

async function main() {
  console.log('== Human API integration tests ==\n');
  let failed = false;
  let serverA = null;
  let dirA = null;
  let dirB = null;
  let serverB = null;
  try {
    if (!checkSyntax()) return 1;

    // --- fresh instance: wire formats + persistence ---
    dirA = makeServerDir();
    const portA = randomPort();
    serverA = await bootServer(dirA, portA);
    const clientA = makeClient(portA);
    await scenarioWireFormats(clientA);
    await scenarioPersistence(clientA, dirA);

    // --- graceful restart: history must survive ---
    const terminalBefore = (await clientA.list()).filter((r) => r.status !== 'pending').length;
    const exitA = await stopServer(serverA);
    serverA = null;
    ok(exitA.code === 0, 'first instance stops cleanly (exit 0)');
    dirB = dirA; // same data dir → restart
    serverB = await bootServer(dirB, portA);
    const clientB = makeClient(portA);
    await scenarioRestart(clientB, dirB, terminalBefore);

    // --- clear semantics ---
    await scenarioClear(clientB, dirB, portA);
    const exitB = await stopServer(serverB, 'SIGKILL'); // simulate crash
    serverB = null;
    ok(exitB.signal === 'SIGKILL', 'second instance killed (crash simulation)');

    // --- after crash+restart: cleared history stays cleared ---
    const serverC = await bootServer(dirB, portA);
    const clientC = makeClient(portA);
    await sleep(200);
    const listC = await clientC.list();
    ok(listC.length === 0, 'after crash + restart history is empty (clear was persisted)');
    const exitC = await stopServer(serverC);
    ok(exitC.code === 0, 'third instance stops cleanly');
    fs.rmSync(dirB, { recursive: true, force: true });
    dirB = null;

    // --- independent dirs for migration / shutdown tests ---
    await scenarioMigration(randomPort());
    await scenarioGracefulDismissal(randomPort());
  } catch (err) {
    failed = true;
    console.error('\nTEST CRASH:', err && err.stack ? err.stack : err);
  } finally {
    for (const s of [serverA, serverB]) {
      if (s) { try { s.kill('SIGKILL'); } catch { /* gone */ } }
    }
    for (const d of [dirA, dirB]) {
      if (d) fs.rmSync(d, { recursive: true, force: true });
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (failed || passed !== total) {
    console.log('FAILED');
    return 1;
  }
  console.log('ALL TESTS PASSED');
  return 0;
}

main().then((code) => process.exit(code));
