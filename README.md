# t3code-api

REST bridge for [T3 Code](https://github.com/anthropics/t3code) — lets external applications control T3 Code sessions over plain HTTP instead of speaking its internal WebSocket protocol directly.

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
  "model": "o3",
  "runtimeMode": "full-access",
  "interactionMode": "default"
}
```

Only `projectId` is required. Defaults: `provider=codex`, `model=o3`, `runtimeMode=full-access`, `interactionMode=default`, `title="API Thread"`.

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

Only `text` is required. Optional overrides: `provider`, `model`, `runtimeMode`, `interactionMode`.

```json
{ "messageId": "uuid", "commandId": "uuid" }
```

After sending, poll `/threads/:threadId/messages` or `/threads/:threadId/status` to track progress.

### Read messages

```
GET /threads/:threadId/messages
GET /threads/:threadId/messages?after=42&limit=20
```

Returns user and assistant messages extracted from buffered events.

```json
{
  "messages": [
    {
      "sequence": 10,
      "messageId": "uuid",
      "role": "user",
      "text": "Write me a hello world in Python",
      "turnId": "uuid",
      "createdAt": "2026-03-27T12:00:00Z"
    },
    {
      "sequence": 15,
      "messageId": "uuid",
      "role": "assistant",
      "text": "Here's a simple hello world...",
      "turnId": "uuid",
      "createdAt": "2026-03-27T12:00:05Z"
    }
  ],
  "lastSequence": 15
}
```

Use `lastSequence` as `?after=` in the next poll to get only new messages.

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

# 3. Create a thread
THREAD=$(curl -s -X POST http://localhost:4774/threads \
  -H 'Content-Type: application/json' \
  -d '{"projectId": "..."}' | jq -r '.threadId')

# 4. Send a message
curl -X POST "http://localhost:4774/threads/$THREAD/messages" \
  -H 'Content-Type: application/json' \
  -d '{"text": "List all files in the current directory"}'

# 5. Poll for completion
while [ "$(curl -s http://localhost:4774/threads/$THREAD/status | jq -r '.status')" = "running" ]; do
  sleep 2
done

# 6. Read the response
curl "http://localhost:4774/threads/$THREAD/messages"

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
