// One live connection per browser, per project (§19.8). Chromium allows six connections to one host,
// so a page that holds its own EventSource in every open tab, next to the media those tabs stream,
// soon has requests waiting on a free socket: a click stalls. Instead one tab, the leader, holds the
// event stream and relays what it hears to the project's other tabs over a BroadcastChannel.
//
// The leader is whichever tab holds the Web Lock `rushes-sse-v1-<project>`; it keeps it for its
// lifetime, and when it closes the lock passes to a waiting tab, which opens the stream. The leader
// relays its connection state too (open, error) and the server's 15 s ping, so every tab still sees
// the server come and go, and a follower that hears nothing for QUIET_MS knows the leader has stalled
// (a frozen or suspended tab keeps its lock): it takes the lock over and opens the stream itself.
// A leader whose page is hidden into the back/forward cache or frozen steps down first, and joins
// the line again when the page comes back. Where the browser has no Web Locks or no
// BroadcastChannel, every tab opens its own stream.

/** The events the server sends that the page acts on. */
export const RELAYED = ["change", "proxy", "corrupt"] as const;
export type Relayed = (typeof RELAYED)[number];

/** The relay's message format. Tabs from another version of Rushes use other names and are ignored. */
export const PROTOCOL = 1;
export const lockName = (project: string): string => `rushes-sse-v${PROTOCOL}-${project}`;
export const channelName = (project: string): string => `rushes-v${PROTOCOL}-${project}`;

/** A follower that hears nothing from the leader for this long (the server pings every 15 s) takes over. */
export const QUIET_MS = 40_000;
/** Spread over this much, so the followers of a stalled leader don't all take over at once. */
const QUIET_JITTER_MS = 5_000;

export interface LiveHandlers {
  change(data: string): void;
  proxy(data: string): void;
  corrupt(data: string): void;
  /** The stream (re)connected. */
  open(): void;
  /** The stream failed; the browser retries it. */
  error(): void;
  /** Events may have been missed (the leader went quiet, or this page was frozen): fetch afresh. */
  resync(): void;
}

/** Which tab holds the stream: this one for every tab (leader), another (follower), or each its own. */
export type LiveRole = "leader" | "follower" | "own";

export interface LiveConnection {
  role(): LiveRole;
  close(): void;
}

type Listenable = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/** What the module reaches outside itself, injectable for tests. */
export interface LiveDeps {
  locks?: Pick<LockManager, "request">;
  BroadcastChannel?: new (name: string) => Pick<BroadcastChannel, "postMessage" | "close" | "onmessage">;
  EventSource: new (url: string) => Pick<EventSource, "addEventListener" | "close" | "onopen" | "onerror">;
  /** Where pagehide/pageshow (window) and freeze/resume (document) fire. */
  page?: { window: Listenable; document: Listenable };
  /** 0…1, for the takeover's jitter. */
  random?: () => number;
}

type Message =
  | { v: typeof PROTOCOL; type: Relayed; data: string }
  | { v: typeof PROTOCOL; type: "open" | "error" | "ping" };

function browserDeps(): LiveDeps {
  return {
    locks: typeof navigator !== "undefined" ? navigator.locks : undefined,
    BroadcastChannel: typeof BroadcastChannel === "function" ? BroadcastChannel : undefined,
    EventSource,
    page: typeof window !== "undefined" ? { window, document } : undefined,
  };
}

function isMessage(m: unknown): m is Message {
  if (typeof m !== "object" || m === null) return false;
  const { v, type, data } = m as { v?: unknown; type?: unknown; data?: unknown };
  if (v !== PROTOCOL) return false;
  if (type === "open" || type === "error" || type === "ping") return true;
  return (RELAYED as readonly unknown[]).includes(type) && typeof data === "string";
}

function deliver(on: LiveHandlers, m: Message): void {
  if (m.type === "open") on.open();
  else if (m.type === "error") on.error();
  // A ping only says the leader is alive.
  else if ("data" in m) on[m.type](m.data);
}

/** Open the stream at `url`, handing every event to `on` and, for a leader, to `relay`. */
function openStream(deps: LiveDeps, url: string, on: LiveHandlers, relay?: (m: Message) => void) {
  const events = new deps.EventSource(url);
  const both = (m: Message) => {
    deliver(on, m);
    relay?.(m);
  };
  for (const type of RELAYED) events.addEventListener(type, (e) => both({ v: PROTOCOL, type, data: String((e as MessageEvent).data ?? "") }));
  events.addEventListener("ping", () => both({ v: PROTOCOL, type: "ping" }));
  events.onopen = () => both({ v: PROTOCOL, type: "open" });
  events.onerror = () => both({ v: PROTOCOL, type: "error" });
  return events;
}

