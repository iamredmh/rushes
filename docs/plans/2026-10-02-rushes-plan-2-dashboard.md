# Rushes Plan 2: The dashboard (Script and Picture tabs)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The review desk you open in a browser. Notes run down the right; every tab unlocks live as the agent adds work.
- **Script tab:** the agent's current line beside your version, plus a fit bar.
- **Picture tab:** frame stepping, In/Out ranges, a box on the frame and frame grabs.

The server also gains what the dashboard needs:
- byte-range media streaming, limited to registered files;
- frame grabs;
- a watcher for hand edits;
- idle shutdown and `rushes stop`;
- the fix for the stale-lock race left over from Plan 1.

**Architecture:**
- **The dashboard** is Preact, bundled by Vite into `web-dist/` and served by the same local server. That server is still the only writer of `.rushes/`.
- **Live updates:** the dashboard reads `GET /api/state` and refetches whenever the server's SSE stream says a file changed. That covers the user's own writes, the agent's MCP writes and hand edits, which the watcher picks up.
- **Media:** served only for paths that `project.json` / `script.json` register, plus the server's own grabs.

**Tech stack:**
- **Runtime:** unchanged (Node ≥ 20, Hono, zod, MCP SDK).
- **Dashboard:** Preact 10.29, Vite 8, fonts bundled from @fontsource (Figtree, JetBrains Mono), all devDependencies that are bundled at build time.
- **Browser tests:** Playwright 1.63 (Chromium).

**Spec:** `docs/specs/2026-10-02-rushes-design.md`. Sections 4, 6, 8 (picture only), 9 and 10 bind this plan. The layout reference is the round-three mockup: Picture has notes on the right; Script has current and yours side by side. There are icon buttons with tooltips, and status is shown as marks rather than words.

**Verified:** the code blocks below come from a prototype. On 2 October 2026 its tasks were replayed in order in a fresh clone of the repo, and every task ended green:
- **Unit tests:** 152 at the end, unchanged by Tasks 6 and 7, which add no unit tests.
- **Browser tests:** 11, passing 5/5 runs.
- **Typecheck:** both typechecks clean.
- **Git install:** `npx -y git+file://…` builds the dashboard and serves it.

## Global Constraints

- **Runtime dependencies stay exactly** `@hono/node-server`, `@modelcontextprotocol/sdk`, `hono`, `zod`. Preact, Vite, the fonts and Playwright are **devDependencies**. The dashboard is bundled into `web-dist/`, which ships in the package (`files`), and `prepare` builds it on a git install.
- **No CDN at runtime.** Fonts and scripts come from the local server.
- **Every route keeps the Plan 1 guard:**
  - the Host must be 127.0.0.1 or localhost;
  - writes must be `application/json` from a local Origin.
- **Media:** `GET /media?path=` serves only paths registered in `project.json` / `script.json`, or `.rushes/grabs/<safe>.png`. Anything else is 404. It never reveals whether a file exists.
- **Visual system (spec §10):**
  - Colours: ground `#0C0D0F`/`#141518`/`#1C1E22`, text `#EEEEF0`, accent `#7C93FF`, to do `#F5B740`, done `#4CC38A`.
  - Type: Figtree for the UI (15px and up), JetBrains Mono for timecodes only.
  - Controls: icon buttons with tooltips that name the key, status as marks, and no helper captions on screen.
- **Keyboard:** Space play, ←/→ one frame (Shift: ten), I/O in and out, B box, G grab, N new note, 1–6 tabs, ? shortcuts, Esc close.
- **Times sent to the server are the video element's time, snapped to its frame** (`snap()`), never a stale React state value.
- **Git:** commits use this repo's local identity (`iamredmh <17407420+iamredmh@users.noreply.github.com>`). Never change git config, and never use another email.
- **Prose** in docs is UK English.

## Review Focus

The six inputs most likely to bite a real user, each pinned by a test in the task that owns it:

1. **Fast keyboard work.** Pressing I, O, G or N straight after a burst of frame steps must use the frame actually on screen, not one behind. *Task 6: "In and Out make a range note…" expects exactly 0:01.00–0:02.00 after 30 + 30 steps.*
2. **A cut the browser can't play** (ProRes, some HEVC, a half-written render) must say so, not show a black frame. *Task 6: "a cut the browser can't play says so…"*
3. **A media request for anything unregistered** (`../../etc/passwd`, `.rushes/notes.json`, a stray file in the project) is 404. *Task 4: "refuses any path the project didn't register".*
4. **The agent changing a line while you're typing in that row** must not wipe what you typed. *Task 6: "an agent's change doesn't overwrite a line you're still typing".*
5. **A stale `server.json` and several harnesses starting Rushes at once** (after a crash or a reboot): exactly one server. *Task 1: "lets exactly one of several racing starts win…".*
6. **A broken hand edit** is reported (a banner naming the file) and never overwritten. *Task 2: "reports a broken hand edit as corrupt…". Task 6: "a broken hand edit shows a banner naming the file".*

## File structure

```
src/server/lock.ts       (modify) token-checked lock claimed by hard link; removeLock(root, token)
src/server/watch.ts      (new)    watchStore(store): announce valid hand edits, report corrupt ones
src/server/files.ts      (new)    content types, registeredMedia, parseRange, sendFile, inside
src/server/start.ts      (modify) watcher, idle shutdown (idleMs), `closed` promise, webDir, shutdown hook
src/server/app.ts        (modify) dashboard files, /media, /api/grabs, /api/shutdown, SSE "corrupt"
src/core/store.ts        (modify) announce(key, rev): one change event per rev
src/mcp/ensure.ts        (modify) background servers get --idle-minutes 120
src/cli/main.ts          (modify) serve --idle-minutes, rushes stop
tsconfig.web.json        (new)    typecheck for web/src (DOM, Preact JSX)
vite.config.ts           (new)    web/ → web-dist/
web/index.html           (new)
web/src/main.tsx         (new)    fonts + styles + <App/>
web/src/types.ts         (new)    type-only re-exports of the server's data types
web/src/lib.ts           (new)    fmt, frameAt, snap, stepFrame, placeNote, noteTime, fit, isChanged, firstTab, boxFrom…
web/src/api.ts           (new)    fetch wrapper, mediaUrl
web/src/useRushes.ts     (new)    state + SSE subscription
web/src/styles.css       (new)    the visual system
web/src/ui/Icon.tsx      (new)    outline icon set
web/src/ui/Notes.tsx     (new)    the notes column every tab uses
web/src/ui/Script.tsx    (new)    Script tab
web/src/ui/Picture.tsx   (new)    Picture tab
web/src/ui/App.tsx       (new)    header, tabs, Send to agent, shortcuts, toasts
playwright.config.ts, e2e/fixture.ts, e2e/dashboard.spec.ts, e2e/fixtures/clip.mp4   (new) browser tests
test/helpers/sse.ts, test/server/{lock-race,watch,idle,files}.test.ts, test/web/lib.test.ts   (new)
```

**How to read the code steps:** every file is given in full. For a file marked *Modify*, replace its whole contents with the block shown. The blocks are the exact files, so there are no partial edits to merge.

---

### Task 1: One server per project, even over a stale lock

**Files:**
- Modify: `src/server/lock.ts`
- Modify: `src/server/start.ts`
- Create: `test/server/lock-race.test.ts`

**Interfaces:**
- **Consumes:** from Plan 1:
  - `lock.ts`: `Lock`, `AlreadyRunningError`, `canonicalRoot`, `lockPath`, `readLock`, `isRushesFor`;
  - `start.ts`: `startServer`.
- **Produces:**
  - `Lock` gains `token?: string`.
  - `writeLock(root, port) -> Lock` writes `<lock>.<token>.tmp`, then `link()`s it into place, so the lock appears whole or not at all.
    - On EEXIST, a live lock serving the same root wins: the call throws `AlreadyRunningError`.
    - A stale lock is removed only if it's still the same lock.
    - After winning, the caller re-reads the lock and goes round again if it was replaced.
  - `removeLock(root, token?)` compares tokens when both have one, otherwise pids.
  - `startServer` passes its token to `removeLock`.

- [ ] **Step 1: Write the failing tests**

`test/server/lock-race.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { tmpProject } from "../helpers/tmp.js";
import { startServer, type Running } from "../../src/server/start.js";
import { lockPath, readLock } from "../../src/server/lock.js";

describe("one server per project", () => {
  it("lets exactly one of several racing starts win, even over a stale lock", async () => {
    const { root } = await tmpProject();
    await writeFile(lockPath(root), JSON.stringify({ port: 4999, pid: 999999, startedAt: "x", token: "stale" }), "utf8");
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => startServer(root, { port: 0 })));
    const winners = results.filter((r): r is PromiseFulfilledResult<Running> => r.status === "fulfilled").map((r) => r.value);
    expect(winners).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as { code?: string }).code).toBe("already_running");
    expect((await readLock(root))?.port).toBe(winners[0].port);
    await winners[0].close();
    expect(await readLock(root)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/server`
Expected: FAIL: "lets exactly one of several racing starts win" (more than one start succeeds over a stale lock).

- [ ] **Step 3: Implement**

`src/server/lock.ts`

```ts
import { link, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { RUSHES_DIR } from "../core/store.js";
import { RushesError } from "../core/errors.js";

export interface Lock {
  port: number;
  pid: number;
  startedAt: string;
  /** Unique per server start, so a server can tell its own lock from a newer one in the same process. */
  token?: string;
}

/** A server for this project is already running at `url`. */
export class AlreadyRunningError extends RushesError {
  constructor(readonly url: string) {
    super(`Rushes is already running for this project at ${url}`, 409, "already_running", { url });
  }
}

/**
 * The one name a project folder goes by: its real path, so a symlinked path
 * and the real one share a server. When the folder doesn't exist yet, its
 * nearest existing parent is resolved instead and the rest is kept as given,
 * which is the path the server will have once it creates the folder.
 */
export async function canonicalRoot(dir: string): Promise<string> {
  const abs = resolve(dir);
  const missing: string[] = [];
  for (let at = abs; ; at = dirname(at)) {
    try {
      return join(await realpath(at), ...missing);
    } catch {
      if (dirname(at) === at) return abs;
      missing.unshift(basename(at));
    }
  }
}

export function lockPath(root: string): string {
  return join(root, RUSHES_DIR, "server.json");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lock file as written, whether or not its process is alive. Null when missing or unreadable. */
async function readLockFile(root: string): Promise<Lock | null> {
  try {
    const lock = JSON.parse(await readFile(lockPath(root), "utf8")) as Lock;
    return typeof lock.port === "number" && typeof lock.pid === "number" ? lock : null;
  } catch {
    return null;
  }
}

/** The running server's lock, or null when there is none or its process has gone. */
export async function readLock(root: string): Promise<Lock | null> {
  const lock = await readLockFile(root);
  return lock && alive(lock.pid) ? lock : null;
}

/** Does the server on this port answer as Rushes for exactly this root? */
export async function isRushesFor(port: number, root: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const health = (await res.json()) as { app?: string; root?: string };
    return health.app === "rushes" && health.root === root;
  } catch {
    return false;
  }
}

/**
 * Claim the project's lock. The lock is written to a temporary file and then
 * hard-linked into place, so it appears complete or not at all, and only one
 * claimant can win the link. A lock whose server is alive and serving this
 * root wins over us (AlreadyRunningError). A stale one is removed, but only if
 * it is still the same lock we judged stale. After winning, we re-read the
 * lock once: if a racing claimant replaced it, we go round again and defer to
 * that server.
 */
export async function writeLock(root: string, port: number): Promise<Lock> {
  const lock: Lock = { port, pid: process.pid, startedAt: new Date().toISOString(), token: randomUUID() };
  const path = lockPath(root);
  const tmp = `${path}.${lock.token}.tmp`;
  await writeFile(tmp, JSON.stringify(lock, null, 2) + "\n", "utf8");
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await link(tmp, path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const existing = await readLockFile(root);
        if (existing && alive(existing.pid) && (await isRushesFor(existing.port, root))) {
          throw new AlreadyRunningError(`http://127.0.0.1:${existing.port}`);
        }
        // Stale: remove it only if it's still the lock we just judged.
        const again = await readLockFile(root);
        if (!existing || (again && again.token === existing.token && again.pid === existing.pid && again.startedAt === existing.startedAt)) {
          await rm(path, { force: true });
        }
        continue;
      }
      await new Promise((r) => setTimeout(r, 25));
      if ((await readLockFile(root))?.token === lock.token) return lock;
    }
    throw new Error(`Couldn't claim ${path}: other servers kept replacing it`);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Remove the lock only if it is ours (same token, or same pid for locks without one), so a newer server's lock survives. */
export async function removeLock(root: string, token?: string): Promise<void> {
  const lock = await readLockFile(root);
  if (!lock) return;
  const ours = token !== undefined && lock.token !== undefined ? lock.token === token : lock.pid === process.pid;
  if (ours) await rm(lockPath(root), { force: true });
}
```

`src/server/start.ts`

```ts
import { createServer, type Server } from "node:http";
import { mkdir, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { Store } from "../core/store.js";
import { createApp } from "./app.js";
import { removeLock, writeLock } from "./lock.js";

export const DEFAULT_PORT = 4317;

export interface Running {
  url: string;
  port: number;
  store: Store;
  close(): Promise<void>;
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((ok, fail) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      fail(e);
    };
    const onListening = () => {
      server.off("error", onError);
      const addr = server.address();
      ok(typeof addr === "object" && addr ? addr.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * Start the Rushes server for a project folder. Tries `port` and the next ten
 * ports; pass port 0 to let the OS choose (tests do).
 */
export async function startServer(rootDir: string, opts: { port?: number; host?: string; name?: string } = {}): Promise<Running> {
  // The real path is the root everywhere (store, lock, health), so a symlinked path finds the same server.
  await mkdir(resolve(rootDir), { recursive: true });
  const root = await realpath(resolve(rootDir));
  const store = new Store(root);
  await store.init(opts.name ?? basename(root));
  const app = createApp(store);
  const server = createServer(getRequestListener(app.fetch));
  const host = opts.host ?? "127.0.0.1";
  const first = opts.port ?? DEFAULT_PORT;

  let port = -1;
  let lastError: unknown;
  for (let p = first; p <= (first === 0 ? 0 : first + 10); p++) {
    try {
      port = await listen(server, p, host);
      break;
    } catch (e) {
      lastError = e;
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    }
  }
  if (port < 0) throw new Error(`No free port from ${first} to ${first + 10}: ${(lastError as Error)?.message}`);

  let token: string | undefined;
  try {
    token = (await writeLock(root, port)).token;
  } catch (e) {
    // Another server owns this project, or the lock couldn't be written: don't leave a socket open.
    server.closeAllConnections?.();
    await new Promise<void>((ok) => server.close(() => ok()));
    throw e;
  }
  const url = `http://${host}:${port}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections?.();
    await new Promise<void>((ok) => server.close(() => ok()));
    await removeLock(root, token);
  };
  return { url, port, store, close };
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/server && npx tsc --noEmit && npx vitest run`
Expected: everything passes, including the full unit suite, and tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/server/lock.ts src/server/start.ts test/server/lock-race.test.ts
git commit -m "fix(server): exactly one server per project, even when a stale lock is left behind"
```

---

### Task 2: Watch .rushes for hand edits

**Files:**
- Modify: `src/core/store.ts`
- Create: `src/server/watch.ts`
- Modify: `src/server/start.ts`
- Modify: `src/server/app.ts`
- Create: `test/helpers/sse.ts`
- Create: `test/server/watch.test.ts`

**Interfaces:**
- **Consumes:** `Store`, `FILES`/`FileKey`, `CorruptFileError`, and `createApp`'s SSE route.
- **Produces:**
  - `Store.announce(key, rev): boolean` emits `"change"` once per rev. `update()` now uses it.
  - `watchStore(store, debounceMs = 80): () => void` (src/server/watch.ts) uses `fs.watch` on `.rushes/`:
    - a valid edit is announced;
    - a broken one emits `"corrupt"` `{file, message}` (type `CorruptEvent`) and is left untouched.
  - The SSE stream (`/api/events`) sends `event: corrupt` as well.
  - `startServer` starts the watcher and stops it on close.
  - `test/helpers/sse.ts`: `sse(url) -> {until(needle), stop(), text()}`.

- [ ] **Step 1: Write the failing tests**

`test/helpers/sse.ts`

```ts
/** Read SSE text from a running server until `needle` appears. */
export async function sse(url: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${url}/api/events`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const until = async (needle: string) => {
    while (!text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    return text;
  };
  return { until, stop: () => ctrl.abort(), text: () => text };
}
```

`test/server/watch.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { tmpProject } from "../helpers/tmp.js";
import { sse } from "../helpers/sse.js";
import { startServer } from "../../src/server/start.js";

describe("watching .rushes for hand edits", () => {
  it("announces a valid hand edit once, with its rev", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const events = await sse(s.url);
    await events.until("event: hello");
    const notes = JSON.parse(await readFile(s.store.path("notes"), "utf8"));
    notes.rev = 7;
    await writeFile(s.store.path("notes"), JSON.stringify(notes, null, 2));
    const text = await events.until('"rev":7');
    expect(text).toContain('"file":"notes"');
    events.stop();
    await s.close();
  });

  it("does not announce the server's own writes twice", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const events = await sse(s.url);
    await events.until("event: hello");
    await fetch(`${s.url}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: "picture", scope: "point", t: 1, text: "x" }),
    });
    await events.until('"file":"notes"');
    await new Promise((r) => setTimeout(r, 300));
    expect(events.text().match(/"file":"notes"/g)).toHaveLength(1);
    events.stop();
    await s.close();
  });

  it("reports a broken hand edit as corrupt and leaves it alone", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const events = await sse(s.url);
    await events.until("event: hello");
    await writeFile(s.store.path("picks"), "{ broken");
    const text = await events.until("event: corrupt");
    expect(text).toContain("picks.json");
    expect(await readFile(s.store.path("picks"), "utf8")).toBe("{ broken");
    events.stop();
    await s.close();
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/server test/core`
Expected: FAIL with `Failed to resolve import "../../src/server/watch.js"` (or the hand-edit tests time out).

- [ ] **Step 3: Implement**

`src/core/store.ts`

```ts
import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile, copyFile, access } from "node:fs/promises";
import { join } from "node:path";
import { FILES, type FileData, type FileKey } from "./schema.js";
import { CorruptFileError, InvalidError, RevConflictError } from "./errors.js";

export const RUSHES_DIR = ".rushes";

const GITIGNORE = "proxies/\npeaks/\nserver.json\nserver.log\n*.tmp\n*.bak\n";

function defaults(key: FileKey, name: string): FileData[FileKey] {
  switch (key) {
    case "project":
      return { schema: 1, rev: 0, name, fps: 30, videos: [], lanes: [] };
    case "script":
      return { schema: 1, rev: 0, wordsPerSecond: 2.6, sections: [] };
    case "notes":
      return { schema: 1, rev: 0, notes: [] };
    case "picks":
      return { schema: 1, rev: 0, lanes: {}, sections: {} };
    case "batches":
      return { schema: 1, rev: 0, batches: [] };
  }
}

export interface ChangeEvent {
  file: FileKey;
  rev: number;
}

/**
 * The only writer of a project's .rushes folder. Every write is validated,
 * serialised per file, written atomically (tmp + rename) and announced with
 * a "change" event.
 */
export class Store extends EventEmitter {
  readonly dir: string;
  private queues = new Map<FileKey, Promise<unknown>>();
  /** The last rev announced for each file, so a watcher can tell our writes from hand edits. */
  private announced = new Map<FileKey, number>();

  constructor(readonly root: string) {
    super();
    this.dir = join(root, RUSHES_DIR);
  }

  path(key: FileKey): string {
    return join(this.dir, FILES[key].name);
  }

  async init(name: string): Promise<void> {
    await mkdir(join(this.dir, "grabs"), { recursive: true });
    await writeIfMissing(join(this.dir, ".gitignore"), GITIGNORE);
    for (const key of Object.keys(FILES) as FileKey[]) {
      await writeIfMissing(this.path(key), serialise(defaults(key, name)));
    }
  }

  async read<K extends FileKey>(key: K): Promise<FileData[K]> {
    const file = FILES[key].name;
    let raw: string;
    try {
      raw = await readFile(this.path(key), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new CorruptFileError(file, "missing; run rushes init");
      throw e;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      throw new CorruptFileError(file, `invalid JSON (${(e as Error).message})`);
    }
    const parsed = FILES[key].schema.safeParse(json);
    if (!parsed.success) throw new CorruptFileError(file, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return parsed.data as FileData[K];
  }

  /**
   * Read, change and write one file. `fn` mutates the draft and may return a
   * value, which update() passes back. Pass `expectedRev` to reject the write
   * if the file changed since the caller read it.
   */
  update<K extends FileKey, R>(key: K, fn: (draft: FileData[K]) => R, expectedRev?: number): Promise<{ data: FileData[K]; result: R }> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async () => {
      const draft = await this.read(key);
      if (expectedRev !== undefined && expectedRev !== draft.rev) throw new RevConflictError(FILES[key].name, expectedRev, draft.rev);
      const result = fn(draft);
      draft.rev += 1;
      const checked = FILES[key].schema.safeParse(draft);
      if (!checked.success) throw new InvalidError(`Change to ${FILES[key].name} is invalid`, checked.error.issues);
      const data = checked.data as FileData[K];
      await atomicWrite(this.path(key), serialise(data));
      this.announce(key, data.rev);
      return { data, result };
    });
    this.queues.set(key, run);
    return run;
  }

  /** Emit a change for `key` at `rev` unless that rev was already announced. Returns whether it emitted. */
  announce(key: FileKey, rev: number): boolean {
    if (this.announced.get(key) === rev) return false;
    this.announced.set(key, rev);
    this.emit("change", { file: key, rev } satisfies ChangeEvent);
    return true;
  }

  async backup(key: FileKey): Promise<string> {
    const to = this.path(key) + ".bak";
    await copyFile(this.path(key), to);
    return to;
  }
}

export function serialise(data: unknown): string {
  return JSON.stringify(data, null, 2) + "\n";
}

async function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}

async function writeIfMissing(path: string, text: string): Promise<void> {
  try {
    await access(path);
  } catch {
    await writeFile(path, text, "utf8");
  }
}
```

`src/server/watch.ts`

```ts
import { watch, type FSWatcher } from "node:fs";
import { FILES, type FileKey } from "../core/schema.js";
import { CorruptFileError } from "../core/errors.js";
import type { Store } from "../core/store.js";

export interface CorruptEvent {
  file: string;
  message: string;
}

const BY_NAME = new Map<string, FileKey>(Object.entries(FILES).map(([key, f]) => [f.name as string, key as FileKey]));

/**
 * Watch .rushes/ for edits made outside the server (a person or an agent
 * editing the JSON by hand). A valid edit with a new rev is announced like any
 * other change; an invalid one is reported as a "corrupt" event and left alone.
 */
