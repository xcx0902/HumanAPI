'use strict';

/**
 * In-memory request store with append-only JSONL persistence.
 *
 * Persistence: only requests that reached a terminal state (completed /
 * rejected / dismissed) are written to disk, so after a restart the web UI
 * still shows history. A `pending` request is never persisted — if the server
 * restarts its client connection is gone anyway.
 *
 * File format (data/requests.jsonl): one compact JSON record per line. A
 * finished request is APPENDED as a single line, so answering a request costs
 * O(one record) instead of re-serializing the whole history. Writes run on a
 * serialized async queue and never block the event loop; graceful shutdown
 * awaits the queue via flush(). The file is rewritten whole only on Clear.
 *
 * Older builds used `data/requests.json` (pretty-printed JSON array, later
 * JSONL). If that file exists and no `.jsonl` file does, it is loaded and
 * migrated to `data/requests.jsonl` on boot, then the old file is removed.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { buildResponse } = require('./response');

const DATA_FILE = path.join(__dirname, 'data', 'requests.jsonl');
/** Pre-rename location used by older builds; migrated once on boot. */
const LEGACY_FILE = path.join(__dirname, 'data', 'requests.json');

class Store {
  constructor() {
    this.requests = new Map(); // id -> record
    this.listeners = new Set(); // fn(record) on every change
    // Serialized queue of async file writes (appends + rewrites), so writes
    // never interleave and shutdown can await the tail.
    this._writeQueue = Promise.resolve();
    this._load();
  }

  // ------------------------------------------------------------ loading

  _load() {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

    // 1. Current file (JSONL). A legacy JSON-array body found inside it is
    //    converted to JSONL in place.
    const raw = this._readMaybe(DATA_FILE);
    if (raw !== null) {
      if (this._absorb(raw)) {
        console.log('[store] converted legacy JSON-array history to JSONL');
        this._writeFileSync(this._jsonlBody());
      }
      return;
    }

    // 2. Pre-rename data/requests.json (JSONL or legacy array) — migrate once.
    const legacyRaw = this._readMaybe(LEGACY_FILE);
    if (legacyRaw === null) return; // no history yet
    console.log(`[store] migrating history from ${LEGACY_FILE} → ${DATA_FILE}…`);
    this._absorb(legacyRaw);
    try {
      this._writeFileSync(this._jsonlBody());
      fs.unlinkSync(LEGACY_FILE);
      console.log('[store] migration complete');
    } catch (err) {
      console.error(`[store] migration failed — keeping ${LEGACY_FILE}:`, err.message);
    }
  }

  _readMaybe(file) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Parse `raw` (JSONL, or a legacy pretty-printed JSON array) into the store.
   * @returns {boolean} true when the text was a legacy array (caller should
   *   rewrite the file in JSONL form)
   */
  _absorb(raw) {
    if (!raw.trim()) return false;
    const legacy = raw.trimStart().startsWith('[');
    const records = legacy ? this._parseLegacy(raw) : this._parseJsonl(raw);
    if (records === null) return false; // unreadable history already logged
    for (const r of records) {
      if (r && typeof r.id === 'string') this.requests.set(r.id, r);
    }
    return legacy;
  }

  _parseLegacy(raw) {
    try {
      const arr = JSON.parse(raw);
      console.log('[store] detected legacy JSON-array history — converting to JSONL…');
      return Array.isArray(arr) ? arr : [];
    } catch (err) {
      console.error('[store] legacy history unreadable:', err.message);
      return null;
    }
  }

