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