export function watchStore(store: Store, debounceMs = 80): () => void {
  const timers = new Map<FileKey, NodeJS.Timeout>();
  let watcher: FSWatcher | null = null;
  const check = async (key: FileKey) => {
    try {
      const data = await store.read(key);
      store.announce(key, data.rev);
    } catch (e) {
      if (e instanceof CorruptFileError) store.emit("corrupt", { file: FILES[key].name, message: e.message } satisfies CorruptEvent);
    }
  };
  try {
    watcher = watch(store.dir, (_event, filename) => {
      const key = filename ? BY_NAME.get(String(filename)) : undefined;
      if (!key) return;
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => void check(key), debounceMs));
    });
    watcher.on("error", () => undefined);
  } catch {
    // Watching is a convenience; the server works without it.
  }
  return () => {
    for (const t of timers.values()) clearTimeout(t);
    watcher?.close();
  };
}
```

`src/server/start.ts`

```ts
import { createServer, type Server } from "node:http";
import { mkdir, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { Store } from "../core/store.js";
import { createApp } from "./app.js";
import { removeLock, writeLock } from "./lock.js";
import { watchStore } from "./watch.js";

export const DEFAULT_PORT = 4317;

export interface Running {
  url: string;
  port: number;
  store: Store;
  close(): Promise<void>;
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((ok, fail) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      fail(e);
    };
    const onListening = () => {
      server.off("error", onError);
      const addr = server.address();
      ok(typeof addr === "object" && addr ? addr.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * Start the Rushes server for a project folder. Tries `port` and the next ten
 * ports; pass port 0 to let the OS choose (tests do).
 */
export async function startServer(rootDir: string, opts: { port?: number; host?: string; name?: string } = {}): Promise<Running> {
  // The real path is the root everywhere (store, lock, health), so a symlinked path finds the same server.
  await mkdir(resolve(rootDir), { recursive: true });
  const root = await realpath(resolve(rootDir));
  const store = new Store(root);
  await store.init(opts.name ?? basename(root));
  const app = createApp(store);
  const server = createServer(getRequestListener(app.fetch));
  const host = opts.host ?? "127.0.0.1";
  const first = opts.port ?? DEFAULT_PORT;

  let port = -1;
  let lastError: unknown;
  for (let p = first; p <= (first === 0 ? 0 : first + 10); p++) {
    try {
      port = await listen(server, p, host);
      break;
    } catch (e) {
      lastError = e;
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    }
  }
  if (port < 0) throw new Error(`No free port from ${first} to ${first + 10}: ${(lastError as Error)?.message}`);

  let token: string | undefined;
  try {
    token = (await writeLock(root, port)).token;
  } catch (e) {
    // Another server owns this project, or the lock couldn't be written: don't leave a socket open.
    server.closeAllConnections?.();
    await new Promise<void>((ok) => server.close(() => ok()));
    throw e;
  }
  const url = `http://${host}:${port}`;
  const stopWatching = watchStore(store);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    stopWatching();
    server.closeAllConnections?.();
    await new Promise<void>((ok) => server.close(() => ok()));
    await removeLock(root, token);
  };
  return { url, port, store, close };
}
```

`src/server/app.ts`

```ts
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Store, ChangeEvent } from "../core/store.js";
import { RushesError, InvalidError, NotFoundError } from "../core/errors.js";
import { addVariant, addVersion } from "../core/project.js";
import { addTake, editSection, setSections } from "../core/script.js";
import { addNote, applyReply, applyUserEdit, filterNotes } from "../core/notes.js";
import { createBatch, latestBatch } from "../core/batches.js";
import { tabStates } from "../core/tabs.js";
import { fromManifestPath, toManifestPath } from "../core/paths.js";
import { probe } from "../core/media.js";
import type { CorruptEvent } from "./watch.js";
import { LaneStageSchema, SectionStatusSchema, StageSchema, BoxSchema, type Batch } from "../core/schema.js";

export const VERSION = "0.1.0";

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new InvalidError("Request body must be JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new InvalidError("Request body is invalid", parsed.error.issues);
  return parsed.data;
}

const t = z.number().nonnegative();

const NewNoteBody = z.object({
  stage: StageSchema,
  video: z.string().nullish(),
  version: z.string().nullish(),
  on: z.string().nullish(),
  scope: z.enum(["point", "range", "whole"]),
  t: t.nullish(),
  tOut: t.nullish(),
  frame: z.number().int().nonnegative().nullish(),
  text: z.string(),
  box: BoxSchema.nullish(),
  grab: z.string().nullish(),
});

const UserEditBody = z.object({
  text: z.string().optional(),
  box: BoxSchema.nullable().optional(),
  grab: z.string().nullable().optional(),
  scope: z.enum(["point", "range", "whole"]).optional(),
  t: t.nullable().optional(),
  tOut: t.nullable().optional(),
  status: z.enum(["todo", "done"]).optional(),
});

const RepliesBody = z.object({
  replies: z
    .array(
      z.object({
        id: z.string(),
        reply: z.string().optional(),
        status: z.enum(["todo", "done"]).optional(),
        fixT: t.nullable().optional(),
        fixVersion: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

const VersionBody = z.object({ video: z.string().min(1), file: z.string().min(1), note: z.string().optional() });
const VariantBody = z.object({
  stage: LaneStageSchema,
  lane: z.string().optional(),
  name: z.string().min(1),
  file: z.string().min(1),
  meta: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  cues: z.array(z.object({ name: z.string().min(1), t })).optional(),
});
const ScriptBody = z.object({
  wordsPerSecond: z.number().positive().optional(),
  replace: z.boolean().optional(),
  sections: z.array(z.object({ id: z.string().min(1).optional(), start: t, end: t, current: z.string() })),
});
const SectionEditBody = z.object({
  proposed: z.string().nullable().optional(),
  direction: z.string().optional(),
  status: SectionStatusSchema.optional(),
});
const TakeBody = z.object({ file: z.string().min(1) });
const PicksBody = z.object({ lanes: z.record(z.string(), z.string()).optional(), sections: z.record(z.string(), z.string()).optional() });
const BatchBody = z.object({ stage: StageSchema });

const NoteQuery = z.object({
  stage: StageSchema.optional(),
  status: z.enum(["todo", "done"]).optional(),
  batch: z.string().optional(),
  version: z.string().optional(),
});

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

/** Hostname of "host[:port]" or a full origin URL, lowercased, or null when it doesn't parse. */
function hostnameOf(value: string, isUrl: boolean): string | null {
  try {
    return new URL(isUrl ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function createApp(store: Store): Hono {
  const app = new Hono();
  // Every SSE client adds a change listener, so lift Node's default limit of ten.
  store.setMaxListeners(0);

  app.onError((err, c) => {
    if (err instanceof RushesError) return c.json({ error: err.code, message: err.message, ...err.detail }, err.status as 400);
    console.error(err);
    return c.json({ error: "internal", message: (err as Error).message }, 500);
  });

  // The server is for this machine only. Checking Host stops DNS rebinding;
  // requiring JSON and a local Origin on writes stops other websites posting
  // to it from the user's browser (a JSON content type forces a CORS preflight,
  // which this server never answers).
  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    const hostname = hostnameOf(host, false);
    if (!hostname || !LOCAL_HOSTS.has(hostname)) {
      return c.json({ error: "forbidden_host", message: `Rushes only answers requests to 127.0.0.1 or localhost, not "${host}"` }, 403);
    }
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const type = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (type !== "application/json") {
        return c.json({ error: "unsupported_media_type", message: "Requests that change data must send Content-Type: application/json" }, 415);
      }
      const origin = c.req.header("origin");
      if (origin !== undefined) {
        const from = hostnameOf(origin, true);
        if (!from || !LOCAL_HOSTS.has(from)) {
          return c.json({ error: "forbidden_origin", message: `Rushes doesn't accept changes from pages on "${origin}"` }, 403);
        }
      }
    }
    await next();
  });

  app.get("/", (c) =>
    c.html(`<!doctype html><title>Rushes</title><p>Rushes is running for <code>${escapeHtml(store.root)}</code>. The dashboard arrives in the next release.</p>`),
  );

  app.get("/api/health", (c) => c.json({ ok: true, app: "rushes", version: VERSION, root: store.root }));

  app.get("/api/state", async (c) => {
    const [project, script, notes, picks, batches] = await Promise.all([
      store.read("project"), store.read("script"), store.read("notes"), store.read("picks"), store.read("batches"),
    ]);
    return c.json({ project, script, notes, picks, batches, tabs: tabStates(project, script, notes) });
  });

  app.get("/api/tabs", async (c) => {
    const [project, script, notes] = await Promise.all([store.read("project"), store.read("script"), store.read("notes")]);
    return c.json({ tabs: tabStates(project, script, notes) });
  });

  // ---- notes ----
  app.get("/api/notes", async (c) => {
    const q = NoteQuery.safeParse(c.req.query());
    if (!q.success) throw new InvalidError("Query is invalid", q.error.issues);
    const { notes } = await store.read("notes");
    return c.json({ notes: filterNotes(notes, q.data) });
  });

  app.post("/api/notes", async (c) => {
    const b = await body(c, NewNoteBody);
    const { result } = await store.update("notes", (f) => addNote(f, { ...b, by: "user" }));
    return c.json({ note: result }, 201);
  });

  app.patch("/api/notes/:id", async (c) => {
    const b = await body(c, UserEditBody);
    const { result } = await store.update("notes", (f) => applyUserEdit(f, { id: c.req.param("id"), ...b }));
    return c.json({ note: result });
  });

  app.post("/api/replies", async (c) => {
    const b = await body(c, RepliesBody);
    const { result } = await store.update("notes", (f) => b.replies.map((r) => applyReply(f, r)));
    return c.json({ notes: result });
  });

  // ---- media ----
  app.post("/api/versions", async (c) => {
    const b = await body(c, VersionBody);
    const file = toManifestPath(store.root, b.file);
    const info = await probe(fromManifestPath(store.root, file));
    const { result } = await store.update("project", (p) => {
      const out = addVersion(p, { video: b.video, file, note: b.note, duration: info.duration, fps: info.fps });
      if (info.fps && p.videos.length === 1 && p.videos[0].versions.length === 1) p.fps = info.fps;
      return out;
    });
    return c.json(result, 201);
  });

  app.post("/api/variants", async (c) => {
    const b = await body(c, VariantBody);
    const { result } = await store.update("project", (p) => addVariant(p, { ...b, file: toManifestPath(store.root, b.file) }));
    return c.json(result, 201);
  });

  // ---- script ----
  app.get("/api/script", async (c) => c.json({ script: await store.read("script") }));

  app.put("/api/script", async (c) => {
    const b = await body(c, ScriptBody);
    const { result } = await store.update("script", (s) => {
      if (b.wordsPerSecond) s.wordsPerSecond = b.wordsPerSecond;
      return setSections(s, b.sections, { replace: b.replace });
    });
    return c.json({ sections: result });
  });

  app.patch("/api/script/:id", async (c) => {
    const b = await body(c, SectionEditBody);
    const { result } = await store.update("script", (s) => editSection(s, c.req.param("id"), b));
    return c.json({ section: result });
  });

  app.post("/api/script/:id/takes", async (c) => {
    const b = await body(c, TakeBody);
    const file = toManifestPath(store.root, b.file);
    const info = await probe(fromManifestPath(store.root, file));
    const { result } = await store.update("script", (s) => addTake(s, c.req.param("id"), { file, duration: info.duration }));
    return c.json({ take: result }, 201);
  });

  // ---- picks ----
  app.get("/api/picks", async (c) => c.json(await store.read("picks")));

  app.put("/api/picks", async (c) => {
    const b = await body(c, PicksBody);
    const { data } = await store.update("picks", (p) => {
      Object.assign(p.lanes, b.lanes ?? {});
      Object.assign(p.sections, b.sections ?? {});
    });
    return c.json(data);
  });

  // ---- batches ----
  // A batch touches two files (notes and batches), so batch creation runs one at a time.
  let batchQueue: Promise<unknown> = Promise.resolve();
  app.post("/api/batches", async (c) => {
    const { stage } = await body(c, BatchBody);
    const run = batchQueue.catch(() => undefined).then(async (): Promise<Batch> => {
      const [project, script, batches] = await Promise.all([store.read("project"), store.read("script"), store.read("batches")]);
      const { result } = await store.update("notes", (notes) => createBatch({ project, script, notes, batches }, stage));
      await store.update("batches", (f) => { f.batches.push(result); });
      return result;
    });
    batchQueue = run;
    return c.json({ batch: await run }, 201);
  });

  app.get("/api/batches/:id", async (c) => {
    const [batches, notes, script] = await Promise.all([store.read("batches"), store.read("notes"), store.read("script")]);
    const id = c.req.param("id");
    const batch = id === "latest" ? latestBatch(batches) : batches.batches.find((b) => b.id === id);
    if (!batch) throw new NotFoundError("batch", id);
    return c.json({
      batch,
      notes: notes.notes.filter((n) => batch.noteIds.includes(n.id)),
      sections: script.sections.filter((s) => batch.sectionIds.includes(s.id)),
    });
  });

  // ---- live updates ----
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const send = (e: ChangeEvent) => void stream.writeSSE({ event: "change", data: JSON.stringify(e) });
      const corrupt = (e: CorruptEvent) => void stream.writeSSE({ event: "corrupt", data: JSON.stringify(e) });
      store.on("change", send);
      store.on("corrupt", corrupt);
      stream.onAbort(() => {
        store.off("change", send);
        store.off("corrupt", corrupt);
      });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ root: store.root }) });
      while (!stream.aborted) await stream.sleep(15000).then(() => stream.writeSSE({ event: "ping", data: "" }));
    }),
  );

  return app;
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/server test/core && npx tsc --noEmit && npx vitest run`
Expected: everything passes, including the full unit suite, and tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/core/store.ts src/server/watch.ts src/server/start.ts src/server/app.ts test/helpers/sse.ts test/server/watch.test.ts
git commit -m "feat(server): announce hand edits to .rushes and report broken ones"
```

---

### Task 3: Idle shutdown and `rushes stop`

**Files:**
- Modify: `src/server/start.ts`
- Modify: `src/server/app.ts`
- Modify: `src/mcp/ensure.ts`
- Modify: `src/cli/main.ts`
- Create: `test/server/idle.test.ts`
- Modify: `test/cli/main.test.ts`

**Interfaces:**
- **Consumes:**
  - Task 2's `start.ts` and `app.ts`;
  - Plan 1's `findServer` and `RushesClient`, and CLI `main`/`Io`.
- **Produces:**
  - `startServer(root, { port?, host?, name?, idleMs? }) -> Running`, which now also has `closed: Promise<void>`. That promise resolves on `close()`, a shutdown request or idle.
    - **Idle:** closes after `idleMs` with no requests and no open connections. An open SSE dashboard keeps it alive.
  - `createApp(store, { onShutdown? })`: `POST /api/shutdown` replies `{ok: true, stopping}`, then calls the hook.
  - CLI:
    - `rushes serve --idle-minutes N` must be a positive number; otherwise exit 2.
    - `rushes stop [dir]`.
    - `open` and `serve` exit the process when the server's `closed` resolves.
  - `ensure.ts`: `BACKGROUND_IDLE_MINUTES = 120`, passed to the spawned `serve`.

- [ ] **Step 1: Write the failing tests**

`test/server/idle.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { tmpProject } from "../helpers/tmp.js";
import { sse } from "../helpers/sse.js";
import { startServer } from "../../src/server/start.js";
import { readLock } from "../../src/server/lock.js";
import { createApp } from "../../src/server/app.js";

describe("idle shutdown", () => {
  it("closes after the idle time with no requests, and removes its lock", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0, idleMs: 200 });
    await fetch(`${s.url}/api/health`).then((r) => r.json());
    await s.closed;
    expect(await readLock(root)).toBeNull();
    await expect(fetch(`${s.url}/api/health`)).rejects.toThrow();
  });

  it("stays up while a dashboard is connected", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0, idleMs: 150 });
    const events = await sse(s.url);
    await events.until("event: hello");
    await new Promise((r) => setTimeout(r, 500));
    expect((await (await fetch(`${s.url}/api/health`)).json()).ok).toBe(true);
    events.stop();
    await s.close();
  });
});

describe("shutdown", () => {
  it("replies, then calls the shutdown hook", async () => {
    const { store } = await tmpProject();
    let shutdowns = 0;
    const app = createApp(store, { onShutdown: () => { shutdowns++; } });
    const r = await app.request("/api/shutdown", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(await r.json()).toEqual({ ok: true, stopping: true });
    await new Promise((ok) => setImmediate(ok));
    expect(shutdowns).toBe(1);
  });

  it("closes a running server, which removes its lock", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    await fetch(`${s.url}/api/shutdown`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await s.closed;
    expect(await readLock(root)).toBeNull();
  });
});
```

`test/cli/main.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { main, longRunningCommand, type Io } from "../../src/cli/main.js";
import { startServer, type Running } from "../../src/server/start.js";

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const x: Io = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    cwd,
    openBrowser: (u) => opened.push(u),
    ensure: { spawnServer: () => { throw new Error("tests start the server themselves"); }, timeoutMs: 300 },
  };
  return { x, out, err, opened };
}

describe("cli", () => {
  it("prints help with no command, and exits 2 on an unknown one", async () => {
    const a = io("/tmp");
    expect(await main([], a.x)).toBe(0);
    expect(a.out.join("\n")).toContain("rushes open [dir]");
    const b = io("/tmp");
    expect(await main(["frobnicate"], b.x)).toBe(2);
    expect(b.err[0]).toContain('Unknown command "frobnicate"');
  });

  it("init creates the .rushes folder in a path with spaces", async () => {
    const { root } = await tmpProject();
    const target = join(root, "Second Film");
    const a = io(root);
    expect(await main(["init", "Second Film"], a.x)).toBe(0);
    await access(join(target, ".rushes", "project.json"));
  });

  it("add, notes and reply talk to the running server", async () => {
    const { root } = await tmpProject("spring-launch");
    const s = await startServer(root, { port: 0 });
    const a = io(root);
    expect(await main(["add", "version", "renders/hero v1.mp4", "--video", "Hero 60s"], a.x)).toBe(0);
    expect(a.out.pop()).toBe("Added Hero 60s v1");
    expect(await main(["add", "variant", "music", "audio/a.wav", "--name", "Deep house"], a.x)).toBe(0);

    const note = (await (await fetch(`${s.url}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: "picture", scope: "range", t: 31.05, tOut: 33.1, text: "Too fast" }),
    })).json()).note;

    const b = io(root);
    expect(await main(["notes", "--stage", "picture"], b.x)).toBe(0);
    expect(b.out[0]).toContain("0:31.05–0:33.10");
    expect(b.out[0]).toContain("Too fast");

    const c = io(root);
    expect(await main(["reply", note.id, "Slowed", "to", "2.4", "s", "--done", "--fix-t", "31.4"], c.x)).toBe(0);
    const d = io(root);
    await main(["notes", "--json"], d.x);
    expect(JSON.parse(d.out[0])[0]).toMatchObject({ reply: "Slowed to 2.4 s", status: "done", fixT: 31.4 });

    const e = io(root);
    await main(["status"], e.x);
    expect(e.out.find((l) => l.startsWith("picture"))).toMatch(/open/);
    await s.close();
  });

  it("explains missing arguments and server errors", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const a = io(root);
    expect(await main(["add", "version", "x.mp4"], a.x)).toBe(2);
    expect(a.err[0]).toContain("--video");
    const b = io(root);
    expect(await main(["reply", "n_missing", "hello"], b.x)).toBe(1);
    expect(b.err[0]).toContain('note "n_missing" not found');
    await s.close();
  });

  it("open starts the server and opens the browser", async () => {
    const { root } = await tmpProject();
    const a = io(root);
    let server: Running | undefined;
    a.x.onServer = (s) => { server = s; };
    expect(await main(["open", ".", "--port", "0"], a.x)).toBe(0);
    expect(a.opened).toEqual([server!.url]);
    const health = await (await fetch(`${a.opened[0]}/api/health`)).json();
    expect(health.root).toBe(root);
    await server!.close();
  });

  it("open and serve reuse a server that is already running instead of starting another", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const a = io(root);
    let started: Running | undefined;
    a.x.onServer = (x) => { started = x; };
    expect(await main(["open", "."], a.x)).toBe(0);
    expect(a.out).toEqual([`Rushes is already running for ${root}\n${s.url}`]);
    expect(a.opened).toEqual([s.url]);
    const b = io(root);
    b.x.onServer = (x) => { started = x; };
    expect(await main(["serve", root], b.x)).toBe(0);
    expect(b.out).toEqual([`Rushes is already running for ${root}\n${s.url}`]);
    expect(b.opened).toEqual([]);
    expect(started).toBeUndefined();
    await s.close();
  });

  it("reply rejects a --fix-t that isn't a finite, non-negative number", async () => {
    const { root } = await tmpProject();
    for (const bad of ["abc", "-1", "Infinity", "NaN", ""]) {
      const a = io(root);
      expect(await main(["reply", "n_x", "hello", `--fix-t=${bad}`], a.x)).toBe(2);
      expect(a.err.join("\n")).toContain("--fix-t");
    }
  });

  it("finds the command after flags, so rushes --dir x mcp stays alive", () => {
    expect(longRunningCommand(["--dir", "x", "mcp"])).toBe(true);
    expect(longRunningCommand(["--port", "4400", "open", "."])).toBe(true);
    expect(longRunningCommand(["serve"])).toBe(true);
    expect(longRunningCommand(["--dir", "open", "status"])).toBe(false);
    expect(longRunningCommand(["notes", "--json"])).toBe(false);
    expect(longRunningCommand(["--bogus"])).toBe(false);
    expect(longRunningCommand([])).toBe(false);
  });

  it("status reads the project folder it is given", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    await (await fetch(`${s.url}/api/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ video: "Hero", file: "a.mp4" }),
    })).json();
    const { dirname } = await import("node:path");
    const a = io(dirname(root));
    expect(await main(["status", root], a.x)).toBe(0);
    expect(a.out.find((l) => l.startsWith("picture"))).toMatch(/open/);
    await s.close();
  });
});

describe("cli setup", () => {
  it("prints one line per harness and the restart hint", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const home = await mkdtemp(join(tmpdir(), "rushes cli home "));
    await mkdir(join(home, ".cursor"));
    const skillFile = join(home, "s.md");
    await writeFile(skillFile, "x");
    const a = io(home);
    a.x.setupEnv = { home, platform: "linux", skillFile, which: async () => false, exec: async () => ({ code: 1, out: "" }) };
    expect(await main(["setup"], a.x)).toBe(0);
    expect(a.out.find((l) => l.startsWith("+ Cursor"))).toContain("added");
    expect(a.out.find((l) => l.startsWith("- Codex"))).toContain("not-found");
    expect(a.out.join("\n")).toContain('ask your agent to "open Rushes"');
    await rm(home, { recursive: true, force: true });
  });
});

describe("cli stop and idle", () => {
  it("stop asks the running server to shut down", async () => {
    const { root } = await tmpProject();
    const a = io(root);
    let server: Running | undefined;
    a.x.onServer = (s) => { server = s; };
    expect(await main(["serve", ".", "--port", "0"], a.x)).toBe(0);
    const b = io(root);
    expect(await main(["stop"], b.x)).toBe(0);
    expect(b.out[0]).toContain("Stopped Rushes");
    await server!.closed;
    const c = io(root);
    expect(await main(["stop"], c.x)).toBe(0);
    expect(c.out[0]).toContain("isn't running");
  });

  it("rejects a bad --idle-minutes", async () => {
    const { root } = await tmpProject();
    const a = io(root);
    expect(await main(["serve", ".", "--idle-minutes", "soon"], a.x)).toBe(2);
    expect(a.err[0]).toContain("--idle-minutes");
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/server test/cli test/mcp`
Expected: FAIL: `s.closed` is undefined, `idleMs` is ignored, /api/shutdown is 404, and `rushes stop` is an unknown command.

- [ ] **Step 3: Implement**

`src/server/start.ts`

```ts
import { createServer, type Server } from "node:http";
import { mkdir, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { Store } from "../core/store.js";
import { createApp } from "./app.js";
import { removeLock, writeLock } from "./lock.js";
import { watchStore } from "./watch.js";

export const DEFAULT_PORT = 4317;

export interface Running {
  url: string;
  port: number;
  store: Store;
  close(): Promise<void>;
  /** Resolves once the server has closed, for any reason (close(), shutdown request or idle). */
  closed: Promise<void>;
}

export interface StartOptions {
  port?: number;
  host?: string;
  name?: string;
  /** Close after this long with no requests and no open connections. Off by default. */
  idleMs?: number;
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((ok, fail) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      fail(e);
    };
    const onListening = () => {
      server.off("error", onError);
      const addr = server.address();
      ok(typeof addr === "object" && addr ? addr.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * Start the Rushes server for a project folder. Tries `port` and the next ten
 * ports; pass port 0 to let the OS choose (tests do).
 */
export async function startServer(rootDir: string, opts: StartOptions = {}): Promise<Running> {
  // The real path is the root everywhere (store, lock, health), so a symlinked path finds the same server.
  await mkdir(resolve(rootDir), { recursive: true });
  const root = await realpath(resolve(rootDir));
  const store = new Store(root);
  await store.init(opts.name ?? basename(root));
  let close: () => Promise<void> = async () => undefined;
  const app = createApp(store, { onShutdown: () => void close() });
  const listener = getRequestListener(app.fetch);
  let lastRequest = Date.now();
  const server = createServer((req, res) => {
    lastRequest = Date.now();
    listener(req, res);
  });
  const host = opts.host ?? "127.0.0.1";
  const first = opts.port ?? DEFAULT_PORT;

  let port = -1;
  let lastError: unknown;
  for (let p = first; p <= (first === 0 ? 0 : first + 10); p++) {
    try {
      port = await listen(server, p, host);
      break;
    } catch (e) {
      lastError = e;
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    }
  }
  if (port < 0) throw new Error(`No free port from ${first} to ${first + 10}: ${(lastError as Error)?.message}`);

  let token: string | undefined;
  try {
    token = (await writeLock(root, port)).token;
  } catch (e) {
    // Another server owns this project, or the lock couldn't be written: don't leave a socket open.
    server.closeAllConnections?.();
    await new Promise<void>((ok) => server.close(() => ok()));
    throw e;
  }
  const url = `http://${host}:${port}`;
  const stopWatching = watchStore(store);
  let idleTimer: NodeJS.Timeout | undefined;
  let done: () => void = () => undefined;
  const closed = new Promise<void>((ok) => { done = ok; });
  let closing: Promise<void> | null = null;
  close = () => {
    closing ??= (async () => {
      clearTimeout(idleTimer);
      stopWatching();
      server.closeAllConnections?.();
      await new Promise<void>((ok) => server.close(() => ok()));
      await removeLock(root, token);
      done();
    })();
    return closing;
  };

  if (opts.idleMs && opts.idleMs > 0) {
    const idleMs = opts.idleMs;
    const tick = () => {
      server.getConnections((_err, open) => {
        if (open === 0 && Date.now() - lastRequest >= idleMs) void close();
        else idleTimer = setTimeout(tick, Math.max(50, idleMs / 4));
      });
    };
    idleTimer = setTimeout(tick, idleMs);
    idleTimer.unref?.();
  }
  return { url, port, store, close, closed };
}
```

`src/server/app.ts`

```ts
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Store, ChangeEvent } from "../core/store.js";
import { RushesError, InvalidError, NotFoundError } from "../core/errors.js";
import { addVariant, addVersion } from "../core/project.js";
import { addTake, editSection, setSections } from "../core/script.js";
import { addNote, applyReply, applyUserEdit, filterNotes } from "../core/notes.js";
import { createBatch, latestBatch } from "../core/batches.js";
import { tabStates } from "../core/tabs.js";
import { fromManifestPath, toManifestPath } from "../core/paths.js";
import { probe } from "../core/media.js";
import type { CorruptEvent } from "./watch.js";
import { LaneStageSchema, SectionStatusSchema, StageSchema, BoxSchema, type Batch } from "../core/schema.js";

export const VERSION = "0.1.0";

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new InvalidError("Request body must be JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new InvalidError("Request body is invalid", parsed.error.issues);
  return parsed.data;
}

const t = z.number().nonnegative();

const NewNoteBody = z.object({
  stage: StageSchema,
  video: z.string().nullish(),
  version: z.string().nullish(),
  on: z.string().nullish(),
  scope: z.enum(["point", "range", "whole"]),
  t: t.nullish(),
  tOut: t.nullish(),
  frame: z.number().int().nonnegative().nullish(),
  text: z.string(),
  box: BoxSchema.nullish(),
  grab: z.string().nullish(),
});

const UserEditBody = z.object({
  text: z.string().optional(),
  box: BoxSchema.nullable().optional(),
  grab: z.string().nullable().optional(),
  scope: z.enum(["point", "range", "whole"]).optional(),
  t: t.nullable().optional(),
  tOut: t.nullable().optional(),
  status: z.enum(["todo", "done"]).optional(),
});

const RepliesBody = z.object({
  replies: z
    .array(
      z.object({
        id: z.string(),
        reply: z.string().optional(),
        status: z.enum(["todo", "done"]).optional(),
        fixT: t.nullable().optional(),
        fixVersion: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

const VersionBody = z.object({ video: z.string().min(1), file: z.string().min(1), note: z.string().optional() });
const VariantBody = z.object({
  stage: LaneStageSchema,
  lane: z.string().optional(),
  name: z.string().min(1),
  file: z.string().min(1),
  meta: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  cues: z.array(z.object({ name: z.string().min(1), t })).optional(),
});
const ScriptBody = z.object({
  wordsPerSecond: z.number().positive().optional(),
  replace: z.boolean().optional(),
  sections: z.array(z.object({ id: z.string().min(1).optional(), start: t, end: t, current: z.string() })),
});
const SectionEditBody = z.object({
  proposed: z.string().nullable().optional(),
  direction: z.string().optional(),
  status: SectionStatusSchema.optional(),
});
const TakeBody = z.object({ file: z.string().min(1) });
const PicksBody = z.object({ lanes: z.record(z.string(), z.string()).optional(), sections: z.record(z.string(), z.string()).optional() });
const BatchBody = z.object({ stage: StageSchema });

const NoteQuery = z.object({
  stage: StageSchema.optional(),
  status: z.enum(["todo", "done"]).optional(),
  batch: z.string().optional(),
  version: z.string().optional(),
});

export interface AppOptions {
  /** Called after POST /api/shutdown has replied. */
  onShutdown?: () => void;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

/** Hostname of "host[:port]" or a full origin URL, lowercased, or null when it doesn't parse. */
function hostnameOf(value: string, isUrl: boolean): string | null {
  try {
    return new URL(isUrl ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function createApp(store: Store, opts: AppOptions = {}): Hono {
  const app = new Hono();
  // Every SSE client adds a change listener, so lift Node's default limit of ten.
  store.setMaxListeners(0);

  app.onError((err, c) => {
    if (err instanceof RushesError) return c.json({ error: err.code, message: err.message, ...err.detail }, err.status as 400);
    console.error(err);
    return c.json({ error: "internal", message: (err as Error).message }, 500);
  });

  // The server is for this machine only. Checking Host stops DNS rebinding;
  // requiring JSON and a local Origin on writes stops other websites posting
  // to it from the user's browser (a JSON content type forces a CORS preflight,
  // which this server never answers).
  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    const hostname = hostnameOf(host, false);
    if (!hostname || !LOCAL_HOSTS.has(hostname)) {
      return c.json({ error: "forbidden_host", message: `Rushes only answers requests to 127.0.0.1 or localhost, not "${host}"` }, 403);
    }
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const type = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (type !== "application/json") {
        return c.json({ error: "unsupported_media_type", message: "Requests that change data must send Content-Type: application/json" }, 415);
      }
      const origin = c.req.header("origin");
      if (origin !== undefined) {
        const from = hostnameOf(origin, true);
        if (!from || !LOCAL_HOSTS.has(from)) {
          return c.json({ error: "forbidden_origin", message: `Rushes doesn't accept changes from pages on "${origin}"` }, 403);
        }
      }
    }
    await next();
  });

  app.get("/", (c) =>
    c.html(`<!doctype html><title>Rushes</title><p>Rushes is running for <code>${escapeHtml(store.root)}</code>. The dashboard arrives in the next release.</p>`),
  );

  app.post("/api/shutdown", (c) => {
    if (opts.onShutdown) setImmediate(opts.onShutdown);
    return c.json({ ok: true, stopping: !!opts.onShutdown });
  });

  app.get("/api/health", (c) => c.json({ ok: true, app: "rushes", version: VERSION, root: store.root }));

  app.get("/api/state", async (c) => {
    const [project, script, notes, picks, batches] = await Promise.all([
      store.read("project"), store.read("script"), store.read("notes"), store.read("picks"), store.read("batches"),
    ]);
    return c.json({ project, script, notes, picks, batches, tabs: tabStates(project, script, notes) });
  });

  app.get("/api/tabs", async (c) => {
    const [project, script, notes] = await Promise.all([store.read("project"), store.read("script"), store.read("notes")]);
    return c.json({ tabs: tabStates(project, script, notes) });
  });

  // ---- notes ----
  app.get("/api/notes", async (c) => {
    const q = NoteQuery.safeParse(c.req.query());
    if (!q.success) throw new InvalidError("Query is invalid", q.error.issues);
    const { notes } = await store.read("notes");
    return c.json({ notes: filterNotes(notes, q.data) });
  });

  app.post("/api/notes", async (c) => {
    const b = await body(c, NewNoteBody);
    const { result } = await store.update("notes", (f) => addNote(f, { ...b, by: "user" }));
    return c.json({ note: result }, 201);
  });

  app.patch("/api/notes/:id", async (c) => {
    const b = await body(c, UserEditBody);
    const { result } = await store.update("notes", (f) => applyUserEdit(f, { id: c.req.param("id"), ...b }));
    return c.json({ note: result });
  });

  app.post("/api/replies", async (c) => {
    const b = await body(c, RepliesBody);
    const { result } = await store.update("notes", (f) => b.replies.map((r) => applyReply(f, r)));
    return c.json({ notes: result });
  });

  // ---- media ----
  app.post("/api/versions", async (c) => {
    const b = await body(c, VersionBody);
    const file = toManifestPath(store.root, b.file);
    const info = await probe(fromManifestPath(store.root, file));
    const { result } = await store.update("project", (p) => {
      const out = addVersion(p, { video: b.video, file, note: b.note, duration: info.duration, fps: info.fps });
      if (info.fps && p.videos.length === 1 && p.videos[0].versions.length === 1) p.fps = info.fps;
      return out;
    });
    return c.json(result, 201);
  });

  app.post("/api/variants", async (c) => {
    const b = await body(c, VariantBody);
    const { result } = await store.update("project", (p) => addVariant(p, { ...b, file: toManifestPath(store.root, b.file) }));
    return c.json(result, 201);
  });

  // ---- script ----
  app.get("/api/script", async (c) => c.json({ script: await store.read("script") }));

  app.put("/api/script", async (c) => {
    const b = await body(c, ScriptBody);
    const { result } = await store.update("script", (s) => {
      if (b.wordsPerSecond) s.wordsPerSecond = b.wordsPerSecond;
      return setSections(s, b.sections, { replace: b.replace });
    });
    return c.json({ sections: result });
  });

  app.patch("/api/script/:id", async (c) => {
    const b = await body(c, SectionEditBody);
    const { result } = await store.update("script", (s) => editSection(s, c.req.param("id"), b));
    return c.json({ section: result });
  });

  app.post("/api/script/:id/takes", async (c) => {
    const b = await body(c, TakeBody);
    const file = toManifestPath(store.root, b.file);
    const info = await probe(fromManifestPath(store.root, file));
    const { result } = await store.update("script", (s) => addTake(s, c.req.param("id"), { file, duration: info.duration }));
    return c.json({ take: result }, 201);
  });

  // ---- picks ----
  app.get("/api/picks", async (c) => c.json(await store.read("picks")));

  app.put("/api/picks", async (c) => {
    const b = await body(c, PicksBody);
    const { data } = await store.update("picks", (p) => {
      Object.assign(p.lanes, b.lanes ?? {});
      Object.assign(p.sections, b.sections ?? {});
    });
    return c.json(data);
  });

  // ---- batches ----
  // A batch touches two files (notes and batches), so batch creation runs one at a time.
  let batchQueue: Promise<unknown> = Promise.resolve();
  app.post("/api/batches", async (c) => {
    const { stage } = await body(c, BatchBody);
    const run = batchQueue.catch(() => undefined).then(async (): Promise<Batch> => {
      const [project, script, batches] = await Promise.all([store.read("project"), store.read("script"), store.read("batches")]);
      const { result } = await store.update("notes", (notes) => createBatch({ project, script, notes, batches }, stage));
      await store.update("batches", (f) => { f.batches.push(result); });
      return result;
    });
    batchQueue = run;
    return c.json({ batch: await run }, 201);
  });

  app.get("/api/batches/:id", async (c) => {
    const [batches, notes, script] = await Promise.all([store.read("batches"), store.read("notes"), store.read("script")]);
    const id = c.req.param("id");
    const batch = id === "latest" ? latestBatch(batches) : batches.batches.find((b) => b.id === id);
    if (!batch) throw new NotFoundError("batch", id);
    return c.json({
      batch,
      notes: notes.notes.filter((n) => batch.noteIds.includes(n.id)),
      sections: script.sections.filter((s) => batch.sectionIds.includes(s.id)),
    });
  });

  // ---- live updates ----
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const send = (e: ChangeEvent) => void stream.writeSSE({ event: "change", data: JSON.stringify(e) });
      const corrupt = (e: CorruptEvent) => void stream.writeSSE({ event: "corrupt", data: JSON.stringify(e) });
      store.on("change", send);
      store.on("corrupt", corrupt);
      stream.onAbort(() => {
        store.off("change", send);
        store.off("corrupt", corrupt);
      });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ root: store.root }) });
      while (!stream.aborted) await stream.sleep(15000).then(() => stream.writeSSE({ event: "ping", data: "" }));
    }),
  );

  return app;
}
```

`src/mcp/ensure.ts`

```ts
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalRoot, isRushesFor, readLock } from "../server/lock.js";
import { RushesClient } from "./client.js";
import { SOURCE } from "../setup/harnesses.js";
import { RUSHES_DIR } from "../core/store.js";

