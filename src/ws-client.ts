/**
 * Persistent WebSocket client to T3 Code server.
 * Maintains connection with auto-reconnect, heartbeat, and request/response matching.
 */

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type PushHandler = (msg: {
  type: "push";
  sequence: number;
  channel: string;
  data: unknown;
}) => void;

const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;

export class T3WebSocketClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly queue: string[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private disposed = false;
  private _connected = false;
  private lastMessageAt = 0;

  onPush: PushHandler | null = null;
  onConnected: (() => void) | null = null;
  onDisconnected: (() => void) | null = null;

  constructor(
    private readonly url: string,
    private readonly requestTimeoutMs = 30_000,
  ) {
    this.connect();
  }

  get connected() {
    return this._connected;
  }

  request<T = unknown>(tag: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this._connected || this.ws?.readyState !== WebSocket.OPEN) {
      this._connected = false;
      return Promise.reject(new Error(`WebSocket not connected — cannot send ${tag}`));
    }
    return new Promise((resolve, reject) => {
      const id = String(this.nextId++);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${tag} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send(JSON.stringify({ id, body: { _tag: tag, ...params } }));
    });
  }

  dispose() {
    this.disposed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Client disposed"));
    }
    this.pending.clear();
    this.ws?.close();
    this.ws = null;
  }

  private connect() {
    if (this.disposed) return;

    const ws = new WebSocket(this.url);

    ws.addEventListener("open", () => {
      this._connected = true;
      this.lastMessageAt = Date.now();
      this.reconnectAttempt = 0;
      this.flushQueue();
      this.startHeartbeat();
      this.onConnected?.();
    });

    ws.addEventListener("message", (event) => {
      this.lastMessageAt = Date.now();
      try {
        const raw = String(event.data);
        const msg = JSON.parse(raw);

        // Push message
        if (msg.type === "push") {
          this.onPush?.(msg);
          return;
        }

        // Response to a request
        if (msg.id !== undefined) {
          const p = this.pending.get(String(msg.id));
          if (p) {
            this.pending.delete(String(msg.id));
            clearTimeout(p.timer);
            if (msg.error) {
              p.reject(new Error(msg.error.message ?? "Unknown server error"));
            } else {
              p.resolve(msg.result);
            }
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.addEventListener("close", () => {
      this.handleDisconnect();
    });

    ws.addEventListener("error", () => {
      // close event will fire after this
    });

    this.ws = ws;
  }

  private handleDisconnect() {
    if (!this._connected && this.ws === null) return; // Already handled
    this._connected = false;
    this.stopHeartbeat();
    this.ws = null;
    // Reject all pending requests immediately
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("WebSocket connection lost"));
      this.pending.delete(id);
    }
    this.onDisconnected?.();
    this.scheduleReconnect();
  }

  private send(data: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      this.queue.push(data);
    }
  }

  private flushQueue() {
    while (this.queue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(this.queue.shift()!);
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this._connected || !this.ws) return;

      // If readyState isn't OPEN, the socket is dead
      if (this.ws.readyState !== WebSocket.OPEN) {
        console.warn(`[ws] Heartbeat: readyState=${this.ws.readyState}, forcing reconnect`);
        this.ws.close();
        this.handleDisconnect();
        return;
      }

      // If no message received for too long, probe with a lightweight request
      const silenceMs = Date.now() - this.lastMessageAt;
      if (silenceMs > HEARTBEAT_INTERVAL_MS) {
        const probeId = `hb-${Date.now()}`;
        const probeTimeout = setTimeout(() => {
          if (this.pending.has(probeId)) {
            this.pending.delete(probeId);
            console.warn(`[ws] Heartbeat probe timed out after ${HEARTBEAT_TIMEOUT_MS}ms, forcing reconnect`);
            this.ws?.close();
            this.handleDisconnect();
          }
        }, HEARTBEAT_TIMEOUT_MS);

        this.pending.set(probeId, {
          resolve: () => {
            clearTimeout(probeTimeout);
            this.pending.delete(probeId);
          },
          reject: () => {
            clearTimeout(probeTimeout);
            this.pending.delete(probeId);
          },
          timer: probeTimeout,
        });

        this.send(
          JSON.stringify({ id: probeId, body: { _tag: "orchestration.getSnapshot" } }),
        );
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.disposed) return;
    const delay = Math.min(500 * 2 ** this.reconnectAttempt, 8000);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
