/**
 * T3 Code API Bridge
 *
 * Lightweight REST proxy to a running T3 Code WebSocket server.
 * Maintains a persistent WS connection, buffers events per thread,
 * and exposes simple HTTP endpoints for external consumers.
 */

import { serve } from "bun";
import { T3WebSocketClient } from "./ws-client";
import { EventBuffer } from "./event-buffer";
import { WebhookManager } from "./webhook";
import { createRoutes } from "./routes";

// ── Config ────────────────────────────────────────────────────────────

const PORT = Number(process.env.T3API_PORT ?? 4774);
const T3_WS_URL = process.env.T3API_WS_URL ?? "ws://localhost:3773";
const API_TOKEN = process.env.T3API_TOKEN ?? undefined;
const MAX_EVENTS = Number(process.env.T3API_MAX_EVENTS ?? 500);

// ── Bootstrap ─────────────────────────────────────────────────────────

const events = new EventBuffer(MAX_EVENTS);
const webhooks = new WebhookManager();
const ws = new T3WebSocketClient(T3_WS_URL);

ws.onPush = (msg) => {
  if (msg.channel === "orchestration.domainEvent") {
    const event = msg.data as import("./event-buffer").DomainEvent;
    events.push(event);

    // Trigger webhooks on status transitions.
    if (event.type === "thread.session-set") {
      const threadId = event.payload?.threadId as string | undefined;
      const session = event.payload?.session as Record<string, unknown> | undefined;
      if (threadId && session?.status) {
        const messages = events.getMessages(threadId);
        webhooks.onStatusChange(threadId, session.status as string, {
          messagesCount: messages.length,
        });
      }
    }
  }
};

ws.onConnected = async () => {
  console.log(`[t3code-api] Connected to T3 Code at ${T3_WS_URL}`);

  // Hydrate event buffer with historical state from snapshot.
  try {
    const snapshot = await ws.request<Record<string, unknown>>("orchestration.getSnapshot");
    events.hydrateFromSnapshot(snapshot as Parameters<typeof events.hydrateFromSnapshot>[0]);
    const threads = (snapshot.threads as unknown[])?.length ?? 0;
    console.log(`[t3code-api] Hydrated ${threads} thread(s) from snapshot`);
  } catch (err) {
    console.warn(`[t3code-api] Failed to hydrate from snapshot:`, err);
  }
};

ws.onDisconnected = () => {
  console.log(`[t3code-api] Disconnected from T3 Code, will reconnect...`);
};

// ── HTTP Server ───────────────────────────────────────────────────────

const app = createRoutes({ ws, events, webhooks });

serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    // Skip auth for docs endpoints
    const isDocsRoute = url.pathname === "/docs" || url.pathname === "/openapi.yaml";

    if (API_TOKEN && !isDocsRoute) {
      const auth = req.headers.get("Authorization");
      if (auth !== `Bearer ${API_TOKEN}`) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return app.fetch(req);
  },
});

console.log(`[t3code-api] REST bridge listening on http://localhost:${PORT}`);
console.log(`[t3code-api] Upstream: ${T3_WS_URL}`);
console.log(`[t3code-api] Docs: http://localhost:${PORT}/docs`);
if (API_TOKEN) console.log(`[t3code-api] Auth: Bearer token required`);
else console.log(`[t3code-api] Auth: disabled (set T3API_TOKEN to enable)`);
