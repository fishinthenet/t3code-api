/**
 * Persistent WebSocket client to T3 Code server.
 * Maintains connection with auto-reconnect, heartbeat, and request/response matching.
 * Uses `ws` npm package for custom header support (bearer token auth).
 *
 * Wire protocol: Effect RPC over WebSocket (@effect/rpc, JSON serialization).
 * Client → Server:  {_tag: "Request", id, tag, payload, headers: []}
 *                   {_tag: "Ack", requestId}    (stream ack)
 *                   {_tag: "Interrupt", requestId}
 *                   {_tag: "Eof"}
 *                   {_tag: "Ping"}
 * Server → Client:  {_tag: "Chunk", requestId, values: [...]}   (stream chunk)
 *                   {_tag: "Exit", requestId, exit: {_tag: "Success"|"Failure", ...}}
 *                   {_tag: "Defect", defect}                    (protocol error)
 *                   {_tag: "Pong"}
 *                   {_tag: "ClientProtocolError", error}
 *
 * Breaking change from T3 v0.0.17 → v0.0.18: server switched from custom
 * `{id, body: {_tag, ...}}` format to Effect RPC. See `t3 bin.mjs` →
 * `RpcServer.toHttpEffectWebsocket(WsRpcGroup, {...}, RpcSerialization.layerJson)`.
 */

import WebSocketNode from "ws";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  tag: string;
  // For streaming RPCs, collect chunks and resolve on Exit.
  stream?: boolean;
  chunks?: unknown[];
  onChunk?: (values: unknown[]) => void;
};

export type PushHandler = (msg: {
  type: "push";
  channel: string;
  data: unknown;
}) => void;

const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;

export class T3WebSocketClient {
  private ws: WebSocketNode | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly queue: string[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatProbeTimer: ReturnType<typeof setTimeout> | null = null;
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
    private readonly bearerToken?: string,
  ) {
    this.connect();
  }

  get connected() {
    return this._connected;
  }