/** URL of a live Rushes server for exactly this project root, or null. */
export async function findServer(rootDir: string): Promise<string | null> {
  const root = await canonicalRoot(rootDir);
  const lock = await readLock(root);
  if (!lock) return null;
  // A reused port or pid can point at something else, so check it's ours.
  return (await isRushesFor(lock.port, root)) ? `http://127.0.0.1:${lock.port}` : null;
}

export interface EnsureOptions {
  /** Command that starts a server in the foreground, given the project root. Defaults to this package's CLI. */
  spawnServer?: (root: string) => void;
  timeoutMs?: number;
}

/** Background servers started for an agent stop after this long with nothing connected. */
export const BACKGROUND_IDLE_MINUTES = 120;

/** Where a background server's output goes, so a failed start leaves evidence. */
export function serverLogPath(root: string): string {
  return join(root, RUSHES_DIR, "server.log");
}

function defaultSpawn(root: string): void {
  const cli = fileURLToPath(new URL("../cli/index.js", import.meta.url));
  let log: number | "ignore" = "ignore";
  try {
    mkdirSync(join(root, RUSHES_DIR), { recursive: true });
    log = openSync(serverLogPath(root), "a");
  } catch {
    // No log if the folder can't be written; the start may still work.
  }
  try {
    const child = spawn(process.execPath, [cli, "serve", root, "--idle-minutes", String(BACKGROUND_IDLE_MINUTES)], { detached: true, stdio: ["ignore", log, log], windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
  } finally {
    if (typeof log === "number") closeSync(log);
  }
}

/** One in-flight ensure per root, so parallel tool calls share a single spawn. */
const pending = new Map<string, Promise<RushesClient>>();

/** Find the project's server, starting one in the background if needed. */
export async function ensureServer(rootDir: string, opts: EnsureOptions = {}): Promise<RushesClient> {
  const root = await canonicalRoot(rootDir);
  const inFlight = pending.get(root);
  if (inFlight) return inFlight;
  const run = ensure(root, opts).finally(() => pending.delete(root));
  pending.set(root, run);
  return run;
}

async function ensure(root: string, opts: EnsureOptions): Promise<RushesClient> {
  const found = await findServer(root);
  if (found) return new RushesClient(found);
  (opts.spawnServer ?? defaultSpawn)(root);
  const deadline = Date.now() + (opts.timeoutMs ?? 8000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const url = await findServer(root);
    if (url) return new RushesClient(url);
  }
  throw new Error(
    `Rushes server did not start for ${root}. Its output is in ${serverLogPath(root)}. Try running "npx -y ${SOURCE} open" in that folder.`,
  );
}
```

`src/cli/main.ts`

```ts
import { parseArgs } from "node:util";
import { basename, resolve } from "node:path";
import { Store } from "../core/store.js";
import { startServer, DEFAULT_PORT, type Running } from "../server/start.js";
import { ensureServer, findServer, type EnsureOptions } from "../mcp/ensure.js";
import { AlreadyRunningError, canonicalRoot } from "../server/lock.js";
import { ApiError, RushesClient } from "../mcp/client.js";
import { openBrowser, runStdio } from "../mcp/stdio.js";
import { VERSION } from "../server/app.js";
import { setup, type SetupEnv } from "../setup/setup.js";
import { realSetupEnv } from "../setup/env.js";
import type { HarnessId } from "../setup/harnesses.js";

export interface Io {
  out(line: string): void;
  err(line: string): void;
  cwd: string;
  ensure?: EnsureOptions;
  openBrowser?: (url: string) => void;
  /** Receives the server started by open/serve. When set, main does not install signal handlers (tests close it). */
  onServer?: (s: Running) => void;
  /** Environment for `rushes setup`. Tests pass a fake home. */
  setupEnv?: SetupEnv;
}

export const HELP = `rushes ${VERSION}: a local review desk for video made with AI agents

Usage
  rushes open [dir] [--port 4317] [--no-browser]   start the review desk and open it
  rushes serve [dir] [--port 4317] [--idle-minutes N]
                                                    start the server without a browser (stops after N idle minutes)
  rushes stop [dir]                                 stop the project's running server
  rushes init [dir] [--name NAME]                  create the .rushes folder
  rushes setup [--only claude-code,codex,...] [--dry-run]
                                                    add Rushes to every agent harness on this machine
  rushes mcp                                        run the MCP server over stdio
  rushes status [dir]                               tabs and open items
  rushes add version <file> --video NAME [--note TEXT]
  rushes add variant <music|sfx|voice> <file> --name NAME [--lane ID]
  rushes notes [--stage S] [--status todo|done] [--batch ID] [--json]
  rushes reply <note-id> <text> [--done] [--fix-t SECONDS] [--fix-version V]

Options
  --dir DIR   project folder for commands that talk to the server (default: current folder)
`;

const OPTIONS = {
  port: { type: "string" },
  "no-browser": { type: "boolean" },
  name: { type: "string" },
  video: { type: "string" },
  note: { type: "string" },
  lane: { type: "string" },
  stage: { type: "string" },
  status: { type: "string" },
  batch: { type: "string" },
  json: { type: "boolean" },
  done: { type: "boolean" },
  "fix-t": { type: "string" },
  "fix-version": { type: "string" },
  dir: { type: "string" },
  only: { type: "string" },
  "dry-run": { type: "boolean" },
  "idle-minutes": { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

const LONG_RUNNING = ["open", "serve", "mcp"];

/** Does this command line start something that keeps running (open, serve, mcp)? Flags before the command are skipped. */
export function longRunningCommand(argv: string[]): boolean {
  try {
    const [cmd] = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }).positionals;
    return LONG_RUNNING.includes(cmd ?? "");
  } catch {
    return false;
  }
}

/** Run the CLI. Returns an exit code. Long-running commands (open, serve, mcp) resolve once started. */
export async function main(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (e) {
    io.err((e as Error).message);
    io.err(HELP);
    return 2;
  }
  const { values: o, positionals: p } = parsed;
  if (o.version) return io.out(VERSION), 0;
  const [cmd, ...rest] = p;
  if (!cmd || o.help || cmd === "help") return io.out(HELP), 0;

  const dir = resolve(io.cwd, o.dir ?? ".");
  const client = () => ensureServer(dir, io.ensure);

  try {
    switch (cmd) {
      case "open":
      case "serve": {
        const root = await canonicalRoot(resolve(io.cwd, rest[0] ?? "."));
        const show = (url: string) => {
          if (cmd === "open" && !o["no-browser"]) (io.openBrowser ?? openBrowser)(url);
        };
        const already = (url: string) => {
          io.out(`Rushes is already running for ${root}\n${url}`);
          show(url);
          return 0;
        };
        const running = await findServer(root);
        if (running) return already(running);
        const idle = o["idle-minutes"] === undefined ? undefined : Number(o["idle-minutes"]);
        if (idle !== undefined && !(Number.isFinite(idle) && idle > 0)) return usage(io, "--idle-minutes must be a number of minutes above 0");
        let s: Running;
        try {
          s = await startServer(root, { port: o.port ? Number(o.port) : DEFAULT_PORT, idleMs: idle ? idle * 60_000 : undefined });
        } catch (e) {
          // Another server won the race between the check above and our start.
          if (e instanceof AlreadyRunningError) return already(e.url);
          throw e;
        }
        io.out(`Rushes is running for ${root}\n${s.url}`);
        show(s.url);
        if (io.onServer) return io.onServer(s), 0;
        // Exit once the server closes for any reason: a signal, `rushes stop`, or the idle timer.
        void s.closed.then(() => process.exit(0));
        const stop = () => void s.close();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        return 0;
      }
      case "stop": {
        const root = await canonicalRoot(resolve(io.cwd, rest[0] ?? "."));
        const url = await findServer(root);
        if (!url) return io.out(`Rushes isn't running for ${root}`), 0;
        await new RushesClient(url).post("/api/shutdown", {});
        io.out(`Stopped Rushes for ${root}`);
        return 0;
      }
      case "init": {
        const root = resolve(io.cwd, rest[0] ?? ".");
        await new Store(root).init(o.name ?? basename(root));
        io.out(`Created ${root}/.rushes`);
        return 0;
      }
      case "setup": {
        const only = o.only ? (o.only.split(",").map((x) => x.trim()) as HarnessId[]) : undefined;
        const results = await setup(io.setupEnv ?? realSetupEnv(), { only, dryRun: o["dry-run"] });
        const mark = { added: "+", "would-add": "~", already: "=", "not-found": "-", failed: "!" } as const;
        for (const r of results) {
          const skill = r.skill ? `, skill ${r.skill}` : "";
          io.out(`${mark[r.status]} ${r.name.padEnd(15)} ${r.status}${skill}${r.status === "not-found" ? "" : `  ${r.detail}`}`);
        }
        const added = results.filter((r) => r.status === "added").length;
        if (added) io.out(`\nRestart ${added === 1 ? "that app" : "those apps"} so ${added === 1 ? "it picks" : "they pick"} up the rushes tools. Then ask your agent to "open Rushes".`);
        if (!results.some((r) => r.status !== "not-found")) io.out("No supported agent harness found. See https://github.com/iamredmh/rushes#other-harnesses");
        return results.some((r) => r.status === "failed") ? 1 : 0;
      }
      case "mcp":
        await runStdio(io.cwd);
        return 0;
      case "status": {
        const root = rest[0] ? resolve(io.cwd, rest[0]) : dir;
        const { tabs } = await (await ensureServer(root, io.ensure)).get("/api/tabs");
        for (const t of tabs as { stage: string; unlocked: boolean; todo: number }[]) {
          io.out(`${t.stage.padEnd(8)} ${t.unlocked ? "open  " : "locked"} ${t.todo ? `${t.todo} to do` : ""}`.trimEnd());
        }
        return 0;
      }
      case "add": {
        const [what, a, b] = rest;
        const c = await client();
        if (what === "version") {
          if (!a || !o.video) return usage(io, "rushes add version <file> --video NAME");
          const r = await c.post("/api/versions", { video: o.video, file: resolve(io.cwd, a), note: o.note });
          io.out(`Added ${r.video.name} ${r.version.id}`);
          return 0;
        }
        if (what === "variant") {
          if (!a || !b || !o.name) return usage(io, "rushes add variant <music|sfx|voice> <file> --name NAME");
          const r = await c.post("/api/variants", { stage: a, file: resolve(io.cwd, b), name: o.name, lane: o.lane });
          io.out(`Added ${r.lane.name}: ${r.variant.name}`);
          return 0;
        }
        return usage(io, "rushes add version|variant ...");
      }
      case "notes": {
        const q = new URLSearchParams();
        for (const k of ["stage", "status", "batch"] as const) if (o[k]) q.set(k, o[k]!);
        const { notes } = await (await client()).get(`/api/notes${q.size ? `?${q}` : ""}`);
        if (o.json) return io.out(JSON.stringify(notes, null, 2)), 0;
        for (const n of notes) io.out(`${n.id}  ${n.status === "done" ? "done" : "todo"}  ${n.stage.padEnd(7)} ${when(n).padEnd(17)} ${n.text}`);
        if (!notes.length) io.out("No notes");
        return 0;
      }
      case "reply": {
        const [id, ...words] = rest;
        const replyUsage = "rushes reply <note-id> <text> [--done] [--fix-t SECONDS] [--fix-version V]";
        if (!id || !words.length) return usage(io, replyUsage);
        const fixT = o["fix-t"] === undefined ? undefined : o["fix-t"].trim() === "" ? NaN : Number(o["fix-t"]);
        if (fixT !== undefined && !(Number.isFinite(fixT) && fixT >= 0)) {
          io.err(`--fix-t must be a number of seconds, 0 or more (got "${o["fix-t"]}")`);
          return usage(io, replyUsage);
        }
        const reply = {
          id,
          reply: words.join(" "),
          ...(o.done ? { status: "done" } : {}),
          ...(fixT !== undefined ? { fixT } : {}),
          ...(o["fix-version"] ? { fixVersion: o["fix-version"] } : {}),
        };
        await (await client()).post("/api/replies", { replies: [reply] });
        io.out(`Replied to ${id}`);
        return 0;
      }
      default:
        io.err(`Unknown command "${cmd}"`);
        io.err(HELP);
        return 2;
    }
  } catch (e) {
    io.err(e instanceof ApiError ? `${e.message}` : (e as Error).message);
    return 1;
  }
}

function usage(io: Io, line: string): number {
  io.err(`Usage: ${line}`);
  return 2;
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
}

function when(n: { scope: string; t: number | null; tOut: number | null }): string {
  if (n.scope === "whole" || n.t === null) return "whole";
  return n.scope === "range" && n.tOut !== null ? `${fmt(n.t)}–${fmt(n.tOut)}` : fmt(n.t);
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/server test/cli test/mcp && npx tsc --noEmit && npx vitest run`
Expected: everything passes, including the full unit suite, and tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/server/start.ts src/server/app.ts src/mcp/ensure.ts src/cli/main.ts test/server/idle.test.ts test/cli/main.test.ts
git commit -m "feat(server): background servers stop when idle, and rushes stop"
```

---

### Task 4: Media streaming, frame grabs and the dashboard's files

**Files:**
- Create: `src/server/files.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/start.ts`
- Create: `test/server/files.test.ts`
- Modify: `test/server/app.test.ts`

**Interfaces:**
- **Consumes:**
  - Task 3's `app.ts` and `start.ts`;
  - `fromManifestPath`.
- **Produces** (`files.ts`):
  - `CONTENT_TYPES`, `contentType(path)`;
  - `GRAB_PATH`;
  - `registeredMedia(project, script) -> Set<string>`;
  - `parseRange(header, size) -> {start, end} | null`;
  - `sendFile(absPath, range?, type?) -> Response`: 200, 206, 404 `missing_file`, or 416;
  - `inside(dir, rel) -> string | null`.
- **Produces** (`app.ts`):
  - `AppOptions { webDir?, onShutdown? }` and `DEFAULT_WEB_DIR` (`<package>/web-dist/`).
  - Routes:
    - `GET /` serves the dashboard's index.html, or a placeholder when it isn't built;
    - `GET /assets/*`;
    - `GET /media?path=`;
    - `POST /api/grabs {video, version, frame, png}` → `{grab: ".rushes/grabs/<video>_<version>_f<frame>.png"}` (PNG only, at most 25 MB).
- **Produces** (`start.ts`): a `webDir` option.

- [ ] **Step 1: Write the failing tests**

`test/server/files.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { createApp } from "../../src/server/app.js";
import { parseRange, inside } from "../../src/server/files.js";

// The smallest valid PNG (1×1, transparent).
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function setup() {
  const { root, store } = await tmpProject("files");
  const webDir = join(root, "web");
  await mkdir(join(webDir, "assets"), { recursive: true });
  await writeFile(join(webDir, "index.html"), "<!doctype html><title>Rushes</title><div id=app></div>");
  await writeFile(join(webDir, "assets", "app-abc123.js"), "console.log('hi')");
  const app = createApp(store, { webDir });
  const call = (path: string, init: RequestInit = {}) => app.request(path, init);
  const post = (path: string, json: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) });
  return { root, store, call, post };
}

describe("parseRange", () => {
  it("reads start-end, open-ended and suffix ranges", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
  });
  it("rejects ranges it can't satisfy", () => {
    expect(parseRange("bytes=2000-", 1000)).toBeNull();
    expect(parseRange("bytes=5-1", 1000)).toBeNull();
    expect(parseRange("bytes=-", 1000)).toBeNull();
    expect(parseRange("items=0-1", 1000)).toBeNull();
    expect(parseRange(undefined, 1000)).toBeNull();
  });
});

describe("inside", () => {
  it("keeps paths inside the folder and refuses escapes", () => {
    expect(inside("/web", "assets/a.js")).toBe("/web/assets/a.js");
    expect(inside("/web", "../etc/passwd")).toBeNull();
    expect(inside("/web", "assets/../../etc/passwd")).toBeNull();
  });
});

describe("dashboard files", () => {
  it("serves the built index.html at / and its assets", async () => {
    const { call } = await setup();
    const page = await call("/");
    expect(await page.text()).toContain("<div id=app>");
    const js = await call("/assets/app-abc123.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toBe("console.log('hi')");
  });
  it("404s for missing assets and refuses to leave the folder", async () => {
    const { call } = await setup();
    expect((await call("/assets/nope.js")).status).toBe(404);
    expect((await call("/assets/..%2F..%2Fpackage.json")).status).toBe(404);
  });
});

describe("media", () => {
  async function withClip() {
    const s = await setup();
    await mkdir(join(s.root, "renders"), { recursive: true });
    await writeFile(join(s.root, "renders", "hero v1.mp4"), Buffer.alloc(1000, 7));
    await s.post("/api/versions", { video: "Hero", file: "renders/hero v1.mp4" });
    return s;
  }

  it("streams a registered file, whole or by byte range", async () => {
    const { call } = await withClip();
    const whole = await call(`/media?path=${encodeURIComponent("renders/hero v1.mp4")}`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("video/mp4");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect((await whole.arrayBuffer()).byteLength).toBe(1000);
    const part = await call(`/media?path=${encodeURIComponent("renders/hero v1.mp4")}`, { headers: { range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    const bad = await call(`/media?path=${encodeURIComponent("renders/hero v1.mp4")}`, { headers: { range: "bytes=5000-" } });
    expect(bad.status).toBe(416);
  });

  it("refuses any path the project didn't register", async () => {
    const { call, root } = await withClip();
    await writeFile(join(root, "secret.txt"), "no");
    expect((await call("/media?path=secret.txt")).status).toBe(404);
    expect((await call("/media?path=..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
    expect((await call("/media?path=.rushes%2Fnotes.json")).status).toBe(404);
  });

  it("says when a registered file has gone missing", async () => {
    const { post, call } = await setup();
    await post("/api/versions", { video: "Hero", file: "renders/gone.mp4" });
    const r = await call("/media?path=renders%2Fgone.mp4");
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: "missing_file" });
  });
});

describe("frame grabs", () => {
  it("saves a PNG under .rushes/grabs and serves it back", async () => {
    const { post, call, root } = await setup();
    const r = await post("/api/grabs", { video: "hero-60s", version: "v3", frame: 744, png: `data:image/png;base64,${PNG_1PX}` });
    expect(r.status).toBe(201);
    const { grab } = (await r.json()) as { grab: string };
    expect(grab).toBe(".rushes/grabs/hero-60s_v3_f744.png");
    expect((await readFile(join(root, grab))).subarray(1, 4).toString()).toBe("PNG");
    const back = await call(`/media?path=${encodeURIComponent(grab)}`);
    expect(back.status).toBe(200);
    expect(back.headers.get("content-type")).toBe("image/png");
  });

  it("rejects anything that isn't a PNG, and unsafe names", async () => {
    const { post } = await setup();
    expect((await post("/api/grabs", { video: "hero", version: "v1", frame: 1, png: Buffer.from("hello").toString("base64") })).status).toBe(400);
    expect((await post("/api/grabs", { video: "../x", version: "v1", frame: 1, png: PNG_1PX })).status).toBe(400);
    expect((await post("/api/grabs", { video: "hero", version: "latest", frame: 1, png: PNG_1PX })).status).toBe(400);
  });
});
```

`test/server/app.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Store } from "../../src/core/store.js";
import { tmpProject } from "../helpers/tmp.js";
import { createApp } from "../../src/server/app.js";

async function setup() {
  const { root, store } = await tmpProject("spring-launch");
  const app = createApp(store);
  const call = async (method: string, path: string, json?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: json === undefined ? {} : { "content-type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { root, store, call };
}

describe("local-only guard", () => {
  it("rejects a Host that isn't 127.0.0.1 or localhost with 403", async () => {
    const { store } = await tmpProject();
    const app = createApp(store);
    const res = await app.request("/api/health", { headers: { host: "evil.example" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden_host", message: expect.any(String) });
    expect((await app.request("http://evil.example:4317/api/state")).status).toBe(403);
    expect((await app.request("/api/health", { headers: { host: "127.0.0.1:4317" } })).status).toBe(200);
    expect((await app.request("/api/health", { headers: { host: "localhost:9" } })).status).toBe(200);
  });

  it("returns 415 for a write that isn't application/json", async () => {
    const { store } = await tmpProject();
    const app = createApp(store);
    const res = await app.request("/api/notes", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ stage: "picture", scope: "point", t: 1, text: "x" }),
    });
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ error: "unsupported_media_type" });
    expect((await store.read("notes")).notes).toHaveLength(0);
    expect((await app.request("/api/batches", { method: "POST" })).status).toBe(415);
  });

  it("rejects a write from a foreign Origin with 403 and accepts a local one", async () => {
    const { store } = await tmpProject();
    const app = createApp(store);
    const note = JSON.stringify({ stage: "picture", scope: "point", t: 1, text: "x" });
    const evil = await app.request("/api/notes", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: note });
    expect(evil.status).toBe(403);
    expect(await evil.json()).toMatchObject({ error: "forbidden_origin" });
    const local = await app.request("/api/notes", { method: "POST", headers: { "content-type": "application/json; charset=utf-8", origin: "http://localhost:4317" }, body: note });
    expect(local.status).toBe(201);
    expect((await store.read("notes")).notes).toHaveLength(1);
  });
});

describe("root page and listeners", () => {
  it("GET / says Rushes is running for the project, with the root escaped", async () => {
    const { root } = await tmpProject();
    const odd = join(root, "<b>A&B</b>");
    const store = new Store(odd);
    await store.init("odd");
    // No built dashboard in this folder, so the placeholder page is served.
    const res = await createApp(store, { webDir: join(root, "no-dashboard") }).request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toBe(
      `<!doctype html><title>Rushes</title><p>Rushes is running for <code>${odd.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>. The dashboard isn't built: run <code>npm run build</code>.</p>`,
    );
    expect(html).not.toContain("<b>");
  });

  it("lets any number of SSE clients listen without a warning", async () => {
    const { store } = await tmpProject();
    createApp(store);
    expect(store.getMaxListeners()).toBe(0);
  });
});

