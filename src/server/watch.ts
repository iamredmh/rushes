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
 *
 * fs.watch is the primary signal, but it's a convenience the OS doesn't fully
 * guarantee: under heavy filesystem load (seen on macOS when many watchers are
 * active at once), a notification can be coalesced away and never delivered.
 * A slow background poll is the safety net, so a hand edit is still picked up
 * — just a little later — even if the OS drops the event for it entirely.
 */
export async function watchStore(store: Store, debounceMs = 80, pollMs = 500): Promise<() => void> {
  const timers = new Map<FileKey, NodeJS.Timeout>();
  let watcher: FSWatcher | null = null;
  let stopped = false;
  const check = async (key: FileKey) => {
    try {
      const data = await store.read(key);
      store.announce(key, data.rev);
    } catch (e) {
      if (e instanceof CorruptFileError) {
        // Forget the rev we last announced, so a restore at the same rev still announces.
        store.forget(key);
        store.emit("corrupt", { file: FILES[key].name, message: e.message } satisfies CorruptEvent);
      }
    }
  };

  // Seed the starting rev for every file that reads cleanly, so the poll below
  // treats "nothing has changed since the server started" as nothing changed,
  // rather than announcing every file's current state as a fresh edit. This is
  // awaited before the server can take any request, so no real hand edit can
  // land in the gap. A file already broken at startup is left for a later edit
  // to surface, same as before this watcher existed.
  await Promise.all(
    (Object.keys(FILES) as FileKey[]).map(async (key) => {
      try {
        const data = await store.read(key);
        store.seed(key, data.rev);
      } catch {
        // Missing or corrupt at startup: nothing to seed.
      }
    }),
  );

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

  let pollTimer: NodeJS.Timeout | undefined;
  const poll = () => {
    if (stopped) return;
    for (const key of Object.keys(FILES) as FileKey[]) void check(key);
    pollTimer = setTimeout(poll, pollMs);
    pollTimer.unref?.();
  };
  pollTimer = setTimeout(poll, pollMs);
  pollTimer.unref?.();

  return () => {
    stopped = true;
    clearTimeout(pollTimer);
    for (const t of timers.values()) clearTimeout(t);
    watcher?.close();
  };
}
