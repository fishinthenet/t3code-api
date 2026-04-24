import { describe, it, expect, mock, beforeEach } from "bun:test";
import { EventBuffer } from "./event-buffer";
import { createRoutes } from "./routes";
import { WebhookManager } from "./webhook";
import type { T3WebSocketClient } from "./ws-client";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Mock WS client ──────────────────────────────────────────────────

function createMockWs(streamSnapshot?: Record<string, unknown> | null): T3WebSocketClient {
  const mockRequestStream = mock(
    (_tag: string, _params: Record<string, unknown>, onChunk: (values: unknown[]) => void) => {
      const snapshot = streamSnapshot;
      if (snapshot) {
        // Simulate first chunk being the snapshot, then resolve.
        setTimeout(() => onChunk([{ kind: "snapshot", snapshot }]), 0);
      }
      let resolveDone!: (v: unknown[]) => void;
      let rejectDone!: (error: Error) => void;
      const done = new Promise<unknown[]>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });
      if (!snapshot) {
        queueMicrotask(() => rejectDone(new Error("No snapshot")));
      }
      return {
        id: "mock-stream-1",
        done,
        cancel: () => resolveDone([]),
      };
    },
  );

  return {
    connected: true,
    request: mock(() => Promise.resolve({ sequence: 1 })),
    requestStream: mockRequestStream,
    dispose: mock(() => {}),
    onPush: null,
    onConnected: null,
    onDisconnected: null,
  } as unknown as T3WebSocketClient;
}

// ── Helpers ──────────────────────────────────────────────────────────

function makeApp(streamSnapshot?: Record<string, unknown> | null) {
  const ws = createMockWs(streamSnapshot);
  const events = new EventBuffer();
  const webhooks = new WebhookManager();
  const app = createRoutes({ ws, events, webhooks });
  return { app, ws, events, webhooks };
}

