import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { RpcPeer } from "./rpc.js";
import { VERSION } from "../../version.js";

export interface AdapterSpec { command: string; args: string[]; env: Record<string, string>; cwd: string }
export interface McpServerSpec { name: string; command: string; args: string[]; env: { name: string; value: string }[] }

export type AcpPermissionParams = {
  sessionId: string;
  toolCall: { toolCallId: string; title?: string; kind?: string; rawInput?: unknown; locations?: { path: string }[] };
  options: { optionId: string; name: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" }[];
};
export type AcpPermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

const STDERR_TAIL = 4096;
const KILL_GRACE_MS = 2000;
const CANCELLED: AcpPermissionOutcome = { outcome: "cancelled" };

function modeIds(result: any): string[] {
  const list = result?.modes?.availableModes;
  return Array.isArray(list) ? list.map((m: any) => String(m.id)) : [];
}

/** The session's current mode as the setup response reports it, or null. */
function currentMode(result: any): string | null {
  const id = result?.modes?.currentModeId;
  return typeof id === "string" ? id : null;
}

/** One running ACP adapter child process and the JSON-RPC conversation with it. */
export class AcpConnection extends EventEmitter {
  private rpc: RpcPeer;
  private stderr = "";
  private exited = false;
  get hasExited(): boolean { return this.exited; }
  private killTimer: NodeJS.Timeout | null = null;
  private permissionHandler: ((p: AcpPermissionParams) => Promise<AcpPermissionOutcome>) | null = null;
  private openAsks = new Map<string, Set<(o: AcpPermissionOutcome) => void>>();

  private constructor(private child: ChildProcess) {
    super();
    this.rpc = new RpcPeer(child.stdout!, child.stdin!);
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => {
      this.stderr = (this.stderr + d).slice(-STDERR_TAIL);
    });
    this.rpc.onNotification("session/update", (p) => {
      if (!p?.update) return;
      // A throwing "update" listener must never reach the host process: log once and carry on.
      try {
        this.emit("update", p.update);
      } catch (err) {
        console.error(`[rushes] an "update" listener threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    this.rpc.onRequest("session/request_permission", (p) => this.askPermission(p));
    let done = false;
    const finish = (code: number | null, label: string) => {
      if (done) return;
      done = true;
      this.exited = true;
      if (this.killTimer) clearTimeout(this.killTimer);
      this.killTimer = null;
      this.rpc.close(new Error(`Agent adapter ${label}`));
      // Nobody is left to answer these; settle them and drop the bookkeeping.
      for (const set of [...this.openAsks.values()]) for (const settle of [...set]) settle(CANCELLED);
      this.openAsks.clear();
      this.emit("exit", { code, stderr: this.stderr });
    };
    // "close", not "exit": stderr is fully read by then, so the tail is complete.
    child.on("close", (code, signal) => finish(code, signal ? `was stopped by ${signal} (exit code ${code})` : `exited with code ${code}`));
    child.on("error", (err) => finish(null, `failed to start: ${err.message} (exit code null)`));
  }

  static start(spec: AdapterSpec): AcpConnection {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
    return new AcpConnection(child);
  }

  async initialize(): Promise<{ loadSession: boolean }> {
    const r = await this.rpc.request<any>("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "rushes", version: VERSION },
    });
    return { loadSession: r?.agentCapabilities?.loadSession === true };
  }

  /** `extra` is merged into the request's params (an adapter's own setup fields, such as Claude's configOptions). */
  async newSession(cwd: string, mcp: McpServerSpec[], extra: Record<string, unknown> = {}): Promise<{ sessionId: string; modes: string[]; current: string | null }> {
    const r = await this.rpc.request<any>("session/new", { cwd, mcpServers: mcp, ...extra });
    return { sessionId: String(r.sessionId), modes: modeIds(r), current: currentMode(r) };
  }

  async loadSession(id: string, cwd: string, mcp: McpServerSpec[], extra: Record<string, unknown> = {}): Promise<{ modes: string[]; current: string | null }> {
    const r = await this.rpc.request<any>("session/load", { sessionId: id, cwd, mcpServers: mcp, ...extra });
    return { modes: modeIds(r), current: currentMode(r) };
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.rpc.request("session/set_mode", { sessionId, modeId });
  }

  async prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    const r = await this.rpc.request<any>("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    return { stopReason: String(r?.stopReason ?? "end_turn") };
  }

  /** Sends session/cancel and answers every permission ask still open for that session as cancelled. */
  cancel(sessionId: string): void {
    this.rpc.notify("session/cancel", { sessionId });
    const asks = this.openAsks.get(sessionId);
    if (asks) for (const settle of [...asks]) settle(CANCELLED);
  }

  onPermission(fn: (p: AcpPermissionParams) => Promise<AcpPermissionOutcome>): void {
    this.permissionHandler = fn;
  }

  /** SIGTERM now, SIGKILL after 2 s if the child is still there. */
  kill(): void {
    if (this.exited || this.killTimer) return;
    this.child.kill("SIGTERM");
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (!this.exited) this.child.kill("SIGKILL");
    }, KILL_GRACE_MS);
    this.killTimer.unref();
  }

  private askPermission(params: AcpPermissionParams): Promise<unknown> {
    const sessionId = params.sessionId;
    return new Promise((resolve) => {
      let settled = false;
      const settle = (o: AcpPermissionOutcome) => {
        if (settled) return;
        settled = true;
        const open = this.openAsks.get(sessionId);
        open?.delete(settle);
        if (open && open.size === 0) this.openAsks.delete(sessionId);
        resolve({ outcome: o });
      };
      let set = this.openAsks.get(sessionId);
      if (!set) this.openAsks.set(sessionId, (set = new Set()));
      set.add(settle);
      const handler = this.permissionHandler;
      if (!handler) return settle(CANCELLED);
      // A handler that throws or rejects gives the agent "cancelled", never an RPC error.
      Promise.resolve().then(() => handler(params)).then(settle, () => settle(CANCELLED));
    });
  }
}