  _parseJsonl(raw) {
    const records = [];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (r && r.id) records.push(r);
      } catch (err) {
        // A torn final line (crash mid-append) is tolerated and skipped.
        console.error(`[store] skipping unreadable history line ${i + 1}: ${err.message}`);
      }
    }
    return records;
  }

  // ---------------------------------------------------------- writing

  /** Compact JSONL text of every terminal record currently in memory. */
  _jsonlBody() {
    const terminal = [...this.requests.values()].filter(
      (r) => r.status !== 'pending'
    );
    return terminal.map((r) => JSON.stringify(r)).join('\n') + (terminal.length ? '\n' : '');
  }

  _writeFileSync(body) {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, DATA_FILE);
  }

  /** Append one terminal record as a new line (async, ordered). */
  _enqueueAppend(record) {
    const line = JSON.stringify(record) + '\n';
    this._writeQueue = this._writeQueue
      .then(() => fsp.appendFile(DATA_FILE, line))
      .catch((err) => console.error('[store] append failed:', err.message));
  }

  /** Rewrite the whole file from the current terminal records (async, ordered). */
  _enqueueRewrite() {
    const body = this._jsonlBody();
    this._writeQueue = this._writeQueue
      .then(async () => {
        const tmp = DATA_FILE + '.tmp';
        await fsp.writeFile(tmp, body);
        await fsp.rename(tmp, DATA_FILE);
      })
      .catch((err) => console.error('[store] rewrite failed:', err.message));
  }

  /**
   * Resolve once every queued file write has hit disk. Graceful shutdown
   * awaits this so a request finished right before exit is never lost.
   * @returns {Promise<void>}
   */
  flush() {
    return this._writeQueue;
  }

  // ------------------------------------------------------------- events

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify(record) {
    for (const fn of this.listeners) fn(record);
  }

  // ------------------------------------------------------------- CRUD

  create({ body, stream, api }) {
    const kind = api === 'responses' ? 'responses' : 'chat';
    const id = (kind === 'responses' ? 'resp_' : 'chatcmpl-') + crypto.randomBytes(12).toString('hex');
    const record = {
      id,
      api: kind,
      status: 'pending',
      stream: !!stream,
      model: (body && body.model) || 'human-proxy',
      receivedAt: new Date().toISOString(),
      respondedAt: null,
      clientDisconnected: false,
      body, // the original OpenAI request body (messages, tools, stream, ...)
      response: null,
      error: null,
    };
    this.requests.set(id, record);
    // A pending request is never persisted — and nothing on disk changed, so
    // no file write is scheduled (parking a request used to rewrite the whole
    // history for nothing).
    this._notify(record);
    return record;
  }

  get(id) {
    return this.requests.get(id);
  }

  list() {
    return [...this.requests.values()].sort((a, b) =>
      b.receivedAt.localeCompare(a.receivedAt)
    );
  }

  markClientGone(id) {
    const r = this.requests.get(id);
    if (r && r.status === 'pending' && !r.clientDisconnected) {
      r.clientDisconnected = true;
      this._notify(r); // still pending → nothing to persist
    }
  }

  respond(id, { content, tool_calls }) {
    const r = this.requests.get(id);
    if (!r || r.status !== 'pending') return r;
    r.status = 'completed';
    r.respondedAt = new Date().toISOString();
    r.error = null;
    r.response = buildResponse(r, { content, tool_calls });
    this._enqueueAppend(r);
    this._notify(r);
    return r;
  }

  reject(id, message) {
    const r = this.requests.get(id);
    if (!r || r.status !== 'pending') return r;
    r.status = 'rejected';
    r.respondedAt = new Date().toISOString();
    r.response = null;
    r.error = {
      message: message || 'Request rejected by the human.',
      type: 'server_error',
      code: 'human_rejected',
    };
    this._enqueueAppend(r);
    this._notify(r);
    return r;
  }

  dismiss(id) {
    const r = this.requests.get(id);
    if (!r || r.status !== 'pending') return r;
    r.status = 'dismissed';
    r.respondedAt = new Date().toISOString();
    r.response = null;
    r.error = {
      message: 'Request dismissed by the human.',
      type: 'server_error',
      code: 'human_dismissed',
    };
    this._enqueueAppend(r);
    this._notify(r);
    return r;
  }

  /**
   * Delete every finished (completed / rejected / dismissed) request. Pending
   * requests are kept — their clients are still connected and waiting. The
   * history file is rewritten (empty if nothing finished remains) so the wipe
   * survives a restart.
   * @returns number of requests removed
   */
  clearHistory() {
    let cleared = 0;
    for (const [id, r] of this.requests) {
      if (r.status !== 'pending') {
        this.requests.delete(id);
        cleared++;
      }
    }
    if (cleared > 0) this._enqueueRewrite();
    return cleared;
  }
}

const store = new Store();

module.exports = store;
