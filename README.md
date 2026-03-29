# t3code-api

**REST bridge for [T3 Code](https://github.com/pingdotgg/t3code) — let AI agents control coding sessions via HTTP, with human handoff through the T3 Code UI.**

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  AI Agent 1  │     │  AI Agent 2  │     │   You (UI)   │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │ HTTP               │ HTTP               │ WS
       ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────┐
│                     t3code-api                          │
│              REST ←→ WebSocket bridge                   │
│                                                         │
│   on completed/error ──► POST webhook callback          │
└─────────────────────────┬───────────────────────────────┘
                          │ WebSocket
                          ▼
               ┌─────────────────────┐
               │   T3 Code Server    │
               └─────────────────────┘
```

Multiple agents work in parallel threads. If one goes off track, open T3 Code UI and take over — same thread, full context preserved.

## Quick start

```bash
bun install && bun run dev    # connects to ws://localhost:3773
open http://localhost:4774/docs   # Swagger UI
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `T3API_PORT` | `4774` | Bridge HTTP port |
| `T3API_WS_URL` | `ws://localhost:3773` | T3 Code WebSocket URL |
| `T3API_TOKEN` | _(none)_ | Bearer token for bridge auth |
| `T3API_MAX_EVENTS` | `500` | Max buffered events per thread |

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Connection status and last sequence number |
| `GET` | `/snapshot` | Full T3 Code state (projects, threads, sessions) |
| `POST` | `/threads` | Create thread (optionally with first message) |
| `DELETE` | `/threads/:id` | Delete thread |
| `GET` | `/threads/:id/status` | Thread status (`idle`, `running`, `ready`, etc.) |
| `POST` | `/threads/:id/messages` | Send message — starts agent turn |
| `GET` | `/threads/:id/messages` | Read messages (streaming deltas merged) |
| `GET` | `/threads/:id/events` | Raw domain events (filterable by `?types=`) |
| `POST` | `/threads/:id/interrupt` | Interrupt current turn |
| `GET` | `/threads/:id/diff` | File changes from agent turns |
| `GET` | `/docs` | Swagger UI |

Full request/response schemas available at `/docs`.

## Usage

```bash
# Get project ID
PROJECT=$(curl -s localhost:4774/snapshot | jq -r '.projects[0].projectId')

# Create thread with initial task
TID=$(curl -s -X POST localhost:4774/threads \
  -H 'Content-Type: application/json' \
  -d "{\"projectId\": \"$PROJECT\",
       \"initialMessage\": {\"text\": \"Add pagination to /users\"}}" \
  | jq -r '.threadId')

# Poll until done
while [ "$(curl -s localhost:4774/threads/$TID/status | jq -r '.status')" = "running" ]; do
  sleep 2
done

# Read result
curl -s "localhost:4774/threads/$TID/messages" | jq '.messages[-1].text'
```

**Thread options**: `provider` (`codex`|`claudeAgent`), `model` (`gpt-5.4`, `claude-opus-4-6`, `claude-sonnet-4-6`), `runtimeMode`, `interactionMode`, `workdir`, `webhook`, `attachments`. All optional — see `/docs` for details.

### Webhooks

Skip polling — get notified when an agent finishes or fails:

```bash
curl -s -X POST localhost:4774/threads \
  -H 'Content-Type: application/json' \
  -d "{\"projectId\": \"$PROJECT\",
       \"webhook\": {
         \"url\": \"https://example.com/callback\",
         \"events\": [\"completed\", \"error\"],
         \"headers\": {\"Authorization\": \"Bearer xxx\"},
         \"metadata\": {\"source\": \"mybot\", \"taskId\": 42}
       },
       \"initialMessage\": {\"text\": \"Refactor auth module\"}}"
```

The bridge POSTs a JSON payload to your URL when the thread status transitions to idle/ready (`completed`) or error (`error`). Retries 3 times with exponential backoff (1s → 5s → 15s), 10s timeout per attempt. The `metadata` object is returned unchanged in every callback.

**Webhook formats**: `"default"` (native payload) or `"openclaw-hooks"` (OpenClaw `/hooks/agent` compatible). Set via `webhook.format`.

### OpenClaw integration

With `format: "openclaw-hooks"`, the bridge transforms callbacks into OpenClaw `/hooks/agent` payloads — the agent gets notified in its Telegram/Discord session when a coding task finishes:

```
  OpenClaw gateway              t3code-api                T3 Code
       │                            │                        │
       │  POST /threads             │                        │
       │  webhook.format=           │                        │
       │    "openclaw-hooks"        │   WS: thread.create    │
       │  metadata.sessionKey=...   │───────────────────────►│
       │───────────────────────────►│                        │
       │                            │   push: domain events  │
       │                            │◄───────────────────────│
       │                            │                        │
       │   POST /hooks/agent        │   status → idle        │
       │   {message, sessionKey,    │◄───────────────────────│
       │    agentId, wakeMode}      │                        │
       │◄───────────────────────────│                        │
       │                            │                        │
       ▼ notifies user in chat      │                        │
```

```bash
curl -s -X POST localhost:4774/threads \
  -H 'Content-Type: application/json' \
  -d "{\"projectId\": \"$PROJECT\",
       \"webhook\": {
         \"url\": \"http://openclaw:18789/hooks/agent\",
         \"format\": \"openclaw-hooks\",
         \"headers\": {\"Authorization\": \"Bearer token\"},
         \"events\": [\"completed\", \"error\"],
         \"metadata\": {
           \"agentId\": \"librus\",
           \"sessionKey\": \"agent:librus:telegram:-1003643494830:6\",
           \"host\": \"librus\"
         }
       },
       \"initialMessage\": {\"text\": \"Fix the calendar bug\"}}"
```

## Architecture

| File | Role |
|------|------|
| `src/index.ts` | Entry point — config, HTTP server, snapshot hydration on connect |
| `src/ws-client.ts` | Persistent WebSocket client (auto-reconnect, heartbeat, request matching) |
| `src/event-buffer.ts` | Per-thread circular buffer with streaming accumulation |
| `src/routes.ts` | Hono REST routes — HTTP ↔ WS translation |
| `src/webhook.ts` | Per-thread webhook delivery with retry and backoff |
| `src/openapi.yaml` | OpenAPI 3.1 spec (powers Swagger UI) |

Event buffer is in-memory only. T3 Code server is the source of truth — `GET /snapshot` rebuilds state after bridge restart.
