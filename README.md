# 🧑‍💻 Human API

An **OpenAI-compatible API endpoint where a human plays the model.**

Every request sent to `POST /v1/chat/completions` (Chat Completions) or
`POST /v1/responses` (Responses API) is parked ("kept alive") and shown in a
local web UI. You read the request — messages, tools, everything — and type the
assistant's answer. The waiting client then receives a perfectly shaped OpenAI
response, as if a real LLM had replied.

No AI models are involved. No API keys. No security. Just you, a queue, and a
web page. Zero dependencies: `node server.js` is all it takes.

---

## Quick start

```bash
node server.js
```

```
┌────────────────────────────────────────────────────────
│ 🧑💻 Human API — OpenAI-compatible endpoint, human answers
│   Chat Completions:  http://127.0.0.1:8787/v1/chat/completions
│   Responses API:     http://127.0.0.1:8787/v1/responses
│   Web UI:            http://127.0.0.1:8787/
└────────────────────────────────────────────────────────
```

Open **http://127.0.0.1:8787/** — that's your control room.

**Stopping the server:** `Ctrl+C` (or `kill <pid>`) shuts down gracefully —
still-pending requests are dismissed so their clients get a proper error
instead of a dead connection, and the history file is flushed immediately, so
nothing is lost to the write debounce. Safe to stop any time.

Then send it something from any OpenAI-compatible client:

```bash
# plain chat (this hangs until you answer in the UI)
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Say hello!"}]}'

# Responses API shape
curl -N http://127.0.0.1:8787/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","instructions":"Be brief.",
       "input":[{"type":"message","role":"user",
                 "content":[{"type":"input_text","text":"Say hello!"}]}]}'
```

Switch to the browser, click the pending request, type the reply, hit
**Send response**, and the curl command above returns the answer.

### Examples

| file | what it shows |
| --- | --- |
| `examples/ask.js` | minimal plain-text chat client (fetch, no SDK) |
| `examples/stream.js` | chat `stream: true` client with an SSE parser |
| `examples/toolcall.js` | chat tool-calling round trip (declare tools, get tool calls back) |
| `examples/responses.js` | Responses API client, non-streaming **and** streaming (`--stream`) |

```bash
node examples/ask.js "What color is the sky?"
node examples/stream.js "Tell me a joke"
node examples/toolcall.js          # ask; answer in UI with a tool call
node examples/toolcall.js --with-tool-result   # continue the round trip
node examples/responses.js         # Responses API (flat tools, input items)
node examples/responses.js --stream
```

## Configuration

| env var | default | meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | bind address |
| `PORT` | `8787` | port |

---

## How it works

```
 OpenAI client                  Human API                    You (browser)
 ─────────────                  ─────────                    ─────────────
 POST /v1/chat/completions  ──▶ park request ──▶ SSE/HTTP ──▶ appears in UI
 POST /v1/responses          (connection held open)          read the request
        ▲                       "pending"                     type the answer
        └─────────── OpenAI-shaped response ◀── respond ◀─────  (or tool calls,
          (chat: JSON or SSE chunks + [DONE];                     or an error)
           responses: JSON or SSE events)
```

- Requests are **never** forwarded anywhere. They sit in an in-memory queue
  (history is also persisted to `data/requests.json`, gitignored) until you act.
- The HTTP connection stays open indefinitely — the server disables
  `requestTimeout` so nothing kills a request that's waiting on you.
- **Streaming** (`stream: true`): the server sends the SSE headers immediately
  and holds the stream. When you answer, the whole assistant turn is delivered
  at once — for chat as a single `chat.completion.chunk` followed by
  `data: [DONE]`, for the Responses API as a burst of real events
  (`response.created` → `output_item`/`output_text`/`function_call_arguments`
  events → `response.completed`). No fake token-by-token simulation.