describe("API", () => {
  it("health names the app and the project root", async () => {
    const { call, root } = await setup();
    expect((await call("GET", "/api/health")).json).toMatchObject({ ok: true, app: "rushes", root });
  });

  it("state starts with every tab locked", async () => {
    const { call } = await setup();
    const { json } = await call("GET", "/api/state");
    expect(json.project.name).toBe("spring-launch");
    expect(json.tabs.every((t: any) => !t.unlocked)).toBe(true);
  });

  it("adding a version unlocks Picture and stores a relative path", async () => {
    const { call, root } = await setup();
    const r = await call("POST", "/api/versions", { video: "Hero 60s", file: `${root}/renders/hero v1.mp4`, note: "first cut" });
    expect(r.status).toBe(201);
    expect(r.json.version).toMatchObject({ id: "v1", file: "renders/hero v1.mp4", note: "first cut" });
    const tabs = (await call("GET", "/api/tabs")).json.tabs;
    expect(tabs.find((t: any) => t.stage === "picture").unlocked).toBe(true);
  });

  it("notes: create, list with filters, edit, reply", async () => {
    const { call } = await setup();
    const a = (await call("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 12.4, frame: 744, text: "Logo lands early" })).json.note;
    await call("POST", "/api/notes", { stage: "music", scope: "whole", on: "deep-house", text: "Make it 110 BPM" });
    expect((await call("GET", "/api/notes?stage=picture")).json.notes).toHaveLength(1);
    const edited = (await call("PATCH", `/api/notes/${a.id}`, { text: "Logo lands a beat early" })).json.note;
    expect(edited.text).toBe("Logo lands a beat early");
    const replied = (await call("POST", "/api/replies", { replies: [{ id: a.id, reply: "Held 0.5 s", status: "done", fixT: 12.9, fixVersion: "v2" }] })).json.notes[0];
    expect(replied).toMatchObject({ status: "done", reply: "Held 0.5 s", fixT: 12.9, text: "Logo lands a beat early" });
    expect((await call("GET", "/api/notes?status=todo")).json.notes).toHaveLength(1);
  });

  it("rejects bad input with 400 and an explanation, and unknown ids with 404", async () => {
    const { call } = await setup();
    const bad = await call("POST", "/api/notes", { stage: "picture", scope: "range", t: 5, tOut: 2, text: "x" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("invalid");
    expect(JSON.stringify(bad.json.issues)).toContain("tOut");
    expect((await call("GET", "/api/notes?stage=nope")).status).toBe(400);
    expect((await call("PATCH", "/api/notes/n_missing", { text: "x" })).status).toBe(404);
    expect((await call("POST", "/api/replies", { replies: [] })).status).toBe(400);
  });

  it("returns 500 with the file name when a data file is corrupt, and leaves it alone", async () => {
    const { call, store } = await setup();
    await writeFile(store.path("notes"), "{ not json", "utf8");
    const r = await call("POST", "/api/notes", { stage: "picture", scope: "point", t: 1, text: "x" });
    expect(r.status).toBe(500);
    expect(r.json).toMatchObject({ error: "corrupt_file", file: "notes.json" });
  });

  it("script: set sections, edit a row, add a take", async () => {
    const { call } = await setup();
    const set = await call("PUT", "/api/script", { sections: [{ start: 0, end: 13, current: "Your work lives on one laptop." }] });
    expect(set.json.sections[0].id).toBe("s1");
    const edit = await call("PATCH", "/api/script/s1", { proposed: "Your work lives on one machine.", status: "flagged" });
    expect(edit.json.section).toMatchObject({ proposed: "Your work lives on one machine.", status: "flagged" });
    const take = await call("POST", "/api/script/s1/takes", { file: "audio/vo_s1.wav" });
    expect(take.status).toBe(201);
    expect(take.json.take).toMatchObject({ id: "t1", forText: "Your work lives on one laptop." });
    expect((await call("PUT", "/api/script", { sections: [{ start: 0, end: 5, current: "a" }, { start: 4, end: 8, current: "b" }] })).status).toBe(400);
  });

  it("script: PUT merges by id unless replace is set, and GET returns the whole script", async () => {
    const { call } = await setup();
    await call("PUT", "/api/script", { sections: [{ start: 0, end: 10, current: "A" }, { start: 10, end: 20, current: "B" }] });
    await call("POST", "/api/script/s1/takes", { file: "audio/a.wav" });
    const merged = await call("PUT", "/api/script", { sections: [{ id: "s2", start: 10, end: 20, current: "B2" }] });
    expect(merged.status).toBe(200);
    expect(merged.json.sections.map((x: any) => [x.id, x.current])).toEqual([["s1", "A"], ["s2", "B2"]]);
    const got = await call("GET", "/api/script");
    expect(got.status).toBe(200);
    expect(got.json.script.wordsPerSecond).toBe(2.6);
    expect(got.json.script.sections[0].takes).toHaveLength(1);
    const replaced = await call("PUT", "/api/script", { replace: true, sections: [{ id: "s2", start: 0, end: 5, current: "B2" }] });
    expect(replaced.json.sections.map((x: any) => x.id)).toEqual(["s2"]);
    expect((await call("PUT", "/api/script", { replace: "yes", sections: [] })).status).toBe(400);
  });

  it("variants and picks", async () => {
    const { call } = await setup();
    const v = await call("POST", "/api/variants", { stage: "music", name: "Deep house", file: "audio/a.wav", meta: { bpm: 120 } });
    expect(v.json.variant.id).toBe("deep-house");
    const picks = await call("PUT", "/api/picks", { lanes: { music: "deep-house" } });
    expect(picks.json.lanes).toEqual({ music: "deep-house" });
  });

  it("batches: send the tab's open notes once, then 409 when nothing is left", async () => {
    const { call } = await setup();
    const n = (await call("POST", "/api/notes", { stage: "picture", scope: "point", t: 1, text: "x" })).json.note;
    const b = await call("POST", "/api/batches", { stage: "picture" });
    expect(b.status).toBe(201);
    expect(b.json.batch).toMatchObject({ id: "b_1", noteIds: [n.id] });
    expect((await call("POST", "/api/batches", { stage: "picture" })).status).toBe(409);
    const latest = await call("GET", "/api/batches/latest");
    expect(latest.json.batch.id).toBe("b_1");
    expect(latest.json.notes[0].batch).toBe("b_1");
    expect((await call("GET", "/api/batches/b_9")).status).toBe(404);
  });

  it("a note sent, marked done and reopened goes in the next batch", async () => {
    const { call } = await setup();
    const n = (await call("POST", "/api/notes", { stage: "picture", scope: "point", t: 1, text: "x" })).json.note;
    expect((await call("POST", "/api/batches", { stage: "picture" })).json.batch.noteIds).toEqual([n.id]);
    await call("POST", "/api/replies", { replies: [{ id: n.id, reply: "Fixed", status: "done" }] });
    await call("PATCH", `/api/notes/${n.id}`, { status: "todo" });
    const again = await call("POST", "/api/batches", { stage: "picture" });
    expect(again.status).toBe(201);
    expect(again.json.batch).toMatchObject({ id: "b_2", noteIds: [n.id] });
  });

  it("two batch requests at once get different ids and split the notes", async () => {
    const { call } = await setup();
    await call("POST", "/api/notes", { stage: "picture", scope: "point", t: 1, text: "x" });
    await call("POST", "/api/notes", { stage: "music", scope: "whole", text: "y" });
    const [a, b] = await Promise.all([call("POST", "/api/batches", { stage: "picture" }), call("POST", "/api/batches", { stage: "music" })]);
    expect(new Set([a.json.batch.id, b.json.batch.id]).size).toBe(2);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/server`
Expected: FAIL with `Failed to resolve import "../../src/server/files.js"`.

- [ ] **Step 3: Implement**

`src/server/files.ts`

```ts
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { Readable } from "node:stream";
import type { Project, Script } from "../core/schema.js";

export const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
};

export function contentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Grab files the server itself writes: .rushes/grabs/<safe name>.png */
export const GRAB_PATH = /^\.rushes\/grabs\/[a-z0-9][a-z0-9_-]*\.png$/;

/** Every media path the project has registered. Only these (and grabs) may be served. */
export function registeredMedia(project: Project, script: Script): Set<string> {
  const files = new Set<string>();
  for (const v of project.videos) for (const ver of v.versions) files.add(ver.file);
  for (const l of project.lanes) for (const variant of l.variants) files.add(variant.file);
  for (const s of script.sections) for (const t of s.takes) files.add(t.file);
  return files;
}

/** Parse a single "bytes=a-b" range against a file size. Returns null for a missing or unusable range. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    // Suffix range: the last N bytes.
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

/**
 * Stream a file, honouring a byte Range so video can seek. Returns 404 JSON
 * when the file is missing, and 416 when the range can't be satisfied.
 */
export async function sendFile(absPath: string, rangeHeader: string | undefined, type = contentType(absPath)): Promise<Response> {
  let size: number;
  try {
    const info = await stat(absPath);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    return Response.json({ error: "missing_file", message: "That file isn't on disk any more" }, { status: 404 });
  }
  const headers: Record<string, string> = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-cache" };
  if (rangeHeader) {
    const range = parseRange(rangeHeader, size);
    if (!range) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    const stream = Readable.toWeb(createReadStream(absPath, { start: range.start, end: range.end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: { ...headers, "content-range": `bytes ${range.start}-${range.end}/${size}`, "content-length": String(range.end - range.start + 1) },
    });
  }
  const stream = Readable.toWeb(createReadStream(absPath)) as ReadableStream;
  return new Response(stream, { status: 200, headers: { ...headers, "content-length": String(size) } });
}

/** Resolve `rel` inside `dir`, or null if it would escape it. */
export function inside(dir: string, rel: string): string | null {
  const full = normalize(join(dir, rel));
  return full === dir || full.startsWith(dir.endsWith(sep) ? dir : dir + sep) ? full : null;
}
```

`src/server/app.ts`

```ts
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Store, ChangeEvent } from "../core/store.js";
import { RushesError, InvalidError, NotFoundError } from "../core/errors.js";
import { addVariant, addVersion } from "../core/project.js";
import { addTake, editSection, setSections } from "../core/script.js";
import { addNote, applyReply, applyUserEdit, filterNotes } from "../core/notes.js";
import { createBatch, latestBatch } from "../core/batches.js";
import { tabStates } from "../core/tabs.js";
import { fromManifestPath, toManifestPath } from "../core/paths.js";
import { probe } from "../core/media.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GRAB_PATH, contentType, inside, registeredMedia, sendFile } from "./files.js";
import type { CorruptEvent } from "./watch.js";
import { LaneStageSchema, SectionStatusSchema, StageSchema, BoxSchema, type Batch } from "../core/schema.js";

export const VERSION = "0.1.0";

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new InvalidError("Request body must be JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new InvalidError("Request body is invalid", parsed.error.issues);
  return parsed.data;
}

const t = z.number().nonnegative();

const NewNoteBody = z.object({
  stage: StageSchema,
  video: z.string().nullish(),
  version: z.string().nullish(),
  on: z.string().nullish(),
  scope: z.enum(["point", "range", "whole"]),
  t: t.nullish(),
  tOut: t.nullish(),
  frame: z.number().int().nonnegative().nullish(),
  text: z.string(),
  box: BoxSchema.nullish(),
  grab: z.string().nullish(),
});

const UserEditBody = z.object({
  text: z.string().optional(),
  box: BoxSchema.nullable().optional(),
  grab: z.string().nullable().optional(),
  scope: z.enum(["point", "range", "whole"]).optional(),
  t: t.nullable().optional(),
  tOut: t.nullable().optional(),
  status: z.enum(["todo", "done"]).optional(),
});

const RepliesBody = z.object({
  replies: z
    .array(
      z.object({
        id: z.string(),
        reply: z.string().optional(),
        status: z.enum(["todo", "done"]).optional(),
        fixT: t.nullable().optional(),
        fixVersion: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

const VersionBody = z.object({ video: z.string().min(1), file: z.string().min(1), note: z.string().optional() });
const VariantBody = z.object({
  stage: LaneStageSchema,
  lane: z.string().optional(),
  name: z.string().min(1),
  file: z.string().min(1),
  meta: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  cues: z.array(z.object({ name: z.string().min(1), t })).optional(),
});
const ScriptBody = z.object({
  wordsPerSecond: z.number().positive().optional(),
  replace: z.boolean().optional(),
  sections: z.array(z.object({ id: z.string().min(1).optional(), start: t, end: t, current: z.string() })),
});
const SectionEditBody = z.object({
  proposed: z.string().nullable().optional(),
  direction: z.string().optional(),
  status: SectionStatusSchema.optional(),
});
const TakeBody = z.object({ file: z.string().min(1) });
const PicksBody = z.object({ lanes: z.record(z.string(), z.string()).optional(), sections: z.record(z.string(), z.string()).optional() });
const BatchBody = z.object({ stage: StageSchema });

const NoteQuery = z.object({
  stage: StageSchema.optional(),
  status: z.enum(["todo", "done"]).optional(),
  batch: z.string().optional(),
  version: z.string().optional(),
});

const GrabBody = z.object({
  video: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  version: z.string().regex(/^v\d+$/),
  frame: z.number().int().nonnegative(),
  /** PNG bytes, base64, with or without a data: prefix. */
  png: z.string().min(1),
});

const MAX_GRAB_BYTES = 25 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Where the built dashboard lives: <package>/web-dist, next to dist/ and src/. */
export const DEFAULT_WEB_DIR = fileURLToPath(new URL("../../web-dist/", import.meta.url));

export interface AppOptions {
  /** Folder with the built dashboard (index.html + assets/). */
  webDir?: string;
  /** Called after POST /api/shutdown has replied. */
  onShutdown?: () => void;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

/** Hostname of "host[:port]" or a full origin URL, lowercased, or null when it doesn't parse. */
function hostnameOf(value: string, isUrl: boolean): string | null {
  try {
    return new URL(isUrl ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function createApp(store: Store, opts: AppOptions = {}): Hono {
  const webDir = opts.webDir ?? DEFAULT_WEB_DIR;
  const app = new Hono();
  // Every SSE client adds a change listener, so lift Node's default limit of ten.
  store.setMaxListeners(0);

  app.onError((err, c) => {
    if (err instanceof RushesError) return c.json({ error: err.code, message: err.message, ...err.detail }, err.status as 400);
    console.error(err);
    return c.json({ error: "internal", message: (err as Error).message }, 500);
  });

  // The server is for this machine only. Checking Host stops DNS rebinding;
  // requiring JSON and a local Origin on writes stops other websites posting
  // to it from the user's browser (a JSON content type forces a CORS preflight,
  // which this server never answers).
  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    const hostname = hostnameOf(host, false);
    if (!hostname || !LOCAL_HOSTS.has(hostname)) {
      return c.json({ error: "forbidden_host", message: `Rushes only answers requests to 127.0.0.1 or localhost, not "${host}"` }, 403);
    }
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const type = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (type !== "application/json") {
        return c.json({ error: "unsupported_media_type", message: "Requests that change data must send Content-Type: application/json" }, 415);
      }
      const origin = c.req.header("origin");
      if (origin !== undefined) {
        const from = hostnameOf(origin, true);
        if (!from || !LOCAL_HOSTS.has(from)) {
          return c.json({ error: "forbidden_origin", message: `Rushes doesn't accept changes from pages on "${origin}"` }, 403);
        }
      }
    }
    await next();
  });

  // ---- dashboard ----
  app.get("/", async (c) => {
    const index = join(webDir, "index.html");
    if (existsSync(index)) return c.html(await readFile(index, "utf8"));
    return c.html(`<!doctype html><title>Rushes</title><p>Rushes is running for <code>${escapeHtml(store.root)}</code>. The dashboard isn't built: run <code>npm run build</code>.</p>`);
  });

  app.get("/assets/*", async (c) => {
    const rel = decodeURIComponent(new URL(c.req.url).pathname.slice(1));
    const file = inside(webDir, rel);
    if (!file) throw new NotFoundError("asset", rel);
    const res = await sendFile(file, undefined, contentType(file));
    if (res.status === 404) throw new NotFoundError("asset", rel);
    res.headers.set("cache-control", "public, max-age=31536000, immutable");
    return res;
  });

  // ---- media: only files the project registered, plus its own grabs ----
  app.get("/media", async (c) => {
    const path = c.req.query("path") ?? "";
    const [project, script] = await Promise.all([store.read("project"), store.read("script")]);
    if (!registeredMedia(project, script).has(path) && !GRAB_PATH.test(path)) throw new NotFoundError("media", path);
    return sendFile(fromManifestPath(store.root, path), c.req.header("range"));
  });

  app.post("/api/grabs", async (c) => {
    const b = await body(c, GrabBody);
    const bytes = Buffer.from(b.png.replace(/^data:image\/png;base64,/, ""), "base64");
    if (bytes.length > MAX_GRAB_BYTES) throw new InvalidError(`Frame grab is over ${MAX_GRAB_BYTES / 1024 / 1024} MB`);
    if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new InvalidError("Frame grab must be a PNG");
    const grab = `.rushes/grabs/${b.video}_${b.version}_f${b.frame}.png`;
    await mkdir(join(store.dir, "grabs"), { recursive: true });
    await writeFile(fromManifestPath(store.root, grab), bytes);
    return c.json({ grab }, 201);
  });

  app.post("/api/shutdown", (c) => {
    if (opts.onShutdown) setImmediate(opts.onShutdown);
    return c.json({ ok: true, stopping: !!opts.onShutdown });
  });

  app.get("/api/health", (c) => c.json({ ok: true, app: "rushes", version: VERSION, root: store.root }));

  app.get("/api/state", async (c) => {
    const [project, script, notes, picks, batches] = await Promise.all([
      store.read("project"), store.read("script"), store.read("notes"), store.read("picks"), store.read("batches"),
    ]);
    return c.json({ project, script, notes, picks, batches, tabs: tabStates(project, script, notes) });
  });

  app.get("/api/tabs", async (c) => {
    const [project, script, notes] = await Promise.all([store.read("project"), store.read("script"), store.read("notes")]);
    return c.json({ tabs: tabStates(project, script, notes) });
  });

  // ---- notes ----
  app.get("/api/notes", async (c) => {
    const q = NoteQuery.safeParse(c.req.query());
    if (!q.success) throw new InvalidError("Query is invalid", q.error.issues);
    const { notes } = await store.read("notes");
    return c.json({ notes: filterNotes(notes, q.data) });
  });

  app.post("/api/notes", async (c) => {
    const b = await body(c, NewNoteBody);
    const { result } = await store.update("notes", (f) => addNote(f, { ...b, by: "user" }));
    return c.json({ note: result }, 201);
  });

  app.patch("/api/notes/:id", async (c) => {
    const b = await body(c, UserEditBody);
    const { result } = await store.update("notes", (f) => applyUserEdit(f, { id: c.req.param("id"), ...b }));
    return c.json({ note: result });
  });

  app.post("/api/replies", async (c) => {
    const b = await body(c, RepliesBody);
    const { result } = await store.update("notes", (f) => b.replies.map((r) => applyReply(f, r)));
    return c.json({ notes: result });
  });

  // ---- media ----
  app.post("/api/versions", async (c) => {
    const b = await body(c, VersionBody);
    const file = toManifestPath(store.root, b.file);
    const info = await probe(fromManifestPath(store.root, file));
    const { result } = await store.update("project", (p) => {
      const out = addVersion(p, { video: b.video, file, note: b.note, duration: info.duration, fps: info.fps });
      if (info.fps && p.videos.length === 1 && p.videos[0].versions.length === 1) p.fps = info.fps;
      return out;
    });
    return c.json(result, 201);
  });

  app.post("/api/variants", async (c) => {
    const b = await body(c, VariantBody);
    const { result } = await store.update("project", (p) => addVariant(p, { ...b, file: toManifestPath(store.root, b.file) }));
    return c.json(result, 201);
  });

  // ---- script ----
  app.get("/api/script", async (c) => c.json({ script: await store.read("script") }));

  app.put("/api/script", async (c) => {
    const b = await body(c, ScriptBody);
    const { result } = await store.update("script", (s) => {
      if (b.wordsPerSecond) s.wordsPerSecond = b.wordsPerSecond;
      return setSections(s, b.sections, { replace: b.replace });
    });
    return c.json({ sections: result });
  });

  app.patch("/api/script/:id", async (c) => {
    const b = await body(c, SectionEditBody);
    const { result } = await store.update("script", (s) => editSection(s, c.req.param("id"), b));
    return c.json({ section: result });
  });

  app.post("/api/script/:id/takes", async (c) => {
    const b = await body(c, TakeBody);
    const file = toManifestPath(store.root, b.file);
    const info = await probe(fromManifestPath(store.root, file));
    const { result } = await store.update("script", (s) => addTake(s, c.req.param("id"), { file, duration: info.duration }));
    return c.json({ take: result }, 201);
  });

  // ---- picks ----
  app.get("/api/picks", async (c) => c.json(await store.read("picks")));

  app.put("/api/picks", async (c) => {
    const b = await body(c, PicksBody);
    const { data } = await store.update("picks", (p) => {
      Object.assign(p.lanes, b.lanes ?? {});
      Object.assign(p.sections, b.sections ?? {});
    });
    return c.json(data);
  });

  // ---- batches ----
  // A batch touches two files (notes and batches), so batch creation runs one at a time.
  let batchQueue: Promise<unknown> = Promise.resolve();
  app.post("/api/batches", async (c) => {
    const { stage } = await body(c, BatchBody);
    const run = batchQueue.catch(() => undefined).then(async (): Promise<Batch> => {
      const [project, script, batches] = await Promise.all([store.read("project"), store.read("script"), store.read("batches")]);
      const { result } = await store.update("notes", (notes) => createBatch({ project, script, notes, batches }, stage));
      await store.update("batches", (f) => { f.batches.push(result); });
      return result;
    });
    batchQueue = run;
    return c.json({ batch: await run }, 201);
  });

  app.get("/api/batches/:id", async (c) => {
    const [batches, notes, script] = await Promise.all([store.read("batches"), store.read("notes"), store.read("script")]);
    const id = c.req.param("id");
    const batch = id === "latest" ? latestBatch(batches) : batches.batches.find((b) => b.id === id);
    if (!batch) throw new NotFoundError("batch", id);
    return c.json({
      batch,
      notes: notes.notes.filter((n) => batch.noteIds.includes(n.id)),
      sections: script.sections.filter((s) => batch.sectionIds.includes(s.id)),
    });
  });

  // ---- live updates ----
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const send = (e: ChangeEvent) => void stream.writeSSE({ event: "change", data: JSON.stringify(e) });
      const corrupt = (e: CorruptEvent) => void stream.writeSSE({ event: "corrupt", data: JSON.stringify(e) });
      store.on("change", send);
      store.on("corrupt", corrupt);
      stream.onAbort(() => {
        store.off("change", send);
        store.off("corrupt", corrupt);
      });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ root: store.root }) });
      while (!stream.aborted) await stream.sleep(15000).then(() => stream.writeSSE({ event: "ping", data: "" }));
    }),
  );

  return app;
}
```

`src/server/start.ts`

```ts
import { createServer, type Server } from "node:http";
import { mkdir, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { Store } from "../core/store.js";
import { createApp } from "./app.js";
import { removeLock, writeLock } from "./lock.js";
import { watchStore } from "./watch.js";

export const DEFAULT_PORT = 4317;

export interface Running {
  url: string;
  port: number;
  store: Store;
  close(): Promise<void>;
  /** Resolves once the server has closed, for any reason (close(), shutdown request or idle). */
  closed: Promise<void>;
}

export interface StartOptions {
  port?: number;
  host?: string;
  name?: string;
  /** Folder with the built dashboard. Defaults to the package's web-dist/. */
  webDir?: string;
  /** Close after this long with no requests and no open connections. Off by default. */
  idleMs?: number;
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((ok, fail) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      fail(e);
    };
    const onListening = () => {
      server.off("error", onError);
      const addr = server.address();
      ok(typeof addr === "object" && addr ? addr.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * Start the Rushes server for a project folder. Tries `port` and the next ten
 * ports; pass port 0 to let the OS choose (tests do).
 */
export async function startServer(rootDir: string, opts: StartOptions = {}): Promise<Running> {
  // The real path is the root everywhere (store, lock, health), so a symlinked path finds the same server.
  await mkdir(resolve(rootDir), { recursive: true });
  const root = await realpath(resolve(rootDir));
  const store = new Store(root);
  await store.init(opts.name ?? basename(root));
  let close: () => Promise<void> = async () => undefined;
  const app = createApp(store, { webDir: opts.webDir, onShutdown: () => void close() });
  const listener = getRequestListener(app.fetch);
  let lastRequest = Date.now();
  const server = createServer((req, res) => {
    lastRequest = Date.now();
    listener(req, res);
  });
  const host = opts.host ?? "127.0.0.1";
  const first = opts.port ?? DEFAULT_PORT;

  let port = -1;
  let lastError: unknown;
  for (let p = first; p <= (first === 0 ? 0 : first + 10); p++) {
    try {
      port = await listen(server, p, host);
      break;
    } catch (e) {
      lastError = e;
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    }
  }
  if (port < 0) throw new Error(`No free port from ${first} to ${first + 10}: ${(lastError as Error)?.message}`);

  let token: string | undefined;
  try {
    token = (await writeLock(root, port)).token;
  } catch (e) {
    // Another server owns this project, or the lock couldn't be written: don't leave a socket open.
    server.closeAllConnections?.();
    await new Promise<void>((ok) => server.close(() => ok()));
    throw e;
  }
  const url = `http://${host}:${port}`;
  const stopWatching = watchStore(store);
  let idleTimer: NodeJS.Timeout | undefined;
  let done: () => void = () => undefined;
  const closed = new Promise<void>((ok) => { done = ok; });
  let closing: Promise<void> | null = null;
  close = () => {
    closing ??= (async () => {
      clearTimeout(idleTimer);
      stopWatching();
      server.closeAllConnections?.();
      await new Promise<void>((ok) => server.close(() => ok()));
      await removeLock(root, token);
      done();
    })();
    return closing;
  };

  if (opts.idleMs && opts.idleMs > 0) {
    const idleMs = opts.idleMs;
    const tick = () => {
      server.getConnections((_err, open) => {
        if (open === 0 && Date.now() - lastRequest >= idleMs) void close();
        else idleTimer = setTimeout(tick, Math.max(50, idleMs / 4));
      });
    };
    idleTimer = setTimeout(tick, idleMs);
    idleTimer.unref?.();
  }
  return { url, port, store, close, closed };
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/server && npx tsc --noEmit && npx vitest run`
Expected: everything passes, including the full unit suite, and tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/server/files.ts src/server/app.ts src/server/start.ts test/server/files.test.ts test/server/app.test.ts
git commit -m "feat(server): stream registered media with byte ranges, save frame grabs, serve the dashboard"
```

---

### Task 5: Dashboard groundwork: web toolchain and pure helpers

**Files:**
- Create: `tsconfig.web.json`
- Create: `web/src/types.ts`
- Create: `web/src/lib.ts`
- Create: `test/web/lib.test.ts`

**Interfaces:**
- **Consumes:** type-only imports of `src/core/schema.ts` and `src/core/tabs.ts`.
- **Produces:**
  - `web/src/types.ts` re-exports the data types, plus `State`, the shape of `GET /api/state`.
  - `web/src/lib.ts` exports:
    - `fmt`, `frameAt`, `snap`, `stepFrame`;
    - `placeNote(note, version) -> {t, tOut, from}`, `noteTime`;
    - `fit`, `isChanged`, `latest`;
    - `BUILT`, `STAGE_NAMES`, `UNLOCK_HINT`;
    - `firstTab`, `boxFrom`.
  - `tsconfig.web.json` adds the web typecheck to `npm run typecheck`.

- [ ] **Step 1: Install the dashboard toolchain (devDependencies only)**

```bash
npm install -D preact@10.29.8 vite@8.3.2 @playwright/test@1.63.0 @fontsource/figtree@5.3.0 @fontsource/jetbrains-mono@5.3.0
```

Then set the `typecheck` script in `package.json` to:

```json
    "typecheck": "tsc --noEmit && tsc -p tsconfig.web.json",
```

Expected: `package.json` gains those five devDependencies and `dependencies` stays unchanged.

- [ ] **Step 2: Write the failing tests**

`test/web/lib.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { boxFrom, firstTab, fit, fmt, frameAt, noteTime, placeNote, snap, stepFrame } from "../../web/src/lib.js";
import type { Note, TabState } from "../../web/src/types.js";

const note = (over: Partial<Note>): Note => ({
  id: "n_1", stage: "picture", video: "hero", version: "v3", on: null, scope: "point", t: 12.4, tOut: null, frame: null,
  text: "x", box: null, grab: null, status: "todo", reply: "", fixT: null, fixVersion: null, batch: null,
  createdAt: "2026-10-02T00:00:00Z", by: "user", ...over,
});

describe("timecode", () => {
  it("formats minutes, seconds and hundredths", () => {
    expect(fmt(0)).toBe("0:00.00");
    expect(fmt(12.4)).toBe("0:12.40");
    expect(fmt(72.456)).toBe("1:12.46");
    expect(fmt(-3)).toBe("0:00.00");
  });
  it("finds frames and steps by one frame, clamped", () => {
    expect(frameAt(12.4, 60)).toBe(744);
    expect(stepFrame(12.4, 60, 1, 60)).toBeCloseTo(745 / 60, 6);
    expect(stepFrame(0, 30, -1, 10)).toBe(0);
    expect(stepFrame(9.99, 30, 5, 10)).toBe(10);
  });
  it("snaps a time to the start of its frame", () => {
    expect(snap(0.9666667, 30)).toBe(0.966667);
    expect(snap(1.01, 30)).toBe(1);
    expect(snap(12.4, 60)).toBe(12.4);
  });
  it("labels points, ranges and whole-track notes", () => {
    expect(noteTime(31.05, 33.1)).toBe("0:31.05–0:33.10");
    expect(noteTime(4.6, null)).toBe("0:04.60");
    expect(noteTime(null, null)).toBe("Whole");
  });
});

describe("placeNote", () => {
  it("leaves a note on the version being watched where it is", () => {
    expect(placeNote(note({}), "v3")).toEqual({ t: 12.4, tOut: null, from: null });
  });
  it("moves a fixed note from an older cut to where the fix landed, keeping a range's length", () => {
    const n = note({ version: "v2", t: 4.1, tOut: 5.1, scope: "range", fixT: 4.6, fixVersion: "v3" });
    const placed = placeNote(n, "v3");
    expect(placed.t).toBe(4.6);
    expect(placed.tOut).toBeCloseTo(5.6, 6);
    expect(placed.from).toBe("v2 at 0:04.10");
  });
  it("keeps an unfixed note from an older cut at its old time, and says where it's from", () => {
    expect(placeNote(note({ version: "v1", t: 2 }), "v3")).toEqual({ t: 2, tOut: null, from: "v1 at 0:02.00" });
  });
  it("has no time for a whole-track note", () => {
    expect(placeNote(note({ scope: "whole", t: null }), "v3")).toEqual({ t: null, tOut: null, from: null });
  });
});

describe("fit", () => {
  it("matches the server's thresholds", () => {
    expect(fit("one two three", 13, 2.6).state).toBe("ok");
    expect(fit("one two three four five six seven eight nine ten", 4.5, 2.6).state).toBe("tight");
    expect(fit("a b c d e f g h i j k l m n o p q r s t u v w", 8, 2.6).state).toBe("over");
  });
});

describe("firstTab", () => {
  const tabs = (unlocked: string[]): TabState[] =>
    (["script", "picture", "voice", "music", "sfx", "mix"] as const).map((stage) => ({ stage, unlocked: unlocked.includes(stage), todo: 0 }));
  it("prefers Picture, then the first unlocked tab, then Picture", () => {
    expect(firstTab(tabs(["script", "picture"]))).toBe("picture");
    expect(firstTab(tabs(["script"]))).toBe("script");
    expect(firstTab(tabs([]))).toBe("picture");
  });
});

describe("boxFrom", () => {
  it("normalises a drag in any direction and clamps it to the frame", () => {
    expect(boxFrom(100, 50, 300, 150, 400, 200)).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(boxFrom(300, 150, 100, 50, 400, 200)).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(boxFrom(-50, -50, 500, 300, 400, 200)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `npx vitest run test/web && npm run typecheck`
Expected: FAIL with `Failed to resolve import "../../web/src/lib.js"`.

- [ ] **Step 4: Implement**

`tsconfig.web.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["web/src"]
}
```

`web/src/types.ts`

```ts
// The server's data types, re-exported for the dashboard. Type-only, so nothing from src/ is bundled.
export type { Batch, Note, Picks, Project, Script, Section, Stage, Take, Variant, Version, Video } from "../../src/core/schema.js";
export type { TabState } from "../../src/core/tabs.js";

import type { BatchesFile, NotesFile, Picks, Project, Script } from "../../src/core/schema.js";
import type { TabState } from "../../src/core/tabs.js";

/** GET /api/state */
export interface State {
  project: Project;
  script: Script;
  notes: NotesFile;
  picks: Picks;
  batches: BatchesFile;
  tabs: TabState[];
}
```

`web/src/lib.ts`

```ts
// Pure helpers for the dashboard. No DOM, so they're unit-tested in Node.
import type { Note, Section, Stage, TabState, Video, Version } from "./types.js";

/** 72.4 -> "1:12.40" (minutes, seconds, hundredths). */
export function fmt(t: number): string {
  const safe = Math.max(0, t);
  const m = Math.floor(safe / 60);
  const s = (safe - m * 60).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
}

/** The frame showing at time t. */
export function frameAt(t: number, fps: number): number {
  return Math.round(t * fps);
}

/** t moved to the start of its frame, to the microsecond. */
export function snap(t: number, fps: number): number {
  return Math.round((frameAt(t, fps) / fps) * 1e6) / 1e6;
}

/** Time of the frame `n` steps from the one at t, clamped to [0, duration]. */
export function stepFrame(t: number, fps: number, n: number, duration: number): number {
  const frame = frameAt(t, fps) + n;
  return Math.min(Math.max(0, frame / fps), duration || Infinity);
}

/** Where a note sits in the version being watched, and where it came from if it was left on another one. */
export function placeNote(note: Note, version: string | null): { t: number | null; tOut: number | null; from: string | null } {
  if (note.t === null) return { t: null, tOut: null, from: null };
  if (!note.version || note.version === version) return { t: note.t, tOut: note.tOut, from: null };
  const from = `${note.version} at ${fmt(note.t)}`;
  if (note.fixT !== null && note.fixVersion === version) {
    const len = note.tOut !== null ? note.tOut - note.t : null;
    return { t: note.fixT, tOut: len !== null ? note.fixT + len : null, from };
  }
  return { t: note.t, tOut: note.tOut, from };
}

/** "1:12.40", "0:31.05–0:33.10" or "Whole". */
export function noteTime(t: number | null, tOut: number | null): string {
  if (t === null) return "Whole";
  return tOut !== null ? `${fmt(t)}–${fmt(tOut)}` : fmt(t);
}

export type FitState = "ok" | "tight" | "over";

/** Words, reading time and whether a line fits its slot. Matches the server's fit(). */
export function fit(text: string, slotSeconds: number, wordsPerSecond: number): { words: number; seconds: number; ratio: number; state: FitState } {
  const words = (text.trim().match(/\S+/g) ?? []).length;
  const seconds = words / wordsPerSecond;
  const ratio = slotSeconds > 0 ? seconds / slotSeconds : Infinity;
  return { words, seconds, ratio, state: ratio > 1 ? "over" : ratio > 0.8 ? "tight" : "ok" };
}

export function isChanged(s: Section): boolean {
  return s.proposed !== null && s.proposed.trim() !== s.current.trim();
}

export function latest(video: Video | undefined): Version | undefined {
  return video?.versions[video.versions.length - 1];
}

/** Is this stage built in this release of the dashboard? Later releases add the audio tabs. */
export const BUILT: Record<Stage, boolean> = { script: true, picture: true, voice: false, music: false, sfx: false, mix: false };

export const STAGE_NAMES: Record<Stage, string> = {
  script: "Script",
  picture: "Picture",
  voice: "Voiceover",
  music: "Music",
  sfx: "Sound effects",
  mix: "Mix",
};

/** One line saying what unlocks a tab. */
export const UNLOCK_HINT: Record<Stage, string> = {
  script: "It unlocks when your agent adds a script with rushes_set_script.",
  picture: "It unlocks when your agent adds a cut with rushes_add_version.",
  voice: "It unlocks when your agent adds a VO take with rushes_add_take.",
  music: "It unlocks when your agent adds a music bed with rushes_add_variant.",
  sfx: "It unlocks when your agent adds an SFX pass with rushes_add_variant.",
  mix: "It unlocks once there's a cut and at least one audio stage.",
};

/** Which tab to show first: the first unlocked one in workflow order, preferring Picture when it's there. */
export function firstTab(tabs: TabState[]): Stage {
  if (tabs.find((t) => t.stage === "picture")?.unlocked) return "picture";
  return tabs.find((t) => t.unlocked)?.stage ?? "picture";
}

/** Normalised box from two pointer positions inside an element of size w × h. */
export function boxFrom(x0: number, y0: number, x1: number, y1: number, w: number, h: number) {
  // Four decimals is finer than a pixel on any screen, and keeps notes.json readable.
  const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
  const ax = clamp(Math.min(x0, x1) / w);
  const ay = clamp(Math.min(y0, y1) / h);
  const bx = clamp(Math.max(x0, x1) / w);
  const by = clamp(Math.max(y0, y1) / h);
  return { x: ax, y: ay, w: Math.round((bx - ax) * 10000) / 10000, h: Math.round((by - ay) * 10000) / 10000 };
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run test/web && npm run typecheck && npx tsc --noEmit && npx vitest run`
Expected: everything passes, including the full unit suite, and tsc prints nothing.

- [ ] **Step 6: Commit**

```bash
git add tsconfig.web.json web/src/types.ts web/src/lib.ts test/web/lib.test.ts package.json package-lock.json
git commit -m "feat(web): dashboard toolchain and timecode, note-placement and fit helpers"
```

---

### Task 6: The dashboard: shell, Script tab and Picture tab, with browser tests

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `vite.config.ts`
- Create: `web/index.html`
- Create: `web/src/main.tsx`
- Create: `web/src/api.ts`
- Create: `web/src/useRushes.ts`
- Create: `web/src/styles.css`
- Create: `web/src/ui/Icon.tsx`
- Create: `web/src/ui/Notes.tsx`
- Create: `web/src/ui/Script.tsx`
- Create: `web/src/ui/Picture.tsx`
- Create: `web/src/ui/App.tsx`
- Create: `playwright.config.ts`
- Create: `e2e/fixture.ts`
- Create: `e2e/dashboard.spec.ts`
- Create: `e2e/fixtures/clip.mp4` (generated in Step 1)

**Interfaces:**
- **Consumes:**
  - Task 4's routes;
  - Task 5's `lib.ts` and `types.ts`;
  - the Plan 1 API for notes, replies, script, batches, versions and variants.
- **Produces:** the dashboard in `web-dist/`, built by `npm run build`:
  - `api` and `mediaUrl`;
  - `useRushes()` for live state;
  - `<Notes>`, `<Script>`, `<Picture>` and `<App>`.
- **Scripts:**
  - `build` = `tsc -p tsconfig.build.json && vite build`;
  - `test:e2e` = `npm run build && playwright test`.
- `files` now includes `web-dist`.

- [ ] **Step 1: Make the test clip and get Chromium**

```bash
mkdir -p e2e/fixtures
ffmpeg -y -f lavfi -i testsrc2=size=320x180:rate=30 -t 4 -c:v libx264 -crf 32 -pix_fmt yuv420p -movflags +faststart e2e/fixtures/clip.mp4
npx playwright install chromium
```

Expected: a clip of about 60 KB, 4 s at 30 fps. The tests rely on 30 fps and 4 s.

- [ ] **Step 2: Write the failing tests**

`playwright.config.ts`

```ts
import { defineConfig, devices } from "@playwright/test";

// Browser tests drive the built dashboard (npm run build first) against a real Rushes server per test.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  timeout: 30_000,
  use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
});
```

`e2e/fixture.ts`

```ts
import { test as base, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
const CLIP = fileURLToPath(new URL("./fixtures/clip.mp4", import.meta.url));

export interface Rushes {
  url: string;
  root: string;
  /** Call the server's API the way an agent would. */
  api<T = any>(method: string, path: string, body?: unknown): Promise<T>;
  /** Register the 4-second test clip as a new cut of "Hero". */
  addCut(note?: string): Promise<{ version: { id: string } }>;
}

/** Start `rushes serve` on a fresh project folder (with a space in its path) and wait for its URL. */
async function start(): Promise<{ child: ChildProcess; url: string; root: string; base: string }> {
  const base = await mkdtemp(join(tmpdir(), "rushes e2e "));
  const root = join(base, "My Film");
  await mkdir(join(root, "renders"), { recursive: true });
  const child = spawn(process.execPath, [CLI, "serve", root, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  const url = await new Promise<string>((ok, fail) => {
    let out = "";
    const timer = setTimeout(() => fail(new Error(`rushes serve didn't start:\n${out}`)), 10_000);
    child.stdout!.on("data", (d) => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) {
        clearTimeout(timer);
        ok(m[0]);
      }
    });
    child.stderr!.on("data", (d) => (out += d));
    child.on("exit", (code) => fail(new Error(`rushes serve exited (${code}):\n${out}`)));
  });
  return { child, url, root, base };
}

export const test = base.extend<{ rushes: Rushes }>({
  rushes: async ({}, use) => {
    const { child, url, root, base } = await start();
    let cuts = 0;
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(url + path, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
      return json;
    };
    const addCut = async (note?: string) => {
      cuts++;
      const file = `renders/hero_v${cuts}.mp4`;
      await copyFile(CLIP, join(root, file));
      return api("POST", "/api/versions", { video: "Hero", file, note });
    };
    await use({ url, root, api, addCut });
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    await rm(base, { recursive: true, force: true });
  },
});

/** Wait until the player has loaded the cut's metadata, so seeking works. */
export async function videoReady(page: Page): Promise<void> {
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
}

export { expect };
```

`e2e/dashboard.spec.ts`

```ts
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, videoReady } from "./fixture.js";

test("tabs stay locked until the project has something, then unlock live", async ({ page, rushes }) => {
  await page.goto(rushes.url);
  await expect(page.getByRole("tab", { name: /Picture/ })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByText("Nothing to review in Picture yet")).toBeVisible();
  await rushes.addCut("first cut");
  // No reload: the server's change event unlocks the tab.
  await expect(page.getByRole("tab", { name: /Picture/ })).toHaveAttribute("aria-disabled", "false");
  await page.getByRole("tab", { name: /Picture/ }).click();
  await videoReady(page);
  await expect(page.getByRole("combobox", { name: "Version" })).toHaveValue("v1");
});

test("a note at the playhead is saved and survives a reload", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  for (let i = 0; i < 15; i++) await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("Timecode")).toContainText("0:00.50");
  await page.keyboard.press("n");
  await page.keyboard.type("Logo lands a beat early.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note")).toHaveCount(1);
  await expect(page.locator(".note .t")).toHaveText("0:00.50");
  await page.reload();
  await expect(page.locator(".note .nx")).toHaveText("Logo lands a beat early.");
  const { notes } = await rushes.api("GET", "/api/notes?stage=picture");
  expect(notes[0]).toMatchObject({ scope: "point", t: 0.5, frame: 15, version: "v1", video: "hero", by: "user" });
});

test("In and Out make a range note, with a frame grab and a box attached", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("i");
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("o");
  await expect(page.locator(".bar .chipx")).toContainText("0:01.00–0:02.00");
  await page.keyboard.press("g");
  await expect(page.locator(".comp .chipx", { hasText: "Frame 60" })).toBeVisible();
  await page.keyboard.press("b");
  const frame = (await page.locator(".overlay").boundingBox())!;
  await page.mouse.move(frame.x + frame.width * 0.25, frame.y + frame.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(frame.x + frame.width * 0.75, frame.y + frame.height * 0.75, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(".comp .chipx", { hasText: "Box" })).toBeVisible();
  // Finishing the box must not start playback.
  expect(await page.locator("video").evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await page.keyboard.press("n");
  await page.keyboard.type("This scene is too fast.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note .t")).toHaveText("0:01.00–0:02.00");
  await expect(page.locator(".note img.thumb")).toBeVisible();
  const { notes } = await rushes.api("GET", "/api/notes?stage=picture");
  expect(notes[0]).toMatchObject({ scope: "range", t: 1, tOut: 2, grab: ".rushes/grabs/hero_v1_f60.png" });
  expect(notes[0].box.x).toBeCloseTo(0.25, 1);
  expect(notes[0].box.w).toBeCloseTo(0.5, 1);
  await access(join(rushes.root, ".rushes", "grabs", "hero_v1_f60.png"));
});

test("an agent's reply appears live, and ticking the circle marks a note done", async ({ page, rushes }) => {
  await rushes.addCut();
  const { note } = await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Too dark." });
  await page.goto(rushes.url);
  await expect(page.locator(".note")).toHaveCount(1);
  await rushes.api("POST", "/api/replies", { replies: [{ id: note.id, reply: "Lifted the shadows.", status: "done" }] });
  await expect(page.locator(".note .rp")).toHaveText("Lifted the shadows.");
  await expect(page.locator(".note")).toHaveClass(/done/);
  await page.getByRole("button", { name: "Reopen" }).click();
  await expect(page.locator(".note")).not.toHaveClass(/done/);
  const { notes } = await rushes.api("GET", "/api/notes");
  expect(notes[0].status).toBe("todo");
});

test("a note fixed in the newer cut shows where it landed and where it came from", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  const { note } = await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1.5, text: "Title card too short." });
  await rushes.addCut("held title");
  await rushes.api("POST", "/api/replies", { replies: [{ id: note.id, reply: "Held 0.6 s longer.", status: "done", fixT: 2.1, fixVersion: "v2" }] });
  await page.goto(rushes.url);
  await expect(page.getByRole("combobox", { name: "Version" })).toHaveValue("v2");
  await expect(page.locator(".note .t")).toHaveText("0:02.10");
  await expect(page.locator(".note .from")).toHaveText("from v1 at 0:01.50");
});

test("script edits are saved, marked as changed, and can be reverted", async ({ page, rushes }) => {
  await rushes.api("PUT", "/api/script", { sections: [{ start: 0, end: 13, current: "Your work lives on one laptop." }] });
  await page.goto(rushes.url);
  await expect(page.getByRole("tab", { name: /Script/ })).toHaveAttribute("aria-selected", "true");
  const box = page.getByLabel("Your version of s1");
  await box.fill("Your work lives on one machine.");
  await expect(page.locator(".srow")).toHaveClass(/changed/);
  await expect.poll(async () => (await rushes.api("GET", "/api/script")).script.sections[0].proposed).toBe("Your work lives on one machine.");
  await page.getByRole("button", { name: "Flag" }).click();
  await expect.poll(async () => (await rushes.api("GET", "/api/script")).script.sections[0].status).toBe("flagged");
  await page.getByRole("button", { name: "Revert" }).click();
  await expect(box).toHaveValue("Your work lives on one laptop.");
  await expect.poll(async () => (await rushes.api("GET", "/api/script")).script.sections[0].proposed).toBe(null);
});

test("Send to agent batches this tab's open notes and shows the prompt to paste", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Too dark." });
  await page.goto(rushes.url);
  await expect(page.getByRole("button", { name: /Send to agent/ })).toContainText("1");
  await page.getByRole("button", { name: /Send to agent/ }).click();
  await expect(page.getByRole("dialog", { name: "Sent to agent" })).toContainText("picture batch b_1");
  const { batch } = await rushes.api("GET", "/api/batches/latest");
  expect(batch.noteIds).toHaveLength(1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Send to agent/ }).click();
  await expect(page.getByRole("status")).toHaveText("Nothing open on Picture to send");
});

test("a tab that isn't built yet says so instead of showing an empty page", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.api("POST", "/api/variants", { stage: "music", name: "Deep house", file: "renders/hero_v1.mp4" });
  await page.goto(rushes.url);
  await page.getByRole("tab", { name: /Music/ }).click();
  await expect(page.getByText("This tab arrives in the next release", { exact: false })).toBeVisible();
});

