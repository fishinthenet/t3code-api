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
      const snapshot = await fetchSnapshot(ws);
      if (snapshot) {
        events.hydrateFromSnapshot(
          snapshot as Parameters<typeof events.hydrateFromSnapshot>[0],
        );
      }
    } catch {
      // Snapshot unavailable — proceed with empty buffer.
    }
  }

  /**
   * Reconcile one thread from the latest snapshot, even if it already exists
   * in the buffer. This keeps /status authoritative when live session events
   * miss a final transition but snapshot already reflects the final state.
   */
  async function reconcileThreadStatus(threadId: string) {
    try {
      const snapshot = await fetchSnapshot(ws);
      if (!snapshot) return;

      const threads = (snapshot.threads as Array<Record<string, unknown>> | undefined) ?? [];
      const thread = threads.find((t) => t.id === threadId);
      if (!thread) return;

      events.hydrateFromSnapshot({
        snapshotSequence: snapshot.snapshotSequence as number | undefined,
        threads: [thread] as Parameters<typeof events.hydrateFromSnapshot>[0]["threads"],
      });
    } catch {
      // Snapshot unavailable — keep buffered state.
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
    c.json({ ok: true, version: "0.0.20", connected: ws.connected, lastSequence: events.lastSequence }),
  );

  // ── Snapshot ────────────────────────────────────────────────────────

  app.get("/snapshot", async (c) => {
    const snapshot = await fetchSnapshot(ws);
    if (!snapshot) return c.json({ error: "Snapshot unavailable" }, 503);
    return c.json(snapshot);
  });

  // ── Threads ─────────────────────────────────────────────────────────

  app.post("/threads", async (c) => {
    const body = await c.req.json<{
      projectId: string;
      title?: string;
      provider?: "codex" | "claudeAgent";
      model?: string;
      modelOptions?: Record<string, unknown>;
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

    const modelSelection: Record<string, unknown> = { provider, model };
    if (body.modelOptions) modelSelection.options = body.modelOptions;

    // Step 1: Create the thread.
    // v0.0.18+: dispatchCommand payload is the command struct itself (flat,
    // discriminated by `type`). Previously it was nested under `{command: {...}}`.
    await ws.request("orchestration.dispatchCommand", {
      type: "thread.create",
      commandId: crypto.randomUUID(),
      threadId,
      projectId: body.projectId,
      title: body.title ?? "API Thread",
      model,
      modelSelection,
      runtimeMode,
      interactionMode,
      branch: null,
      worktreePath: body.workdir ?? null,
      createdAt: new Date().toISOString(),
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
        type: "thread.turn.start",
        commandId: crypto.randomUUID(),
        threadId,
        message: {
          messageId,
          role: "user",
          text: body.initialMessage.text,
          attachments,
        },
        provider,
        model,
        ...(body.modelOptions ? { modelOptions: body.modelOptions } : {}),
        runtimeMode,
        interactionMode,
        createdAt: new Date().toISOString(),
      });
    }

    return c.json({ threadId, ...(messageId ? { messageId } : {}) }, 201);
  });

  app.delete("/threads/:threadId", async (c) => {
    const { threadId } = c.req.param();
    await ws.request("orchestration.dispatchCommand", {
      type: "thread.delete",
      commandId: crypto.randomUUID(),
      threadId,
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
      modelOptions?: Record<string, unknown>;
      attachments?: AttachmentInput[];
    }>();

    const messageId = crypto.randomUUID();
    const commandId = crypto.randomUUID();

    const attachments = body.attachments?.length
      ? await Promise.all(body.attachments.map(resolveAttachment))
      : [];

    // Build optional per-turn model override.
    let turnModelSelection: Record<string, unknown> | undefined;
    if (body.provider || body.model) {
      turnModelSelection = {
        provider: body.provider ?? "codex",
        model: body.model ?? "gpt-5.4",
      };
      if (body.modelOptions) turnModelSelection.options = body.modelOptions;
    }

    await ws.request("orchestration.dispatchCommand", {
      type: "thread.turn.start",
      commandId,
      threadId,
      message: {
        messageId,
        role: "user",
        text: body.text,
        attachments,
      },
      ...(turnModelSelection ? { modelSelection: turnModelSelection } : {}),
      ...(body.provider ? { provider: body.provider } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.modelOptions ? { modelOptions: body.modelOptions } : {}),
      runtimeMode: body.runtimeMode ?? "full-access",
      interactionMode: body.interactionMode ?? "default",
      createdAt: new Date().toISOString(),
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
    await reconcileThreadStatus(threadId);

    const status = events.getThreadStatus(threadId);
    return c.json({ threadId, status });
  });

  // ── Interrupt ──────────────────────────────────────────────────────

  app.post("/threads/:threadId/interrupt", async (c) => {
    const { threadId } = c.req.param();
    await ws.request("orchestration.dispatchCommand", {
      type: "thread.turn.interrupt",
      commandId: crypto.randomUUID(),
      threadId,
      createdAt: new Date().toISOString(),
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

    // v0.0.18+: `toTurnCount` is required (non-optional). When the caller
    // omits a turn count, ask for everything by setting a large upper bound.
    const diff = await ws.request("orchestration.getFullThreadDiff", {
      threadId,
      toTurnCount: from > 0 ? from : 1_000_000,
    });
    return c.json(diff);
  });

  // ── Server settings ──────────────────────────────────────────────────

  app.get("/server/settings", async (c) => {
    const settings = await ws.request("server.getSettings");
    return c.json(settings);
  });

  app.patch("/server/settings", async (c) => {
    const patch = await c.req.json();
    const result = await ws.request("server.updateSettings", { patch });
    return c.json(result);
  });

  app.post("/server/providers/refresh", async (c) => {
    const result = await ws.request("server.refreshProviders", {});
    return c.json(result);
  });

  return app;
}

/**
 * Fetch a full orchestration snapshot via the subscribeShell stream.
 *
 * v0.0.18+ removed `orchestration.getSnapshot`. The shell subscription stream
 * emits the same data as its first chunk: `{kind: "snapshot", snapshot: {...}}`.
 * We open the stream, wait for the first snapshot chunk, cancel, and return.
 */
async function fetchSnapshot(
  ws: T3WebSocketClient,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { handle.cancel(); } catch { /* noop */ }
        resolve(null);
      }
    }, 5000);

    const handle = ws.requestStream<Record<string, unknown>>(
      "orchestration.subscribeShell",
      {},
      (values) => {
        if (resolved) return;
        for (const v of values) {
          const chunk = v as { kind?: string; snapshot?: Record<string, unknown> };
          if (chunk?.kind === "snapshot" && chunk.snapshot) {
            resolved = true;
            clearTimeout(timer);
            try { handle.cancel(); } catch { /* noop */ }
            resolve(chunk.snapshot);
            return;
          }
        }
      },
    );

    handle.done.catch(() => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}