- **Tool calls**: you can answer with plain text, one or more tool calls, or
  both. Tool names are pre-filled from the `tools` the client declared (both
  the chat `function.function` nesting and the Responses flat shape). Chat
  responses use `tool_calls` + `finish_reason: "tool_calls"`; Responses
  responses emit `function_call` output items with a fresh `call_id`, which the
  client echoes back as `function_call_output` input items.
- If you'd rather simulate a failure, "Send error" rejects the request with
  `500 {"error": {...}}` (or an `error` frame over SSE); "Dismiss" drops it
  with a `503`. The client sees a real HTTP error either way.

## What the human can do in the UI

- See every request live (SSE push), newest first, with filters; each entry is
  tagged `chat` or `responses`.
- Inspect the full request: the message thread (system / user / assistant /
  tool roles, tool calls and their JSON arguments) and the declared tools.
  Responses-API requests show `instructions` as a system message and render
  `input` items — `function_call` entries appear as assistant tool calls,
  `function_call_output` entries as tool results. Long messages (and system
  prompts in particular) start **folded** — click a message header to expand or
  fold it, keeping the panel readable. Declared tools appear as name chips;
  click a name to reveal its description and parameter schema.
- Reply with **content**, **tool calls** (name + JSON arguments, validated),
  or both. `⌘/Ctrl + Enter` sends.
- Send an **error** or **dismiss** the request.
- Switch between **dark and light themes** with the button in the header (your
  choice is remembered in `localStorage`).
- **Clear history**: the 🗑 button wipes every *finished* request (done /
  rejected / dismissed) from the UI and from `data/requests.json`. Requests
  still pending are kept — their clients are connected and waiting.
- Watch the queue drain as the parked clients get their answers.

## Endpoints

| method | path | description |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | Chat Completions; parks the request |
| `POST` | `/v1/responses` | Responses API; parks the request |
| `GET` | `/v1/models` | fake model list (`human-proxy`) |
| `GET` | `/api/requests` | list all requests (admin) |
| `GET` | `/api/requests/:id` | one request (admin) |
| `POST` | `/api/requests/:id/respond` | answer: `{"content"?, "tool_calls"?: [{name, arguments}]}` |
| `POST` | `/api/requests/:id/error` | reject: `{"message"?: string}` → HTTP 500 |
| `POST` | `/api/requests/:id/dismiss` | drop → HTTP 503 |
| `POST` | `/api/requests/clear` | wipe finished requests → `{"cleared": n, "remaining": n}` |
| `GET` | `/api/events` | SSE feed of changes (drives the UI) |
| `GET` | `/` | the web UI |

## Notes & limitations

- Any `model` name is accepted and echoed back; nothing is actually called.
- Chat requests ignore `n`, `logprobs`, `response_format`, `stop` etc. — you
  get one choice with `finish_reason` `stop` or `tool_calls`. Responses
  requests come back as a single `response` with `message` / `function_call`
  output items; other configuration (`reasoning`, `store`, `text.format`, …)
  is echoed back rather than honored.
- The Responses reply is **not stored** (`store: false`) and no assistant
  message is injected into later requests' `input` — a follow-up request is a
  fresh parked item whose `input` is whatever the client re-sends.
- Client-side timeouts: the parked response only returns once you answer, so
  give your client a long/disabled timeout (e.g. the OpenAI SDK's default 10
  minutes might be short if you step away).
- "Tool calls" here means the assistant *emits* tool calls to the client; the
  client then executes the tool and sends a follow-up request with the tool
  result, which you answer again. The full loop is demonstrated by
  `examples/toolcall.js` (chat) and `examples/responses.js` (Responses).
- History is stored append-only in `data/requests.json`: one compact JSON
  record per line. Answering a request appends one line (~O(one request)) —
  no whole-file rewrite per answer, and writes never block the server. Files
  written as pretty JSON arrays by older builds are auto-converted on first
  boot. Use **Clear history** in the UI to wipe the file (rewrites it empty).
