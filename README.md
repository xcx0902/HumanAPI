# 🧑‍💻 Human API

An **OpenAI-compatible API endpoint where a human plays the model.**

Every request sent to `POST /v1/chat/completions` is parked ("kept alive") and
shown in a local web UI. You read the request — messages, tools, everything —
and type the assistant's answer. The waiting client then receives a perfectly
shaped OpenAI response, as if a real LLM had replied.

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
│   OpenAI API:  http://127.0.0.1:8787/v1/chat/completions
│   Web UI:      http://127.0.0.1:8787/
└────────────────────────────────────────────────────────
```

Open **http://127.0.0.1:8787/** — that's your control room.

Then send it something from any OpenAI-compatible client:

```bash
# plain chat (this hangs until you answer in the UI)
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Say hello!"}]}'
```

Switch to the browser, click the pending request, type the reply, hit
**Send response**, and the curl command above returns the answer.

### Examples

| file | what it shows |
| --- | --- |
| `examples/ask.js` | minimal plain-text client (fetch, no SDK) |
| `examples/stream.js` | `stream: true` client with an SSE parser |
| `examples/toolcall.js` | tool-calling round trip (declare tools, get tool calls back) |

```bash
node examples/ask.js "What color is the sky?"
node examples/stream.js "Tell me a joke"
node examples/toolcall.js          # ask; answer in UI with a tool call
node examples/toolcall.js --with-tool-result   # continue the round trip
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
 (connection held open)         "pending"                     read messages
        ▲                                                      type the answer
        └─────────── OpenAI-shaped response ◀── respond ◀─────  (or tool calls,
          (or SSE chunks + [DONE])                               or an error)
```

- Requests are **never** forwarded anywhere. They sit in an in-memory queue
  (history is also persisted to `data/requests.json`, gitignored) until you act.
- The HTTP connection stays open indefinitely — the server disables
  `requestTimeout` so nothing kills a request that's waiting on you.
- **Streaming** (`stream: true`): the server sends the SSE headers immediately
  and holds the stream. When you answer, the whole assistant turn is delivered
  as a single `chat.completion.chunk` followed by `data: [DONE]`. No fake
  token-by-token simulation.
- **Tool calls**: you can answer with plain text, one or more tool calls, or
  both. Tool names are pre-filled from the `tools` the client declared. The
  response uses the standard `tool_calls` / `finish_reason: "tool_calls"`
  format, so clients that execute tools work unchanged.
- If you'd rather simulate a failure, "Send error" rejects the request with
  `500 {"error": {...}}` (or an error frame over SSE); "Dismiss" drops it with
  a `503`. The client sees a real HTTP error either way.

## What the human can do in the UI

- See every request live (SSE push), newest first, with filters.
- Inspect the full message thread: system / user / assistant / tool roles,
  tool calls and their JSON arguments, declared tools.
- Reply with **content**, **tool calls** (name + JSON arguments, validated),
  or both. `⌘/Ctrl + Enter` sends.
- Send an **error** or **dismiss** the request.
- Watch the queue drain as the parked clients get their answers.

## Endpoints

| method | path | description |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI-compatible; parks the request |
| `GET` | `/v1/models` | fake model list (`human-proxy`) |
| `GET` | `/api/requests` | list all requests (admin) |
| `GET` | `/api/requests/:id` | one request (admin) |
| `POST` | `/api/requests/:id/respond` | answer: `{"content"?, "tool_calls"?: [{name, arguments}]}` |
| `POST` | `/api/requests/:id/error` | reject: `{"message"?: string}` → HTTP 500 |
| `POST` | `/api/requests/:id/dismiss` | drop → HTTP 503 |
| `GET` | `/api/events` | SSE feed of changes (drives the UI) |
| `GET` | `/` | the web UI |

## Notes & limitations

- Any `model` name is accepted and echoed back; nothing is actually called.
- `n`, `logprobs`, `response_format`, `stop` etc. are ignored — you get one
  choice with `finish_reason` `stop` or `tool_calls`.
- Client-side timeouts: the parked response only returns once you answer, so
  give your client a long/disabled timeout (e.g. the OpenAI SDK's default 10
  minutes might be short if you step away).
- "Tool calls" here means the assistant *emits* tool calls to the client; the
  client then executes the tool and sends a follow-up request with the tool
  result, which you answer again. The full loop is demonstrated by
  `examples/toolcall.js`.
