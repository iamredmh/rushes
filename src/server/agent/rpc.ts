import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";

type Id = number | string;
interface Pending { resolve: (v: any) => void; reject: (e: Error) => void }

/** A JSON-RPC error that came back from the other side. */
export class RpcError extends Error {
  constructor(message: string, readonly code: number, readonly data?: unknown) {
    super(message);
    this.name = "RpcError";
  }
}

/**
 * JSON-RPC 2.0 over a pair of streams, one JSON object per line.
 * Both sides can send requests and notifications.
 */
export class RpcPeer {
  private nextId = 1;
  private pending = new Map<Id, Pending>();
  private requestHandlers = new Map<string, (params: any) => Promise<unknown>>();
  private notificationHandlers = new Map<string, (params: any) => void>();
  private closed: Error | null = null;

  constructor(input: Readable, private output: Writable) {
    const rl = createInterface({ input, crlfDelay: Infinity });
    rl.on("line", (line) => this.onLine(line));
    // A write to a dead child must not crash the process; the exit handler closes us.
    output.on("error", () => {});
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  onRequest(method: string, fn: (params: any) => Promise<unknown>): void {
    this.requestHandlers.set(method, fn);
  }

  onNotification(method: string, fn: (params: any) => void): void {
    this.notificationHandlers.set(method, fn);
  }

  /** Rejects every request in flight (and any later one) with `reason`. */
  close(reason: Error): void {
    if (this.closed) return;
    this.closed = reason;
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(reason);
  }

  private send(msg: object): void {
    try {
      this.output.write(JSON.stringify(msg) + "\n");
    } catch {
      /* the stream is gone; close() settles the requests */
    }
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method === "string") {
      if (hasId) void this.answer(msg.id, msg.method, msg.params);
      else this.dispatchNotification(msg.method, msg.params);
      return;
    }
    if (hasId) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(String(msg.error.message ?? "rpc error"), Number(msg.error.code ?? -32000), msg.error.data));
      else p.resolve(msg.result);
    }
  }

  /**
   * A throwing notification handler must neither crash the host nor wedge the peer.
   * The error is reported once on stderr with the method name, then ignored.
   */
  private dispatchNotification(method: string, params: unknown): void {
    try {
      this.notificationHandlers.get(method)?.(params);
    } catch (err) {
      console.error(`[rushes] notification handler for ${method} threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async answer(id: Id, method: string, params: unknown): Promise<void> {
    const fn = this.requestHandlers.get(method);
    if (!fn) {
      this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    try {
      const result = await fn(params);
      this.send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (err) {
      this.send({ jsonrpc: "2.0", id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
    }
  }
}
