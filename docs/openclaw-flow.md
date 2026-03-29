# t3code-api — flow dla agenta OpenClaw

## Co to jest

REST API pod `http://t3code:4774` pozwalające zlecać zadania kodowania agentom (Codex/Claude) i dostawać callback gdy skończą.

## Flow w 3 krokach

### 1. Pobierz `projectId`

```bash
curl -s http://t3code:4774/snapshot | jq -r '.projects[0].projectId'
```

### 2. Utwórz wątek z zadaniem i webhookiem

```bash
curl -s -X POST http://t3code:4774/threads \
  -H 'Content-Type: application/json' \
  -d '{
    "projectId": "<PROJECT_ID>",
    "initialMessage": { "text": "Napraw bug w kalendarzu" },
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

Zwraca: `{ "threadId": "...", "messageId": "..." }`

### 3. Agent koduje -> bridge wywołuje callback -> OpenClaw budzi agenta

Nie musisz pollować. Gdy agent skończy (status `idle`/`ready`) lub wystąpi błąd, bridge sam wyśle POST na OpenClaw:

```json
{
  "message": "Napraw bug: status:idle (24 msgs, 38s)",
  "wakeMode": "agent",
  "name": "t3code (librus)",
  "agentId": "librus",
  "sessionKey": "agent:librus:telegram:-1003643494830:6"
}
```

OpenClaw dostarcza powiadomienie do właściwej sesji czatu (Telegram/Discord) identyfikowanej przez `sessionKey`.

## Klucze w `metadata`

| Klucz | Wymagany | Co robi |
|-------|----------|---------|
| `sessionKey` | **tak** | Identyfikuje sesję czatu do wybudzenia (np. `agent:librus:telegram:<chat_id>:<thread_id>`) |
| `agentId` | tak | Nazwa agenta w OpenClaw (np. `librus`) |
| `host` | nie | Pojawia się w tekście powiadomienia |

## Opcjonalnie: odczyt wyników

Po callbacku agent może pobrać wynik:

```bash
# Wiadomości z odpowiedzią agenta
curl -s "http://t3code:4774/threads/<THREAD_ID>/messages" | jq '.messages[-1].text'

# Diff zmian w plikach
curl -s "http://t3code:4774/threads/<THREAD_ID>/diff"
```

## Opcje wątku

- `provider`: `"codex"` (domyślny) lub `"claudeAgent"`
- `model`: `"gpt-5.4"`, `"claude-opus-4-6"`, `"claude-sonnet-4-6"`
- `modelOptions`: `{ "reasoningEffort": "high" }` (Codex) lub `{ "thinking": true, "effort": "high" }` (Claude)
- `runtimeMode`: `"full-access"` (domyślny) lub `"approval-required"`
- `workdir`: ścieżka do katalogu roboczego (opcjonalna)

## Ważne

- Webhook config żyje **w pamięci bridge'a** — ginie przy restarcie.
- `sessionKey` musi dokładnie odpowiadać aktywnej sesji w OpenClaw, inaczej callback dotrze ale nie wybudzi agenta.
- Retry: 3 próby z backoff (1s -> 5s -> 15s), timeout 10s.
