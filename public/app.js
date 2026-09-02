'use strict';

/* Human API control-room UI: live request list + respond-to-request panel. */

const state = {
  requests: [],
  selectedId: null,
  filter: 'all',
};

const $ = (sel) => document.querySelector(sel);

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));

const STATUS_LABEL = {
  pending: 'pending',
  completed: 'done',
  rejected: 'rejected',
  dismissed: 'dismissed',
  client_gone: 'client gone',
};

/** Which OpenAI endpoint a record came from (old records are chat). */
function apiLabelOf(r) {
  return r.api === 'responses' ? 'responses' : 'chat';
}

function timeAgo(iso) {
  if (!iso) return '';
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return data;
}

// ------------------------------------------------------------- live updates

function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('snapshot', (e) => {
    state.requests = JSON.parse(e.data);
    setConn(true);
    renderAll();
  });
  es.addEventListener('update', (e) => {
    const rec = JSON.parse(e.data);
    const i = state.requests.findIndex((r) => r.id === rec.id);
    if (i === -1) state.requests.unshift(rec);
    else state.requests[i] = rec;
    renderAll();
  });
  es.addEventListener('cleared', (e) => {
    state.requests = JSON.parse(e.data); // whatever is left (pending requests)
    renderAll();
  });
  es.onerror = () => {
    setConn(false);
    // EventSource auto-reconnects; when it reopens we get a fresh snapshot.
  };
}

function setConn(ok) {
  $('#conn-dot').className = 'dot ' + (ok ? 'ok' : ok === false ? 'err' : '');
  $('#conn-text').textContent = ok ? 'connected' : 'reconnecting…';
}

// ------------------------------------------------------------- list

function filtered() {
  if (state.filter === 'all') return state.requests;
  if (state.filter === 'pending')
    return state.requests.filter((r) => r.status === 'pending');
  if (state.filter === 'completed')
    return state.requests.filter((r) => r.status === 'completed');
  return state.requests.filter((r) => r.status === 'rejected' || r.status === 'dismissed');
}

// --------------------------------------------------- transcripts (per wire API)

/** Content that may be a string, an array of content parts, or null. */
function textOfParts(parts) {
  if (parts == null) return '';
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => (p && typeof p === 'object' ? p.text ?? '' : String(p)))
    .join('');
}

function textOf(m) {
  return textOfParts(m?.content);
}

/**
 * The message transcript of a request. Chat requests already carry an array of
 * `messages`; Responses-API requests carry `instructions` + `input` items,
 * which are projected onto the same message shape so everything downstream
 * (folding, previews, tool-call blocks) can stay generic:
 *   instructions           → system message
 *   message item           → message with its content text
 *   function_call item     → assistant message with a tool_calls entry
 *   function_call_output   → role 'tool' message (the tool's result)
 */
function threadOf(r) {
  const body = r?.body;
  if (!body) return [];
  if (r.api !== 'responses') {
    return Array.isArray(body.messages) ? body.messages : [];
  }

  const out = [];
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    out.push({ role: 'system', content: body.instructions });
  }
  let input = body.input;
  if (typeof input === 'string') input = [{ type: 'message', role: 'user', content: input }];
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'message') {
        out.push({ role: item.role || 'user', content: textOfParts(item.content) });
      } else if (item.type === 'function_call') {
        out.push({
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: item.call_id || item.id || null,
              type: 'function',
              function: {
                name: item.name || '(function)',
                arguments:
                  typeof item.arguments === 'string'
                    ? item.arguments
                    : JSON.stringify(item.arguments ?? {}),
              },
            },
          ],
        });
      } else if (item.type === 'function_call_output') {
        out.push({
          role: 'tool',
          tool_call_id: item.call_id || '',
          content:
            typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
        });
      }
    }
  }
  return out;
}

