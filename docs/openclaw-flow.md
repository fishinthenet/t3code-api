# t3code-api — OpenClaw agent webhook flow

## What is this

REST API at `http://t3code:4774` that lets you dispatch coding tasks to agents (Codex/Claude) and get a callback when they finish. The callback wakes an OpenClaw agent in the correct chat/topic.

## OpenClaw configuration

### Hook mapping

OpenClaw has two kinds of hook endpoints:
- **Built-in** (`/hooks/agent`, `/hooks/wake`) — hardcoded handlers with their own validation, no mapping support
- **Custom paths** (`/hooks/t3code`, `/hooks/anything`) — routed through **mappings** with template interpolation, `deliver`, `channel`, `to`

For t3code callbacks, use a **custom path with a mapping**:

```yaml
hooks:
  enabled: true
  token: "<your-secret-token>"
  mappings:
    - id: t3code
      match:
        path: t3code                    # matches POST /hooks/t3code
      action: agent
      agentId: my-agent                 # must exist in agents.list
      messageTemplate: "{{message}}"    # extracts message from payload
      deliver: true                     # post result to channel
      channel: telegram                 # delivery channel
      to: "-100123456789:1"             # chat_id:topic_id
```

### Mapping fields

| Field | Required | Purpose |
|-------|----------|---------|
| `match.path` | **yes** | URL path segment after `/hooks/` (e.g. `t3code` matches `/hooks/t3code`) |
| `action` | no | `"agent"` (default) or `"wake"`. Agent runs an agent turn; wake just enqueues a notification |
| `agentId` | yes | Which OpenClaw agent handles the callback. Must be in `agents.list` config |
| `messageTemplate` | yes | Template for the agent message. `{{message}}` extracts the `message` field from the POST body |
| `deliver` | **yes** | Must be `true` to post the result to a channel |
| `channel` | **yes** | Target channel: `telegram`, `discord`, `whatsapp`, etc. |
| `to` | **yes** | Destination in that channel. For Telegram: `chat_id:topic_id` (e.g. `-100123456789:362`) |

> **Why not `/hooks/agent`?** The `/hooks/agent` endpoint has its own validation and ignores mappings. It requires `allowRequestSessionKey: true` and `sessionKey`-based routing which is harder to set up. The mapping approach is simpler and more flexible.

> **Template interpolation** works in `messageTemplate`, `sessionKey`, `textTemplate` — any mapping string field supports `{{payload.field}}` syntax. However, hardcoded values (e.g. `to`, `channel`) are often simpler and more reliable than templates.

## Flow in 3 steps

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
      "metadata": {
        "host": "my-agent"
      }
    }
  }'
```

Returns: `{ "threadId": "...", "messageId": "..." }`

### 3. Agent codes → bridge fires callback → OpenClaw delivers notification

No polling needed. When the agent finishes (status `idle`/`ready`) or hits an error, the bridge POSTs to your custom hook path:

```json
{
  "message": "🔔 t3code: \"Fix the calendar bug\" — status:idle (idle, 24 msgs, 38s)\nthreadId: abc-123\nhost: my-agent",
  "wakeMode": "now",
  "name": "t3code:Fix the calendar bug"
}
```

OpenClaw matches the path `t3code` → runs the mapping → agent processes the notification → result is delivered to the configured Telegram chat/topic.

## Webhook metadata

| Key | Required | Purpose |
|-----|----------|---------|
| `host` | no | Included in the notification message text (identifies which host ran the task) |

> Note: `agentId` and `sessionKey` are **not needed** in metadata when using mappings — the mapping config defines routing.

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

## Multiple channels

To deliver to different chats/topics, create separate mappings per destination:

```yaml
hooks:
  enabled: true
  token: "<your-secret-token>"
  mappings:
    - id: t3code-main
      match:
        path: t3code-main
      action: agent
      agentId: my-agent
      messageTemplate: "{{message}}"
      deliver: true
      channel: telegram
      to: "-100123456789:1"

    - id: t3code-dev
      match:
        path: t3code-dev
      action: agent
      agentId: dev-agent
      messageTemplate: "{{message}}"
      deliver: true
      channel: telegram
      to: "-100987654321:42"
```

Then point each thread's webhook URL at the appropriate path (`/hooks/t3code-main` or `/hooks/t3code-dev`).

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| OpenClaw returns 404 | No mapping matches the path | Check `match.path` matches the URL path segment |
| OpenClaw returns 401 | Wrong or missing token | Check `Authorization: Bearer <token>` matches `hooks.token` |
| Callback arrives but no notification | `deliver` is `false` or missing `to` | Set `deliver: true` and `to: "<destination>"` in the mapping |
| Wrong agent responds | `agentId` not in `agents.list` | Add the agent to config or use the correct `agentId` |
| Bridge logs `ECONNREFUSED` | OpenClaw gateway unreachable | Check that the gateway is running and the URL/port is correct |
| No webhook logs at all | Bridge too old | Check `GET /health` returns `version: "0.0.20"` or later |

## Important

- Webhook config lives **in bridge memory** — lost on restart.
- `wakeMode` is always `"now"` (immediate delivery). OpenClaw also supports `"next-heartbeat"` but the bridge doesn't expose this.
- Retry: 3 attempts with backoff (1s → 5s → 15s), 10s timeout per attempt.
