/**
 * Per-thread webhook delivery with retry and backoff.
 */

export interface WebhookConfig {
  url: string;
  events: string[];
  headers?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface WebhookPayload {
  event: string;
  threadId: string;
  projectId: string;
  title: string;
  status: string;
  durationMs: number;
  messagesCount: number;
  metadata?: Record<string, unknown>;
  error?: string;
}

interface ThreadState {
  config: WebhookConfig;
  projectId: string;
  title: string;
  createdAt: number;
  lastStatus: string | null;
  /** Queued deliveries, processed in order. */
  queue: Array<() => Promise<void>>;
  processing: boolean;
}

const RETRY_DELAYS_MS = [1_000, 5_000, 15_000];
const DELIVERY_TIMEOUT_MS = 10_000;

export type FetchFn = typeof globalThis.fetch;

export class WebhookManager {
  private readonly threads = new Map<string, ThreadState>();
  private readonly fetchFn: FetchFn;

  constructor(fetchFn?: FetchFn) {
    this.fetchFn = fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  /** Register a webhook for a thread. */
  register(
    threadId: string,
    config: WebhookConfig,
    projectId: string,
    title: string,
  ) {
    this.threads.set(threadId, {
      config: {
        ...config,
        events: config.events?.length ? config.events : ["completed", "error"],
      },
      projectId,
      title,
      createdAt: Date.now(),
      lastStatus: null,
      queue: [],
      processing: false,
    });
  }

  /** Remove a thread's webhook config. */
  remove(threadId: string) {
    this.threads.delete(threadId);
  }

  /** Check if a thread has a webhook registered. */
  has(threadId: string): boolean {
    return this.threads.has(threadId);
  }

  /** Get webhook config for a thread (for testing). */
  get(threadId: string): WebhookConfig | undefined {
    return this.threads.get(threadId)?.config;
  }

  /**
   * Called on every status change. Determines whether to fire a webhook
   * based on the event mapping and status transition.
   */
  onStatusChange(
    threadId: string,
    newStatus: string,
    extra?: { messagesCount?: number; error?: string },
  ) {
    const state = this.threads.get(threadId);
    if (!state) return;

    // Avoid firing on same status repeatedly.
    if (state.lastStatus === newStatus) return;
    const prevStatus = state.lastStatus;
    state.lastStatus = newStatus;

    const event = this.mapStatusToEvent(newStatus, prevStatus);
    if (!event) return;
    if (!state.config.events.includes(event)) return;

    const payload: WebhookPayload = {
      event,
      threadId,
      projectId: state.projectId,
      title: state.title,
      status: newStatus,
      durationMs: Date.now() - state.createdAt,
      messagesCount: extra?.messagesCount ?? 0,
      ...(state.config.metadata ? { metadata: state.config.metadata } : {}),
      ...(extra?.error ? { error: extra.error } : {}),
    };

    // Enqueue delivery to guarantee in-order per thread.
    state.queue.push(() => this.deliver(state.config, payload, threadId));
    this.processQueue(state);
  }

  private mapStatusToEvent(
    status: string,
    _prev: string | null,
  ): string | null {
    switch (status) {
      case "idle":
      case "ready":
        return "completed";
      case "error":
        return "error";
      default:
        return null;
    }
  }

  private async processQueue(state: ThreadState) {
    if (state.processing) return;
    state.processing = true;
    while (state.queue.length > 0) {
      const task = state.queue.shift()!;
      try {
        await task();
      } catch {
        // Delivery failed after all retries — move on.
      }
    }
    state.processing = false;
  }

  private async deliver(
    config: WebhookConfig,
    payload: WebhookPayload,
    threadId: string,
  ) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          DELIVERY_TIMEOUT_MS,
        );

        const res = await this.fetchFn(config.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-T3-Event": payload.event,
            "X-T3-Thread": threadId,
            ...config.headers,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (res.status >= 200 && res.status < 300) return; // Success

        // Non-2xx — retry if attempts remain.
      } catch {
        // Network error or timeout — retry if attempts remain.
      }

      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
    // All retries exhausted — silently give up.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
