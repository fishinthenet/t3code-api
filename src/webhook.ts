/**
 * Per-thread webhook delivery with retry and backoff.
 */

export interface WebhookConfig {
  url: string;
  events: string[];
  headers?: Record<string, string>;
  metadata?: Record<string, unknown>;
  format?: "default" | "openclaw-hooks";
}

export interface WebhookPayload {
  event: string;
  webhookSeq: number;
  threadId: string;
  projectId: string;
  title: string;
  previousStatus: string | null;
  status: string;
  durationMs: number;
  messagesCount: number;
  metadata?: Record<string, unknown>;
  error?: string;
}

/** Expand aliases to granular status:* events. */
const ALIASES: Record<string, string[]> = {
  completed: ["status:ready", "status:idle"],
  error: ["status:error"],
};

interface ThreadState {
  config: WebhookConfig;
  /** Expanded set of granular events this webhook listens for. */
  expandedEvents: Set<string>;
  projectId: string;
  title: string;
  createdAt: number;
  lastStatus: string | null;
  webhookSeq: number;
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
    const events = config.events?.length ? config.events : ["completed", "error"];
    // Expand aliases into granular status:* events.
    const expanded = new Set<string>();
    for (const e of events) {
      const aliases = ALIASES[e];
      if (aliases) {
        for (const a of aliases) expanded.add(a);
      } else {
        expanded.add(e);
      }
    }

    this.threads.set(threadId, {
      config: { ...config, events },
      expandedEvents: expanded,
      projectId,
      title,
      createdAt: Date.now(),
      lastStatus: null,
      webhookSeq: 0,
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
   * based on the granular event and subscription matching.
   */
  onStatusChange(
    threadId: string,
    newStatus: string,
    extra?: { messagesCount?: number; error?: string },
  ) {
    const state = this.threads.get(threadId);
    if (!state) return;

    // Only fire on actual status transitions.
    if (state.lastStatus === newStatus) return;
    const previousStatus = state.lastStatus;
    state.lastStatus = newStatus;

    const event = `status:${newStatus}`;
    if (!state.expandedEvents.has(event)) return;

    state.webhookSeq++;

    const payload: WebhookPayload = {
      event,
      webhookSeq: state.webhookSeq,
      threadId,
      projectId: state.projectId,
      title: state.title,
      previousStatus,
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

  private formatBody(config: WebhookConfig, payload: WebhookPayload): string {
    if (config.format === "openclaw-hooks") {
      return JSON.stringify(formatOpenClawPayload(config, payload));
    }
    return JSON.stringify(payload);
  }

  private async deliver(
    config: WebhookConfig,
    payload: WebhookPayload,
    threadId: string,
  ) {
    const body = this.formatBody(config, payload);

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
          body,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (res.status >= 200 && res.status < 300) {
          console.log(`[webhook] Delivered ${payload.event} seq=${payload.webhookSeq} to ${config.url} (thread=${threadId})`);
          return;
        }

        // Non-2xx — log and retry if attempts remain.
        let responseBody = "";
        try { responseBody = await res.text(); } catch { /* ignore */ }
        console.warn(
          `[webhook] ${config.url} returned ${res.status} for ${payload.event} seq=${payload.webhookSeq} (thread=${threadId}, attempt=${attempt + 1}/${RETRY_DELAYS_MS.length + 1})`,
          responseBody ? `— body: ${responseBody.slice(0, 200)}` : "",
        );
      } catch (err) {
        console.warn(
          `[webhook] ${config.url} failed for ${payload.event} seq=${payload.webhookSeq} (thread=${threadId}, attempt=${attempt + 1}/${RETRY_DELAYS_MS.length + 1}):`,
          err instanceof Error ? err.message : err,
        );
      }

      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
    console.error(`[webhook] Exhausted ${RETRY_DELAYS_MS.length + 1} attempts for ${payload.event} seq=${payload.webhookSeq} → ${config.url} (thread=${threadId})`);
  }
}

/** Format payload for OpenClaw /hooks/agent endpoint. */
export function formatOpenClawPayload(
  config: WebhookConfig,
  payload: WebhookPayload,
): Record<string, unknown> {
  const meta = config.metadata ?? {};
  const durationSec = Math.round(payload.durationMs / 1000);
  const host = meta.host ? `\nhost: ${meta.host}` : "";
  const errorLine = payload.error ? `\nerror: ${payload.error}` : "";

  const message =
    `🔔 t3code: "${payload.title}" — ${payload.event} (${payload.status}, ${payload.messagesCount} msgs, ${durationSec}s)` +
    `\nthreadId: ${payload.threadId}` +
    host +
    errorLine;

  const result: Record<string, unknown> = {
    message,
    wakeMode: "now",
    name: `t3code:${payload.title}`,
  };

  if (meta.agentId) result.agentId = meta.agentId;
  if (meta.sessionKey) result.sessionKey = meta.sessionKey;

  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
