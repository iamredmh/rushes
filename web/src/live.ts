// One live connection per browser, per project (§19.8). Chromium allows six connections to one host,
// so a page that holds its own EventSource in every open tab, next to the media those tabs stream,
// soon has requests waiting on a free socket: a click stalls. Instead one tab, the leader, holds the
// event stream and relays what it hears to the project's other tabs over a BroadcastChannel.
//
// The leader is whichever tab holds the Web Lock `rushes-sse-<project>`; it keeps it for its
// lifetime, and when it closes the lock passes to a waiting tab, which opens the stream. The leader
// relays its connection state too (open, error), so every tab still sees the server come and go.
// Where the browser has no Web Locks or no BroadcastChannel, every tab opens its own stream.

/** The events the server sends that the page acts on. */
export const RELAYED = ["change", "proxy", "corrupt"] as const;
export type Relayed = (typeof RELAYED)[number];

export interface LiveHandlers {
  change(data: string): void;
  proxy(data: string): void;
  corrupt(data: string): void;
  /** The stream (re)connected. */
  open(): void;
  /** The stream failed; the browser retries it. */
  error(): void;
}

/** Which tab holds the stream: this one for every tab (leader), another (follower), or each its own. */
export type LiveRole = "leader" | "follower" | "own";

export interface LiveConnection {
  role(): LiveRole;
  close(): void;
}

/** What the module reaches outside itself, injectable for tests. */
export interface LiveDeps {
  locks?: Pick<LockManager, "request">;
  BroadcastChannel?: new (name: string) => Pick<BroadcastChannel, "postMessage" | "close" | "onmessage">;
  EventSource: new (url: string) => Pick<EventSource, "addEventListener" | "close" | "onopen" | "onerror">;
}

type Message = { type: Relayed; data: string } | { type: "open" } | { type: "error" };

function browserDeps(): LiveDeps {
  return {
    locks: typeof navigator !== "undefined" ? navigator.locks : undefined,
    BroadcastChannel: typeof BroadcastChannel === "function" ? BroadcastChannel : undefined,
    EventSource,
  };
}

function isMessage(m: unknown): m is Message {
  if (typeof m !== "object" || m === null) return false;
  const { type, data } = m as { type?: unknown; data?: unknown };
  if (type === "open" || type === "error") return true;
  return (RELAYED as readonly unknown[]).includes(type) && typeof data === "string";
}

function deliver(on: LiveHandlers, m: Message): void {
  if (m.type === "open") on.open();
  else if (m.type === "error") on.error();
  else on[m.type](m.data);
}

/** Open the stream at `url`, handing every event to `on` and, for a leader, to `relay`. */
function openStream(deps: LiveDeps, url: string, on: LiveHandlers, relay?: (m: Message) => void) {
  const events = new deps.EventSource(url);
  const both = (m: Message) => {
    deliver(on, m);
    relay?.(m);
  };
  for (const type of RELAYED) events.addEventListener(type, (e) => both({ type, data: String((e as MessageEvent).data ?? "") }));
  events.onopen = () => both({ type: "open" });
  events.onerror = () => both({ type: "error" });
  return events;
}

/** Hear the project's live events through one connection shared by every tab on it. */
export function connectLive(project: string, url: string, on: LiveHandlers, deps: LiveDeps = browserDeps()): LiveConnection {
  const { locks, BroadcastChannel: Channel } = deps;
  if (!locks || !Channel) {
    const events = openStream(deps, url, on);
    return { role: () => "own", close: () => events.close() };
  }

  let role: LiveRole = "follower";
  let closed = false;
  let events: { close(): void } | null = null;
  let resign: (() => void) | null = null;
  const channel = new Channel(`rushes-${project}`);
  channel.onmessage = (e: MessageEvent) => {
    if (role === "follower" && isMessage(e.data)) deliver(on, e.data);
  };
  const waiting = new AbortController();
  // Held, the lock never resolves until this tab closes (or its page goes): then the next tab in line gets it.
  locks
    .request(`rushes-sse-${project}`, { signal: waiting.signal }, () =>
      new Promise<void>((done) => {
        if (closed) return done();
        role = "leader";
        resign = done;
        events = openStream(deps, url, on, (m) => channel.postMessage(m));
      }),
    )
    // Aborted while still waiting in line: this tab closed first.
    .catch(() => undefined);

  return {
    role: () => role,
    close() {
      if (closed) return;
      closed = true;
      waiting.abort();
      events?.close();
      resign?.();
      channel.close();
    },
  };
}
