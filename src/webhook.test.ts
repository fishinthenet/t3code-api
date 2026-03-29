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

  describe("onStatusChange → delivery", () => {
    it("fires webhook on idle (completed event)", async () => {
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

      // Wait for async delivery.
      await new Promise((r) => setTimeout(r, 50));

      expect(calls.length).toBe(1);
      const call = calls[0];
      expect(call.url).toBe("http://cb.test/hook");

      const headers = call.init.headers as Record<string, string>;
      expect(headers["X-T3-Event"]).toBe("completed");
      expect(headers["X-T3-Thread"]).toBe("t1");
      expect(headers["X-Custom"]).toBe("val");
      expect(headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(call.init.body as string) as WebhookPayload;
      expect(body.event).toBe("completed");
      expect(body.threadId).toBe("t1");
      expect(body.projectId).toBe("proj-1");
      expect(body.title).toBe("My Thread");
      expect(body.status).toBe("idle");
      expect(body.messagesCount).toBe(5);
      expect(body.durationMs).toBeGreaterThanOrEqual(0);
      expect(body.metadata).toEqual({ source: "test", topic: 42 });
      expect(body.error).toBeUndefined();
    });

    it("fires webhook on ready (completed event)", async () => {
      const { fn, calls } = mockFetch();
      const mgr = makeManager(fn);
      mgr.register("t1", { url: "http://x.com", events: ["completed"] }, "p1", "T");

      mgr.onStatusChange("t1", "running");
      mgr.onStatusChange("t1", "ready", { messagesCount: 2 });

      await new Promise((r) => setTimeout(r, 50));
      expect(calls.length).toBe(1);
      expect(JSON.parse(calls[0].init.body as string).status).toBe("ready");
    });

    it("fires webhook on error with error field", async () => {
      const { fn, calls } = mockFetch();
      const mgr = makeManager(fn);
      mgr.register("t1", { url: "http://x.com", events: ["error"] }, "p1", "T");

      mgr.onStatusChange("t1", "error", { error: "Build failed" });

      await new Promise((r) => setTimeout(r, 50));
      expect(calls.length).toBe(1);
      const body = JSON.parse(calls[0].init.body as string) as WebhookPayload;
      expect(body.event).toBe("error");
      expect(body.error).toBe("Build failed");
    });

    it("does not fire for unsubscribed events", async () => {
      const { fn, calls } = mockFetch();
      const mgr = makeManager(fn);
      mgr.register("t1", { url: "http://x.com", events: ["error"] }, "p1", "T");

      // completed event not in events list
      mgr.onStatusChange("t1", "idle");

      await new Promise((r) => setTimeout(r, 50));
      expect(calls.length).toBe(0);
    });

    it("does not fire for non-trigger statuses (running, starting)", async () => {
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

      const body = JSON.parse(calls[0].init.body as string);
      expect(body).not.toHaveProperty("metadata");
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

      // Wait for retries (1s + 5s + 15s max, but with mock it's instant — except the sleep).
      // We can't easily test real delays, but we verify the fetch was called 4 times (1 + 3 retries).
      // For this test we need to bypass the sleep. Let's just verify it attempts multiple times.
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