function previewOf(r) {
  const msgs = threadOf(r);
  const last = msgs[msgs.length - 1];
  if (!last) return '(no messages)';
  const content = textOf(last).trim();
  if (content) return content;
  if (last.tool_calls?.length) {
    const names = last.tool_calls.map((t) => (t.function || t).name).filter(Boolean);
    return `🔧 ${names.join(', ')}`;
  }
  return `(${last.role} message)`;
}

function renderList() {
  const list = $('#request-list');
  const items = filtered();
  if (items.length === 0) {
    list.innerHTML = `<div class="empty-list">Nothing here yet. Send a request to
      <code class="kbd">/v1/chat/completions</code> or <code class="kbd">/v1/responses</code>
      and it will show up.</div>`;
    return;
  }
  list.innerHTML = items
    .map((r) => {
      const badges = [`<span class="badge ${r.status}">${STATUS_LABEL[r.status] || r.status}</span>`];
      badges.push(`<span class="badge kind">${apiLabelOf(r)}</span>`);
      if (r.stream) badges.push('<span class="badge stream">stream</span>');
      if (r.clientDisconnected) badges.push('<span class="badge client_gone">client gone</span>');
      return `<div class="req ${r.id === state.selectedId ? 'selected' : ''}" data-id="${esc(r.id)}">
        <div class="req-top">
          <span class="req-id">${esc(r.id)}</span>
          ${badges.join('')}
        </div>
        <div class="req-preview">${esc(previewOf(r))}</div>
        <div class="req-meta">
          <span>${esc(r.model)}</span>
          <span>${timeAgo(r.receivedAt)}</span>
          ${r.respondedAt ? `<span>answered ${timeAgo(r.respondedAt)}</span>` : ''}
        </div>
      </div>`;
    })
    .join('');

  list.querySelectorAll('.req').forEach((el) => {
    el.addEventListener('click', () => {
      state.selectedId = el.dataset.id;
      renderAll();
    });
  });

  const pending = state.requests.filter((r) => r.status === 'pending').length;
  $('#queue-count').textContent = pending ? `${pending} waiting` : 'queue empty';
}

// ------------------------------------------------------------- detail

/**
 * Per-request fold state. A message folds when the user toggles it, or by
 * default when it is a system prompt / long enough to hog the panel. The
 * default only applies until the user explicitly toggles that message.
 */
const FOLD_PREVIEW_CHARS = 240;
const FOLD_DEFAULT_CHARS = 600;
const foldOverride = new Map(); // requestId -> Map(msgIdx -> bool: collapsed)

function bodyTextOf(m) {
  const parts = [];
  const content = textOf(m);
  if (content) parts.push(content);
  for (const tc of m.tool_calls || []) {
    const fn = tc.function || tc;
    let args = fn.arguments;
    if (args && typeof args !== 'string') args = JSON.stringify(args);
    parts.push(`${fn.name || 'function'} ${args || '{}'}`);
  }
  return parts.join('\n');
}

function foldDefaultFor(rId, m) {
  return m.role === 'system' || bodyTextOf(m).length > FOLD_DEFAULT_CHARS;
}

function isFolded(rId, idx, m) {
  const per = foldOverride.get(rId);
  if (per && per.has(idx)) return per.get(idx);
  return foldDefaultFor(rId, m);
}

function toggleFold(rId, idx) {
  const r = state.requests.find((x) => x.id === rId);
  const m = threadOf(r)[idx];
  if (!m) return;
  const per = foldOverride.get(rId) || new Map();
  per.set(idx, !isFolded(rId, idx, m));
  foldOverride.set(rId, per);
}