  /**
   * Send a unary request. Resolves with the success value, rejects with
   * the encoded failure or a protocol-level error.
   */
  request<T = unknown>(tag: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this._connected || this.ws?.readyState !== WebSocketNode.OPEN) {
      this._connected = false;
      return Promise.reject(new Error(`WebSocket not connected — cannot send ${tag}`));
    }
    return new Promise((resolve, reject) => {
      const id = String(this.nextId++);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${tag} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        tag,
      });
      this.send(JSON.stringify({
        _tag: "Request",
        id,
        tag,
        payload: params,
        headers: [],
      }));
    });
  }

  /**
   * Subscribe to a streaming RPC. Calls `onChunk` for each batch of values
   * received, and resolves once the server sends Exit (or rejects on failure).
   */
  requestStream<T = unknown>(
    tag: string,
    params: Record<string, unknown> = {},
    onChunk: (values: T[]) => void,
  ): { id: string; done: Promise<T[]>; cancel: () => void } {
    if (!this._connected || this.ws?.readyState !== WebSocketNode.OPEN) {
      this._connected = false;
      const err = new Error(`WebSocket not connected — cannot send ${tag}`);
      return {
        id: "-1",
        done: Promise.reject(err),
        cancel: () => {},
      };
    }
    const id = String(this.nextId++);
    let resolveDone!: (v: T[]) => void;
    let rejectDone!: (e: Error) => void;
    const done = new Promise<T[]>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });
    // Streams have no overall timeout — caller cancels or server ends.
    const chunks: unknown[] = [];
    this.pending.set(id, {
      resolve: (v) => resolveDone(v as T[]),
      reject: rejectDone,
      // Dummy timer (cleared on exit). We still set one to avoid hanging forever
      // if the connection dies without an Exit frame — the disconnect handler
      // will reject pending.
      timer: setTimeout(() => {}, 0),
      tag,
      stream: true,
      chunks,
      onChunk: (values) => onChunk(values as T[]),
    });
    this.send(JSON.stringify({
      _tag: "Request",
      id,
      tag,
      payload: params,
      headers: [],
    }));

    return {
      id,
      done,
      cancel: () => {
        const p = this.pending.get(id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(id);
          this.send(JSON.stringify({ _tag: "Interrupt", requestId: id }));
          resolveDone(chunks as T[]);
        }
      },
    };
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

    const options: WebSocketNode.ClientOptions = {};
    if (this.bearerToken) {
      options.headers = { Authorization: "Bearer " + this.bearerToken };
    }

    const ws = new WebSocketNode(this.url, options);

    ws.on("open", () => {
      this._connected = true;
      this.lastMessageAt = Date.now();
      this.reconnectAttempt = 0;
      this.flushQueue();
      this.startHeartbeat();
      this.onConnected?.();
    });

    ws.on("message", (data: WebSocketNode.RawData) => {
      this.lastMessageAt = Date.now();
      try {
        const raw = data.toString();
        const msg = JSON.parse(raw);
        this.handleServerMessage(msg);
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("pong", () => {
      // Native WS-level pong → connection is alive. Reset silence clock
      // and clear any pending heartbeat probe timeout.
      this.lastMessageAt = Date.now();
      if (this.heartbeatProbeTimer) {
        clearTimeout(this.heartbeatProbeTimer);
        this.heartbeatProbeTimer = null;
      }
    });

    ws.on("close", () => {
      this.handleDisconnect();
    });

    ws.on("error", () => {
      // close event will fire after this
    });

    this.ws = ws;
  }

  /**
   * Parse a server frame (Effect RPC FromServerEncoded).
   */
  private handleServerMessage(msg: Record<string, unknown>) {
    const tag = msg._tag as string | undefined;
    if (!tag) return;

    switch (tag) {
      case "Pong":
        // App-level pong — just extend lastMessageAt (already done above).
        if (this.heartbeatProbeTimer) {
          clearTimeout(this.heartbeatProbeTimer);
          this.heartbeatProbeTimer = null;
        }
        return;

      case "Chunk": {
        const requestId = String(msg.requestId ?? "");
        const values = (msg.values as unknown[]) ?? [];
        const p = this.pending.get(requestId);
        if (!p) return;

        if (p.stream) {
          if (p.chunks) p.chunks.push(...values);
          p.onChunk?.(values);
          // Ack to let the server send more.
          this.send(JSON.stringify({ _tag: "Ack", requestId }));
        } else {
          // Unary request produced a chunk — buffer; Exit resolves the promise.
          p.chunks = (p.chunks ?? []).concat(values);
        }
        return;
      }

      case "Exit": {
        const requestId = String(msg.requestId ?? "");
        const p = this.pending.get(requestId);
        if (!p) return;
        this.pending.delete(requestId);
        clearTimeout(p.timer);

        const exit = msg.exit as
          | { _tag: "Success"; value: unknown }
          | { _tag: "Failure"; cause: ReadonlyArray<Record<string, unknown>> }
          | undefined;

        if (!exit) {
          p.reject(new Error(`Malformed Exit for ${p.tag}`));
          return;
        }

        if (exit._tag === "Success") {
          if (p.stream) {
            p.resolve(p.chunks ?? []);
          } else if (p.chunks && p.chunks.length > 0) {
            // Unary RPC that sent chunks — prefer the chunk stream over the
            // (usually undefined) Success value.
            p.resolve(p.chunks);
          } else {
            p.resolve(exit.value);
          }
        } else {
          const detail = this.formatFailure(exit.cause ?? []);
          p.reject(new Error(`${p.tag}: ${detail}`));
        }
        return;
      }

      case "Defect": {
        // Protocol-level error not tied to a specific request (unknown tag, etc.)
        console.warn(`[ws] Server Defect: ${JSON.stringify(msg.defect)}`);
        return;
      }

      case "ClientProtocolError": {
        console.warn(`[ws] ClientProtocolError: ${JSON.stringify(msg.error)}`);
        return;
      }

      default:
        // Backward compat: legacy `{type: "push", ...}` events from older
        // t3code servers. On v0.0.18 push events are modeled as streaming
        // Chunk frames in orchestration.subscribeShell / subscribeThread.
        if ((msg as Record<string, unknown>).type === "push") {
          this.onPush?.(msg as unknown as Parameters<PushHandler>[0]);
        }
    }
  }

  private formatFailure(cause: ReadonlyArray<Record<string, unknown>>): string {
    if (cause.length === 0) return "Unknown failure";
    return cause
      .map((c) => {
        if (c._tag === "Fail") {
          const err = c.error as { message?: string; _tag?: string } | string | undefined;
          if (typeof err === "string") return err;
          return err?.message ?? err?._tag ?? JSON.stringify(err);
        }
        if (c._tag === "Die") {
          const defect = c.defect;
          if (typeof defect === "string") return defect;
          return JSON.stringify(defect);
        }
        if (c._tag === "Interrupt") return "Interrupted";
        return JSON.stringify(c);
      })
      .join("; ");
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
    if (this.ws?.readyState === WebSocketNode.OPEN) {
      this.ws.send(data);
    } else {
      this.queue.push(data);
    }
  }

  private flushQueue() {
    while (this.queue.length > 0 && this.ws?.readyState === WebSocketNode.OPEN) {
      this.ws.send(this.queue.shift()!);
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this._connected || !this.ws) return;

      if (this.ws.readyState !== WebSocketNode.OPEN) {
        console.warn(`[ws] Heartbeat: readyState=${this.ws.readyState}, forcing reconnect`);
        this.ws.close();
        this.handleDisconnect();
        return;
      }

      const silenceMs = Date.now() - this.lastMessageAt;
      if (silenceMs > HEARTBEAT_INTERVAL_MS) {
        // Use native WebSocket-level ping/pong — works regardless of server
        // app protocol versions. (Previously we sent
        // `orchestration.getSnapshot` which was removed from T3 Code server
        // in v0.0.18.)
        if (this.heartbeatProbeTimer) return; // Probe in flight
        this.heartbeatProbeTimer = setTimeout(() => {
          this.heartbeatProbeTimer = null;
          console.warn(`[ws] Heartbeat ping timed out after ${HEARTBEAT_TIMEOUT_MS}ms, forcing reconnect`);
          this.ws?.close();
          this.handleDisconnect();
        }, HEARTBEAT_TIMEOUT_MS);

        try {
          this.ws.ping();
        } catch (err) {
          console.warn(`[ws] Heartbeat ping failed to send, forcing reconnect`, err);
          if (this.heartbeatProbeTimer) {
            clearTimeout(this.heartbeatProbeTimer);
            this.heartbeatProbeTimer = null;
          }
          this.ws?.close();
          this.handleDisconnect();
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatProbeTimer) {
      clearTimeout(this.heartbeatProbeTimer);
      this.heartbeatProbeTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.disposed) return;
    const delay = Math.min(500 * 2 ** this.reconnectAttempt, 8000);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