async function json(app: ReturnType<typeof createRoutes>, path: string, init?: RequestInit) {
  const url = `http://localhost${path}`;
  const r = await app.request(url, init);
  return {
    status: r.status,
    body: (await r.json()) as Record<string, unknown>,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("routes", () => {
  describe("GET /health", () => {
    it("returns health status", async () => {
      const { app } = makeApp();
      const res = await json(app, "/health");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body).toHaveProperty("connected");
      expect(res.body).toHaveProperty("lastSequence");
    });
  });

  describe("GET /docs", () => {
    it("returns HTML with swagger-ui", async () => {
      const { app } = makeApp();
      const res = await app.request(new Request("http://localhost/docs"));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("swagger-ui");
    });
  });

  describe("POST /threads", () => {
    it("creates a thread and returns threadId", async () => {
      const { app, ws } = makeApp();
      const res = await json(app, "/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "proj-1" }),
      });

      expect(res.status).toBe(201);
      expect(res.body.threadId).toBeDefined();
      expect(typeof res.body.threadId).toBe("string");
      expect(res.body).not.toHaveProperty("messageId");

      // Should have called ws.request with thread.create
      expect(ws.request).toHaveBeenCalledTimes(1);
      const [tag, params] = (ws.request as ReturnType<typeof mock>).mock.calls[0];
      expect(tag).toBe("orchestration.dispatchCommand");
      expect(params.type).toBe("thread.create");
      expect(params.projectId).toBe("proj-1");
      expect(params.modelSelection).toEqual({ provider: "codex", model: "gpt-5.4" });
      // Flat model field also sent for v0.0.14 backward compatibility.
      expect(params.model).toBe("gpt-5.4");
    });

    it("passes workdir as worktreePath", async () => {
      const { app, ws } = makeApp();
      await json(app, "/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "proj-1", workdir: "/opt/my-project" }),
      });

      const [tag, params] = (ws.request as ReturnType<typeof mock>).mock.calls[0];
      expect(tag).toBe("orchestration.dispatchCommand");
      expect(params.type).toBe("thread.create");
      expect(params.worktreePath).toBe("/opt/my-project");
    });

    it("sets worktreePath to null when workdir not provided", async () => {
      const { app, ws } = makeApp();
      await json(app, "/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "proj-1" }),
      });

      const [, params] = (ws.request as ReturnType<typeof mock>).mock.calls[0];
      expect(params.worktreePath).toBeNull();
    });

    it("passes workdir with initialMessage together", async () => {
      const { app, ws } = makeApp();
      const res = await json(app, "/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "proj-1",
          workdir: "/opt/my-project",
          initialMessage: { text: "List files" },
        }),
      });

      expect(res.status).toBe(201);
      expect(res.body.threadId).toBeDefined();
      expect(res.body.messageId).toBeDefined();

      // thread.create has worktreePath
      const [, createParams] = (ws.request as ReturnType<typeof mock>).mock.calls[0];
      expect(createParams.type).toBe("thread.create");
      expect(createParams.worktreePath).toBe("/opt/my-project");

      // thread.turn.start uses the same threadId
      const [, turnParams] = (ws.request as ReturnType<typeof mock>).mock.calls[1];
      expect(turnParams.type).toBe("thread.turn.start");
      expect(turnParams.threadId).toBe(createParams.threadId);
      expect(turnParams.message.text).toBe("List files");
    });

    it("sends initialMessage as a second dispatch", async () => {
      const { app, ws } = makeApp();
      const res = await json(app, "/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "proj-1",
          initialMessage: { text: "Do something" },
        }),
      });

      expect(res.status).toBe(201);
      expect(res.body.threadId).toBeDefined();
      expect(res.body.messageId).toBeDefined();

      // Two ws.request calls: thread.create + thread.turn.start
      expect(ws.request).toHaveBeenCalledTimes(2);
      const [, createParams] = (ws.request as ReturnType<typeof mock>).mock.calls[0];
      const [, turnParams] = (ws.request as ReturnType<typeof mock>).mock.calls[1];
      expect(createParams.type).toBe("thread.create");
      expect(turnParams.type).toBe("thread.turn.start");
      expect(turnParams.message.text).toBe("Do something");
    });
  });

  describe("POST /threads/:id/messages", () => {
    it("sends a message with correct command structure", async () => {
      const { app, ws } = makeApp();
      const res = await json(app, "/threads/tid-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello agent" }),
      });

      expect(res.status).toBe(201);
      expect(res.body.messageId).toBeDefined();
      expect(res.body.commandId).toBeDefined();

      const [tag, params] = (ws.request as ReturnType<typeof mock>).mock.calls[0];
      expect(tag).toBe("orchestration.dispatchCommand");
      expect(params.type).toBe("thread.turn.start");
      expect(params.threadId).toBe("tid-1");
      expect(params.message.text).toBe("Hello agent");
    });

    it("includes modelSelection when provider/model overridden", async () => {
      const { app, ws } = makeApp();
      await json(app, "/threads/tid-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Hello",
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        }),
      });

      const [, params] = (ws.request as ReturnType<typeof mock>).mock.calls[0];
      expect(params.modelSelection).toEqual({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      });
      // Flat fields also sent for v0.0.14 backward compatibility.
      expect(params.provider).toBe("claudeAgent");
      expect(params.model).toBe("claude-opus-4-6");
    });

    it("does not include modelSelection when no override", async () => {
      const { app, ws } = makeApp();
      await json(app, "/threads/tid-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello" }),
      });

      const [, params] = (ws.request as ReturnType<typeof mock>).mock.calls[0];
      expect(params.modelSelection).toBeUndefined();
    });
  });

  describe("POST /threads/:id/messages with file attachments", () => {
    let tmpDir: string;
    let imgPath: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "t3api-test-"));
      // 1x1 red PNG
      const pngBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
        "base64",
      );
      imgPath = join(tmpDir, "test.png");
      await writeFile(imgPath, pngBytes);
    });

    it("resolves file path attachments to data URLs", async () => {
      const { app, ws } = makeApp();
      await json(app, "/threads/tid-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Check this",
          attachments: [{ type: "image", path: imgPath }],
        }),
      });

      const [, params] = (ws.request as ReturnType<typeof mock>).mock.calls[0];
      const att = params.message.attachments[0];
      expect(att.name).toBe("test.png");
      expect(att.mimeType).toBe("image/png");
      expect(att.dataUrl).toMatch(/^data:image\/png;base64,/);
      expect(att.sizeBytes).toBeGreaterThan(0);

      await unlink(imgPath);
    });
  });

  describe("GET /threads/:id/messages", () => {
    it("returns accumulated messages from event buffer", async () => {
      const { app, events } = makeApp();
      let seq = 0;
      const pushMsg = (
        msgId: string,
        role: string,
        text: string,
        streaming: boolean,
      ) => {
        seq++;
        events.push({
          sequence: seq,
          eventId: `e-${seq}`,
          type: "thread.message-sent",
          aggregateId: "tid-1",
          occurredAt: new Date().toISOString(),
          payload: {
            threadId: "tid-1",
            messageId: msgId,
            role,
            text,
            streaming,
            turnId: "turn-1",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        });
      };

      pushMsg("m1", "user", "Hello", false);
      pushMsg("m2", "assistant", "Hi ", true);
      pushMsg("m2", "assistant", "there!", true);
      pushMsg("m2", "assistant", "", false);

      const res = await json(app, "/threads/tid-1/messages");
      expect(res.status).toBe(200);

      const msgs = res.body.messages as Array<Record<string, unknown>>;
      expect(msgs).toHaveLength(2);
      expect(msgs[0].text).toBe("Hello");
      expect(msgs[1].text).toBe("Hi there!");
      expect(msgs[1].streaming).toBe(false);
    });
  });

  describe("DELETE /threads/:id", () => {
    it("dispatches thread.delete and drops buffer", async () => {
      const { app, ws, events } = makeApp();
      events.push({
        sequence: 1,
        eventId: "e1",
        type: "thread.created",
        aggregateId: "tid-1",
        occurredAt: new Date().toISOString(),
        payload: { threadId: "tid-1" },
      });
      expect(events.knownThreadIds()).toContain("tid-1");

      const res = await json(app, "/threads/tid-1", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
      expect(events.knownThreadIds()).not.toContain("tid-1");
    });
  });

  describe("POST /threads/:id/interrupt", () => {
    it("dispatches thread.turn.interrupt", async () => {
      const { app, ws } = makeApp();
      const res = await json(app, "/threads/tid-1/interrupt", { method: "POST" });
      expect(res.status).toBe(200);
      expect(res.body.interrupted).toBe(true);

      const [, params] = (ws.request as ReturnType<typeof mock>).mock.calls[0];
      expect(params.type).toBe("thread.turn.interrupt");
      expect(params.threadId).toBe("tid-1");
    });
  });

  describe("GET /threads/:id/status", () => {
    it("returns thread status from session events", async () => {
      const { app, events } = makeApp();
      events.push({
        sequence: 1,
        eventId: "e1",
        type: "thread.session-set",
        aggregateId: "tid-1",
        occurredAt: new Date().toISOString(),
        payload: { threadId: "tid-1", session: { status: "running" } },
      });

      const res = await json(app, "/threads/tid-1/status");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("running");
    });

    it("returns null when no session events", async () => {
      const { app } = makeApp();
      const res = await json(app, "/threads/tid-1/status");
      expect(res.body.status).toBeNull();
    });

    it("hydrates from snapshot when thread not in buffer", async () => {
      const snapshotData = {
        snapshotSequence: 50,
        threads: [
          {
            id: "tid-hydrate",
            messages: [],
            session: { status: "idle" },
          },
        ],
      };
      const ws = createMockWs(snapshotData);
      const events = new EventBuffer();
      const app = createRoutes({ ws, events });

      const res = await json(app, "/threads/tid-hydrate/status");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("idle");
    });

    it("returns snapshot-corrected status for thread with stale buffered status", async () => {
      // Regression: thread already in buffer with stale "running" status.
      // After reconnect, hydrateFromSnapshot must correct it to snapshot's value.
      const snapshotData = {
        snapshotSequence: 200,
        threads: [
          {
            id: "tid-stale",
            messages: [],
            session: { status: "ready" },
          },
        ],
      };
      const ws = createMockWs(snapshotData);
      const events = new EventBuffer();
      const app = createRoutes({ ws, events });

      // Simulate pre-reconnect state: thread exists with stale "running" status.
      events.push({
        sequence: 1,
        eventId: "e-stale",
        type: "thread.session-set",
        aggregateId: "tid-stale",
        occurredAt: new Date().toISOString(),
        payload: { threadId: "tid-stale", session: { status: "running" } },
      });
      expect(events.getThreadStatus("tid-stale")).toBe("running");

      // Simulate reconnect: hydrate from snapshot (as onConnected would do).
      events.hydrateFromSnapshot(
        snapshotData as Parameters<typeof events.hydrateFromSnapshot>[0],
      );

      // GET /status must return the snapshot-corrected value.
      const res = await json(app, "/threads/tid-stale/status");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ready");
    });
  });

  describe("GET /threads/:id/messages — snapshot hydration", () => {
    it("hydrates messages from snapshot when thread not in buffer", async () => {
      const snapshotData = {
        snapshotSequence: 100,
        threads: [
          {
            id: "tid-snap",
            messages: [
              {
                id: "m1",
                role: "user",
                text: "From snapshot",
                turnId: null,
                streaming: false,
                createdAt: "2026-03-27T12:00:00Z",
                updatedAt: "2026-03-27T12:00:00Z",
              },
              {
                id: "m2",
                role: "assistant",
                text: "Snapshot reply",
                turnId: "turn-1",
                streaming: false,
                createdAt: "2026-03-27T12:00:01Z",
                updatedAt: "2026-03-27T12:00:05Z",
              },
            ],
            session: { status: "idle" },
          },
        ],
      };
      const ws = createMockWs(snapshotData);
      const events = new EventBuffer();
      const app = createRoutes({ ws, events });

      const res = await json(app, "/threads/tid-snap/messages");
      expect(res.status).toBe(200);

      const msgs = res.body.messages as Array<Record<string, unknown>>;
      expect(msgs).toHaveLength(2);
      expect(msgs[0].text).toBe("From snapshot");
      expect(msgs[0].role).toBe("user");
      expect(msgs[1].text).toBe("Snapshot reply");
      expect(msgs[1].role).toBe("assistant");
    });

    it("does not re-hydrate when thread already has live events", async () => {
      const snapshotData = {
        threads: [
          {
            id: "tid-live",
            messages: [
              {
                id: "old",
                role: "user",
                text: "Old snapshot",
                turnId: null,
                streaming: false,
                createdAt: "2026-03-27T10:00:00Z",
                updatedAt: "2026-03-27T10:00:00Z",
              },
            ],
          },
        ],
      };
      const ws = createMockWs(snapshotData);
      const events = new EventBuffer();
      const app = createRoutes({ ws, events });

      // Push a live event first
      events.push({
        sequence: 1,
        eventId: "e1",
        type: "thread.message-sent",
        aggregateId: "tid-live",
        occurredAt: new Date().toISOString(),
        payload: {
          threadId: "tid-live",
          messageId: "live-msg",
          role: "user",
          text: "Live message",
          streaming: false,
          turnId: "turn-1",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });

      const res = await json(app, "/threads/tid-live/messages");
      const msgs = res.body.messages as Array<Record<string, unknown>>;
      expect(msgs).toHaveLength(1);
      expect(msgs[0].text).toBe("Live message");
    });

    it("handles snapshot failure gracefully", async () => {
      // Pass null to simulate no snapshot available (timeout/error).
      const ws = createMockWs(null);
      const events = new EventBuffer();
      const app = createRoutes({ ws, events });

      const res = await json(app, "/threads/tid-missing/messages");
      expect(res.status).toBe(200);
      expect((res.body.messages as unknown[]).length).toBe(0);
    });
  });

  describe("GET /snapshot", () => {
    it("returns raw snapshot from ws", async () => {
      const snapshotData = { snapshotSequence: 42, threads: [] };
      const ws = createMockWs(snapshotData);
      const events = new EventBuffer();
      const app = createRoutes({ ws, events });

      const res = await json(app, "/snapshot");
      expect(res.status).toBe(200);
      expect(res.body.snapshotSequence).toBe(42);
    });
  });

  describe("POST /threads when WS disconnected", () => {
    it("returns 502 immediately instead of hanging", async () => {
      const ws = createMockWs();
      (ws as unknown as Record<string, boolean>).connected = false;
      (ws.request as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.reject(new Error("WebSocket not connected — cannot send orchestration.dispatchCommand")),
      );
      const events = new EventBuffer();
      const app = createRoutes({ ws, events });

      const res = await json(app, "/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "proj-1" }),
      });

      expect(res.status).toBe(502);
      expect(res.body.error).toBe("T3 Code server not connected");
    });
  });

  describe("POST /threads/:id/messages when WS disconnected", () => {
    it("returns 502 immediately instead of hanging", async () => {
      const ws = createMockWs();
      (ws as unknown as Record<string, boolean>).connected = false;
      (ws.request as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.reject(new Error("WebSocket not connected — cannot send orchestration.dispatchCommand")),
      );
      const events = new EventBuffer();
      const app = createRoutes({ ws, events });

      const res = await json(app, "/threads/tid-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello" }),
      });

      expect(res.status).toBe(502);
      expect(res.body.error).toBe("T3 Code server not connected");
    });
  });

  describe("GET /threads/:id/events", () => {
    it("returns filtered events", async () => {
      const { app, events } = makeApp();
      events.push({
        sequence: 1,
        eventId: "e1",
        type: "thread.created",
        aggregateId: "tid-1",
        occurredAt: new Date().toISOString(),
        payload: { threadId: "tid-1" },
      });
      events.push({
        sequence: 2,
        eventId: "e2",
        type: "thread.session-set",
        aggregateId: "tid-1",
        occurredAt: new Date().toISOString(),
        payload: { threadId: "tid-1", session: { status: "running" } },
      });

      const res = await json(app, "/threads/tid-1/events?types=thread.session-set");
      expect(res.status).toBe(200);
      const evts = res.body.events as Array<Record<string, unknown>>;
      expect(evts).toHaveLength(1);
      expect(evts[0].type).toBe("thread.session-set");
    });
  });

  describe("POST /threads with webhook", () => {
    it("registers webhook config on thread creation", async () => {
      const { app, webhooks } = makeApp();
      const res = await json(app, "/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "proj-1",
          webhook: {
            url: "http://example.com/callback",
            events: ["completed", "error"],
            headers: { Authorization: "Bearer secret" },
            metadata: { source: "test", topic: 7 },
          },
        }),
      });

      expect(res.status).toBe(201);
      const threadId = res.body.threadId as string;
      expect(webhooks.has(threadId)).toBe(true);
      const config = webhooks.get(threadId)!;
      expect(config.url).toBe("http://example.com/callback");
      expect(config.events).toEqual(["completed", "error"]);
      expect(config.headers).toEqual({ Authorization: "Bearer secret" });
      expect(config.metadata).toEqual({ source: "test", topic: 7 });
    });

    it("does not register webhook when field absent", async () => {
      const { app, webhooks } = makeApp();
      const res = await json(app, "/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "proj-1" }),
      });

      expect(res.status).toBe(201);
      expect(webhooks.has(res.body.threadId as string)).toBe(false);
    });

    it("webhook defaults events to completed + error when empty", async () => {
      const { app, webhooks } = makeApp();
      const res = await json(app, "/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "proj-1",
          webhook: { url: "http://x.com" },
        }),
      });

      expect(res.status).toBe(201);
      const config = webhooks.get(res.body.threadId as string)!;
      expect(config.events).toEqual(["completed", "error"]);
    });
  });

  describe("POST /threads with modelOptions", () => {
    it("passes modelOptions into modelSelection.options", async () => {
      const { app, ws } = makeApp();
      await json(app, "/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "proj-1",
          provider: "codex",
          model: "gpt-5.4",
          modelOptions: { reasoningEffort: "high" },
        }),
      });

      const [, params] = (ws.request as ReturnType<typeof mock>).mock.calls[0];
      expect(params.modelSelection).toEqual({
        provider: "codex",
        model: "gpt-5.4",
        options: { reasoningEffort: "high" },
      });
    });

    it("omits options when modelOptions not provided", async () => {
      const { app, ws } = makeApp();
      await json(app, "/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "proj-1" }),
      });

      const [, params] = (ws.request as ReturnType<typeof mock>).mock.calls[0];
      expect(params.modelSelection).toEqual({
        provider: "codex",
        model: "gpt-5.4",
      });
      expect(params.modelSelection.options).toBeUndefined();
    });
  });

  describe("POST /threads/:id/messages with modelOptions", () => {
    it("passes modelOptions into modelSelection.options", async () => {
      const { app, ws } = makeApp();
      await json(app, "/threads/tid-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Hello",
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          modelOptions: { thinking: true, effort: "high" },
        }),
      });

      const [, params] = (ws.request as ReturnType<typeof mock>).mock.calls[0];
      expect(params.modelSelection).toEqual({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: { thinking: true, effort: "high" },
      });
    });

    it("does not include modelOptions when no provider/model override", async () => {
      const { app, ws } = makeApp();
      await json(app, "/threads/tid-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello" }),
      });

      const [, params] = (ws.request as ReturnType<typeof mock>).mock.calls[0];
      expect(params.modelSelection).toBeUndefined();
    });
  });

  describe("Server settings endpoints", () => {
    it("GET /server/settings proxies to server.getSettings", async () => {
      const ws = createMockWs();
      const settingsData = {
        enableAssistantStreaming: false,
        defaultThreadEnvMode: "local",
        providers: {
          codex: { enabled: true, binaryPath: "codex" },
          claudeAgent: { enabled: true, binaryPath: "claude" },
        },
      };
      (ws.request as ReturnType<typeof mock>).mockImplementation(
        (tag: string) => {
          if (tag === "server.getSettings") return Promise.resolve(settingsData);
          return Promise.resolve({});
        },
      );
      const events = new EventBuffer();
      const app = createRoutes({ ws, events });

      const res = await json(app, "/server/settings");
      expect(res.status).toBe(200);
      expect(res.body.enableAssistantStreaming).toBe(false);
      expect(res.body.providers).toBeDefined();
    });

    it("PATCH /server/settings proxies to server.updateSettings", async () => {
      const ws = createMockWs();
      (ws.request as ReturnType<typeof mock>).mockImplementation(
        (tag: string, params: Record<string, unknown>) => {
          if (tag === "server.updateSettings") {
            return Promise.resolve({ ok: true, patch: params.patch });
          }
          return Promise.resolve({});
        },
      );
      const events = new EventBuffer();
      const app = createRoutes({ ws, events });

      const res = await json(app, "/server/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providers: { codex: { enabled: false } },
        }),
      });
      expect(res.status).toBe(200);

      const [tag, params] = (ws.request as ReturnType<typeof mock>).mock.calls[0];
      expect(tag).toBe("server.updateSettings");
      expect(params.patch).toEqual({ providers: { codex: { enabled: false } } });
    });

    it("POST /server/providers/refresh proxies to server.refreshProviders", async () => {
      const ws = createMockWs();
      const providersData = [
        { provider: "codex", enabled: true, status: "ready" },
      ];
      (ws.request as ReturnType<typeof mock>).mockImplementation(
        (tag: string) => {
          if (tag === "server.refreshProviders") return Promise.resolve(providersData);
          return Promise.resolve({});
        },
      );
      const events = new EventBuffer();
      const app = createRoutes({ ws, events });

      const res = await json(app, "/server/providers/refresh", { method: "POST" });
      expect(res.status).toBe(200);
      expect(ws.request).toHaveBeenCalledWith("server.refreshProviders", {});
    });
  });

  describe("DELETE /threads/:id cleans up webhook", () => {
    it("removes webhook on thread delete", async () => {
      const { app, webhooks } = makeApp();
      // Create thread with webhook
      const res = await json(app, "/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "proj-1",
          webhook: { url: "http://x.com", events: ["completed"] },
        }),
      });
      const threadId = res.body.threadId as string;
      expect(webhooks.has(threadId)).toBe(true);

      // Delete thread
      await json(app, `/threads/${threadId}`, { method: "DELETE" });
      expect(webhooks.has(threadId)).toBe(false);
    });
  });
});
