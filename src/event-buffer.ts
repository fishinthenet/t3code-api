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

  /** Get messages (user + assistant) from thread events. */
  getMessages(threadId: string, options?: { afterSequence?: number; limit?: number }) {
    return this.getEvents(threadId, {
      ...options,
      types: ["thread.message-sent"],
    }).map((e) => ({
      sequence: e.sequence,
      messageId: e.payload.messageId,
      role: e.payload.role,
      text: e.payload.text,
      turnId: e.payload.turnId,
      createdAt: e.payload.createdAt,
    }));
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
