# t3code-api — OpenClaw agent webhook flow

## What is this

REST API at `http://t3code:4774` that lets you dispatch coding tasks to agents (Codex/Claude) and get a callback when they finish.

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
      "url": "http://openclaw:18789/hooks/agent",
      "format": "openclaw-hooks",
      "events": ["completed", "error"],
      "headers": { "Authorization": "Bearer <OPENCLAW_TOKEN>" },
      "metadata": {
        "agentId": "librus",
        "sessionKey": "agent:librus:telegram:-1003643494830:6",
        "host": "librus"
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
  "wakeMode": "agent",
  "name": "t3code (librus)",
  "agentId": "librus",
  "sessionKey": "agent:librus:telegram:-1003643494830:6"
}
```

OpenClaw delivers the notification to the correct chat session (Telegram/Discord) identified by `sessionKey`.

## Metadata keys

| Key | Required | Purpose |
|-----|----------|---------|
| `sessionKey` | **yes** | Identifies the chat session to wake (e.g. `agent:librus:telegram:<chat_id>:<thread_id>`) |
| `agentId` | yes | Agent name in OpenClaw (e.g. `librus`) |
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

## Important

- Webhook config lives **in bridge memory** — lost on restart.
- `sessionKey` must exactly match the active session in OpenClaw, otherwise the callback arrives but won't wake the agent.
- Retry: 3 attempts with backoff (1s -> 5s -> 15s), 10s timeout per attempt.
