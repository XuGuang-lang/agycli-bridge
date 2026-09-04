# agycli-bridge Design Spec

**Date:** 2026-09-01
**Status:** Implemented

> Revised after implementation. Probing the real CLI changed four decisions;
> each is called out inline as **[revised]**.

## Purpose

A Node.js (zero-dependency) bridge service that wraps the local Antigravity CLI (`agy -p`) into an OpenAI-compatible REST API, enabling SillyTavern to use agy-backed models (Gemini, Claude, GPT-OSS) without direct API keys.

## Architecture

```
SillyTavern                    agycli-bridge                     agy CLI
┌──────────┐   POST /v1/chat   ┌─────────────┐   spawn -p       ┌─────────┐
│          │ ──completions───> │ HTTP Server  │ ──stream-json──> │ agy.exe │
│  Client  │ <───SSE stream──  │ (Node.js)    │ <──NDJSON──────  │  -p     │
│          │                   │              │                  │         │
└──────────┘                   └─────────────┘                   └─────────┘
```

Each incoming request spawns a new `agy -p` process with `--output-format stream-json`. No session/conversation reuse — SillyTavern manages context and sends the full messages array each time.

### Modules

| File | Responsibility |
|------|----------------|
| `src/server.js` | HTTP server, routing, concurrency gating, SSE streaming |
| `src/agy.js` | Locate agy binary, build CLI args, spawn process, parse NDJSON output |
| `src/messages.js` | Convert OpenAI messages format to agy prompt text, stop sequence truncation |
| `src/config.js` | Load config.json, apply BRIDGE_ env var overrides |
| `start.bat` | Windows launcher |
| `start.sh` | Linux launcher |

## API Endpoints

### `POST /v1/chat/completions`

Accepts OpenAI-compatible chat completion requests. Supports both streaming (`stream: true`) and non-streaming modes.

**Request body fields used:**
- `model` — mapped to `--model` flag. Supports optional suffixes (e.g., `model:high` to set effort)
- `messages` — array of `{role, content}` objects
- `stream` — boolean, enables SSE streaming
- `stop` — array of stop sequences for client-side truncation
- `max_tokens` — forwarded if supported

### `GET /v1/models`

Returns the list of available models from `agy models` output (cached on startup).

### `GET /health` (and `GET /`)

Returns service status including uptime, CLI version, and active request count.

## Data Flow

### Message Conversion (messages → prompt text)

1. **`systemPreamble`** — a fixed task description placed first, ahead of everything else.
2. **Leading system messages** — extracted and placed after the preamble. If `agent` is configured, `--agent` is also passed.
3. **Mid-conversation system messages** — rendered as `System: content` inline in dialogue.
4. **user messages** — rendered as `Human: content`
5. **assistant messages** — rendered as `Assistant: content`
6. A trailing `Assistant:` cue ends the prompt so the model continues rather than echoing the transcript.

