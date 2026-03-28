# t3code-api

REST bridge for [T3 Code](https://github.com/pingdotgg/t3code) — lets external applications control T3 Code sessions over plain HTTP instead of speaking its internal WebSocket protocol directly.

## Why

T3 Code's frontend talks to its server over a persistent WebSocket with a custom binary-ish JSON-RPC protocol. That's fine for the built-in UI, but awkward for external tools that just want to fire off a request and check back later. This bridge sits between your app and a running T3 Code server:

```
Your App  ──HTTP──▶  t3code-api  ══WS══▶  T3 Code Server
                         │
                    event buffer
                    (per thread)
```

- **No WebSocket management** — your app uses plain REST calls
- **Event buffering** — the bridge collects orchestration events while your app isn't looking; poll whenever you want
- **Runs alongside the frontend** — the T3 Code web UI keeps working normally; this is just another WebSocket client

## Quick start

```bash
bun install
bun run dev
```

The bridge connects to `ws://localhost:3773` by default (T3 Code's default port). Make sure T3 Code is running first.

## Configuration

All settings via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `T3API_PORT` | `4774` | Port for the REST bridge |
| `T3API_WS_URL` | `ws://localhost:3773` | T3 Code WebSocket URL |
| `T3API_TOKEN` | _(none)_ | Bearer token for bridge auth (optional) |
| `T3API_MAX_EVENTS` | `500` | Max buffered events per thread |

Example with all options:

```bash
T3API_PORT=4774 T3API_WS_URL=ws://localhost:3773 T3API_TOKEN=secret T3API_MAX_EVENTS=1000 bun run dev
```

## Authentication

When `T3API_TOKEN` is set, all requests require a `Authorization: Bearer <token>` header. Without it, the bridge is open (fine for local use).

Note: this is the bridge's own auth. It's independent of T3 Code server's `--auth-token` — if T3 Code itself requires a token, set it in the `T3API_WS_URL` query string: `ws://localhost:3773?token=t3secret`.

## API docs (Swagger UI)

Interactive API docs are available at `http://localhost:4774/docs` when the bridge is running. The OpenAPI spec is served at `/openapi.yaml`.

Both endpoints are exempt from bearer auth — docs are always accessible.

## Session configuration reference

### Providers and models

Each thread is bound to a provider. The provider determines which AI backend processes the conversation.

| Provider | Value | Available models | Description |
|----------|-------|------------------|-------------|
| Codex (OpenAI) | `codex` | `gpt-5.4` | OpenAI Codex agent — code generation and execution via JSON-RPC |
| Claude Agent | `claudeAgent` | `claude-opus-4-6`, `claude-sonnet-4-6` | Anthropic Claude agent — autonomous coding with tool use |

Provider and model are set when creating a thread and can be overridden per message (turn).

### Runtime mode

Controls whether the agent can execute tools (shell commands, file writes) autonomously or needs explicit approval.

| Value | Behavior |
|-------|----------|
| `full-access` (default) | Agent executes tools freely without asking for permission |
| `approval-required` | Agent pauses before each tool execution and waits for approval |

When using `approval-required`, the agent will emit `thread.approval-response-requested` events. In the current bridge version, approval responses are not yet exposed as a REST endpoint — use `full-access` for fully autonomous operation.

### Interaction mode

Controls whether the agent executes tasks immediately or produces a plan first.

| Value | Behavior |
|-------|----------|
| `default` (default) | Agent starts working on the task immediately |
| `plan` | Agent first produces a plan (markdown), then waits before executing it |

### Thread status lifecycle

After sending a message, the thread goes through these statuses (available via `GET /threads/:threadId/status`):

| Status | Meaning |
|--------|---------|
| `idle` | No turn in progress, ready for new messages |
| `starting` | Turn is initializing, provider session spinning up |
| `running` | Agent is actively working (generating, executing tools) |
| `ready` | Agent is waiting for input (e.g. approval in `approval-required` mode) |
| `interrupted` | Turn was interrupted via `POST /threads/:threadId/interrupt` |
| `stopped` | Session was explicitly stopped |
| `error` | Something went wrong — check events for details |
| `null` | No session events observed yet (thread just created) |

### Domain event types

When polling `GET /threads/:threadId/events`, you can filter by these event types using the `?types=` parameter:

| Event type | When it fires |
|------------|---------------|
| `thread.created` | Thread was created |
| `thread.deleted` | Thread was deleted |
| `thread.message-sent` | A message (user or assistant) was persisted |
| `thread.session-set` | Session status changed (contains new status) |
| `thread.turn-start-requested` | A turn was requested (message submitted) |
| `thread.turn-diff-completed` | Turn finished and file diff is available |
| `thread.activity-appended` | Activity log entry (tool calls, info, errors) |
| `thread.approval-response-requested` | Agent is waiting for tool approval |
| `thread.meta-updated` | Thread metadata (title, model) was updated |
| `thread.runtime-mode-set` | Runtime mode was changed |
| `thread.interaction-mode-set` | Interaction mode was changed |
| `thread.proposed-plan-upserted` | Agent produced or updated a plan (in `plan` mode) |

### Configuration defaults summary

| Field | Default | Set on |
|-------|---------|--------|
| `provider` | `codex` | thread create, message send |
| `model` | `gpt-5.4` | thread create, message send |
| `runtimeMode` | `full-access` | thread create, message send |
| `interactionMode` | `default` | thread create, message send |
| `title` | `API Thread` | thread create |
| `workdir` | _(project root)_ | thread create |
| `attachments` | _(none)_ | thread create (initialMessage), message send |

All optional fields on `POST /threads/:threadId/messages` are per-turn overrides — they apply only to that turn without changing the thread's defaults.

## API reference

### Health

```
GET /health
```

```json
{ "ok": true, "connected": true, "lastSequence": 42 }
```

`connected` tells you whether the bridge has an active WebSocket to T3 Code.

### Snapshot

```
GET /snapshot
```

Returns the full orchestration state from T3 Code — all projects, threads, messages, sessions. This is a pass-through to `orchestration.getSnapshot`.

### Create thread

```
POST /threads
Content-Type: application/json

{
  "projectId": "uuid-from-snapshot",
  "title": "My task",
  "provider": "codex",
  "model": "gpt-5.4",
  "runtimeMode": "full-access",
  "interactionMode": "default",
  "workdir": "/opt/projects/my-app",
  "initialMessage": {
    "text": "List all files in the current directory"
  }
}
```

Only `projectId` is required. All other fields are optional:

| Field | Default | Description |
|-------|---------|-------------|
| `title` | `API Thread` | Display name |
| `provider` | `codex` | AI provider |
| `model` | `gpt-5.4` | Model identifier |
| `runtimeMode` | `full-access` | Tool execution permissions |
| `interactionMode` | `default` | Immediate execution vs plan-first |
| `workdir` | _(project root)_ | Working directory for the agent |
| `initialMessage` | _(none)_ | Send first message immediately on creation |

When `initialMessage` is provided, the response includes `messageId`:

```json
{ "threadId": "generated-uuid", "messageId": "generated-uuid" }
```

Without `initialMessage`:

```json
{ "threadId": "generated-uuid" }
```

### Delete thread

```
DELETE /threads/:threadId
```

### Send message (start a turn)

```
POST /threads/:threadId/messages
Content-Type: application/json

{
  "text": "Write me a hello world in Python",
  "runtimeMode": "full-access"
}
```

Only `text` is required. Optional overrides: `provider`, `model`, `runtimeMode`, `interactionMode`, `attachments`.

```json
{ "messageId": "uuid", "commandId": "uuid" }
```

After sending, poll `/threads/:threadId/messages` or `/threads/:threadId/status` to track progress.

#### Attachments

You can attach images via local file path (bridge reads and converts) or raw data URL:

```json
{
  "text": "What's in this screenshot?",
  "attachments": [
    { "type": "image", "path": "/tmp/screenshot.png" }
  ]
}
```

Supported image formats: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`. Max 10 MB per image.

### Read messages

```
GET /threads/:threadId/messages
GET /threads/:threadId/messages?after=42&limit=20
```

Returns accumulated user and assistant messages. Assistant streaming deltas are automatically concatenated into a single message per `messageId`.

```json
{
  "messages": [
    {
      "sequence": 10,
      "messageId": "uuid",
      "role": "user",
      "text": "Write me a hello world in Python",
      "turnId": "uuid",
      "streaming": false,
      "createdAt": "2026-03-27T12:00:00Z",
      "updatedAt": "2026-03-27T12:00:00Z"
    },
    {
      "sequence": 55,
      "messageId": "uuid",
      "role": "assistant",
      "text": "Here's a simple hello world...",
      "turnId": "uuid",
      "streaming": false,
      "createdAt": "2026-03-27T12:00:01Z",
      "updatedAt": "2026-03-27T12:00:05Z"
    }
  ],
  "lastSequence": 55
}
```

The `streaming` field indicates if the assistant is still generating. Poll again while `streaming: true` to get more text. Use `lastSequence` as `?after=` in the next poll to get only new messages.

### Read raw events

```
GET /threads/:threadId/events
GET /threads/:threadId/events?after=10&limit=50&types=thread.message-sent,thread.session-set
```

Returns raw orchestration domain events. Useful for detailed tracking (approvals, activity logs, diffs).

### Thread status

```
GET /threads/:threadId/status
```

```json
{ "threadId": "uuid", "status": "idle" }
```

Possible statuses: `idle`, `starting`, `running`, `ready`, `interrupted`, `stopped`, `error`.

### Interrupt a turn

```
POST /threads/:threadId/interrupt
```

### Get file diff

```
GET /threads/:threadId/diff              # Full thread diff
GET /threads/:threadId/diff?from=1&to=3  # Diff between turn counts
```

## Typical workflow

```bash
# 1. Check bridge is connected
curl http://localhost:4774/health

# 2. Get projectId from snapshot
curl http://localhost:4774/snapshot | jq '.projects[0].projectId'

# 3. Create thread + send first message in one call
RESULT=$(curl -s -X POST http://localhost:4774/threads \
  -H 'Content-Type: application/json' \
  -d '{
    "projectId": "...",
    "workdir": "/opt/projects/my-app",
    "initialMessage": { "text": "List all files in the current directory" }
  }')
THREAD=$(echo "$RESULT" | jq -r '.threadId')

# 4. Poll for completion
while [ "$(curl -s http://localhost:4774/threads/$THREAD/status | jq -r '.status')" = "running" ]; do
  sleep 2
done

# 5. Read the response (user + assistant messages, accumulated)
curl "http://localhost:4774/threads/$THREAD/messages"

# 6. Send a follow-up with a screenshot
curl -X POST "http://localhost:4774/threads/$THREAD/messages" \
  -H 'Content-Type: application/json' \
  -d '{
    "text": "Fix the layout issue shown here",
    "attachments": [{"type": "image", "path": "/tmp/screenshot.png"}]
  }'

# 7. Check what files changed
curl "http://localhost:4774/threads/$THREAD/diff"
```

## Architecture

| File | Role |
|------|------|
| `src/index.ts` | Entry point — config, HTTP server, wires everything together |
| `src/ws-client.ts` | WebSocket client with auto-reconnect and request/response matching |
| `src/event-buffer.ts` | Per-thread circular buffer for orchestration domain events |
| `src/routes.ts` | Hono REST routes — translates HTTP to WS commands and buffer reads |
| `src/openapi.yaml` | OpenAPI 3.1 spec — served at `/openapi.yaml`, powers Swagger UI at `/docs` |

The bridge is stateless except for the event buffer (in-memory, lost on restart). T3 Code server is the source of truth — use `GET /snapshot` to rebuild state after a bridge restart.