function messageHtml(rId, m, idx) {
  const content = textOf(m);
  const text = bodyTextOf(m);
  const folded = text !== '' && isFolded(rId, idx, m);
  const hasBody = text !== '';

  let html = `<div class="msg msg-${esc(m.role)} ${folded ? 'msg-folded' : ''}">`;
  html += `<div class="msg-head" ${hasBody ? `data-fold-idx="${idx}"` : ''}>`;
  html += hasBody
    ? `<button class="msg-toggle" data-fold-idx="${idx}" aria-expanded="${!folded}"
         title="${folded ? 'Expand message' : 'Fold message'}">${folded ? '▸' : '▾'}</button>`
    : `<span class="msg-toggle msg-toggle-spacer"></span>`;
  html += `<span class="role">${esc(m.role)}</span>`;
  if (m.name) html += `<span>name: ${esc(m.name)}</span>`;
  if (m.tool_call_id) html += `<span>↳ ${esc(m.tool_call_id)}</span>`;
  html += `</div>`;

  if (folded) {
    const preview = text.length > FOLD_PREVIEW_CHARS
      ? text.slice(0, FOLD_PREVIEW_CHARS) + '…'
      : text;
    html += `<div class="msg-body msg-preview">${esc(preview)}</div>`;
    html += `<div class="fold-hint">folded · click header to expand</div>`;
  } else {
    if (content !== '') {
      html += `<div class="msg-content">${esc(content)}</div>`;
    }
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      html += `<div class="tool-calls">`;
      for (const tc of m.tool_calls) {
        const fn = tc.function || tc;
        let args = fn.arguments || '{}';
        if (typeof args !== 'string') args = JSON.stringify(args);
        try { args = JSON.stringify(JSON.parse(args), null, 2); } catch { /* keep raw */ }
        html += `<div class="tool-call">
          <div class="tool-call-head">🔧 ${esc(fn.name || 'function')} <code>${esc(tc.id || '')}</code></div>
          <pre>${esc(args)}</pre>
        </div>`;
      }
      html += `</div>`;
    }
  }
  html += `</div>`;
  return html;
}

function toolNamesOf(r) {
  const tools = r.body?.tools || [];
  return tools
    .map((t) => ((t.function || t).name || '').trim())
    .filter(Boolean);
}

/**
 * Tools the client declared, rendered as clickable name chips. Details
 * (description, parameter schema, strict flag) stay hidden until a name is
 * clicked, so a request with many/big tool definitions doesn't flood the
 * panel. Expansion state is remembered per request across re-renders.
 */
const toolOpen = new Set(); // "requestId:toolIdx"

function toolDetailOf(t) {
  const fn = t.function || t; // tolerate both nested and flat tool defs
  const name = fn.name || '(unnamed)';
  const desc = typeof fn.description === 'string' ? fn.description : '';

  let paramsPretty = null;
  if (fn.parameters != null) {
    try {
      paramsPretty = JSON.stringify(
        typeof fn.parameters === 'string' ? JSON.parse(fn.parameters) : fn.parameters,
        null,
        2
      );
    } catch {
      paramsPretty = String(fn.parameters);
    }
  }

  const meta = [];
  if (fn.strict !== undefined) meta.push(`strict: ${JSON.stringify(fn.strict)}`);
  if (t.type && t.type !== 'function') meta.push(`type: ${esc(t.type)}`);
  return { name, desc, paramsPretty, meta };
}

function toolsHtmlOf(r) {
  const tools = r.body?.tools || [];
  if (tools.length === 0) return '';
  const items = tools
    .map((t, i) => {
      const { name, desc, paramsPretty, meta } = toolDetailOf(t);
      const key = `${r.id}:${i}`;
      const open = toolOpen.has(key);
      return `<div class="tool-item">
        <button class="tool-chip" data-tool-idx="${i}" aria-expanded="${open}">
          <span class="tool-chevron">${open ? '▾' : '▸'}</span>🔧 ${esc(name)}
        </button>
        <div class="tool-detail" ${open ? '' : 'hidden'}>
          ${desc ? `<div class="tool-desc">${esc(desc)}</div>` : ''}
          ${meta.length ? `<div class="tool-meta">${meta.join(' · ')}</div>` : ''}
          ${paramsPretty ? `<div class="tool-params-title">parameters</div><pre class="tool-params">${esc(paramsPretty)}</pre>` : ''}
        </div>
      </div>`;
    })
    .join('');
  return `<div class="tools-available">
    <div class="tools-title">Tools the client declared — click a name for its details</div>
    ${items}
  </div>`;
}