test("a cut the browser can't play says so instead of showing a black frame", async ({ page, rushes }) => {
  await writeFile(join(rushes.root, "renders", "prores.mov"), Buffer.alloc(4096, 1));
  await rushes.api("POST", "/api/versions", { video: "Hero", file: "renders/prores.mov" });
  await page.goto(rushes.url);
  await expect(page.getByText("This file won't play in a browser", { exact: false })).toBeVisible();
});

test("an agent's change doesn't overwrite a line you're still typing", async ({ page, rushes }) => {
  await rushes.api("PUT", "/api/script", { sections: [{ id: "s1", start: 0, end: 13, current: "First line." }] });
  await page.goto(rushes.url);
  const box = page.getByLabel("Your version of s1");
  await box.click();
  await box.press("End");
  await page.keyboard.type(" Still typing");
  await rushes.api("PUT", "/api/script", { sections: [{ id: "s1", start: 0, end: 13, current: "The agent's new line." }] });
  await expect(page.locator(".srow .cur")).toHaveText("The agent's new line.");
  await expect(box).toHaveValue("First line. Still typing");
});

test("a broken hand edit shows a banner naming the file", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  await writeFile(join(rushes.root, ".rushes", "picks.json"), "{ broken");
  await expect(page.getByText("picks.json has an error", { exact: false })).toBeVisible();
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `npm run build && npx playwright test`
Expected: FAIL: the browser tests can't find the tabs, because GET / still serves the "dashboard isn't built" placeholder.

- [ ] **Step 4: Implement**

`package.json`

```json
{
  "name": "rushes",
  "version": "0.1.0",
  "description": "A local review desk for video made with AI agents: timecoded notes, script edits and audio picks your agent can read and act on.",
  "type": "module",
  "license": "MIT",
  "author": "Red Morley Hewitt",
  "repository": "github:iamredmh/rushes",
  "bin": {
    "rushes": "dist/cli/index.js"
  },
  "files": [
    "dist",
    "web-dist",
    "skills",
    "AGENTS.md"
  ],
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json && vite build",
    "typecheck": "tsc --noEmit && tsc -p tsconfig.web.json",
    "test": "vitest run",
    "rushes": "tsx src/cli/index.ts",
    "prepare": "npm run build",
    "test:e2e": "npm run build && playwright test"
  },
  "dependencies": {
    "@hono/node-server": "^2.1.3",
    "@modelcontextprotocol/sdk": "^1.31.0",
    "hono": "^4.12.0",
    "zod": "^4.1.0"
  },
  "devDependencies": {
    "@fontsource/figtree": "^5.3.0",
    "@fontsource/jetbrains-mono": "^5.3.0",
    "@playwright/test": "^1.63.0",
    "@types/node": "^22.10.0",
    "preact": "^10.29.8",
    "tsx": "^4.20.0",
    "typescript": "^5.9.3",
    "vite": "^8.3.2",
    "vitest": "^5.0.0"
  }
}
```

`.gitignore`

```
node_modules/
dist/
coverage/
.DS_Store
*.log
.rushes/
web-dist/
test-results/
playwright-report/
```

`vite.config.ts`

```ts
import { defineConfig } from "vite";

// The dashboard is plain Preact, bundled into web-dist/ and served by the Rushes server.
export default defineConfig({
  root: "web",
  base: "/",
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  build: { outDir: "../web-dist", emptyOutDir: true, assetsDir: "assets", sourcemap: false },
});
```

`web/index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Rushes</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='6' fill='%237c93ff'/%3E%3Cpath d='M9 7v10l8-5z' fill='%230b1026'/%3E%3C/svg%3E" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/src/main.tsx`

```tsx
import { render } from "preact";
import "@fontsource/figtree/400.css";
import "@fontsource/figtree/500.css";
import "@fontsource/figtree/600.css";
import "@fontsource/figtree/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles.css";
import { App } from "./ui/App.js";

render(<App />, document.getElementById("app")!);
```

`web/src/api.ts`

```ts
// Talks to the Rushes server this page was served from. Every write sends JSON, as the server requires.
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, json.error ?? "error", json.message ?? `Request failed (${res.status})`);
  return json as T;
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => call<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => call<T>("PATCH", path, body),
};

/** URL the browser can load a registered media file (or grab) from. */
export function mediaUrl(path: string): string {
  return `/media?path=${encodeURIComponent(path)}`;
}
```

`web/src/useRushes.ts`

```ts
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import type { State } from "./types.js";

export interface Live {
  state: State | null;
  /** Set when the server can't be reached or a data file is broken. */
  problem: string | null;
  /** Fetch the latest state now (after a write the page made itself). */
  refresh(): Promise<void>;
}

/** The project's state, kept current from the server's change events. */
export function useRushes(): Live {
  const [state, setState] = useState<State | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const refresh = async () => {
    try {
      setState(await api.get<State>("/api/state"));
      setProblem(null);
    } catch (e) {
      setProblem((e as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
    const events = new EventSource("/api/events");
    events.addEventListener("change", () => {
      // Several files often change together; fetch once.
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void refresh(), 40);
    });
    events.addEventListener("corrupt", (e) => {
      const { file } = JSON.parse((e as MessageEvent).data) as { file: string };
      setProblem(`${file} has an error and wasn't loaded. Fix or restore it, and Rushes will pick it up.`);
    });
    events.onerror = () => setProblem("Lost touch with the Rushes server. Retrying…");
    events.onopen = () => void refresh();
    return () => {
      events.close();
      clearTimeout(timer.current);
    };
  }, []);

  return { state, problem, refresh };
}
```

`web/src/styles.css`

```css
/* Rushes visual system (spec section 10). Dark ground for judging picture, one accent, status as marks. */
:root {
  color-scheme: dark;
  --bg: #0c0d0f;
  --app: #141518;
  --raised: #1c1e22;
  --hover: #25282d;
  --press: #2d3036;
  --line: #26282d;
  --line-2: #34373d;
  --text: #eeeef0;
  --text-2: #a3a6ad;
  --text-3: #70737a;
  --accent: #7c93ff;
  --accent-2: #9eaeff;
  --on-accent: #0b1026;
  --accent-soft: rgba(124, 147, 255, 0.14);
  --todo: #f5b740;
  --todo-soft: rgba(245, 183, 64, 0.14);
  --done: #4cc38a;
  --done-soft: rgba(76, 195, 138, 0.14);
  --over: #f07167;
  --sans: "Figtree", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
  --r: 10px;
  --r-lg: 14px;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; background: var(--bg); height: 100%; }
