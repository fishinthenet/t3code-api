import { describe, it, expect } from "bun:test";
import { EventBuffer, type DomainEvent } from "./event-buffer";

// ── Helpers ──────────────────────────────────────────────────────────

let seq = 0;

function makeEvent(
  threadId: string,
  type: string,
  payload: Record<string, unknown> = {},
): DomainEvent {
  seq++;
  return {
    sequence: seq,
    eventId: `evt-${seq}`,
    type,
    aggregateId: threadId,
    occurredAt: new Date().toISOString(),
    payload: { threadId, ...payload },
  };
}

function makeMessageEvent(
  threadId: string,
  messageId: string,
  opts: { role: string; text: string; streaming: boolean; turnId?: string },
): DomainEvent {
  return makeEvent(threadId, "thread.message-sent", {
    messageId,
    role: opts.role,
    text: opts.text,
    streaming: opts.streaming,
    turnId: opts.turnId ?? "turn-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe("EventBuffer", () => {
  describe("push and getEvents", () => {
    it("stores events per thread", () => {
      const buf = new EventBuffer();
      buf.push(makeEvent("t1", "thread.created"));
      buf.push(makeEvent("t2", "thread.created"));
      buf.push(makeEvent("t1", "thread.session-set"));

      expect(buf.getEvents("t1")).toHaveLength(2);
      expect(buf.getEvents("t2")).toHaveLength(1);
      expect(buf.getEvents("t3")).toHaveLength(0);
    });

    it("ignores events without threadId in payload", () => {
      const buf = new EventBuffer();
      buf.push({
        sequence: 1,
        eventId: "e1",
        type: "server.welcome",
        aggregateId: "x",
        occurredAt: new Date().toISOString(),
        payload: {},
      });
      expect(buf.knownThreadIds()).toHaveLength(0);
    });

    it("enforces max events per thread", () => {
      const buf = new EventBuffer(3);
      buf.push(makeEvent("t1", "a"));
      buf.push(makeEvent("t1", "b"));
      buf.push(makeEvent("t1", "c"));
      buf.push(makeEvent("t1", "d"));

      const events = buf.getEvents("t1");
      expect(events).toHaveLength(3);
      expect(events[0].type).toBe("b");
      expect(events[2].type).toBe("d");
    });

    it("tracks global sequence", () => {
      const buf = new EventBuffer();
      buf.push(makeEvent("t1", "a"));
      buf.push(makeEvent("t1", "b"));
      expect(buf.lastSequence).toBeGreaterThan(0);
    });
  });

  describe("getEvents filtering", () => {
    it("filters by afterSequence", () => {
      const buf = new EventBuffer();
      const e1 = makeEvent("t1", "a");
      const e2 = makeEvent("t1", "b");
      buf.push(e1);
      buf.push(e2);

      const result = buf.getEvents("t1", { afterSequence: e1.sequence });
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("b");
    });

    it("filters by event types", () => {
      const buf = new EventBuffer();
      buf.push(makeEvent("t1", "thread.created"));
      buf.push(makeEvent("t1", "thread.session-set"));
      buf.push(makeEvent("t1", "thread.message-sent"));

      const result = buf.getEvents("t1", { types: ["thread.session-set"] });
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("thread.session-set");
    });

    it("applies limit (takes last N)", () => {
      const buf = new EventBuffer();
      buf.push(makeEvent("t1", "a"));
      buf.push(makeEvent("t1", "b"));
      buf.push(makeEvent("t1", "c"));

      const result = buf.getEvents("t1", { limit: 2 });
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe("b");
      expect(result[1].type).toBe("c");
    });
  });

  describe("getMessages — streaming accumulation", () => {
    it("returns a single user message as-is", () => {
      const buf = new EventBuffer();
      buf.push(
        makeMessageEvent("t1", "msg-1", {
          role: "user",
          text: "Hello",
          streaming: false,
        }),
      );

      const msgs = buf.getMessages("t1");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].role).toBe("user");
      expect(msgs[0].text).toBe("Hello");
      expect(msgs[0].streaming).toBe(false);
    });

    it("accumulates streaming assistant deltas into one message", () => {
      const buf = new EventBuffer();
      buf.push(
        makeMessageEvent("t1", "msg-u", {
          role: "user",
          text: "Write hello world",
          streaming: false,
        }),
      );
      buf.push(
        makeMessageEvent("t1", "msg-a", {
          role: "assistant",
          text: "Here",
          streaming: true,
        }),
      );
      buf.push(
        makeMessageEvent("t1", "msg-a", {
          role: "assistant",
          text: " is",
          streaming: true,
        }),
      );
      buf.push(
        makeMessageEvent("t1", "msg-a", {
          role: "assistant",
          text: " hello world",
          streaming: true,
        }),
      );
      // Completion event (streaming: false, empty text)
      buf.push(
        makeMessageEvent("t1", "msg-a", {
          role: "assistant",
          text: "",
          streaming: false,
        }),
      );

      const msgs = buf.getMessages("t1");
      expect(msgs).toHaveLength(2);

      const user = msgs[0];
      expect(user.role).toBe("user");
      expect(user.text).toBe("Write hello world");

      const assistant = msgs[1];
      expect(assistant.role).toBe("assistant");
      expect(assistant.text).toBe("Here is hello world");
      expect(assistant.streaming).toBe(false);
      expect(assistant.messageId).toBe("msg-a");
    });

    it("shows streaming=true while assistant is still generating", () => {
      const buf = new EventBuffer();
      buf.push(
        makeMessageEvent("t1", "msg-a", {
          role: "assistant",
          text: "Working on ",
          streaming: true,
        }),
      );
      buf.push(
        makeMessageEvent("t1", "msg-a", {
          role: "assistant",
          text: "it...",
          streaming: true,
        }),
      );

      const msgs = buf.getMessages("t1");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].text).toBe("Working on it...");
      expect(msgs[0].streaming).toBe(true);
    });

    it("handles multiple turns with separate assistant messages", () => {
      const buf = new EventBuffer();

      // Turn 1
      buf.push(
        makeMessageEvent("t1", "u1", { role: "user", text: "First", streaming: false }),
      );
      buf.push(
        makeMessageEvent("t1", "a1", {
          role: "assistant",
          text: "Reply 1",
          streaming: true,
          turnId: "turn-1",
        }),
      );
      buf.push(
        makeMessageEvent("t1", "a1", {
          role: "assistant",
          text: "",
          streaming: false,
          turnId: "turn-1",
        }),
      );

      // Turn 2
      buf.push(
        makeMessageEvent("t1", "u2", { role: "user", text: "Second", streaming: false }),
      );
      buf.push(
        makeMessageEvent("t1", "a2", {
          role: "assistant",
          text: "Reply 2",
          streaming: true,
          turnId: "turn-2",
        }),
      );
      buf.push(
        makeMessageEvent("t1", "a2", {
          role: "assistant",
          text: "",
          streaming: false,
          turnId: "turn-2",
        }),
      );

      const msgs = buf.getMessages("t1");
      expect(msgs).toHaveLength(4);
      expect(msgs.map((m) => m.text)).toEqual(["First", "Reply 1", "Second", "Reply 2"]);
    });

    it("respects limit after accumulation", () => {
      const buf = new EventBuffer();
      buf.push(
        makeMessageEvent("t1", "u1", { role: "user", text: "Msg 1", streaming: false }),
      );
      buf.push(
        makeMessageEvent("t1", "u2", { role: "user", text: "Msg 2", streaming: false }),
      );
      buf.push(
        makeMessageEvent("t1", "u3", { role: "user", text: "Msg 3", streaming: false }),
      );

      const msgs = buf.getMessages("t1", { limit: 2 });
      expect(msgs).toHaveLength(2);
      expect(msgs[0].text).toBe("Msg 2");
      expect(msgs[1].text).toBe("Msg 3");
    });
  });

  describe("getThreadStatus", () => {
    it("returns null when no session events", () => {
      const buf = new EventBuffer();
      buf.push(makeEvent("t1", "thread.created"));
      expect(buf.getThreadStatus("t1")).toBeNull();
    });

    it("returns latest session status", () => {
      const buf = new EventBuffer();
      buf.push(
        makeEvent("t1", "thread.session-set", {
          session: { status: "starting" },
        }),
      );
      buf.push(
        makeEvent("t1", "thread.session-set", {
          session: { status: "running" },
        }),
      );
      buf.push(
        makeEvent("t1", "thread.session-set", {
          session: { status: "idle" },
        }),
      );
      expect(buf.getThreadStatus("t1")).toBe("idle");
    });
  });

  describe("hydrateFromSnapshot", () => {
    it("populates messages from snapshot threads", () => {
      const buf = new EventBuffer();
      buf.hydrateFromSnapshot({
        snapshotSequence: 100,
        threads: [
          {
            id: "t1",
            messages: [
              {
                id: "m1",
                role: "user",
                text: "Hello",
                turnId: null,
                streaming: false,
                createdAt: "2026-03-27T12:00:00Z",
                updatedAt: "2026-03-27T12:00:00Z",
              },
              {
                id: "m2",
                role: "assistant",
                text: "Hi there!",
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

      const msgs = buf.getMessages("t1");
      expect(msgs).toHaveLength(2);
      expect(msgs[0].role).toBe("user");
      expect(msgs[0].text).toBe("Hello");
      expect(msgs[1].role).toBe("assistant");
      expect(msgs[1].text).toBe("Hi there!");

      expect(buf.getThreadStatus("t1")).toBe("idle");
      expect(buf.lastSequence).toBe(100);
    });

    it("does not overwrite threads that already have live events", () => {
      const buf = new EventBuffer();
      buf.push(
        makeMessageEvent("t1", "live-msg", {
          role: "user",
          text: "Live message",
          streaming: false,
        }),
      );

      buf.hydrateFromSnapshot({
        snapshotSequence: 50,
        threads: [
          {
            id: "t1",
            messages: [
              {
                id: "old-msg",
                role: "user",
                text: "Old snapshot message",
                turnId: null,
                streaming: false,
                createdAt: "2026-03-27T10:00:00Z",
                updatedAt: "2026-03-27T10:00:00Z",
              },
            ],
          },
        ],
      });

      const msgs = buf.getMessages("t1");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].text).toBe("Live message");
    });

    it("hydrates multiple threads", () => {
      const buf = new EventBuffer();
      buf.hydrateFromSnapshot({
        threads: [
          {
            id: "t1",
            messages: [
              {
                id: "m1",
                role: "user",
                text: "Thread 1",
                turnId: null,
                streaming: false,
                createdAt: "2026-03-27T12:00:00Z",
                updatedAt: "2026-03-27T12:00:00Z",
              },
            ],
          },
          {
            id: "t2",
            messages: [
              {
                id: "m2",
                role: "user",
                text: "Thread 2",
                turnId: null,
                streaming: false,
                createdAt: "2026-03-27T12:00:00Z",
                updatedAt: "2026-03-27T12:00:00Z",
              },
            ],
          },
        ],
      });

      expect(buf.knownThreadIds()).toContain("t1");
      expect(buf.knownThreadIds()).toContain("t2");
      expect(buf.getMessages("t1")[0].text).toBe("Thread 1");
      expect(buf.getMessages("t2")[0].text).toBe("Thread 2");
    });

    it("handles empty snapshot gracefully", () => {
      const buf = new EventBuffer();
      buf.hydrateFromSnapshot({});
      buf.hydrateFromSnapshot({ threads: [] });
      expect(buf.knownThreadIds()).toHaveLength(0);
    });
  });

  describe("hasThread", () => {
    it("returns false for unknown thread", () => {
      const buf = new EventBuffer();
      expect(buf.hasThread("nonexistent")).toBe(false);
    });

    it("returns true after push", () => {
      const buf = new EventBuffer();
      buf.push(makeEvent("t1", "a"));
      expect(buf.hasThread("t1")).toBe(true);
    });

    it("returns false after drop", () => {
      const buf = new EventBuffer();
      buf.push(makeEvent("t1", "a"));
      buf.drop("t1");
      expect(buf.hasThread("t1")).toBe(false);
    });
  });

  describe("drop", () => {
    it("removes a thread's buffer", () => {
      const buf = new EventBuffer();
      buf.push(makeEvent("t1", "a"));
      buf.push(makeEvent("t1", "b"));
      expect(buf.getEvents("t1")).toHaveLength(2);

      buf.drop("t1");
      expect(buf.getEvents("t1")).toHaveLength(0);
      expect(buf.knownThreadIds()).not.toContain("t1");
    });
  });
});