/** Hear the project's live events through one connection shared by every tab on it. */
export function connectLive(project: string, url: string, on: LiveHandlers, deps: LiveDeps = browserDeps()): LiveConnection {
  const { locks, BroadcastChannel: Channel } = deps;
  if (!locks || !Channel) {
    const events = openStream(deps, url, on);
    return { role: () => "own", close: () => events.close() };
  }
  const random = deps.random ?? Math.random;

  let role: LiveRole = "follower";
  let closed = false;
  /** Hidden into the back/forward cache, or frozen: out of the running until the page is back. */
  let paused = false;
  let events: { close(): void } | null = null;
  /** Releases the lock this tab holds. */
  let resign: (() => void) | null = null;
  /** Each lock request gets a number; a grant for anything but the latest is handed straight back. */
  let attempt = 0;
  /** The request this tab leads under, or 0. */
  let leading = 0;
  let waiting: AbortController | null = null;
  let quiet: ReturnType<typeof setTimeout> | undefined;

  const channel = new Channel(channelName(project));
  const relay = (m: Message) => channel.postMessage(m);

  const stepDown = () => {
    events?.close();
    events = null;
    leading = 0;
    if (role === "leader") role = "follower";
    const release = resign;
    resign = null;
    release?.();
  };

  // A follower expects to hear the leader at least every ping; silence for QUIET_MS means it stalled.
  const listen = () => {
    clearTimeout(quiet);
    if (closed || paused || role !== "follower") return;
    quiet = setTimeout(takeOver, QUIET_MS + random() * QUIET_JITTER_MS);
  };

  const lead = (n: number) => {
    leading = n;
    role = "leader";
    clearTimeout(quiet);
    events = openStream(deps, url, on, relay);
  };

  /** Wait in line for the lock, or with `steal`, take it from a leader that has gone quiet. */
  const join = (steal = false) => {
    const n = ++attempt;
    waiting?.abort();
    const ctrl = new AbortController();
    waiting = ctrl;
    let granted = false;
    locks
      .request(lockName(project), steal ? { steal: true } : { signal: ctrl.signal }, () =>
        new Promise<void>((done) => {
          granted = true;
          if (closed || paused || n !== attempt) return done();
          resign = done;
          lead(n);
        }),
      )
      .catch(() => {
        if (leading === n) {
          // Taken over while leading (this tab stalled, and another stepped in): follow again.
          stepDown();
          if (!closed && !paused) {
            join();
            listen();
          }
        } else if (steal && !granted && n === attempt && !closed && !paused) {
          // The lock couldn't be taken at all: hear the server directly instead.
          role = "own";
          events = openStream(deps, url, on);
        }
        // Otherwise: aborted while waiting in line, because this tab closed, paused or asked again.
      });
  };

  const takeOver = () => {
    if (closed || paused || role !== "follower") return;
    join(true);
    on.resync();
  };

  channel.onmessage = (e: MessageEvent) => {
    if (role !== "follower" || paused || !isMessage(e.data)) return;
    listen();
    deliver(on, e.data);
  };

  const pause = () => {
    if (closed || paused) return;
    paused = true;
    clearTimeout(quiet);
    attempt++;
    waiting?.abort();
    waiting = null;
    stepDown();
    if (role === "own") role = "follower";
  };
  const resume = () => {
    if (closed || !paused) return;
    paused = false;
    join();
    listen();
    on.resync();
  };
  const onPageShow = (e: Event) => {
    if ((e as PageTransitionEvent).persisted) resume();
  };
  const page = deps.page;
  page?.window.addEventListener("pagehide", pause);
  page?.window.addEventListener("pageshow", onPageShow);
  page?.document.addEventListener("freeze", pause);
  page?.document.addEventListener("resume", resume);

  join();
  listen();

  return {
    role: () => role,
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(quiet);
      waiting?.abort();
      stepDown();
      channel.close();
      page?.window.removeEventListener("pagehide", pause);
      page?.window.removeEventListener("pageshow", onPageShow);
      page?.document.removeEventListener("freeze", pause);
      page?.document.removeEventListener("resume", resume);
    },
  };
}