body { color: var(--text); font: 15px/1.5 var(--sans); -webkit-font-smoothing: antialiased; }
button, input, textarea, select { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
svg.ic { width: 18px; height: 18px; stroke: currentColor; fill: none; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; flex: none; display: block; }
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.sp { flex: 1; }

/* controls */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 36px; padding: 0 14px; border-radius: var(--r); border: 0; background: var(--raised); color: var(--text); font-weight: 500; font-size: 14px; cursor: pointer; white-space: nowrap; transition: background 0.12s; }
.btn:hover { background: var(--hover); }
.btn:active { background: var(--press); }
.btn.primary { background: var(--accent); color: var(--on-accent); font-weight: 600; }
.btn.primary:hover { background: var(--accent-2); }
.btn.ghost { background: transparent; color: var(--text-2); }
.btn.ghost:hover { background: var(--raised); color: var(--text); }
.ib { width: 36px; padding: 0; }
.ib.sm { width: 32px; height: 32px; }
.ib[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-2); }
.count { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; font: 600 12px/20px var(--sans); text-align: center; background: var(--on-accent); color: var(--accent-2); }
.seg { display: inline-flex; background: var(--app); border-radius: var(--r); padding: 3px; gap: 2px; }
.seg button { border: 0; background: transparent; height: 30px; padding: 0 12px; border-radius: 8px; font-size: 13.5px; font-weight: 500; color: var(--text-2); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.seg button:hover { color: var(--text); }
.seg button[aria-pressed="true"] { background: var(--raised); color: var(--text); }
.seg .n { color: var(--text-3); font-variant-numeric: tabular-nums; }
.sel { appearance: none; display: inline-flex; align-items: center; background: transparent; border: 0; border-radius: var(--r); height: 32px; padding: 0 10px; font-size: 14px; font-weight: 500; color: var(--text-2); cursor: pointer; }
.sel:hover { background: var(--raised); color: var(--text); }
.sel option { background: var(--raised); color: var(--text); }

/* tooltips */
[data-tip] { position: relative; }
[data-tip]::after { content: attr(data-tip); position: absolute; left: 50%; bottom: calc(100% + 8px); transform: translateX(-50%) translateY(2px); background: #000; color: #fff; font: 500 12.5px/1 var(--sans); padding: 7px 9px; border-radius: 7px; white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity 0.12s, transform 0.12s; z-index: 30; }
[data-tip]:hover::after, [data-tip]:focus-visible::after { opacity: 1; transform: translateX(-50%); }
.tip-below[data-tip]::after { bottom: auto; top: calc(100% + 8px); }

/* frame */
.shell { min-height: 100%; display: flex; flex-direction: column; }
.head { display: flex; align-items: center; gap: 14px; padding: 14px 20px; flex-wrap: wrap; }
.logo { width: 28px; height: 28px; border-radius: 8px; background: var(--accent); display: grid; place-items: center; color: var(--on-accent); }
.logo svg { width: 14px; height: 14px; fill: currentColor; stroke: none; }
.crumb { display: flex; align-items: center; gap: 4px; font-weight: 600; font-size: 15px; }
.crumb .slash { color: var(--text-3); }
.tabs { display: flex; gap: 4px; padding: 0 14px; border-bottom: 1px solid var(--line); overflow-x: auto; scrollbar-width: none; }
.tab { border: 0; background: transparent; display: flex; align-items: center; gap: 8px; padding: 12px 14px 13px; color: var(--text-2); font-weight: 500; font-size: 14.5px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; border-radius: 8px 8px 0 0; }
.tab:hover { color: var(--text); background: rgba(255, 255, 255, 0.02); }
.tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
.tab .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--todo); }
.tab[aria-disabled="true"] { color: #4c4f56; cursor: default; }
.tab[aria-disabled="true"]:hover { background: transparent; }
.tab .lk { width: 14px; height: 14px; }
.banner { display: flex; gap: 10px; align-items: center; margin: 12px 20px 0; padding: 10px 14px; border-radius: var(--r); background: var(--todo-soft); color: var(--todo); font-size: 14px; }
.toast { position: fixed; left: 50%; top: 18px; transform: translateX(-50%); background: var(--raised); color: var(--text); padding: 10px 14px; border-radius: var(--r); font-size: 14px; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5); z-index: 40; display: flex; gap: 8px; align-items: center; }
.pop { position: absolute; right: 20px; top: 62px; width: min(460px, calc(100% - 40px)); background: var(--raised); border-radius: var(--r-lg); padding: 16px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55); z-index: 40; display: grid; gap: 12px; }
.pop pre { margin: 0; background: var(--bg); border-radius: var(--r); padding: 12px 14px; font: 13px/1.6 var(--mono); white-space: pre-wrap; color: var(--text); }
.pop h3 { margin: 0; font-size: 15px; font-weight: 600; }
.keys { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; font-size: 14px; color: var(--text-2); }
kbd { font: 500 12px var(--mono); background: var(--bg); border-radius: 6px; padding: 3px 7px; color: var(--text); box-shadow: inset 0 -1px 0 var(--line-2); }
.body { padding: 24px; flex: 1; }
.col { max-width: 1000px; margin: 0 auto; display: grid; gap: 16px; }
.empty { max-width: 420px; margin: 12vh auto 0; text-align: center; display: grid; gap: 10px; justify-items: center; color: var(--text-2); }
.empty svg.ic { width: 32px; height: 32px; color: var(--text-3); }
.empty h2 { margin: 0; font-size: 18px; color: var(--text); font-weight: 600; }
.empty p { margin: 0; }

