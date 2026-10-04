// One live connection per project, shared by every open tab (§19.8), against fake Web Locks,
// BroadcastChannels and EventSources. The real browsers are covered in e2e/dashboard.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelName, connectLive, lockName, PROTOCOL, QUIET_MS, type LiveDeps, type LiveHandlers } from "../../web/src/live.js";

/** Web Locks, exclusive only, granted a microtask later as browsers do. `steal` takes a held lock:
 *  the holder's request rejects with AbortError. */
class FakeLocks {
  holders = new Map<string, { reject(e: unknown): void; token: object }>();
  queues = new Map<string, (() => void)[]>();
  get held() { return new Set(this.holders.keys()); }
  request(name: string, opts: { signal?: AbortSignal; steal?: boolean }, cb: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const token = {};
      // Taken now, though the callback runs a microtask later.
      const take = () => this.holders.set(name, { reject, token });
      const grant = () => {
        take();
        void cb().then(() => {
          if (this.holders.get(name)?.token !== token) return;
          this.holders.delete(name);
          resolve();
          this.queues.get(name)?.shift()?.();
        });
      };
      const later = () => {
        take();
        queueMicrotask(grant);
      };
      if (opts.steal) {
        this.holders.get(name)?.reject(new DOMException("stolen", "AbortError"));
        return later();
      }
      if (!this.holders.has(name)) return later();
      const queue = this.queues.get(name) ?? [];
      this.queues.set(name, queue);
      queue.push(later);
      opts.signal?.addEventListener("abort", () => {
        const i = queue.indexOf(later);
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
/** Let every queued microtask (lock grants, channel messages) run. */
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function handlers(): LiveHandlers & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    change: (d) => seen.push(`change ${d}`),
    proxy: (d) => seen.push(`proxy ${d}`),
    corrupt: (d) => seen.push(`corrupt ${d}`),
    open: () => seen.push("open"),
    error: () => seen.push("error"),
    resync: () => seen.push("resync"),
  };
}

/** A tab's window and document, where the page lifecycle events fire. */
function page() {
  return { window: new EventTarget(), document: new EventTarget() };
}
const pageshow = (persisted: boolean) => Object.assign(new Event("pageshow"), { persisted });

let locks: FakeLocks;
const deps = (extra: Partial<LiveDeps> = {}): LiveDeps => ({
  locks: locks as unknown as LiveDeps["locks"],
  BroadcastChannel: FakeChannel as unknown as LiveDeps["BroadcastChannel"],
  EventSource: FakeStream as unknown as LiveDeps["EventSource"],
  random: () => 0,
  ...extra,
});

beforeEach(() => {
  channels = [];
  streams = [];
  locks = new FakeLocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("connectLive (§19.8)", () => {
  it("opens one stream for four tabs on a project: the leader's", async () => {
    const tabs = [0, 1, 2, 3].map(() => connectLive("abcd2345", "/api/events?project=abcd2345", handlers(), deps()));
    await flush();
    expect(open()).toHaveLength(1);
    expect(tabs.map((t) => t.role())).toEqual(["leader", "follower", "follower", "follower"]);
  });

  it("names its lock and channel by protocol version and project", async () => {
    connectLive("abcd2345", "/e", handlers(), deps());
    await flush();
    expect(PROTOCOL).toBe(1);
    expect(locks.held).toEqual(new Set(["rushes-sse-v1-abcd2345"]));
    expect(lockName("abcd2345")).toBe("rushes-sse-v1-abcd2345");
    expect(channels.map((c) => c.name)).toEqual(["rushes-v1-abcd2345"]);
    expect(channelName("abcd2345")).toBe("rushes-v1-abcd2345");
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
    stream.emit("ping");
    stream.onerror!();
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

  it("ignores a stray message, and any from another protocol version", async () => {
    connectLive("abcd2345", "/e", handlers(), deps());
    const h = handlers();
    connectLive("abcd2345", "/e", h, deps());
    await flush();
    const stray = new FakeChannel("rushes-v1-abcd2345");
    stray.postMessage({ v: 1, type: "change" });
    stray.postMessage({ v: 1, type: "shutdown", data: "" });
    stray.postMessage("change");
    stray.postMessage({ type: "change", data: "unversioned" });
    stray.postMessage({ v: 2, type: "change", data: "from a newer Rushes" });
    stray.postMessage({ v: 2, type: "open" });
    await flush();
    expect(h.seen).toEqual([]);
    stray.postMessage({ v: 1, type: "change", data: "ours" });
    await flush();
    expect(h.seen).toEqual(["change ours"]);
  });

  it("falls back to a stream per tab without Web Locks or BroadcastChannel", async () => {
    const noLocks = connectLive("abcd2345", "/e", handlers(), deps({ locks: undefined }));
    const noChannel = connectLive("abcd2345", "/e", handlers(), deps({ BroadcastChannel: undefined }));
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

describe("connectLive: a leader that stalls (§19.8)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  it("a follower that hears nothing for 40 s takes the stream over and fetches afresh", async () => {
    const leader = connectLive("abcd2345", "/e", handlers(), deps());
    const h = handlers();
    const follower = connectLive("abcd2345", "/e", h, deps());
    await flush();
    const [stalled] = open();
    // The leader's tab is frozen: it still holds the lock, but nothing reaches the channel.
    vi.advanceTimersByTime(QUIET_MS - 1);
    await flush();
    expect(follower.role()).toBe("follower");
    vi.advanceTimersByTime(1);
    await flush();
    expect(follower.role()).toBe("leader");
    expect(h.seen).toEqual(["resync"]);
    // The stalled leader learns it lost the lock: it closes its stream and follows.
    expect(stalled.closed).toBe(true);
    expect(leader.role()).toBe("follower");
    expect(open()).toHaveLength(1);
    expect(open()[0]).not.toBe(stalled);
  });

  it("the server's ping keeps followers waiting on a quiet project", async () => {
    connectLive("abcd2345", "/e", handlers(), deps());
    const followers = [0, 1, 2].map(() => connectLive("abcd2345", "/e", handlers(), deps()));
    await flush();
    const [stream] = open();
    for (let s = 0; s < 120; s += 15) {
      vi.advanceTimersByTime(15_000);
      stream.emit("ping");
      await flush();
    }
    expect(followers.map((f) => f.role())).toEqual(["follower", "follower", "follower"]);
    expect(streams).toHaveLength(1);
  });

  it("a leader hidden into the back/forward cache steps down, and rejoins as a follower when shown", async () => {
    const p = page();
    const leader = connectLive("abcd2345", "/e", handlers(), deps({ page: p }));
    const h = handlers();
    const follower = connectLive("abcd2345", "/e", h, deps());
    await flush();
    const [first] = open();
    p.window.dispatchEvent(new Event("pagehide"));
    expect(first.closed).toBe(true);
    await flush();
    expect(follower.role()).toBe("leader");
    expect(open()).toHaveLength(1);
    // A first show (not from the cache) changes nothing.
    p.window.dispatchEvent(pageshow(false));
    await flush();
    expect(locks.queues.get(lockName("abcd2345")) ?? []).toHaveLength(0);
    p.window.dispatchEvent(pageshow(true));
    await flush();
    expect(leader.role()).toBe("follower");
    expect(open()).toHaveLength(1);
    // Back in line: when the new leader closes, it leads again.
    follower.close();
    await flush();
    expect(leader.role()).toBe("leader");
  });

  it("a frozen tab steps down and leaves the line; on resume it rejoins and fetches afresh", async () => {
    const p = page();
    const ha = handlers();
    const a = connectLive("abcd2345", "/e", ha, deps({ page: p }));
    const b = connectLive("abcd2345", "/e", handlers(), deps());
    const pc = page();
    const c = connectLive("abcd2345", "/e", handlers(), deps({ page: pc }));
    await flush();
    expect(a.role()).toBe("leader");
    // c is frozen while waiting: it mustn't be handed the lock it can't use.
    pc.document.dispatchEvent(new Event("freeze"));
    p.document.dispatchEvent(new Event("freeze"));
    await flush();
    expect(b.role()).toBe("leader");
    b.close();
    await flush();
    expect(open()).toHaveLength(0);
    p.document.dispatchEvent(new Event("resume"));
    await flush();
    expect(a.role()).toBe("leader");
    expect(ha.seen).toContain("resync");
    expect(c.role()).toBe("follower");
  });
});
