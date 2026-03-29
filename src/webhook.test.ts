import { describe, it, expect, mock, beforeEach } from "bun:test";
import { WebhookManager } from "./webhook";
import type { WebhookPayload, FetchFn } from "./webhook";

// ── Helpers ──────────────────────────────────────────────────────────

function mockFetch(status = 200): { fn: FetchFn; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response("ok", { status });
  }) as unknown as FetchFn;
  return { fn, calls };
}

function makeManager(fetchFn?: FetchFn) {
  return new WebhookManager(fetchFn);
}

function parseBody(call: { init: RequestInit }) {
  return JSON.parse(call.init.body as string) as WebhookPayload;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("WebhookManager", () => {
  describe("register / remove / has", () => {
    it("registers and removes webhook configs", () => {
      const mgr = makeManager();
      mgr.register("t1", { url: "http://example.com/hook", events: ["completed"] }, "p1", "Title");
      expect(mgr.has("t1")).toBe(true);
      expect(mgr.get("t1")?.url).toBe("http://example.com/hook");

      mgr.remove("t1");
      expect(mgr.has("t1")).toBe(false);
    });

    it("defaults events to completed + error when empty", () => {
      const mgr = makeManager();
      mgr.register("t1", { url: "http://x.com", events: [] }, "p1", "T");
      expect(mgr.get("t1")?.events).toEqual(["completed", "error"]);
    });
  });

  describe("onStatusChange → delivery (alias events)", () => {
    it("fires on idle via completed alias with full payload", async () => {
      const { fn, calls } = mockFetch();
      const mgr = makeManager(fn);
      mgr.register("t1", {
        url: "http://cb.test/hook",
        events: ["completed"],
        headers: { "X-Custom": "val" },
        metadata: { source: "test", topic: 42 },
      }, "proj-1", "My Thread");

      mgr.onStatusChange("t1", "running");
      mgr.onStatusChange("t1", "idle", { messagesCount: 5 });

      await new Promise((r) => setTimeout(r, 50));

      expect(calls.length).toBe(1);
      const call = calls[0];
      expect(call.url).toBe("http://cb.test/hook");

      const headers = call.init.headers as Record<string, string>;
      expect(headers["X-T3-Event"]).toBe("status:idle");
      expect(headers["X-T3-Thread"]).toBe("t1");
      expect(headers["X-Custom"]).toBe("val");
      expect(headers["Content-Type"]).toBe("application/json");

      const body = parseBody(call);
      expect(body.event).toBe("status:idle");
      expect(body.webhookSeq).toBe(1);
      expect(body.message).toContain("My Thread");
      expect(body.message).toContain("status:idle");
      expect(body.message).toContain("5 msgs");
      expect(body.previousStatus).toBe("running");
      expect(body.threadId).toBe("t1");
      expect(body.projectId).toBe("proj-1");
      expect(body.title).toBe("My Thread");
      expect(body.status).toBe("idle");
      expect(body.messagesCount).toBe(5);
      expect(body.durationMs).toBeGreaterThanOrEqual(0);
      expect(body.metadata).toEqual({ source: "test", topic: 42 });
      expect(body.error).toBeUndefined();
    });

    it("fires on ready via completed alias", async () => {
      const { fn, calls } = mockFetch();
      const mgr = makeManager(fn);
      mgr.register("t1", { url: "http://x.com", events: ["completed"] }, "p1", "T");

      mgr.onStatusChange("t1", "running");
      mgr.onStatusChange("t1", "ready", { messagesCount: 2 });

      await new Promise((r) => setTimeout(r, 50));
      expect(calls.length).toBe(1);
      const body = parseBody(calls[0]);
      expect(body.event).toBe("status:ready");
      expect(body.status).toBe("ready");
      expect(body.previousStatus).toBe("running");
    });

    it("fires on error via error alias with error in message", async () => {
      const { fn, calls } = mockFetch();
      const mgr = makeManager(fn);
      mgr.register("t1", { url: "http://x.com", events: ["error"] }, "p1", "T");

      mgr.onStatusChange("t1", "error", { error: "Build failed" });

      await new Promise((r) => setTimeout(r, 50));
      expect(calls.length).toBe(1);
      const body = parseBody(calls[0]);
      expect(body.event).toBe("status:error");
      expect(body.error).toBe("Build failed");
      expect(body.message).toContain("Build failed");
      expect(body.previousStatus).toBeNull();
    });

    it("does not fire for unsubscribed events", async () => {
      const { fn, calls } = mockFetch();
      const mgr = makeManager(fn);
      mgr.register("t1", { url: "http://x.com", events: ["error"] }, "p1", "T");

      mgr.onStatusChange("t1", "idle");

      await new Promise((r) => setTimeout(r, 50));
      expect(calls.length).toBe(0);
    });

    it("does not fire for non-subscribed statuses (running, starting) with aliases", async () => {
      const { fn, calls } = mockFetch();
      const mgr = makeManager(fn);
      mgr.register("t1", { url: "http://x.com", events: ["completed", "error"] }, "p1", "T");

      mgr.onStatusChange("t1", "running");
      mgr.onStatusChange("t1", "starting");

      await new Promise((r) => setTimeout(r, 50));
      expect(calls.length).toBe(0);
    });

    it("does not fire twice for same status", async () => {
      const { fn, calls } = mockFetch();
      const mgr = makeManager(fn);
      mgr.register("t1", { url: "http://x.com", events: ["completed"] }, "p1", "T");

      mgr.onStatusChange("t1", "idle");
      mgr.onStatusChange("t1", "idle");

      await new Promise((r) => setTimeout(r, 50));
      expect(calls.length).toBe(1);
    });

    it("fires again after status changes and returns", async () => {
      const { fn, calls } = mockFetch();
      const mgr = makeManager(fn);
      mgr.register("t1", { url: "http://x.com", events: ["completed"] }, "p1", "T");

      mgr.onStatusChange("t1", "idle");
      await new Promise((r) => setTimeout(r, 50));
      expect(calls.length).toBe(1);

      mgr.onStatusChange("t1", "running");
      mgr.onStatusChange("t1", "idle");
      await new Promise((r) => setTimeout(r, 50));
      expect(calls.length).toBe(2);
    });

    it("does not fire for unregistered threads", async () => {
      const { fn, calls } = mockFetch();
      const mgr = makeManager(fn);
      mgr.onStatusChange("unknown", "idle");
      await new Promise((r) => setTimeout(r, 50));
      expect(calls.length).toBe(0);
    });

    it("omits metadata from payload when not configured", async () => {
      const { fn, calls } = mockFetch();
      const mgr = makeManager(fn);
      mgr.register("t1", { url: "http://x.com", events: ["completed"] }, "p1", "T");

      mgr.onStatusChange("t1", "idle");
      await new Promise((r) => setTimeout(r, 50));

      const body = parseBody(calls[0]);
      expect(body).not.toHaveProperty("metadata");
    });
  });

  describe("granular status:* events", () => {
    it("status:idle fires only on idle, not ready", async () => {
      const { fn, calls } = mockFetch();
      const mgr = makeManager(fn);
      mgr.register("t1", { url: "http://x.com", events: ["status:idle"] }, "p1", "T");

      mgr.onStatusChange("t1", "running");
      mgr.onStatusChange("t1", "ready");
      await new Promise((r) => setTimeout(r, 50));
      expect(calls.length).toBe(0);

      mgr.onStatusChange("t1", "running");
      mgr.onStatusChange("t1", "idle");
      await new Promise((r) => setTimeout(r, 50));
      expect(calls.length).toBe(1);
      expect(parseBody(calls[0]).event).toBe("status:idle");
    });

    it("status:ready fires only on ready, not idle", async () => {
      const { fn, calls } = mockFetch();
      const mgr = makeManager(fn);
      mgr.register("t1", { url: "http://x.com", events: ["status:ready"] }, "p1", "T");

      mgr.onStatusChange("t1", "idle");
      await new Promise((r) => setTimeout(r, 50));
      expect(calls.length).toBe(0);

      mgr.onStatusChange("t1", "running");
      mgr.onStatusChange("t1", "ready");
      await new Promise((r) => setTimeout(r, 50));
      expect(calls.length).toBe(1);
      expect(parseBody(calls[0]).event).toBe("status:ready");
    });

    it("status:running fires on running transition", async () => {
      const { fn, calls } = mockFetch();
      const mgr = makeManager(fn);
      mgr.register("t1", { url: "http://x.com", events: ["status:running"] }, "p1", "T");

      mgr.onStatusChange("t1", "running");
      await new Promise((r) => setTimeout(r, 50));
      expect(calls.length).toBe(1);
      const body = parseBody(calls[0]);
      expect(body.event).toBe("status:running");
      expect(body.previousStatus).toBeNull();
    });

    it("mixed granular + alias events work together", async () => {
      const { fn, calls } = mockFetch();
      const mgr = makeManager(fn);
      mgr.register("t1", { url: "http://x.com", events: ["status:idle", "status:error"] }, "p1", "T");

      mgr.onStatusChange("t1", "running");
      mgr.onStatusChange("t1", "ready"); // not subscribed
      await new Promise((r) => setTimeout(r, 50));
      expect(calls.length).toBe(0);

      mgr.onStatusChange("t1", "idle");
      await new Promise((r) => setTimeout(r, 50));
      expect(calls.length).toBe(1);

      mgr.onStatusChange("t1", "error", { error: "crash" });
      await new Promise((r) => setTimeout(r, 50));
      expect(calls.length).toBe(2);
      expect(parseBody(calls[1]).event).toBe("status:error");
    });
  });

  describe("webhookSeq and previousStatus", () => {
    it("increments webhookSeq across multiple deliveries", async () => {
      const { fn, calls } = mockFetch();
      const mgr = makeManager(fn);
      mgr.register("t1", { url: "http://x.com", events: ["completed", "error"] }, "p1", "T");

      mgr.onStatusChange("t1", "idle");
      await new Promise((r) => setTimeout(r, 50));
      expect(parseBody(calls[0]).webhookSeq).toBe(1);

      mgr.onStatusChange("t1", "running");
      mgr.onStatusChange("t1", "error", { error: "fail" });
      await new Promise((r) => setTimeout(r, 50));
      expect(parseBody(calls[1]).webhookSeq).toBe(2);

      mgr.onStatusChange("t1", "idle");
      await new Promise((r) => setTimeout(r, 50));
      expect(parseBody(calls[2]).webhookSeq).toBe(3);
    });

    it("tracks previousStatus correctly through transitions", async () => {
      const { fn, calls } = mockFetch();
      const mgr = makeManager(fn);
      mgr.register("t1", { url: "http://x.com", events: ["completed"] }, "p1", "T");

      // First transition: null → idle
      mgr.onStatusChange("t1", "idle");
      await new Promise((r) => setTimeout(r, 50));
      expect(parseBody(calls[0]).previousStatus).toBeNull();

      // Second transition: idle → running → idle
      mgr.onStatusChange("t1", "running");
      mgr.onStatusChange("t1", "idle");
      await new Promise((r) => setTimeout(r, 50));
      expect(parseBody(calls[1]).previousStatus).toBe("running");
    });
  });

  describe("openclaw-hooks format", () => {
    it("delivers payload in OpenClaw format with agentId and sessionKey", async () => {
      const { fn, calls } = mockFetch();
      const mgr = makeManager(fn);
      mgr.register("t1", {
        url: "http://gateway/hooks/agent",
        events: ["completed"],
        format: "openclaw-hooks",
        headers: { Authorization: "Bearer secret" },
        metadata: {
          agentId: "librus",
          sessionKey: "agent:librus:telegram:-1003643494830:6",
          host: "librus",
        },
      }, "proj-1", "Fix calendar bug");

      mgr.onStatusChange("t1", "running");
      mgr.onStatusChange("t1", "idle", { messagesCount: 184 });

      await new Promise((r) => setTimeout(r, 50));

      expect(calls.length).toBe(1);
      const body = JSON.parse(calls[0].init.body as string);
      expect(body.wakeMode).toBe("now");
      expect(body.name).toBe("t3code:Fix calendar bug");
      expect(body.agentId).toBe("librus");
      expect(body.sessionKey).toBe("agent:librus:telegram:-1003643494830:6");
      expect(body.message).toContain("Fix calendar bug");
      expect(body.message).toContain("status:idle");
      expect(body.message).toContain("idle");
      expect(body.message).toContain("184 msgs");
      expect(body.message).toContain("host: librus");
      expect(body.message).toContain("threadId: t1");

      // Headers still sent
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer secret");
      expect(headers["X-T3-Event"]).toBe("status:idle");
    });

    it("omits agentId and sessionKey when not in metadata", async () => {
      const { fn, calls } = mockFetch();
      const mgr = makeManager(fn);
      mgr.register("t1", {
        url: "http://gateway/hooks/agent",
        events: ["completed"],
        format: "openclaw-hooks",
        metadata: { host: "myhost" },
      }, "proj-1", "Task");

      mgr.onStatusChange("t1", "idle");
      await new Promise((r) => setTimeout(r, 50));

      const body = JSON.parse(calls[0].init.body as string);
      expect(body).not.toHaveProperty("agentId");
      expect(body).not.toHaveProperty("sessionKey");
      expect(body.wakeMode).toBe("now");
    });

    it("includes error text in message for error events", async () => {
      const { fn, calls } = mockFetch();
      const mgr = makeManager(fn);
      mgr.register("t1", {
        url: "http://gateway/hooks/agent",
        events: ["error"],
        format: "openclaw-hooks",
        metadata: { agentId: "bot" },
      }, "proj-1", "Broken build");

      mgr.onStatusChange("t1", "error", { error: "Build failed after 3 retries" });
      await new Promise((r) => setTimeout(r, 50));

      const body = JSON.parse(calls[0].init.body as string);
      expect(body.message).toContain("status:error");
      expect(body.message).toContain("Build failed after 3 retries");
      expect(body.name).toBe("t3code:Broken build");
    });

    it("uses default format when format is not set", async () => {
      const { fn, calls } = mockFetch();
      const mgr = makeManager(fn);
      mgr.register("t1", {
        url: "http://x.com",
        events: ["completed"],
      }, "proj-1", "T");

      mgr.onStatusChange("t1", "idle");
      await new Promise((r) => setTimeout(r, 50));

      const body = JSON.parse(calls[0].init.body as string);
      expect(body.event).toBe("status:idle");
      expect(body.threadId).toBe("t1");
      expect(body.message).toContain("T");
      expect(body.message).toContain("status:idle");
      expect(body).not.toHaveProperty("wakeMode");
    });
  });

  describe("retry behavior", () => {
    it("retries on non-2xx response up to 3 times", async () => {
      let attempt = 0;
      const fn = (async () => {
        attempt++;
        if (attempt < 4) return new Response("fail", { status: 500 });
        return new Response("ok", { status: 200 });
      }) as unknown as FetchFn;

      const mgr = new WebhookManager(fn);
      mgr.register("t1", { url: "http://x.com", events: ["completed"] }, "p1", "T");
      mgr.onStatusChange("t1", "idle");

      await new Promise((r) => setTimeout(r, 25_000));
      expect(attempt).toBe(4);
    }, 30_000);

    it("retries on network error", async () => {
      let attempt = 0;
      const fn = (async () => {
        attempt++;
        if (attempt < 2) throw new Error("ECONNREFUSED");
        return new Response("ok", { status: 200 });
      }) as unknown as FetchFn;

      const mgr = new WebhookManager(fn);
      mgr.register("t1", { url: "http://x.com", events: ["completed"] }, "p1", "T");
      mgr.onStatusChange("t1", "idle");

      await new Promise((r) => setTimeout(r, 3_000));
      expect(attempt).toBe(2);
    }, 10_000);
  });
});
