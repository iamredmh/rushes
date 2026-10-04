// One live connection per project, shared by every open tab (§19.8), against fake Web Locks,
// BroadcastChannels and EventSources. The real browsers are covered in e2e/dashboard.spec.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectLive, type LiveDeps, type LiveHandlers } from "../../web/src/live.js";

/** Web Locks, exclusive only: a lock goes to the next request in line when its callback's promise settles. */
class FakeLocks {
  held = new Set<string>();
  queues = new Map<string, (() => void)[]>();
  request(name: string, opts: { signal?: AbortSignal }, cb: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const grant = () => {
        this.held.add(name);
        void cb().finally(() => {
          this.held.delete(name);
          resolve();
          this.queues.get(name)?.shift()?.();
        });
      };
      if (!this.held.has(name)) return grant();
      const queue = this.queues.get(name) ?? [];
      this.queues.set(name, queue);
      queue.push(grant);
      opts.signal?.addEventListener("abort", () => {
        const i = queue.indexOf(grant);
        if (i >= 0) queue.splice(i, 1);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  }
}

let channels: FakeChannel[];
class FakeChannel {
  onmessage: ((e: MessageEvent) => void) | null = null;
  closed = false;
  constructor(public name: string) { channels.push(this); }
  postMessage(data: unknown) {
    for (const c of channels) {
      if (c === this || c.closed || c.name !== this.name) continue;
      queueMicrotask(() => { if (!c.closed) c.onmessage?.({ data } as MessageEvent); });
    }
  }
  close() { this.closed = true; }
}

let streams: FakeStream[];
class FakeStream {
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { streams.push(this); }
  addEventListener(type: string, cb: (e: MessageEvent) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]); }
  emit(type: string, data = "") { for (const cb of this.listeners.get(type) ?? []) cb({ data } as MessageEvent); }
  close() { this.closed = true; }
}

const open = () => streams.filter((s) => !s.closed);
const flush = () => new Promise((r) => setTimeout(r, 0));

function handlers(): LiveHandlers & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    change: (d) => seen.push(`change ${d}`),
    proxy: (d) => seen.push(`proxy ${d}`),
    corrupt: (d) => seen.push(`corrupt ${d}`),
    open: () => seen.push("open"),
    error: () => seen.push("error"),
  };
}

let locks: FakeLocks;
const deps = (): LiveDeps => ({
  locks: locks as unknown as LiveDeps["locks"],
  BroadcastChannel: FakeChannel as unknown as LiveDeps["BroadcastChannel"],
  EventSource: FakeStream as unknown as LiveDeps["EventSource"],
});

beforeEach(() => {
  channels = [];
  streams = [];
  locks = new FakeLocks();
});

describe("connectLive (§19.8)", () => {
  it("opens one stream for four tabs on a project: the leader's", async () => {
    const tabs = [0, 1, 2, 3].map(() => connectLive("abcd2345", "/api/events?project=abcd2345", handlers(), deps()));
    await flush();
    expect(open()).toHaveLength(1);
    expect(tabs.map((t) => t.role())).toEqual(["leader", "follower", "follower", "follower"]);
    expect(locks.held).toEqual(new Set(["rushes-sse-abcd2345"]));
  });

  it("relays every event, and the connection's state, to the other tabs", async () => {
    const hs = [handlers(), handlers(), handlers()];
    for (const h of hs) connectLive("abcd2345", "/e", h, deps());
    await flush();
    const [stream] = open();
    stream.onopen!();
    stream.emit("change", '{"file":"notes"}');
    stream.emit("proxy", '{"id":"j1"}');
    stream.emit("corrupt", '{"file":"notes"}');
    stream.onerror!();
    stream.emit("ping");
    await flush();
    const expected = ["open", 'change {"file":"notes"}', 'proxy {"id":"j1"}', 'corrupt {"file":"notes"}', "error"];
    for (const h of hs) expect(h.seen).toEqual(expected);
  });

  it("hands the stream to another tab when the leader closes", async () => {
    const leader = connectLive("abcd2345", "/e", handlers(), deps());
    const h = handlers();
    const follower = connectLive("abcd2345", "/e", h, deps());
    await flush();
    const [first] = open();
    leader.close();
    expect(first.closed).toBe(true);
    await flush();
    expect(follower.role()).toBe("leader");
    expect(open()).toHaveLength(1);
    open()[0].emit("change", "x");
    expect(h.seen).toEqual(["change x"]);
  });

  it("never shares between projects", async () => {
    const a = connectLive("aaaa2345", "/e?project=aaaa2345", handlers(), deps());
    const hb = handlers();
    const b = connectLive("bbbb2345", "/e?project=bbbb2345", hb, deps());
    await flush();
    expect([a.role(), b.role()]).toEqual(["leader", "leader"]);
    expect(open().map((s) => s.url)).toEqual(["/e?project=aaaa2345", "/e?project=bbbb2345"]);
    open()[0].emit("change", "a");
    await flush();
    expect(hb.seen).toEqual([]);
  });

  it("a tab closed while waiting in line never opens a stream", async () => {
    const leader = connectLive("abcd2345", "/e", handlers(), deps());
    const waiting = connectLive("abcd2345", "/e", handlers(), deps());
    await flush();
    waiting.close();
    leader.close();
    await flush();
    expect(streams).toHaveLength(1);
    expect(open()).toHaveLength(0);
    expect(locks.held.size).toBe(0);
  });

  it("ignores a stray message on the channel", async () => {
    connectLive("abcd2345", "/e", handlers(), deps());
    const h = handlers();
    connectLive("abcd2345", "/e", h, deps());
    await flush();
    const stray = new FakeChannel("rushes-abcd2345");
    stray.postMessage({ type: "change" });
    stray.postMessage({ type: "shutdown", data: "" });
    stray.postMessage("change");
    await flush();
    expect(h.seen).toEqual([]);
  });

  it("falls back to a stream per tab without Web Locks or BroadcastChannel", async () => {
    const noLocks = connectLive("abcd2345", "/e", handlers(), { ...deps(), locks: undefined });
    const noChannel = connectLive("abcd2345", "/e", handlers(), { ...deps(), BroadcastChannel: undefined });
    await flush();
    expect([noLocks.role(), noChannel.role()]).toEqual(["own", "own"]);
    expect(open()).toHaveLength(2);
    noLocks.close();
    expect(open()).toHaveLength(1);
  });

  it("closes cleanly, and only once", async () => {
    const live = connectLive("abcd2345", "/e", handlers(), deps());
    await flush();
    const close = vi.spyOn(open()[0], "close");
    live.close();
    live.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(channels[0].closed).toBe(true);
    await flush();
    expect(locks.held.size).toBe(0);
  });
});
