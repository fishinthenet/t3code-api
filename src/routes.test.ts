import { describe, it, expect, mock, beforeEach } from "bun:test";
import { EventBuffer } from "./event-buffer";
import { createRoutes } from "./routes";
import type { T3WebSocketClient } from "./ws-client";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Mock WS client ──────────────────────────────────────────────────

function createMockWs(): T3WebSocketClient {
  return {
    connected: true,
    request: mock(() => Promise.resolve({ sequence: 1 })),
    dispose: mock(() => {}),
    onPush: null,
    onConnected: null,
    onDisconnected: null,
  } as unknown as T3WebSocketClient;
}

// ── Helpers ──────────────────────────────────────────────────────────

function makeApp() {
  const ws = createMockWs();
  const events = new EventBuffer();
  const app = createRoutes({ ws, events });
  return { app, ws, events };
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
      expect(params.command.type).toBe("thread.create");
      expect(params.command.projectId).toBe("proj-1");
      expect(params.command.modelSelection).toEqual({ provider: "codex", model: "gpt-5.4" });
      // Flat fields for v0.0.14 compatibility
      expect(params.command.model).toBe("gpt-5.4");
      expect(params.command.provider).toBe("codex");
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
      expect(params.command.type).toBe("thread.create");
      expect(params.command.worktreePath).toBe("/opt/my-project");
    });

    it("sets worktreePath to null when workdir not provided", async () => {
      const { app, ws } = makeApp();
      await json(app, "/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "proj-1" }),
      });

      const [, params] = (ws.request as ReturnType<typeof mock>).mock.calls[0];
      expect(params.command.worktreePath).toBeNull();
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
      expect(createParams.command.type).toBe("thread.create");
      expect(createParams.command.worktreePath).toBe("/opt/my-project");

      // thread.turn.start uses the same threadId
      const [, turnParams] = (ws.request as ReturnType<typeof mock>).mock.calls[1];
      expect(turnParams.command.type).toBe("thread.turn.start");
      expect(turnParams.command.threadId).toBe(createParams.command.threadId);
      expect(turnParams.command.message.text).toBe("List files");
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
      expect(createParams.command.type).toBe("thread.create");
      expect(turnParams.command.type).toBe("thread.turn.start");
      expect(turnParams.command.message.text).toBe("Do something");
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
      expect(params.command.type).toBe("thread.turn.start");
      expect(params.command.threadId).toBe("tid-1");
      expect(params.command.message.text).toBe("Hello agent");
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
      expect(params.command.modelSelection).toEqual({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      });
      // Flat fields for v0.0.14 compatibility
      expect(params.command.provider).toBe("claudeAgent");
      expect(params.command.model).toBe("claude-opus-4-6");
    });

    it("does not include modelSelection when no override", async () => {
      const { app, ws } = makeApp();
      await json(app, "/threads/tid-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello" }),
      });

      const [, params] = (ws.request as ReturnType<typeof mock>).mock.calls[0];
      expect(params.command.modelSelection).toBeUndefined();
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
      const att = params.command.message.attachments[0];
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
      expect(params.command.type).toBe("thread.turn.interrupt");
      expect(params.command.threadId).toBe("tid-1");
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
      const ws = createMockWs();
      (ws.request as ReturnType<typeof mock>).mockImplementation(
        (tag: string) => {
          if (tag === "orchestration.getSnapshot") {
            return Promise.resolve({
              snapshotSequence: 50,
              threads: [
                {
                  id: "tid-hydrate",
                  messages: [],
                  session: { status: "idle" },
                },
              ],
            });
          }
          return Promise.resolve({});
        },
      );
      const events = new EventBuffer();
      const app = createRoutes({ ws, events });

      const res = await json(app, "/threads/tid-hydrate/status");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("idle");
    });
  });

  describe("GET /threads/:id/messages — snapshot hydration", () => {
    it("hydrates messages from snapshot when thread not in buffer", async () => {
      const ws = createMockWs();
      (ws.request as ReturnType<typeof mock>).mockImplementation(
        (tag: string) => {
          if (tag === "orchestration.getSnapshot") {
            return Promise.resolve({
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
            });
          }
          return Promise.resolve({});
        },
      );
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
      const ws = createMockWs();
      (ws.request as ReturnType<typeof mock>).mockImplementation(
        (tag: string) => {
          if (tag === "orchestration.getSnapshot") {
            return Promise.resolve({
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
            });
          }
          return Promise.resolve({});
        },
      );
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
      const ws = createMockWs();
      (ws.request as ReturnType<typeof mock>).mockImplementation(
        (tag: string) => {
          if (tag === "orchestration.getSnapshot") {
            return Promise.reject(new Error("Connection lost"));
          }
          return Promise.resolve({});
        },
      );
      const events = new EventBuffer();
      const app = createRoutes({ ws, events });

      const res = await json(app, "/threads/tid-missing/messages");
      expect(res.status).toBe(200);
      expect((res.body.messages as unknown[]).length).toBe(0);
    });
  });

  describe("GET /snapshot", () => {
    it("returns raw snapshot from ws", async () => {
      const ws = createMockWs();
      const snapshotData = { snapshotSequence: 42, threads: [] };
      (ws.request as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(snapshotData),
      );
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
});
