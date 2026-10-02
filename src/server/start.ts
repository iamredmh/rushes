import { createServer, type Server } from "node:http";
import { mkdir, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { Store } from "../core/store.js";
import { ensureProjectIdOnce } from "../core/project.js";
import { createApp, type AppOptions } from "./app.js";
import { removeLock, writeLock } from "./lock.js";
import { watchStore } from "./watch.js";

export const DEFAULT_PORT = 4580;

export interface Running {
  url: string;
  port: number;
  /** This project's id (8 characters), stable across restarts. */
  id: string;
  /** `${url}/p/${id}/`: the one address every open tab and printed link should use. */
  dashboardUrl: string;
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
  // `appOpts` is the exact object the app's closure reads `projectId` from on every request, so
  // setting it below (once this server has won the project's lock and ensured the id) reaches
  // the already-constructed app without recreating it.
  const appOpts: AppOptions = { webDir: opts.webDir, onShutdown: () => void close() };
  const app = createApp(store, appOpts);
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
  // Only the server that actually won the lock ever touches project.json here, so racing
  // starts for the same root never collide writing it. ensureProjectIdOnce shares its one
  // in-flight promise with the app's own lazy ensure (keyed on this same store), so a request
  // landing before this line — however briefly a request could reach a freshly-listening
  // socket — can never cause a second write: restarts never bump the rev either way.
  const id = await ensureProjectIdOnce(store);
  appOpts.projectId = id;
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
  return { url, port, id, dashboardUrl: `${url}/p/${id}/`, store, close, closed };
}
