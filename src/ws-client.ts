/**
 * Persistent WebSocket client to T3 Code server.
 * Maintains connection with auto-reconnect and request/response matching.
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

export class T3WebSocketClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly queue: string[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private disposed = false;
  private _connected = false;

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
      this.reconnectAttempt = 0;
      this.flushQueue();
      this.onConnected?.();
    });

    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(String(event.data));

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
      this._connected = false;
      this.ws = null;
      this.onDisconnected?.();
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // close event will fire after this
    });

    this.ws = ws;
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

  private scheduleReconnect() {
    if (this.disposed) return;
    const delay = Math.min(500 * 2 ** this.reconnectAttempt, 8000);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
