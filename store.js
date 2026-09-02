'use strict';

/**
 * In-memory request store with optional JSON persistence.
 *
 * Persistence: only requests that reached a terminal state (completed /
 * rejected / dismissed) are written to disk, so after a restart the web UI
 * still shows history. A `pending` request is never persisted — if the server
 * restarts its client connection is gone anyway.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildResponse } = require('./response');

const DATA_FILE = path.join(__dirname, 'data', 'requests.json');

class Store {
  constructor() {
    this.requests = new Map(); // id -> record
    this.listeners = new Set(); // fn(record) on every change
    this._saveTimer = null;
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const arr = JSON.parse(raw);
      for (const r of arr) this.requests.set(r.id, r);
    } catch {
      /* no history yet */
    }
  }

  _persist() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        const terminal = [...this.requests.values()].filter(
          (r) => r.status !== 'pending'
        );
        fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
        const tmp = DATA_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(terminal, null, 2));
        fs.renameSync(tmp, DATA_FILE);
      } catch (err) {
        console.error('[store] persist failed:', err.message);
      }
    }, 200);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _bump(record) {
    this._persist();
    for (const fn of this.listeners) fn(record);
  }

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
    this._bump(record);
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
      this._bump(r);
    }
  }

  respond(id, { content, tool_calls }) {
    const r = this.requests.get(id);
    if (!r || r.status !== 'pending') return r;
    r.status = 'completed';
    r.respondedAt = new Date().toISOString();
    r.error = null;
    r.response = buildResponse(r, { content, tool_calls });
    this._bump(r);
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
    this._bump(r);
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
    this._bump(r);
    return r;
  }
}

const store = new Store();

module.exports = store;
