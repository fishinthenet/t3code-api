/**
 * REST API routes — thin layer over the T3 Code WebSocket protocol.
 */

import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { T3WebSocketClient } from "./ws-client";
import type { EventBuffer, DomainEvent } from "./event-buffer";
import type { WebhookConfig, WebhookManager } from "./webhook";

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

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
};

interface FileAttachmentInput {
  type: "image";
  path: string;
}

interface DataUrlAttachmentInput {
  type: "image";
  name: string;
  mimeType: string;
  dataUrl: string;
  sizeBytes: number;
}

type AttachmentInput = FileAttachmentInput | DataUrlAttachmentInput;

function isFileAttachment(a: AttachmentInput): a is FileAttachmentInput {
  return "path" in a && typeof a.path === "string";
}

async function resolveAttachment(input: AttachmentInput) {
  if (!isFileAttachment(input)) {
    return input;
  }

  const ext = extname(input.path).toLowerCase();
  const mime = MIME_TYPES[ext];
  if (!mime) {
    throw new Error(`Unsupported image extension: ${ext} (path: ${input.path})`);
  }

  const data = await readFile(input.path);
  const dataUrl = `data:${mime};base64,${data.toString("base64")}`;

  return {
    type: "image" as const,
    name: basename(input.path),
    mimeType: mime,
    dataUrl,
    sizeBytes: data.length,
  };
}

interface Deps {
  ws: T3WebSocketClient;
  events: EventBuffer;
  webhooks?: WebhookManager;
}

export function createRoutes({ ws, events, webhooks }: Deps) {
  const app = new Hono();

  // ── Global error handler ─────────────────────────────────────────
  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : "Unknown error";
    const isDisconnected = message.includes("not connected");
    return c.json(
      { error: isDisconnected ? "T3 Code server not connected" : message },
      isDisconnected ? 502 : 500,
    );
  });

  /** Ensure a thread's data is in the buffer, hydrating from snapshot if needed. */
  async function ensureHydrated(threadId: string) {
    if (events.hasThread(threadId)) return;
    try {
      const snapshot = await ws.request<Record<string, unknown>>(
        "orchestration.getSnapshot",
      );
      events.hydrateFromSnapshot(
        snapshot as Parameters<typeof events.hydrateFromSnapshot>[0],
      );
    } catch {
      // Snapshot unavailable — proceed with empty buffer.
    }
  }

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
      workdir?: string;
      initialMessage?: {
        text: string;
        attachments?: AttachmentInput[];
      };
      webhook?: WebhookConfig;
    }>();

    const threadId = crypto.randomUUID();
    const provider = body.provider ?? "codex";
    const model = body.model ?? "gpt-5.4";
    const runtimeMode = body.runtimeMode ?? "full-access";
    const interactionMode = body.interactionMode ?? "default";

    // Step 1: Create the thread.
    // Send both `model` (v0.0.14) and `modelSelection` (dev) for compatibility.
    await ws.request("orchestration.dispatchCommand", {
      command: {
        type: "thread.create",
        commandId: crypto.randomUUID(),
        threadId,
        projectId: body.projectId,
        title: body.title ?? "API Thread",
        model,
        provider,
        modelSelection: { provider, model },
        runtimeMode,
        interactionMode,
        branch: null,
        worktreePath: body.workdir ?? null,
        createdAt: new Date().toISOString(),
      },
    });

    // Register webhook if provided.
    if (body.webhook && webhooks) {
      webhooks.register(
        threadId,
        body.webhook,
        body.projectId,
        body.title ?? "API Thread",
      );
    }

    // Step 2: Optionally send the first message in the same request.
    let messageId: string | undefined;
    if (body.initialMessage) {
      messageId = crypto.randomUUID();

      const attachments = body.initialMessage.attachments?.length
        ? await Promise.all(body.initialMessage.attachments.map(resolveAttachment))
        : [];

      await ws.request("orchestration.dispatchCommand", {
        command: {
          type: "thread.turn.start",
          commandId: crypto.randomUUID(),
          threadId,
          message: {
            messageId,
            role: "user",
            text: body.initialMessage.text,
            attachments,
          },
          runtimeMode,
          interactionMode,
          createdAt: new Date().toISOString(),
        },
      });
    }

    return c.json({ threadId, ...(messageId ? { messageId } : {}) }, 201);
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
    webhooks?.remove(threadId);
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
      attachments?: AttachmentInput[];
    }>();

    const messageId = crypto.randomUUID();
    const commandId = crypto.randomUUID();

    const attachments = body.attachments?.length
      ? await Promise.all(body.attachments.map(resolveAttachment))
      : [];

    await ws.request("orchestration.dispatchCommand", {
      command: {
        type: "thread.turn.start",
        commandId,
        threadId,
        message: {
          messageId,
          role: "user",
          text: body.text,
          attachments,
        },
        // Send both flat fields (v0.0.14) and nested modelSelection (dev).
        ...(body.provider || body.model
          ? {
              provider: body.provider ?? "codex",
              model: body.model ?? "gpt-5.4",
              modelSelection: {
                provider: body.provider ?? "codex",
                model: body.model ?? "gpt-5.4",
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

  app.get("/threads/:threadId/messages", async (c) => {
    const { threadId } = c.req.param();
    const after = Number(c.req.query("after") || "0");
    const limit = Number(c.req.query("limit") || "50");

    await ensureHydrated(threadId);

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

  app.get("/threads/:threadId/status", async (c) => {
    const { threadId } = c.req.param();

    await ensureHydrated(threadId);

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
