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