**[revised] The preamble must be phrased as a task description, not an identity override.**
agy ships a coding-assistant persona that leaks into roleplay replies. The first draft
said "Ignore any default identity as a software engineering assistant". Claude read that
as a jailbreak and refused, opening with *"I'm Antigravity, your AI coding assistant —
I can't be reassigned to a different role via prompts"* — producing the exact leak the
preamble existed to prevent. Gemini complied with the same wording, so this only shows up
on Claude models. Describing the task instead ("This session is a creative-writing and
roleplay task…") tested clean on both.

**[revised] There is no `--system-prompt-file` flag.** The design assumed one existed
(by analogy with the Claude CLI). agy has no system-prompt flag at all, so the system
prompt travels inside the prompt text.

### agy Process Lifecycle

**[revised] The prompt is delivered as NDJSON on stdin, not as a `-p` argument.**
`-p` requires its value inline, which would hit the ~32K Windows command-line limit on
any real character card. `--input-format stream-json` accepts the prompt on stdin
instead. Two constraints discovered by probing:

- Only `{"event":"user", "message":{...}}` lines are accepted. An `assistant` event is
  ignored with `warning: ignoring unsupported stream input message event "assistant"`,
  so assistant prefill is not expressible.
- **agy runs one turn per input line.** Sending the history as separate lines would bill
  N generations, so the whole conversation is flattened into a single user message.

Content blocks are limited to `type: "text"` (`content block type %q is not supported
(only "text")`), which is why images are out of scope.

```
spawn: agy --output-format stream-json --input-format stream-json
            --model <model> [--effort <effort>] [--agent <agent>]
            --disable-slash-commands --print-timeout <timeout>s

stdin:  {"event":"user","message":{"role":"user","content":"<whole prompt>"}}\n
        (then closed)

stdout (NDJSON, one JSON object per line):
  {"event":"init", "conversation_id":"...", "init":{...}}
  {"event":"step_update", "step_update":{"state":"ACTIVE", "text_delta":"..."}}
  {"event":"step_update", "step_update":{"state":"DONE", "text_delta":"...", "usage":{...}}}
  {"event":"result", "result":{"status":"SUCCESS", "response":"...", "usage":{...}}}

stderr: error messages (buffered, capped at 8KB)
```

**[revised] Only `agent_response` steps are forwarded.** `step_type` also takes the
values `user_input`, `tool_use`, `system_message`, `checkpoint`, `plan` and `browser`.
These are CLI-internal and must not reach the client.

### SSE Output (OpenAI delta format)

For each `text_delta` received from a `step_update` event:

```
data: {"id":"chatcmpl-<conversation_id>","object":"chat.completion.chunk","created":<ts>,"model":"<model>","choices":[{"index":0,"delta":{"content":"<text_delta>"},"finish_reason":null}]}
```

Final event:
```
data: {"id":"chatcmpl-<conversation_id>","object":"chat.completion.chunk","created":<ts>,"model":"<model>","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### Stop Sequence Handling

Stop sequences from the request's `stop` array are matched against the streaming output using a sliding buffer. When a match is found, output is truncated at the match point and the process is killed.

## Configuration

### config.json

```json
{
  "host": "127.0.0.1",
  "port": 5599,
  "apiKey": "",
  "agyPath": "agy",
  "model": "claude-sonnet-4-6",
  "effort": "",
  "agent": "",
  "maxConcurrent": 2,
  "timeout": 600,
  "disableSlashCommands": true,
  "debug": false,
  "systemPromptPrefix": "[System]\n",
  "roleLabels": {
    "user": "Human",
    "assistant": "Assistant",
    "system": "System"
  }
}
```

### Environment Variable Overrides

All fields support `BRIDGE_` prefix overrides (e.g., `BRIDGE_PORT=8080`, `BRIDGE_MODEL=gemini-3.7-flash-high`). Priority: env vars > config.json > defaults.

### Key Config Fields

- `agyPath` — absolute path or command name in PATH. On Windows, resolves `.exe`/`.cmd` variants.
- `apiKey` — if non-empty, validates `Authorization: Bearer <key>` on all requests.
- `agent` — if non-empty, passes `--agent <value>` to agy for system prompt injection.
- `maxConcurrent` — max parallel agy processes (default 2). Excess requests queue.
- `timeout` — seconds before killing an agy process (default 600). Returns 504 on timeout.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| agy not found on startup | Log error, exit with code 1 |
| Process timeout | Kill process, return 504 Gateway Timeout |
| Process crash (non-zero exit) | Parse stderr, return 502 with error message |
| Invalid request body | Return 400 Bad Request |
| Concurrent limit reached | Queue request (no rejection) |
| Auth failure | Return 401 Unauthorized |
| Client disconnects | Abort via `res` close, kill agy, release the slot |
| **[revised]** Transient agy failure, nothing sent yet | Retry (`retries`, default 1) |
| **[revised]** agy errors *after* streaming text | Keep the text, log the error |

**[revised] agy fails transiently often enough to need retries.** It performs a network
eligibility check on every invocation; under concurrency this intermittently fails with
e.g. `Eligibility check failed: failed to get profile picture: … EOF`, and it sometimes
reports `The stream was interrupted` *after* delivering a complete reply. Retry is
attempted only while nothing has been streamed, so it stays invisible to the client.

**[revised] Errors are never written into the response body.** An earlier version
appended `[bridge] <message>` to the content stream when a failure arrived mid-stream.
In a roleplay client that text becomes part of the character's dialogue and persists in
the chat log. Once headers are sent the stream is instead closed cleanly and the failure
is logged server-side.

**[revised] Client disconnects are detected on `res`, not `req`.** The request body has
already been fully read by then, so `req`'s close event does not track the client;
listening on `req` leaked an agy process and a concurrency slot per disconnect, which
would deadlock the bridge at `maxConcurrent`.

## Cross-Platform Support

- Node.js `child_process.spawn` without `shell: true` (direct exec).
- Binary resolution: `where` on Windows, `which` on Linux/macOS.
- Path separators handled by Node.js `path` module.
- Stdin prompt delivery avoids command-line length limits on all platforms.
- Console encoding set to UTF-8 on Windows for CJK character support.

## Out of Scope (MVP)

- Session/conversation reuse (`--conversation`)
- Prefill / assistant continuation — **not expressible**: agy ignores `assistant` input events
- Image/multimodal support — **not expressible**: stream input accepts `text` blocks only
- Thinking/reasoning block exposure
- Tool / function calling

## Known Costs

- **~13–16K input tokens per request.** agy injects its full tool schema into every
  invocation and no flag disables it. This is inherent to driving the CLI.
- **7–15s time to first token**, from process cold start plus that context overhead.

## Verification

`npm test` covers the pure logic (33 tests): prompt assembly, leading-label stripping,
cross-chunk stop-sequence backtracking, CLI argument construction, and transient-error
classification.

Checked against the live CLI: streaming and non-streaming completions, multi-turn
history recall, stop-sequence truncation, `model:effort` suffixes, inline system
messages, `/v1/models`, 400 on empty messages, 5-way concurrency against
`maxConcurrent: 2`, and client-abort process cleanup.