/** Compact, readable shape of what was sent to the client (shown when done). */
function responseSummaryOf(r) {
  const resp = r.response || {};
  if (r.api === 'responses') {
    const items = Array.isArray(resp.output) ? resp.output : [];
    const out = {};
    const content = items
      .filter((it) => it.type === 'message')
      .map((it) => textOfParts(it.content))
      .filter((t) => t.trim())
      .join('\n');
    const toolCalls = items
      .filter((it) => it.type === 'function_call')
      .map((it) => ({ id: it.id, call_id: it.call_id, name: it.name, arguments: it.arguments }));
    if (content) out.content = content;
    if (toolCalls.length) out.tool_calls = toolCalls;
    out.status = resp.status;
    if (resp.usage) out.usage = resp.usage;
    return out;
  }
  const msg = resp.choices?.[0]?.message || {};
  const out = {};
  if (msg.content != null) out.content = msg.content;
  if (msg.tool_calls) out.tool_calls = msg.tool_calls;
  const finishReason = resp.choices?.[0]?.finish_reason;
  if (finishReason) out.finish_reason = finishReason;
  if (resp.usage) out.usage = resp.usage;
  return out;
}

function renderDetail() {
  const detail = $('#detail');
  const r = state.requests.find((x) => x.id === state.selectedId);
  if (!r) {
    detail.innerHTML = `<div class="empty" id="empty-state">
      <div class="empty-icon">🫖</div>
      <p>No request selected.</p>
      <p class="muted">Requests sent to <code>/v1/chat/completions</code> or
      <code>/v1/responses</code> will appear here, waiting for you. You answer
      them — the client gets a perfect OpenAI-shaped response.</p>
    </div>`;
    return;
  }

  const badges = [`<span class="badge ${r.status}">${STATUS_LABEL[r.status] || r.status}</span>`];
  badges.push(`<span class="badge kind">${apiLabelOf(r)}</span>`);
  if (r.stream) badges.push('<span class="badge stream">stream</span>');
  if (r.clientDisconnected) badges.push('<span class="badge client_gone">client gone</span>');

  const thread = threadOf(r).map((m, i) => messageHtml(r.id, m, i)).join('');
  const toolsHtml = toolsHtmlOf(r);

  let bodyHtml;
  if (r.status === 'pending') {
    bodyHtml = respondFormHtml(r);
  } else if (r.status === 'completed') {
    bodyHtml = `<div class="finished-box">
      <p class="ok-title">✓ Responded ${fmtTime(r.respondedAt)} — connection closed</p>
      <pre>${esc(JSON.stringify(responseSummaryOf(r), null, 2))}</pre>
    </div>`;
  } else {
    bodyHtml = `<div class="finished-box">
      <p class="err-title">✕ ${r.status === 'rejected' ? 'Rejected' : 'Dismissed'} ${fmtTime(r.respondedAt)}</p>
      <pre>${esc(JSON.stringify(r.error, null, 2))}</pre>
    </div>`;
  }

  detail.innerHTML = `
    <div class="detail-head">
      <span class="req-id">${esc(r.id)}</span>
      ${badges.join('')}
    </div>
    <div class="meta-grid">
      <span>model <b>${esc(r.model)}</b></span>
      <span>endpoint <b>${apiLabelOf(r)}</b></span>
      <span>received <b>${fmtTime(r.receivedAt)}</b> (${timeAgo(r.receivedAt)})</span>
      <span>transport <b>${r.stream ? 'SSE stream' : 'HTTP JSON'}</b></span>
    </div>
    ${r.clientDisconnected ? `<div class="notice">⚠ The client disconnected before you answered.
      Responding still records the answer, but nobody will receive it.</div>` : ''}
    <div class="thread">${thread}</div>
    ${toolsHtml}
    <div class="banner-error" id="banner-error"></div>
    ${bodyHtml}
  `;

  // Fold/unfold messages: clicking the chevron or the message header toggles.
  const threadEl = detail.querySelector('.thread');
  threadEl.addEventListener('click', (e) => {
    const el = e.target.closest('[data-fold-idx]');
    if (!el) return;
    e.preventDefault();
    toggleFold(r.id, Number(el.dataset.foldIdx));
    renderDetail();
  });

  // Tool chips: clicking a declared tool's name reveals its details.
  const toolsEl = detail.querySelector('.tools-available');
  if (toolsEl) {
    toolsEl.addEventListener('click', (e) => {
      const chip = e.target.closest('.tool-chip');
      if (!chip) return;
      const key = `${r.id}:${Number(chip.dataset.toolIdx)}`;
      if (toolOpen.has(key)) toolOpen.delete(key);
      else toolOpen.add(key);
      renderDetail();
    });
  }

  if (r.status === 'pending') wireForm(r);
}

