/**
 * REST API routes — thin layer over the T3 Code WebSocket protocol.
 */

import { Hono } from "hono";
import type { T3WebSocketClient } from "./ws-client";
import type { EventBuffer, DomainEvent } from "./event-buffer";

const SWAGGER_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>t3code-api</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"/>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>SwaggerUIBundle({ url: "/openapi.yaml", dom_id: "#swagger-ui" })</script>
</body>
</html>`;

interface Deps {
  ws: T3WebSocketClient;
  events: EventBuffer;
}

export function createRoutes({ ws, events }: Deps) {
  const app = new Hono();

  // ── Docs ──────────────────────────────────────────────────────────

  app.get("/docs", (c) => c.html(SWAGGER_UI_HTML));

  app.get("/openapi.yaml", async (c) => {
    const spec = await Bun.file(new URL("openapi.yaml", import.meta.url)).text();
    return c.text(spec, 200, { "Content-Type": "text/yaml" });
  });

  // ── Health ──────────────────────────────────────────────────────────

  app.get("/health", (c) =>
    c.json({ ok: true, connected: ws.connected, lastSequence: events.lastSequence }),
  );

  // ── Snapshot ────────────────────────────────────────────────────────

  app.get("/snapshot", async (c) => {
    const snapshot = await ws.request("orchestration.getSnapshot");
    return c.json(snapshot);
  });

  // ── Threads ─────────────────────────────────────────────────────────

  app.post("/threads", async (c) => {
    const body = await c.req.json<{
      projectId: string;
      title?: string;
      provider?: "codex" | "claudeAgent";
      model?: string;
      runtimeMode?: "approval-required" | "full-access";
      interactionMode?: "default" | "plan";
    }>();

    const threadId = crypto.randomUUID();
    const commandId = crypto.randomUUID();

    await ws.request("orchestration.dispatchCommand", {
      command: {
        type: "thread.create",
        commandId,
        threadId,
        projectId: body.projectId,
        title: body.title ?? "API Thread",
        modelSelection: {
          provider: body.provider ?? "codex",
          model: body.model ?? "o3",
        },
        runtimeMode: body.runtimeMode ?? "full-access",
        interactionMode: body.interactionMode ?? "default",
        branch: null,
        worktreePath: null,
        createdAt: new Date().toISOString(),
      },
    });

    return c.json({ threadId }, 201);
  });

  app.delete("/threads/:threadId", async (c) => {
    const { threadId } = c.req.param();
    await ws.request("orchestration.dispatchCommand", {
      command: {
        type: "thread.delete",
        commandId: crypto.randomUUID(),
        threadId,
      },
    });
    events.drop(threadId);
    return c.json({ deleted: true });
  });

  // ── Messages ────────────────────────────────────────────────────────

  app.post("/threads/:threadId/messages", async (c) => {
    const { threadId } = c.req.param();
    const body = await c.req.json<{
      text: string;
      runtimeMode?: "approval-required" | "full-access";
      interactionMode?: "default" | "plan";
      provider?: "codex" | "claudeAgent";
      model?: string;
    }>();

    const messageId = crypto.randomUUID();
    const commandId = crypto.randomUUID();

    await ws.request("orchestration.dispatchCommand", {
      command: {
        type: "thread.turn.start",
        commandId,
        threadId,
        message: {
          messageId,
          role: "user",
          text: body.text,
          attachments: [],
        },
        ...(body.provider || body.model
          ? {
              modelSelection: {
                provider: body.provider ?? "codex",
                model: body.model ?? "o3",
              },
            }
          : {}),
        runtimeMode: body.runtimeMode ?? "full-access",
        interactionMode: body.interactionMode ?? "default",
        createdAt: new Date().toISOString(),
      },
    });

    return c.json({ messageId, commandId }, 201);
  });

  app.get("/threads/:threadId/messages", (c) => {
    const { threadId } = c.req.param();
    const after = Number(c.req.query("after") || "0");
    const limit = Number(c.req.query("limit") || "50");
    const messages = events.getMessages(threadId, {
      afterSequence: after || undefined,
      limit,
    });
    return c.json({ messages, lastSequence: events.lastSequence });
  });

  // ── Events (raw) ───────────────────────────────────────────────────

  app.get("/threads/:threadId/events", (c) => {
    const { threadId } = c.req.param();
    const after = Number(c.req.query("after") || "0");
    const limit = Number(c.req.query("limit") || "100");
    const types = c.req.query("types")?.split(",").filter(Boolean);
    const threadEvents = events.getEvents(threadId, {
      afterSequence: after || undefined,
      types: types?.length ? types : undefined,
      limit,
    });
    return c.json({ events: threadEvents, lastSequence: events.lastSequence });
  });

  // ── Thread status ──────────────────────────────────────────────────

  app.get("/threads/:threadId/status", (c) => {
    const { threadId } = c.req.param();
    const status = events.getThreadStatus(threadId);
    return c.json({ threadId, status });
  });

  // ── Interrupt ──────────────────────────────────────────────────────

  app.post("/threads/:threadId/interrupt", async (c) => {
    const { threadId } = c.req.param();
    await ws.request("orchestration.dispatchCommand", {
      command: {
        type: "thread.turn.interrupt",
        commandId: crypto.randomUUID(),
        threadId,
        createdAt: new Date().toISOString(),
      },
    });
    return c.json({ interrupted: true });
  });

  // ── Diff ───────────────────────────────────────────────────────────

  app.get("/threads/:threadId/diff", async (c) => {
    const { threadId } = c.req.param();
    const from = Number(c.req.query("from") || "0");
    const to = Number(c.req.query("to") || "0");

    if (to > 0) {
      const diff = await ws.request("orchestration.getTurnDiff", {
        threadId,
        fromTurnCount: from,
        toTurnCount: to,
      });
      return c.json(diff);
    }

    const diff = await ws.request("orchestration.getFullThreadDiff", {
      threadId,
      toTurnCount: from || undefined,
    });
    return c.json(diff);
  });

  return app;
}
