# t3code-api — OpenClaw agent webhook flow

## What is this

REST API at `http://t3code:4774` that lets you dispatch coding tasks to agents (Codex/Claude) and get a callback when they finish.

## Prerequisites: OpenClaw gateway configuration

The OpenClaw gateway must have hooks enabled with the right session policy. In your OpenClaw config:

```yaml
hooks:
  enabled: true
  token: "<your-secret-token>"
  allowRequestSessionKey: true
  allowedSessionKeyPrefixes: ["agent:"]
```

| Setting | Required | Why |
|---------|----------|-----|
| `hooks.enabled` | **yes** | Enables the `/hooks/agent` endpoint |
| `hooks.token` | **yes** | Bearer token for authenticating webhook requests |
| `hooks.allowRequestSessionKey` | **yes** | Without this, OpenClaw rejects any `sessionKey` in the request body (returns 400) |
| `hooks.allowedSessionKeyPrefixes` | recommended | Restricts which session keys callers can target. Use `["agent:"]` to allow agent-scoped keys like `agent:my-agent:telegram:...` |

The `agentId` sent in the webhook must match a known agent in your OpenClaw config (listed under `agents.list`). If it doesn't match, OpenClaw routes to the default agent instead.

## Flow in 3 steps

### 1. Get `projectId`

```bash
curl -s http://t3code:4774/snapshot | jq -r '.projects[0].projectId'
```

### 2. Create a thread with a task and webhook

```bash
curl -s -X POST http://t3code:4774/threads \
  -H 'Content-Type: application/json' \
  -d '{
    "projectId": "<PROJECT_ID>",
    "initialMessage": { "text": "Fix the calendar bug" },
    "webhook": {
      "url": "http://your-openclaw-host:18789/hooks/agent",
      "format": "openclaw-hooks",
      "events": ["completed", "error"],
      "headers": { "Authorization": "Bearer <OPENCLAW_TOKEN>" },
      "metadata": {
        "agentId": "my-agent",
        "sessionKey": "agent:my-agent:telegram:-100123456789:1",
        "host": "my-agent"
      }
    }
  }'
```

Returns: `{ "threadId": "...", "messageId": "..." }`

### 3. Agent codes -> bridge fires callback -> OpenClaw wakes the agent

No polling needed. When the agent finishes (status `idle`/`ready`) or hits an error, the bridge POSTs to OpenClaw automatically:

```json
{
  "message": "Fix the calendar bug: status:idle (24 msgs, 38s)",
  "wakeMode": "now",
  "name": "t3code:Fix the calendar bug",
  "agentId": "my-agent",
  "sessionKey": "agent:my-agent:telegram:-100123456789:1"
}
```

OpenClaw parses the `sessionKey`, strips the `agent:my-agent:` prefix (since it matches `agentId`), and routes the notification to the `telegram:-100123456789:1` session — waking the agent in the correct chat.

## Metadata keys

| Key | Required | Purpose |
|-----|----------|---------|
| `sessionKey` | **yes** | Identifies the chat session to wake. Format: `agent:<agentId>:<channel>:<chat_id>:<topic_id>`. OpenClaw strips the `agent:<agentId>:` prefix before routing. |
| `agentId` | yes | Agent name in OpenClaw. Must be listed in `agents.list` config, otherwise falls back to default agent. |
| `host` | no | Appears in the notification message text |

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
| Bridge logs `returned 400` | `hooks.allowRequestSessionKey` is `false` (default) | Set `hooks.allowRequestSessionKey: true` in OpenClaw config |
| Callback arrives but wrong agent responds | `agentId` not in OpenClaw's `agents.list` | Add the agent to config or use the correct `agentId` |
| Callback arrives but no notification | `sessionKey` doesn't match an active session | Verify the session key matches the current chat (channel, chat_id, topic_id) |
| Bridge logs `ECONNREFUSED` | OpenClaw gateway unreachable | Check that the gateway is running and the URL/port is correct |
| No webhook logs at all | Bridge version < 0.0.15 (no webhook support) | Check `GET /health` returns `version: "0.0.19"` or later |

## Important

- Webhook config lives **in bridge memory** — lost on restart.
- `wakeMode` is always `"now"` (immediate delivery). OpenClaw also supports `"next-heartbeat"` but the bridge doesn't expose this.
- Retry: 3 attempts with backoff (1s -> 5s -> 15s), 10s timeout per attempt.