function respondFormHtml(r) {
  const toolNames = toolNamesOf(r);
  const datalist = toolNames.length
    ? `<datalist id="tool-names">${toolNames.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>`
    : '';
  return `
  <div class="respond-box">
    ${datalist}
    <span class="section-label">Assistant reply — plain text content</span>
    <textarea id="resp-content" rows="4"
      placeholder="What should the assistant say? Leave empty if it should call tools instead."></textarea>

    <div class="toolcalls-head">
      <span class="section-label" style="margin:0">Tool calls for the assistant to emit</span>
      <button id="add-toolcall" class="btn btn-ghost btn-sm">+ Add tool call</button>
    </div>
    <div id="toolcall-rows"></div>

    <div class="error-zone" id="error-zone">
      <input type="text" id="error-msg" placeholder="Error message to send to the client…">
      <button id="send-error" class="btn btn-danger">Send error</button>
      <button id="cancel-error" class="btn btn-ghost">Cancel</button>
    </div>

    <div class="actions">
      <button id="send-response" class="btn btn-primary">Send response</button>
      <button id="toggle-error" class="btn btn-ghost">Send error instead</button>
      <button id="dismiss" class="btn btn-ghost">Dismiss</button>
    </div>
  </div>`;
}

function wireForm(r) {
  const rows = $('#toolcall-rows');
  const toolNames = toolNamesOf(r);

  function addRow() {
    const div = document.createElement('div');
    div.className = 'toolcall-row';
    div.innerHTML = `
      <div class="row-head">
        <input type="text" class="tc-name" list="tool-names" placeholder="tool name">
        <button class="tc-remove btn btn-ghost btn-sm" title="Remove">✕</button>
      </div>
      <textarea class="tc-args" rows="3" placeholder='JSON arguments, e.g. {"city": "Paris"}'></textarea>`;
    div.querySelector('.tc-remove').addEventListener('click', () => div.remove());
    rows.appendChild(div);
    div.querySelector('.tc-name').focus();
  }

  $('#add-toolcall').addEventListener('click', addRow);

  function showError(msg) {
    const b = $('#banner-error');
    b.textContent = msg;
    b.classList.add('show');
  }
  function clearError() {
    $('#banner-error').classList.remove('show');
  }

  $('#send-response').addEventListener('click', async () => {
    clearError();
    const content = $('#resp-content').value.trim() || null;
    const tool_calls = [...rows.querySelectorAll('.toolcall-row')]
      .map((row) => ({
        name: row.querySelector('.tc-name').value.trim(),
        arguments: row.querySelector('.tc-args').value.trim(),
      }))
      .filter((t) => t.name);

    for (const t of tool_calls) {
      try {
        JSON.parse(t.arguments || '{}');
      } catch {
        showError(`Tool "${t.name}": arguments are not valid JSON.`);
        return;
      }
    }
    if (!content && tool_calls.length === 0) {
      showError('Type a reply, add a tool call, or both.');
      return;
    }

    const payload = {};
    if (content) payload.content = content;
    if (tool_calls.length) payload.tool_calls = tool_calls;

    try {
      await api(`/api/requests/${encodeURIComponent(r.id)}/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      // SSE will push the completed record; re-render optimistically too.
    } catch (err) {
      showError(err.message);
    }
  });

  $('#toggle-error').addEventListener('click', () => {
    $('#error-zone').classList.add('show');
  });
  $('#cancel-error').addEventListener('click', () => {
    $('#error-zone').classList.remove('show');
  });
  $('#send-error').addEventListener('click', async () => {
    clearError();
    const message = $('#error-msg').value.trim() || 'Request rejected by the human.';
    try {
      await api(`/api/requests/${encodeURIComponent(r.id)}/error`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      });
    } catch (err) {
      showError(err.message);
    }
  });
  $('#dismiss').addEventListener('click', async () => {
    clearError();
    try {
      await api(`/api/requests/${encodeURIComponent(r.id)}/dismiss`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    } catch (err) {
      showError(err.message);
    }
  });

  // keyboard shortcut: Cmd/Ctrl+Enter sends the response
  $('#resp-content').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      $('#send-response').click();
    }
  });
}

// ------------------------------------------------------------- theme

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem('humanapi-theme', t);
  } catch {
    /* private mode etc. — theme just won't persist */
  }
  renderThemeButton();
}

function renderThemeButton() {
  const cur = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const next = cur === 'dark' ? 'light' : 'dark';
  const btn = $('#theme-toggle');
  if (!btn) return;
  btn.textContent = next === 'light' ? '☀️' : '🌙';
  btn.title = `Switch to ${next} theme`;
  btn.setAttribute('aria-label', btn.title);
}

// ------------------------------------------------------------- clear history

/** Ask before wiping history; resolves true only when confirmed. */
function confirmClear(message) {
  return new Promise((resolve) => {
    const dlg = $('#clear-confirm');
    const okBtn = $('#clear-ok');
    const cancelBtn = $('#clear-cancel');
    if (!dlg || !okBtn) return resolve(false);
    $('#clear-confirm-msg').textContent = message;

    let settled = false;
    const settle = (val) => {
      if (settled) return;
      settled = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      dlg.removeEventListener('close', onClose);
      if (dlg.open) dlg.close();
      resolve(val);
    };
    const onOk = () => settle(true);
    const onCancel = () => settle(false);
    const onClose = () => settle(false); // Esc / backdrop dismissal
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}

function refreshClearButton() {
  const btn = $('#clear-history');
  if (!btn) return;
  const hasFinished = state.requests.some((r) => r.status !== 'pending');
  btn.disabled = !hasFinished;
}

async function onClearHistory() {
  const finished = state.requests.filter((r) => r.status !== 'pending').length;
  const pend = state.requests.length - finished;
  if (finished === 0) return;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const msg = pend > 0
    ? `Delete ${plural(finished, 'finished request')} from history?\n\n` +
      `${plural(pend, 'pending request')} still waiting for you will be kept.`
    : `Delete ${plural(finished, 'request')} from history?`;
  if (!(await confirmClear(msg))) return;
  try {
    await api('/api/requests/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    // The SSE 'cleared' event updates the list too; refetch keeps us in sync.
    state.requests = await api('/api/requests');
    renderAll();
  } catch (err) {
    window.alert(`Clear failed: ${err.message}`);
  }
}

// ------------------------------------------------------------- glue

function renderAll() {
  renderList();
  refreshClearButton();
  renderDetail();
}

function init() {
  $('#filters').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    $('#filters').querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === btn));
    renderList();
  });

  $('#theme-toggle').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    setTheme(cur === 'dark' ? 'light' : 'dark');
  });
  renderThemeButton();

  $('#clear-history').addEventListener('click', onClearHistory);
  refreshClearButton();

  connectSSE();
  // Immediate paint without waiting for the SSE snapshot.
  api('/api/requests')
    .then((list) => {
      state.requests = list;
      renderAll();
    })
    .catch(() => setConn(false));
}

init();
