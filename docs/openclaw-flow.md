# t3code-api — OpenClaw agent webhook flow

## What is this

REST API at `http://t3code:4774` that lets you dispatch coding tasks to agents (Codex/Claude) and get a callback when they finish. The callback notifies an OpenClaw agent in the correct chat/topic.

## Important: use custom hook paths

OpenClaw has two kinds of hook endpoints:
- **Built-in** (`/hooks/agent`, `/hooks/wake`) — hardcoded handlers with their own validation, **mappings don't apply**
- **Custom paths** (`/hooks/t3code`, `/hooks/anything`) — routed through **mappings** with template interpolation, delivery routing, etc.

Always use a **custom path** for t3code callbacks.

## Two approaches

### Option A: Direct delivery (simpler)

Mapping delivers the notification directly to a specific chat/topic. No agent routing logic needed.

```yaml
hooks:
  enabled: true
  token: "<your-secret-token>"
  mappings:
    - id: t3code
      match:
        path: t3code
      action: agent
      agentId: my-agent
      messageTemplate: "{{message}}"
      deliver: true
      channel: telegram
      to: "-100123456789:1"          # chat_id:topic_id
```

**Pros**: simple, one mapping per destination.
**Cons**: hardcoded destination — need separate mappings (and webhook URLs) per chat/topic.

### Option B: Wake main session (more flexible)

Mapping wakes the agent's main session. The agent itself decides where to route the notification.

```yaml
hooks:
  enabled: true
  token: "<your-secret-token>"
  mappings:
    - id: t3code
      match:
        path: t3code
      action: agent
      wakeMode: "now"
      name: "t3code webhook → agent wake"
      agentId: my-agent
      sessionKey: "agent:my-agent:main"
      messageTemplate: "{{message}}"
      deliver: false
```

**How it works**:
1. `deliver: false` — the isolated hook session does NOT post to a channel
2. Result goes as a `systemEvent` to the main session (`sessionKey: "agent:my-agent:main"`)
3. Agent wakes up, sees the notification, checks diff via t3code API
4. Agent itself routes the report to the correct chat/topic

**Pros**: single mapping handles all destinations — agent has the context to route intelligently.
**Cons**: agent must have routing logic.

### Mapping fields reference

| Field | Purpose |
|-------|---------|
| `match.path` | URL path segment after `/hooks/` (e.g. `t3code` → `/hooks/t3code`) |
| `action` | `"agent"` (default) — runs an agent turn. `"wake"` — enqueues a notification |
| `agentId` | Which agent to run. Must be in `agents.list` |
| `messageTemplate` | Template for the message. `{{field}}` accesses POST body fields |
| `deliver` | `true` = post result to channel. `false` = result goes as systemEvent to session |
| `channel` | Target channel for delivery: `telegram`, `discord`, `whatsapp`, etc. |
| `to` | Destination in channel. Telegram: `chat_id:topic_id` |
| `sessionKey` | Target session to wake (Option B). Format: `agent:<agentId>:main` |
| `wakeMode` | `"now"` (immediate) or `"next-heartbeat"` |

> **Template interpolation** works in `messageTemplate`, `sessionKey`, `textTemplate` — supports `{{field}}` to access POST body fields. Available fields depend on the webhook format (see below).

## Flow

### 1. Get `projectId`

```bash
curl -s http://t3code:4774/snapshot | jq -r '.projects[0].id'
```

### 2. Create a thread with a task and webhook

```bash
curl -s -X POST http://t3code:4774/threads \
  -H 'Content-Type: application/json' \
  -d '{
    "projectId": "<PROJECT_ID>",
    "initialMessage": { "text": "Fix the calendar bug" },
    "webhook": {
      "url": "http://your-openclaw-host:18789/hooks/t3code",
      "format": "openclaw-hooks",
      "events": ["completed", "error"],
      "headers": { "Authorization": "Bearer <OPENCLAW_TOKEN>" },
      "metadata": { "host": "my-agent" }
    }
  }'
```

Returns: `{ "threadId": "...", "messageId": "..." }`

### 3. Agent codes → bridge fires callback → OpenClaw notifies

No polling needed. When the agent finishes or hits an error, the bridge POSTs to `/hooks/t3code`. OpenClaw matches the mapping and either delivers directly (Option A) or wakes the main session (Option B).

## Webhook formats

### `"openclaw-hooks"` format (recommended)

Sends a compact payload with a pre-formatted message:

```json
{
  "message": "🔔 t3code: \"Fix the calendar bug\" — status:idle (idle, 24 msgs, 38s)\nthreadId: abc-123\nhost: my-agent",
  "wakeMode": "now",
  "name": "t3code:Fix the calendar bug"
}
```

Template variable: `{{message}}` — the full pre-formatted notification text.

### `"default"` format

Sends a structured payload with all fields accessible via templates:

```json
{
  "event": "status:idle",
  "webhookSeq": 1,
  "message": "Fix the calendar bug: status:idle (24 msgs, 38s)",
  "threadId": "abc-123",
  "projectId": "proj-1",
  "title": "Fix the calendar bug",
  "status": "idle",
  "previousStatus": "running",
  "durationMs": 38000,
  "messagesCount": 24,
  "metadata": { "host": "my-agent" }
}
```

Template variables: `{{title}}`, `{{threadId}}`, `{{event}}`, `{{status}}`, `{{messagesCount}}`, `{{durationMs}}`, `{{metadata.host}}`, etc.

## Optional: read results after callback

```bash
# Agent's reply messages
curl -s "http://t3code:4774/threads/<THREAD_ID>/messages" | jq '.messages[-1].text'

# File changes diff
curl -s "http://t3code:4774/threads/<THREAD_ID>/diff"
```

## Thread options

- `provider`: `"codex"` (default) or `"claudeAgent"`
- `model`: `"gpt-5.4"`, `"claude-opus-4-6"`, `"claude-sonnet-4-6"`
- `modelOptions`: `{ "reasoningEffort": "high" }` (Codex) or `{ "thinking": true, "effort": "high" }` (Claude)
- `runtimeMode`: `"full-access"` (default) or `"approval-required"`
- `workdir`: absolute path to working directory (optional)

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| OpenClaw returns 404 | No mapping matches the path | Check `match.path` matches the URL path segment |
| OpenClaw returns 401 | Wrong or missing token | Check `Authorization: Bearer <token>` matches `hooks.token` |
| Callback arrives but no notification | `deliver` is `false` without `sessionKey` | Either set `deliver: true` + `channel`/`to`, or set `sessionKey` for wake |
| Wrong agent responds | `agentId` not in `agents.list` | Add the agent to config or use the correct `agentId` |
| Bridge logs `ECONNREFUSED` | OpenClaw gateway unreachable | Check that the gateway is running and the URL/port is correct |
| No webhook logs at all | Bridge too old | Check `GET /health` returns `version: "0.0.20"` or later |

## Important

- Webhook config lives **in bridge memory** — lost on restart.
- Retry: 3 attempts with backoff (1s → 5s → 15s), 10s timeout per attempt.