/* player */
.split { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 20px; align-items: stretch; }
.stack { display: grid; gap: 14px; align-content: start; }
.frame { position: relative; aspect-ratio: 16 / 9; max-width: 100%; border-radius: var(--r-lg); overflow: hidden; background: #000; }
.frame video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
.frame .overlay { position: absolute; inset: 0; }
.frame .overlay.drawing { cursor: crosshair; }
.frame .bx { position: absolute; border: 2px solid var(--todo); border-radius: 6px; pointer-events: none; }
.frame .bx.saved { border-color: var(--accent); border-style: dashed; }
.frame .msg { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; padding: 24px; color: var(--text-2); }
.tcover { position: absolute; right: 12px; bottom: 10px; font: 500 12px var(--mono); color: #d7dae0; background: rgba(0, 0, 0, 0.6); padding: 4px 8px; border-radius: 6px; pointer-events: none; }
.bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tc { font: 500 17px var(--mono); letter-spacing: -0.01em; padding: 0 8px; }
.tc small { font-size: 13px; color: var(--text-3); margin-left: 4px; }
.vsep { width: 1px; height: 20px; background: var(--line-2); margin: 0 6px; }
.rng { font: 500 13px var(--mono); color: var(--todo); padding: 0 4px; }
.track { position: relative; height: 40px; border-radius: var(--r); background: var(--raised); cursor: pointer; }
.playhead { position: absolute; top: -5px; bottom: -5px; width: 2px; background: var(--text); border-radius: 2px; z-index: 4; pointer-events: none; }
.playhead::before { content: ""; position: absolute; top: -4px; left: -4px; width: 10px; height: 10px; border-radius: 50%; background: var(--text); }
.mk { position: absolute; top: 50%; width: 10px; height: 10px; border-radius: 50%; transform: translate(-50%, -50%); z-index: 3; box-shadow: 0 0 0 2px var(--raised); }
.mk.todo { background: var(--todo); }
.mk.done { background: var(--done); }
.span { position: absolute; top: 4px; bottom: 4px; border-radius: 7px; z-index: 2; pointer-events: none; }
.span.todo { background: var(--todo-soft); box-shadow: inset 0 0 0 1px rgba(245, 183, 64, 0.5); }
.span.done { background: var(--done-soft); box-shadow: inset 0 0 0 1px rgba(76, 195, 138, 0.45); }
.span.live { background: rgba(124, 147, 255, 0.18); box-shadow: inset 0 0 0 1.5px var(--accent); }
.ends { display: flex; justify-content: space-between; font: 12px var(--mono); color: var(--text-3); margin-top: -6px; }

/* notes */
.panel { background: var(--raised); border-radius: var(--r-lg); display: flex; flex-direction: column; min-height: 0; }
.side { height: 0; min-height: 100%; }
.ph { display: flex; align-items: center; gap: 10px; padding: 14px 16px 10px; }
.ph h3 { margin: 0; font-size: 16px; font-weight: 600; }
.list { flex: 1; min-height: 0; overflow: auto; padding: 4px 8px; }
.list .none { color: var(--text-3); padding: 12px 8px; font-size: 14px; }
.note { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 2px 8px; padding: 10px 8px; border-radius: var(--r); }
.note:hover { background: var(--hover); }
.chk { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--todo); background: transparent; cursor: pointer; margin-top: 1px; display: grid; place-items: center; padding: 0; }
.chk svg.ic { width: 12px; height: 12px; stroke: var(--app); stroke-width: 3; opacity: 0; }
.note.done .chk { background: var(--done); border-color: var(--done); }
.note.done .chk svg.ic { opacity: 1; }
.nt { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.nt .t { font: 500 13px var(--mono); color: var(--accent-2); cursor: pointer; background: none; border: 0; padding: 0; }
.nt .from { font-size: 12.5px; color: var(--text-3); }
.nx { grid-column: 2; font-size: 14.5px; color: var(--text); line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
.note.done .nx { color: var(--text-3); }
.rp { grid-column: 2; display: flex; gap: 6px; align-items: flex-start; font-size: 13.5px; color: var(--text-2); margin-top: 4px; }
.rp svg.ic { width: 15px; height: 15px; color: var(--done); margin-top: 2px; }
.att { grid-column: 2; display: flex; gap: 8px; margin-top: 6px; }
.thumb { width: 96px; aspect-ratio: 16 / 9; border-radius: 6px; object-fit: cover; background: #000; }
.comp { padding: 12px; display: grid; gap: 10px; border-top: 1px solid var(--line); }
.comp .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.input { width: 100%; background: var(--app); border: 1px solid transparent; border-radius: var(--r); padding: 10px 12px; color: var(--text); font-size: 14.5px; resize: none; min-height: 44px; }
.input:focus { border-color: var(--accent); outline: none; }
.input::placeholder { color: var(--text-3); }
.cbox { position: relative; }
.cbox .input { padding-right: 48px; }
.cbox .send { position: absolute; right: 6px; bottom: 6px; }
.chipx { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 6px 0 10px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-2); font-size: 13px; font-weight: 500; }
.chipx button { border: 0; background: transparent; color: inherit; cursor: pointer; padding: 2px; display: grid; }
.chipx svg.ic { width: 14px; height: 14px; }

/* script */
.shead { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.shead h2 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
.shead .meta { color: var(--text-3); font-size: 14px; }
.sgrid { display: grid; grid-template-columns: 84px minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.scols { padding: 0 20px; color: var(--text-3); font-size: 13px; font-weight: 500; }
.srow { background: var(--raised); border-radius: var(--r-lg); padding: 18px 20px; display: grid; gap: 14px; box-shadow: inset 0 0 0 1px transparent; transition: box-shadow 0.12s; }
.srow.changed { box-shadow: inset 0 0 0 1.5px var(--todo); }
.when { display: grid; gap: 6px; font: 500 13px var(--mono); color: var(--text-2); }
.when b { font: 600 15px var(--sans); color: var(--text); }
.stat { display: inline-flex; align-items: center; gap: 6px; font: 500 12.5px var(--sans); color: var(--text-3); }
.stat i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.cur { font-size: 16px; line-height: 1.6; color: var(--text-2); padding-top: 9px; white-space: pre-wrap; }
.srow textarea { min-height: 84px; font-size: 16px; line-height: 1.6; overflow: hidden; }
.sfoot { display: grid; grid-template-columns: 84px minmax(0, 1fr) auto; gap: 16px; align-items: center; }
.fit { height: 6px; border-radius: 3px; background: var(--app); position: relative; overflow: hidden; cursor: help; }
.fit i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; background: var(--done); }
.fit.tight i { background: var(--todo); }
.fit.over i { background: var(--over); }
.sact { display: flex; gap: 6px; align-items: center; }
.dirin { background: var(--app); border: 1px solid transparent; border-radius: var(--r); height: 36px; padding: 0 12px; font-size: 14px; width: 100%; }
.dirin:focus { border-color: var(--accent); outline: none; }
.dirin::placeholder { color: var(--text-3); }
.ib.okd[aria-pressed="true"] { background: var(--done-soft); color: var(--done); }
.ib.flagd[aria-pressed="true"] { background: var(--todo-soft); color: var(--todo); }

@media (max-width: 1000px) {
  .split { grid-template-columns: minmax(0, 1fr); }
  .side { height: auto; min-height: 480px; }
}
@media (max-width: 680px) {
  .body { padding: 16px; }
  .head { padding: 12px 14px; }
  .sgrid, .sfoot { grid-template-columns: minmax(0, 1fr); }
  .scols { display: none; }
  .when { grid-auto-flow: column; justify-content: start; align-items: center; gap: 12px; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
```

`web/src/ui/Icon.tsx`

```tsx
// Outline icons, drawn on a 24px grid. One set for the whole dashboard.
const PATHS: Record<string, string> = {
  chev: '<path d="M6 9l6 6 6-6"/>',
  kbd: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h1M10.5 10h1M14.5 10h1M8 14h8"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  script: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  zap: '<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>',
  sliders: '<path d="M5 21v-7M5 10V3M12 21v-9M12 8V3M19 21v-5M19 12V3M2 14h6M9 8h6M16 16h6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  prev: '<path d="M15 6l-6 6 6 6"/>',
  next: '<path d="M9 6l6 6-6 6"/>',
  in: '<path d="M10 5H6v14h4"/><path d="M14 12h6M17 9l3 3-3 3"/>',
  out: '<path d="M14 5h4v14h-4"/><path d="M4 12h6M7 9l3 3-3 3"/>',
  box: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  send: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  reply: '<path d="M5 4v7a4 4 0 0 0 4 4h11"/><path d="M16 11l4 4-4 4"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  alert: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17h.01"/>',
};

export function Icon({ name, class: cls }: { name: keyof typeof PATHS | string; class?: string }) {
  return (
    <svg
      class={`ic${cls ? ` ${cls}` : ""}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: PATHS[name] ?? "" }}
    />
  );
}

export const STAGE_ICONS = { script: "script", picture: "film", voice: "mic", music: "music", sfx: "zap", mix: "sliders" } as const;
```

`web/src/ui/Notes.tsx`

```tsx
import type { ComponentChildren, RefObject } from "preact";
import { useState } from "preact/hooks";
import { api, mediaUrl } from "../api.js";
import { noteTime, placeNote } from "../lib.js";
import type { Note } from "../types.js";
import { Icon } from "./Icon.js";

type Filter = "all" | "todo" | "done";

export interface NotesProps {
  /** This tab's notes (already narrowed to the video being watched, where that applies). */
  notes: Note[];
  /** The version being watched, so notes from older cuts can be placed. */
  version: string | null;
  placeholder: string;
  /** Chips shown above the note box (a box or a frame grab waiting to be attached). */
  attachments?: ComponentChildren;
  inputRef?: RefObject<HTMLTextAreaElement>;
  onAdd(text: string): Promise<void>;
  onSeek?(t: number, note: Note): void;
  onChanged(): void;
}

/** The notes column used on every tab: list, filter, done circles and the note box. */
export function Notes({ notes, version, placeholder, attachments, inputRef, onAdd, onSeek, onChanged }: NotesProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const todo = notes.filter((n) => n.status === "todo").length;
  const placed = notes
    .map((n) => ({ n, at: placeNote(n, version) }))
    .filter(({ n }) => filter === "all" || n.status === filter)
    .sort((a, b) => (a.at.t ?? -1) - (b.at.t ?? -1));

  const toggle = async (n: Note) => {
    await api.patch(`/api/notes/${n.id}`, { status: n.status === "done" ? "todo" : "done" });
    onChanged();
  };

  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await onAdd(value);
      setText("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside class="panel side" aria-label="Notes">
      <div class="ph">
        <h3>Notes</h3>
        <span class="sp" />
        <div class="seg" role="group" aria-label="Filter notes">
          {(["all", "todo", "done"] as const).map((f) => (
            <button aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f === "todo" ? "To do" : "Done"}
              {f === "todo" && todo > 0 && <span class="n">{todo}</span>}
            </button>
          ))}
        </div>
      </div>
      <div class="list">
        {placed.length === 0 && <div class="none">{filter === "all" ? "No notes yet." : "Nothing here."}</div>}
        {placed.map(({ n, at }) => (
          <div class={`note${n.status === "done" ? " done" : ""}`} data-note={n.id}>
            <button class="chk" aria-label={n.status === "done" ? "Reopen" : "Mark done"} title={n.status === "done" ? "Reopen" : "Mark done"} onClick={() => void toggle(n)}>
              <Icon name="check" />
            </button>
            <div class="nt">
              <button class="t" onClick={() => at.t !== null && onSeek?.(at.t, n)}>{noteTime(at.t, at.tOut)}</button>
              {at.from && <span class="from">from {at.from}</span>}
            </div>
            <div class="nx">{n.text}</div>
            {n.grab && (
              <div class="att">
                <img class="thumb" src={mediaUrl(n.grab)} alt="Frame grab" />
              </div>
            )}
            {n.reply && (
              <div class="rp">
                <Icon name="reply" />
                <span>{n.reply}</span>
              </div>
            )}
          </div>
        ))}
      </div>
      <div class="comp">
        {attachments && <div class="row">{attachments}</div>}
        <div class="cbox">
          <textarea
            ref={inputRef}
            class="input"
            rows={2}
            aria-label="New note"
            placeholder={placeholder}
            value={text}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
              if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
            }}
          />
          <button class="btn primary ib sm send" data-tip="Add note  ↵" aria-label="Add note" onClick={() => void submit()}>
            <Icon name="send" />
          </button>
        </div>
      </div>
    </aside>
  );
}
```

`web/src/ui/Script.tsx`

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api } from "../api.js";
import { fit, fmt, isChanged } from "../lib.js";
import type { Script as ScriptData, Section } from "../types.js";
import { Icon } from "./Icon.js";

const STATUS = {
  approved: { color: "var(--done)", label: "Approved" },
  flagged: { color: "var(--todo)", label: "Flagged" },
  draft: { color: "var(--text-3)", label: "Draft" },
} as const;

const SAVE_AFTER_MS = 500;

/** Run `fn` once input has paused for `ms`; flush() runs it now. */
function useDebounced(fn: () => void, ms: number) {
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    schedule() {
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => latest.current(), ms);
    },
    flush() {
      if (timer.current === undefined) return;
      clearTimeout(timer.current);
      timer.current = undefined;
      latest.current();
    },
  };
}

function Row({ section, wps, onChanged }: { section: Section; wps: number; onChanged(): void }) {
  const [text, setText] = useState(section.proposed ?? section.current);
  const [direction, setDirection] = useState(section.direction);
  const editing = useRef(false);
  const area = useRef<HTMLTextAreaElement>(null);

  // The agent changed the line, or another window did: follow it unless you're mid-edit.
  useEffect(() => {
    if (!editing.current) setText(section.proposed ?? section.current);
  }, [section.proposed, section.current]);
  useEffect(() => {
    if (!editing.current) setDirection(section.direction);
  }, [section.direction]);

  // Grow the box to fit its text.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);

  const patch = async (body: Record<string, unknown>) => {
    await api.patch(`/api/script/${encodeURIComponent(section.id)}`, body);
    onChanged();
  };
  const saveText = useDebounced(() => {
    editing.current = false;
    void patch({ proposed: text.trim() === section.current.trim() ? null : text });
  }, SAVE_AFTER_MS);
  const saveDirection = useDebounced(() => {
    editing.current = false;
    void patch({ direction });
  }, SAVE_AFTER_MS);

  const slot = section.end - section.start;
  const f = fit(text, slot, wps);
  const changed = text.trim() !== section.current.trim();
  const status = STATUS[section.status];

  return (
    <div class={`srow${changed ? " changed" : ""}`} data-section={section.id}>
      <div class="sgrid">
        <div class="when">
          <b>{section.id.toUpperCase()}</b>
          <span>{fmt(section.start).replace(/\.\d+$/, "")}–{fmt(section.end).replace(/\.\d+$/, "")}</span>
          <span class="stat"><i style={{ background: status.color }} />{status.label}</span>
        </div>
        <div class="cur">{section.current}</div>
        <textarea
          ref={area}
          class="input"
          aria-label={`Your version of ${section.id}`}
          value={text}
          onInput={(e) => {
            editing.current = true;
            setText((e.target as HTMLTextAreaElement).value);
            saveText.schedule();
          }}
          onBlur={() => saveText.flush()}
        />
      </div>
      <div class="sfoot">
        <div class={`fit${f.state === "ok" ? "" : ` ${f.state}`}`} title={`${f.words} words · ${f.seconds.toFixed(1)} s of ${slot.toFixed(1)} s`}>
          <i style={{ width: `${Math.min(100, f.ratio * 100)}%` }} />
        </div>
        <input
          class="dirin"
          placeholder="Direction"
          aria-label={`Direction for ${section.id}`}
          value={direction}
          onInput={(e) => {
            editing.current = true;
            setDirection((e.target as HTMLInputElement).value);
            saveDirection.schedule();
          }}
          onBlur={() => saveDirection.flush()}
        />
        <div class="sact">
          {changed && (
            <button
              class="btn ghost ib"
              data-tip="Revert to current"
              aria-label="Revert"
              onClick={() => {
                setText(section.current);
                void patch({ proposed: null });
              }}
            >
              <Icon name="undo" />
            </button>
          )}
          <button
            class={`btn ib flagd${section.status === "flagged" ? "" : " ghost"}`}
            data-tip={section.status === "flagged" ? "Unflag" : "Flag"}
            aria-label="Flag"
            aria-pressed={section.status === "flagged"}
            onClick={() => void patch({ status: section.status === "flagged" ? "draft" : "flagged" })}
          >
            <Icon name="flag" />
          </button>
          <button
            class="btn ib okd"
            data-tip={section.status === "approved" ? "Unapprove" : "Approve"}
            aria-label="Approve"
            aria-pressed={section.status === "approved"}
            onClick={() => void patch({ status: section.status === "approved" ? "draft" : "approved" })}
          >
            <Icon name="check" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** The VO script: the agent's current line beside your version, one row per section. */
export function Script({ script, onChanged }: { script: ScriptData; onChanged(): void }) {
  const changed = script.sections.filter(isChanged).length;
  return (
    <div class="col">
      <div class="shead">
        <h2>Script</h2>
        <span class="meta">
          {script.sections.length} section{script.sections.length === 1 ? "" : "s"} · {changed} changed
        </span>
      </div>
      <div class="sgrid scols"><span /><span>Current</span><span>Yours</span></div>
      <div style={{ display: "grid", gap: "12px" }}>
        {script.sections.map((s) => <Row key={s.id} section={s} wps={script.wordsPerSecond} onChanged={onChanged} />)}
      </div>
    </div>
  );
}
```

`web/src/ui/Picture.tsx`

```tsx
import { useEffect, useRef, useState } from "preact/hooks";
import { api, mediaUrl } from "../api.js";
import { boxFrom, fmt, frameAt, noteTime, placeNote, snap, stepFrame } from "../lib.js";
import type { Note, Video, Version } from "../types.js";
import { Icon } from "./Icon.js";
import { Notes } from "./Notes.js";

type Box = { x: number; y: number; w: number; h: number };

export interface PictureProps {
  video: Video;
  version: Version;
  fps: number;
  notes: Note[];
  toast(message: string): void;
  onChanged(): void;
}

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/** The cut, with notes down the right: frame stepping, In/Out ranges, a box on the frame and frame grabs. */
export function Picture({ video, version, fps, notes, toast, onChanged }: PictureProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [t, setT] = useState(0);
  const [duration, setDuration] = useState(version.duration ?? 0);
  const [playing, setPlaying] = useState(false);
  const [broken, setBroken] = useState(false);
  const [range, setRange] = useState<{ in: number | null; out: number | null }>({ in: null, out: null });
  const [boxMode, setBoxMode] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [grab, setGrab] = useState<string | null>(null);
  const [shown, setShown] = useState<Box | null>(null);
  // The click that ends a box drag shouldn't also start playback.
  const justDrew = useRef(false);

  // A new cut: start again from the top, with nothing pending. A file the browser
  // can't decode can fail before any handler is attached, so check the element too.
  useEffect(() => {
    setBroken(false);
    setT(0);
    setRange({ in: null, out: null });
    setBox(null);
    setGrab(null);
    setShown(null);
    const v = ref.current;
    if (!v) return;
    const fail = () => setBroken(true);
    if (v.error) fail();
    v.addEventListener("error", fail);
    return () => v.removeEventListener("error", fail);
  }, [version.file]);

  // Smooth playhead while playing.
  useEffect(() => {
    if (!playing) return;
    let id = 0;
    const loop = () => {
      if (ref.current) setT(ref.current.currentTime);
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [playing]);

  // The element's time, snapped to its frame. Key handlers can run before a re-render, so never trust `t` for this.
  const now = () => snap(ref.current?.currentTime ?? t, fps);

  const seek = (to: number) => {
    const v = ref.current;
    if (!v) return;
    v.currentTime = Math.min(Math.max(0, to), duration || v.duration || to);
    setT(v.currentTime);
  };
  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => toast("Couldn't play this file"));
    else v.pause();
  };
  const step = (n: number) => {
    ref.current?.pause();
    seek(stepFrame(ref.current?.currentTime ?? t, fps, n, duration));
  };
  const setIn = () => setRange({ in: now(), out: null });
  const setOut = () => {
    const at = now();
    const start = range.in ?? 0;
    if (at <= start) return toast("Out has to come after In");
    setRange({ in: start, out: at });
  };
  const clearRange = () => setRange({ in: null, out: null });

  const grabFrame = async () => {
    const v = ref.current;
    if (!v || !v.videoWidth) return toast("Nothing to grab yet");
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")!.drawImage(v, 0, 0);
    const frame = frameAt(now(), fps);
    try {
      const r = await api.post<{ grab: string }>("/api/grabs", { video: video.id, version: version.id, frame, png: canvas.toDataURL("image/png") });
      setGrab(r.grab);
      toast(`Frame ${frame} saved`);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const add = async (text: string) => {
    const isRange = range.in !== null && range.out !== null;
    const at = isRange ? range.in! : now();
    await api.post("/api/notes", {
      stage: "picture",
      video: video.id,
      version: version.id,
      scope: isRange ? "range" : "point",
      t: at,
      tOut: isRange ? range.out : null,
      frame: frameAt(at, fps),
      text,
      box,
      grab,
    });
    clearRange();
    setBox(null);
    setGrab(null);
    onChanged();
  };

  // Keyboard: Space, ←/→, I, O, G, B and N, unless you're typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (e.key === " ") { e.preventDefault(); toggle(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); step(e.shiftKey ? -10 : -1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); step(e.shiftKey ? 10 : 1); }
      else if (k === "i") setIn();
      else if (k === "o") setOut();
      else if (k === "g") void grabFrame();
      else if (k === "b") setBoxMode((m) => !m);
      else if (k === "n") { e.preventDefault(); input.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Drawing a box on the frame.
  const point = (e: PointerEvent) => {
    const r = overlay.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  };
  const down = (e: PointerEvent) => {
    if (!boxMode) return;
    const p = point(e);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const move = (e: PointerEvent) => {
    if (!drag) return;
    const p = point(e);
    setDrag({ ...drag, x1: p.x, y1: p.y });
  };
  const up = (e: PointerEvent) => {
    if (!drag) return;
    const p = point(e);
    const b = boxFrom(drag.x0, drag.y0, p.x, p.y, p.w, p.h);
    setDrag(null);
    setBoxMode(false);
    justDrew.current = true;
    if (b.w > 0.01 && b.h > 0.01) setBox(b);
  };
  const live: Box | null = drag && overlay.current
    ? boxFrom(drag.x0, drag.y0, drag.x1, drag.y1, overlay.current.clientWidth, overlay.current.clientHeight)
    : null;
  const style = (b: Box) => ({ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });

  const pct = (s: number) => `${duration ? (s / duration) * 100 : 0}%`;
  const placed = notes.map((n) => ({ n, at: placeNote(n, version.id) })).filter(({ at }) => at.t !== null);
  const rangeLabel = range.in === null ? null : range.out === null ? `${fmt(range.in)} →` : noteTime(range.in, range.out);
  const placeholder = range.in !== null && range.out === null ? "Set an Out point" : `Note at ${rangeLabel && range.out !== null ? rangeLabel : fmt(t)}`;

  return (
    <div class="split">
      <div class="stack">
        <div class="frame">
          {broken && <div class="msg">This file won't play in a browser. Ask your agent for an H.264 MP4 of this cut.</div>}
          <video
            hidden={broken}
            ref={ref}
            src={mediaUrl(version.file)}
            preload="auto"
            playsInline
            onLoadedMetadata={(e) => setDuration((e.target as HTMLVideoElement).duration || version.duration || 0)}
            onTimeUpdate={(e) => !playing && setT((e.target as HTMLVideoElement).currentTime)}
            onSeeked={(e) => setT((e.target as HTMLVideoElement).currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
          />
          <div
            ref={overlay}
            class={`overlay${boxMode ? " drawing" : ""}`}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onClick={() => {
              if (justDrew.current) justDrew.current = false;
              else if (!boxMode) toggle();
            }}
          >
            {shown && <div class="bx saved" style={style(shown)} />}
            {box && <div class="bx" style={style(box)} />}
            {live && <div class="bx" style={style(live)} />}
          </div>
          <div class="tcover">f{frameAt(t, fps)}</div>
        </div>

        <div class="bar">
          <button class="btn ghost ib" data-tip="Back one frame  ←" aria-label="Back one frame" onClick={() => step(-1)}><Icon name="prev" /></button>
          <button class="btn ib" data-tip="Play  Space" aria-label={playing ? "Pause" : "Play"} onClick={toggle}><Icon name={playing ? "pause" : "play"} /></button>
          <button class="btn ghost ib" data-tip="Forward one frame  →" aria-label="Forward one frame" onClick={() => step(1)}><Icon name="next" /></button>
          <span class="tc" aria-label="Timecode">{fmt(t)}<small>/ {fmt(duration)}</small></span>
          <span class="sp" />
          {rangeLabel && (
            <span class="chipx">
              <span class="mono">{rangeLabel}</span>
              <button aria-label="Clear range" onClick={clearRange}><Icon name="x" /></button>
            </span>
          )}
          <button class="btn ghost ib" data-tip="Set in  I" aria-label="Set in point" onClick={setIn}><Icon name="in" /></button>
          <button class="btn ghost ib" data-tip="Set out  O" aria-label="Set out point" onClick={setOut}><Icon name="out" /></button>
          <span class="vsep" />
          <button class="btn ghost ib" data-tip="Draw a box  B" aria-label="Draw a box" aria-pressed={boxMode} onClick={() => setBoxMode(!boxMode)}><Icon name="box" /></button>
          <button class="btn ghost ib" data-tip="Grab frame  G" aria-label="Grab frame" onClick={() => void grabFrame()}><Icon name="camera" /></button>
        </div>

        <div
          class="track"
          role="slider"
          aria-label="Timeline"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={t}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            seek(((e.clientX - r.left) / r.width) * duration);
          }}
        >
          {placed.map(({ n, at }) => at.tOut !== null && <div class={`span ${n.status}`} style={{ left: pct(at.t!), width: pct(at.tOut - at.t!) }} />)}
          {range.in !== null && <div class="span live" style={{ left: pct(range.in), width: pct((range.out ?? range.in + 0.2) - range.in) }} />}
          {placed.map(({ n, at }) => <div class={`mk ${n.status}`} style={{ left: pct(at.t!) }} title={n.text} />)}
          <div class="playhead" style={{ left: pct(t) }} />
        </div>
        <div class="ends"><span>0:00</span><span>{fmt(duration)}</span></div>
      </div>

      <Notes
        notes={notes}
        version={version.id}
        placeholder={placeholder}
        inputRef={input}
        onAdd={add}
        onChanged={onChanged}
        onSeek={(to, n) => {
          ref.current?.pause();
          seek(to);
          setShown(n.box && (!n.version || n.version === version.id) ? n.box : null);
        }}
        attachments={(box || grab) && (
          <>
            {box && (
              <span class="chipx"><Icon name="box" />Box<button aria-label="Remove box" onClick={() => setBox(null)}><Icon name="x" /></button></span>
            )}
            {grab && (
              <span class="chipx"><Icon name="image" />Frame {grab.match(/_f(\d+)\.png$/)?.[1]}<button aria-label="Remove frame" onClick={() => setGrab(null)}><Icon name="x" /></button></span>
            )}
          </>
        )}
      />
    </div>
  );
}
```

`web/src/ui/App.tsx`

```tsx
import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../api.js";
import { BUILT, STAGE_NAMES, UNLOCK_HINT, firstTab, latest } from "../lib.js";
import type { Batch, Stage } from "../types.js";
import { useRushes } from "../useRushes.js";
import { Icon, STAGE_ICONS } from "./Icon.js";
import { Picture } from "./Picture.js";
import { Script } from "./Script.js";

const ORDER: Stage[] = ["script", "picture", "voice", "music", "sfx", "mix"];
const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

function Empty({ stage, unlocked }: { stage: Stage; unlocked: boolean }) {
  return (
    <div class="empty">
      <Icon name={unlocked ? STAGE_ICONS[stage] : "lock"} />
      <h2>{unlocked ? `${STAGE_NAMES[stage]} is coming` : `Nothing to review in ${STAGE_NAMES[stage]} yet`}</h2>
      <p>{unlocked ? "This tab arrives in the next release of Rushes. Your agent can already read and reply to notes for it." : UNLOCK_HINT[stage]}</p>
    </div>
  );
}

export function App() {
  const { state, problem, refresh } = useRushes();
  const [stage, setStage] = useState<Stage | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [toastText, setToastText] = useState<string | null>(null);
  const [sent, setSent] = useState<Batch | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const toastTimer = useRef<number | undefined>(undefined);

  const toast = (message: string) => {
    setToastText(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastText(null), 2400);
  };

  // First load: pick a tab and a video.
  useEffect(() => {
    if (!state) return;
    if (stage === null) setStage(firstTab(state.tabs));
    if (videoId === null && state.project.videos[0]) setVideoId(state.project.videos[0].id);
  }, [state]);

  // Follow the newest cut unless you've chosen an older one.
  const video = state?.project.videos.find((v) => v.id === videoId) ?? state?.project.videos[0];
  const newest = latest(video);
  const version = video?.versions.find((v) => v.id === versionId) ?? newest;

  const tabs = state?.tabs ?? [];
  const tab = (s: Stage) => tabs.find((t) => t.stage === s);
  const show = (s: Stage) => {
    if (!tab(s)?.unlocked) return toast(`Nothing to review in ${STAGE_NAMES[s]} yet`);
    setStage(s);
    setSent(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 6) show(ORDER[n - 1]);
      if (e.key === "?") setKeysOpen((o) => !o);
      if (e.key === "Escape") {
        setKeysOpen(false);
        setSent(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const send = async () => {
    if (!stage) return;
    setKeysOpen(false);
    try {
      const { batch } = await api.post<{ batch: Batch }>("/api/batches", { stage });
      setSent(batch);
      setCopied(false);
      void refresh();
    } catch (e) {
      toast(e instanceof ApiError && e.code === "empty_batch" ? `Nothing open on ${STAGE_NAMES[stage]} to send` : (e as Error).message);
    }
  };
  const copy = async () => {
    if (!sent) return;
    try {
      await navigator.clipboard.writeText(sent.prompt);
      setCopied(true);
    } catch {
      toast("Couldn't reach the clipboard. Select the text and copy it.");
    }
  };

  if (!state || !stage) {
    return (
      <div class="shell">
        {problem ? <div class="banner"><Icon name="alert" />{problem}</div> : <div class="empty"><p>Loading…</p></div>}
      </div>
    );
  }

  const fps = version?.fps ?? state.project.fps;
  const pictureNotes = state.notes.notes.filter((n) => n.stage === "picture" && (!n.video || n.video === video?.id));
  const unlocked = tab(stage)?.unlocked ?? false;
  const open = tab(stage)?.todo ?? 0;

  return (
    <div class="shell">
      <header class="head">
        <span class="logo"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg></span>
        <nav class="crumb" aria-label="Project">
          <span>{state.project.name}</span>
          {video && (
            <>
              <span class="slash">/</span>
              {state.project.videos.length > 1 ? (
                <select class="sel" aria-label="Video" value={video.id} onChange={(e) => { setVideoId((e.target as HTMLSelectElement).value); setVersionId(null); }}>
                  {state.project.videos.map((v) => <option value={v.id}>{v.name}</option>)}
                </select>
              ) : (
                <span class="sel">{video.name}</span>
              )}
              {version && (
                <select
                  class="sel mono"
                  aria-label="Version"
                  value={version.id}
                  onChange={(e) => {
                    const id = (e.target as HTMLSelectElement).value;
                    setVersionId(id === newest?.id ? null : id);
                  }}
                >
                  {[...video.versions].reverse().map((v) => <option value={v.id}>{v.id}{v.note ? ` · ${v.note}` : ""}</option>)}
                </select>
              )}
            </>
          )}
        </nav>
        <span class="sp" />
        <button class="btn ghost ib tip-below" data-tip="Shortcuts  ?" aria-label="Keyboard shortcuts" onClick={() => { setSent(null); setKeysOpen(!keysOpen); }}>
          <Icon name="kbd" />
        </button>
        <button class="btn primary" onClick={() => void send()}>
          Send to agent{open > 0 && <span class="count">{open}</span>}
        </button>
      </header>

      {sent && (
        <div class="pop" role="dialog" aria-label="Sent to agent">
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <h3>Batch {sent.id} is ready</h3>
            <span class="sp" />
            <button class="btn ghost ib sm" aria-label="Close" onClick={() => setSent(null)}><Icon name="x" /></button>
          </div>
          <pre>{sent.prompt}</pre>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button class="btn primary" onClick={() => void copy()}><Icon name="copy" />{copied ? "Copied" : "Copy prompt"}</button>
          </div>
        </div>
      )}
      {keysOpen && (
        <div class="pop" role="dialog" aria-label="Keyboard shortcuts" style={{ width: "300px" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <h3>Shortcuts</h3>
            <span class="sp" />
            <button class="btn ghost ib sm" aria-label="Close" onClick={() => setKeysOpen(false)}><Icon name="x" /></button>
          </div>
          <div class="keys">
            <span><kbd>Space</kbd></span><span>Play or pause</span>
            <span><kbd>←</kbd> <kbd>→</kbd></span><span>Step one frame (Shift: ten)</span>
            <span><kbd>I</kbd> <kbd>O</kbd></span><span>Set in and out</span>
            <span><kbd>B</kbd></span><span>Draw a box</span>
            <span><kbd>G</kbd></span><span>Grab frame</span>
            <span><kbd>N</kbd></span><span>New note</span>
            <span><kbd>1</kbd>–<kbd>6</kbd></span><span>Switch tab</span>
          </div>
        </div>
      )}
      {toastText && <div class="toast" role="status">{toastText}</div>}

      <nav class="tabs" role="tablist" aria-label="Stages">
        {ORDER.map((s) => {
          const t = tab(s);
          return (
            <button class="tab" role="tab" aria-selected={stage === s} aria-disabled={!t?.unlocked} onClick={() => show(s)}>
              <Icon name={STAGE_ICONS[s]} />
              {STAGE_NAMES[s]}
              {t?.unlocked ? (t.todo > 0 && <span class="dot" title={`${t.todo} open`} />) : <Icon name="lock" class="lk" />}
            </button>
          );
        })}
      </nav>
      {problem && <div class="banner"><Icon name="alert" />{problem}</div>}

      <main class="body">
        {!unlocked || !BUILT[stage] ? (
          <Empty stage={stage} unlocked={unlocked} />
        ) : stage === "picture" && video && version ? (
          <Picture video={video} version={version} fps={fps} notes={pictureNotes} toast={toast} onChanged={() => void refresh()} />
        ) : stage === "script" ? (
          <Script script={state.script} onChanged={() => void refresh()} />
        ) : (
          <Empty stage={stage} unlocked={unlocked} />
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm run build && npx playwright test && npx tsc --noEmit && npx vitest run`
Expected: everything passes, including the full unit suite, and tsc prints nothing.

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore vite.config.ts web/index.html web/src/main.tsx web/src/api.ts web/src/useRushes.ts web/src/styles.css web/src/ui/Icon.tsx web/src/ui/Notes.tsx web/src/ui/Script.tsx web/src/ui/Picture.tsx web/src/ui/App.tsx playwright.config.ts e2e/fixture.ts e2e/dashboard.spec.ts e2e/fixtures/clip.mp4 package-lock.json
git commit -m "feat(web): the review desk dashboard, with Script and Picture tabs"
```

---

### Task 7: Docs, full verification and release

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`

**Interfaces:**
- **Consumes:** everything above.
- **Produces:** README and AGENTS.md describing the dashboard, `rushes stop` and idle background servers, plus a verified release.

- [ ] **Step 1: Implement**

`README.md`

````markdown
# Rushes

A local review desk for video made with AI agents.

Your agent renders a cut, writes a voiceover script or generates music beds. Rushes shows that work stage by stage in your browser:

- **Script:** your edits sit beside the agent's lines.
- **Picture:** timecoded notes, ranges, boxes on the frame and frame grabs.
- **Voiceover, Music, Sound effects:** variants you can switch between with no gap.
- **Mix:** everything playing together.

Your notes are saved as plain files in your project. The agent reads them, fixes things and replies on each one, and you see each reply arrive.

It runs on your machine. There's no account, no API key and no server to sign up for. You need [Node.js](https://nodejs.org) 20 or newer, and git (needed to install straight from GitHub until Rushes is on npm).

> Status: early. The Script and Picture tabs, the MCP tools and the CLI work today. The audio tabs (Voiceover, Music, Sound effects, Mix) are next.

## Get started

Tell your agent:

> Use github.com/iamredmh/rushes as my review tool for video, voiceover and music.

That's all. Your agent reads the next section and sets itself up.

## For agents: set yourself up

If your user asked you to use Rushes, do this:

1. Run this once. It finds every supported harness on the machine and registers the Rushes MCP server, plus the Rushes skill where the harness supports skills:

   ```bash
   npx -y github:iamredmh/rushes setup
   ```

   It prints one line per harness. Existing config is kept and a `.rushes.bak` backup is written first. Run it with `--dry-run` first if you want to show the user the changes before making them.
2. If it added anything, tell the user to restart the app (or start a new session) so the `rushes_*` tools load.
3. From then on, follow [AGENTS.md](AGENTS.md). In short: register what you made, call `rushes_open`, wait for the user to press **Send to agent**, then `rushes_get_batch`, fix the notes, and `rushes_reply`.

The MCP server has eleven tools: `rushes_open`, `rushes_status`, `rushes_add_version`, `rushes_add_variant`, `rushes_set_script`, `rushes_get_script`, `rushes_add_take`, `rushes_list_notes`, `rushes_get_batch`, `rushes_reply` and `rushes_get_picks`.

If you can't run commands, give the user the matching line from **Manual setup** below.

## Manual setup

| Harness | How |
|---|---|
| **Claude Code**: plugin, which includes the skill | `/plugin marketplace add iamredmh/rushes` then `/plugin install rushes@iamredmh` |
| **Claude Code**: MCP only | `claude mcp add --scope user rushes -- npx -y github:iamredmh/rushes mcp` |
| **Codex** | add to `~/.codex/config.toml`:<br>`[mcp_servers.rushes]`<br>`command = "npx"`<br>`args = ["-y", "github:iamredmh/rushes", "mcp"]` |
| **Cursor** (`~/.cursor/mcp.json`), **Claude Desktop** (`claude_desktop_config.json`), **Gemini CLI** (`~/.gemini/settings.json`) | `{ "mcpServers": { "rushes": { "command": "npx", "args": ["-y", "github:iamredmh/rushes", "mcp"] } } }` |

On Windows, `rushes setup` writes the launch as `cmd /c npx -y github:iamredmh/rushes mcp` (in JSON: `"command": "cmd", "args": ["/c", "npx", "-y", "github:iamredmh/rushes", "mcp"]`), because harnesses can't start `npx` directly there. Do the same if you set it up by hand.

### Other harnesses

Any MCP client that can launch a local stdio server works. Point it at `npx -y github:iamredmh/rushes mcp`. Agents with no MCP support can use the CLI instead (`rushes add`, `rushes notes`, `rushes reply`): see [AGENTS.md](AGENTS.md).

ChatGPT's apps can't run local MCP servers yet. Use Codex, OpenAI's agent, instead.

## Use it yourself

```bash
cd your-project
npx -y github:iamredmh/rushes open    # opens the review desk in your browser
npx -y github:iamredmh/rushes stop    # stops it
```

A server your agent starts in the background stops by itself after two hours with nothing connected.

## What gets saved

```
your-project/.rushes/
  project.json   videos, versions, audio lanes and variants
  script.json    VO sections: the agent's line, your version, direction, takes
  notes.json     every note, with the agent's replies
  picks.json     which variant or take is in use
  batches.json   what you sent to the agent
  grabs/         frame grabs
```

Add `.rushes/` to git if you want your review history kept with the project. Rushes ignores its own temporary files.

## Develop

```bash
git clone https://github.com/iamredmh/rushes && cd rushes
npm install
npm test
npm run rushes -- open ../some-project
```

ffmpeg and ffprobe are optional. With them installed, Rushes reads frame rates and durations and can make browser-playable copies.

## Licence

MIT © Red Morley Hewitt
````

`AGENTS.md`

````markdown
# Rushes, for agents

Rushes is a local review desk. Your user watches the work in a browser, leaves timecoded notes, edits the script and picks audio variants. You read that feedback, act on it, and reply. Everything is saved in the project's `.rushes/` folder, and one local server is the only thing that writes to it.

## Setup (once per machine)

```bash
npx -y github:iamredmh/rushes setup
```

This registers the Rushes MCP server with every supported harness it finds (Claude Code, Codex, Cursor, Claude Desktop, Gemini CLI), and installs the skill where the harness supports skills. If it added anything, ask the user to restart the app. Use `--dry-run` to preview, and `--only claude-code,codex` to limit it.

## The loop

1. **Register what you made.**
   - A render: `rushes_add_version` with `video` and `file`. Run it again for each new cut.
   - A VO script: `rushes_set_script` with sections `{start, end, current}` in seconds. It merges by `id`: send only the sections you changed, with their ids, plus any new ones without an id. Sections you leave out are kept, with their takes. Pass `replace: true` only when you mean to replace the whole script. `rushes_get_script` reads the whole script back.
   - VO takes: `rushes_add_take` for each section.
   - Music beds, SFX passes or alternative VO lanes: `rushes_add_variant` with `stage` `music`, `sfx` or `voice`.
2. **Open it for the user:** `rushes_open`. A tab unlocks as soon as it has something in it.
3. **Wait for feedback.** The user presses **Send to agent**, which saves a batch and gives them a prompt to paste to you. Call `rushes_get_batch` to read the latest batch, its notes and any changed script sections.
4. **Fix each note.** A note has `stage`, `scope` (`point`, `range` or `whole`), `t`, `tOut`, `on` (the lane, variant, take, cue or section it's about), `text`, and optionally `box` (normalised 0 to 1) and `grab` (a PNG path in `.rushes/grabs/`).
5. **Register the new cut** with `rushes_add_version` and note what changed.
6. **Reply to every note** in one `rushes_reply` call. For each, set `status: "done"`, a one-line `reply`, `fixT` (when the fix is visible in the new cut, in seconds) and `fixVersion`. If you didn't fix a note, leave it `todo` and say why in `reply`.
7. **Script batches.** When a section's `proposed` differs from `current`, the user rewrote the line. Adopt it by calling `rushes_set_script` with just that section's `id`, `start`, `end` and the new `current`; the other sections stay as they are. The proposal then clears itself, and a flagged section goes back to draft. A changed line makes that section's existing takes stale, so record new takes and add them.

## Tools

The MCP server has eleven tools: `rushes_open`, `rushes_status`, `rushes_add_version`, `rushes_add_variant`, `rushes_set_script`, `rushes_get_script`, `rushes_add_take`, `rushes_list_notes`, `rushes_get_batch`, `rushes_reply` and `rushes_get_picks`. Each takes an optional `project` folder, which defaults to the folder the harness started in.

## Rules

- Never edit `.rushes/*.json` by hand while the server is running. Use the tools, or the CLI (`rushes add`, `rushes notes`, `rushes reply`).
- You own a note's `reply`, `fixT` and `fixVersion`. The user owns its text, times and box. Either of you can set `status`.
- Times are seconds from the start of the video, as numbers (e.g. `31.05`).
- A server you start through the tools stops by itself after two hours with nothing connected. The next tool call starts it again. `rushes stop` stops it now.
- Prefer H.264 MP4 for cuts: browsers can't play ProRes, and some can't play HEVC.

## Without MCP

```bash
npx -y github:iamredmh/rushes open
npx -y github:iamredmh/rushes add version renders/hero_v2.mp4 --video "Hero 60s" --note "logo hold"
npx -y github:iamredmh/rushes notes --stage picture --status todo --json
npx -y github:iamredmh/rushes reply n_8f2k3a "Held the phone 0.5 s longer" --done --fix-t 12.9 --fix-version v2
```
````

- [ ] **Step 2: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: the dashboard, rushes stop and idle background servers"
```

- [ ] **Step 3: Verify everything, including a fresh git install of the committed tree**

```bash
npm test && npm run typecheck && npm run test:e2e
cd "$(mktemp -d)" && npx -y "git+file://$HOME/Documents/Projects/rushes" --help | head -1
```

Expected:
- 152 unit tests and 11 browser tests pass, and both typechecks are clean.
- The git install prints `rushes 0.1.0: a local review desk for video made with AI agents`. It takes about 8 s the first time, because it builds the dashboard.

Then check the installed copy serves the dashboard. Run it from the same temp folder in a second terminal:

```bash
npx -y "git+file://$HOME/Documents/Projects/rushes" serve proj --port 4420
```

and open http://127.0.0.1:4420. Expected: the review desk, not the placeholder. Stop it with `npx -y "git+file://$HOME/Documents/Projects/rushes" stop proj`.

- [ ] **Step 4: Push to the public repo (ask Red first)**

This publishes to `github.com/iamredmh/rushes`. Ask Red first: *"Plan 2 is green. OK to push main to the public repo?"* Only after he says yes:

```bash
git push origin main
cd "$(mktemp -d)" && npx -y github:iamredmh/rushes --help | head -1
```

Expected: the push succeeds and the install from GitHub prints the help line.

---

---

## What comes next

- **Plan 3: audio tabs and the playback engine.**
  - **Voiceover:** the assembled read, the takes for each section, stale-take marks, and per-section take picks (`picks.json`).
  - **Music:** a lane per bed, Use and Blind.
  - **Sound effects:** passes with cue labels.
  - **Mix:** mute and solo, plus loudness via ffmpeg when it's installed.
  - **Shared engine:** Web Audio, sample-locked switching (two gain nodes on one clock), waveforms computed in the browser, and the audio clock as master with video drift correction.
  - The notes column gains the On target and Point/Range/Whole scope from the mockup.
- **Plan 4: robustness and release.**
  - Playable proxies via ffmpeg (`.rushes/proxies/`), replacing Picture's "won't play" message with a **Make a playable copy** button.
  - `rushes doctor`, `rushes demo`, and recovering from `.bak` files.
  - Pinning the install source to a release tag, and Codex `startup_timeout_sec`.
  - CI on macOS, Linux and Windows.
  - `npm publish` as `rushes`, with `@iamredmh/rushes` reserved.
