/**
 * Per-thread circular event buffer.
 * Stores orchestration domain events, filterable by type and sequence.
 */

export interface DomainEvent {
  sequence: number;
  eventId: string;
  type: string;
  aggregateId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AccumulatedMessage {
  sequence: number;
  messageId: string;
  role: string;
  text: string;
  turnId: string | null;
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_MAX_EVENTS = 500;

export class EventBuffer {
  private readonly threads = new Map<string, DomainEvent[]>();
  private readonly maxPerThread: number;
  private globalSequence = 0;

  constructor(maxPerThread = DEFAULT_MAX_EVENTS) {
    this.maxPerThread = maxPerThread;
  }

  /** Push a domain event into the appropriate thread buffer. */
  push(event: DomainEvent) {
    const threadId = event.payload?.threadId as string | undefined;
    if (!threadId) return;

    if (event.sequence > this.globalSequence) {
      this.globalSequence = event.sequence;
    }

    let buf = this.threads.get(threadId);
    if (!buf) {
      buf = [];
      this.threads.set(threadId, buf);
    }
    buf.push(event);
    if (buf.length > this.maxPerThread) {
      buf.splice(0, buf.length - this.maxPerThread);
    }
  }

  /** Get events for a thread, optionally filtered. */
  getEvents(
    threadId: string,
    options?: { afterSequence?: number; types?: string[]; limit?: number },
  ): DomainEvent[] {
    const buf = this.threads.get(threadId) ?? [];
    let result = buf;

    if (options?.afterSequence !== undefined) {
      const after = options.afterSequence;
      result = result.filter((e) => e.sequence > after);
    }

    if (options?.types?.length) {
      const allowed = new Set(options.types);
      result = result.filter((e) => allowed.has(e.type));
    }

    if (options?.limit) {
      result = result.slice(-options.limit);
    }

    return result;
  }

  /**
   * Get accumulated messages (user + assistant) from thread events.
   *
   * Assistant messages arrive as streaming deltas — many `thread.message-sent`
   * events with `streaming: true` carrying text fragments, followed by one
   * `streaming: false` event marking completion. This method accumulates
   * deltas by messageId and returns one entry per logical message.
   */
  getMessages(
    threadId: string,
    options?: { afterSequence?: number; limit?: number },
  ): AccumulatedMessage[] {
    const rawEvents = this.getEvents(threadId, {
      ...options,
      types: ["thread.message-sent"],
      // Don't apply limit here — we need all events to accumulate correctly.
      // Limit is applied after accumulation.
      limit: undefined,
    });

    // Accumulate by messageId, preserving insertion order.
    const messages = new Map<string, AccumulatedMessage>();

    for (const e of rawEvents) {
      const msgId = e.payload.messageId as string;
      const streaming = e.payload.streaming as boolean;
      const text = (e.payload.text as string) ?? "";

      const existing = messages.get(msgId);
      if (existing) {
        // Append delta text for streaming messages.
        if (streaming) {
          existing.text += text;
        }
        // Update metadata from latest event.
        existing.sequence = e.sequence;
        existing.streaming = streaming;
        existing.updatedAt = (e.payload.updatedAt as string) ?? existing.updatedAt;
      } else {
        messages.set(msgId, {
          sequence: e.sequence,
          messageId: msgId,
          role: e.payload.role as string,
          text,
          turnId: (e.payload.turnId as string) ?? null,
          streaming,
          createdAt: (e.payload.createdAt as string) ?? e.occurredAt,
          updatedAt: (e.payload.updatedAt as string) ?? e.occurredAt,
        });
      }
    }

    let result = [...messages.values()];

    // Apply afterSequence filter on the first event's sequence for each message.
    // (Already filtered at the event level, but user messages that started before
    // the cursor and had no new events won't appear — that's correct.)

    if (options?.limit) {
      result = result.slice(-options.limit);
    }

    return result;
  }

  /** Get the latest status for a thread from session events. */
  getThreadStatus(threadId: string): string | null {
    const sessionEvents = this.getEvents(threadId, {
      types: ["thread.session-set"],
    });
    if (sessionEvents.length === 0) return null;
    const last = sessionEvents[sessionEvents.length - 1];
    const session = last.payload.session as Record<string, unknown> | undefined;
    return (session?.status as string) ?? null;
  }

  /** List all known thread IDs. */
  knownThreadIds(): string[] {
    return [...this.threads.keys()];
  }

  /** Drop a thread's buffer. */
  drop(threadId: string) {
    this.threads.delete(threadId);
  }

  /** Current highest observed sequence. */
  get lastSequence(): number {
    return this.globalSequence;
  }
}
