import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { FILES, type FileKey } from "../core/schema.js";
import { CorruptFileError } from "../core/errors.js";
import type { Store } from "../core/store.js";

export interface CorruptEvent {
  file: string;
  message: string;
}

const BY_NAME = new Map<string, FileKey>(Object.entries(FILES).map(([key, f]) => [f.name as string, key as FileKey]));

/**
 * A cheap fingerprint of a file's on-disk state. `null` means it doesn't exist. `ino` and
 * `ctimeMs` catch an atomic rename-replace (a common write pattern), which changes the inode
 * but can otherwise land on the same mtime and size as the file it replaced, on a volume with
 * coarse timestamp resolution.
 */
interface Snap {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
}

function sameSnap(a: Snap | null, b: Snap | null): boolean {
  if (a === null || b === null) return a === b;
  return a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size && a.ino === b.ino;
}

/**
 * Watch .rushes/ for edits made outside the server (a person or an agent
 * editing the JSON by hand). A valid edit with a new rev is announced like any
 * other change; an invalid one is reported as a "corrupt" event and left alone.
 *
 * fs.watch is the primary signal, but it's a convenience the OS doesn't fully
 * guarantee: under heavy filesystem load (seen on macOS when many watchers are
 * active at once), a notification can be coalesced away and never delivered.
 * A slow background poll is the safety net, so a hand edit is still picked up
 * — just a little later — even if the OS drops the event for it entirely. The
 * poll only ever `stat`s each file (cheap, no read or parse); it reads and
 * announces or reports a file only when that stat has actually changed, so an
 * idle project costs nothing and a file that stays broken is reported once,
 * not on every poll tick.
 */
export async function watchStore(store: Store, debounceMs = 80, pollMs = 500): Promise<() => void> {
  const timers = new Map<FileKey, NodeJS.Timeout>();
  const snaps = new Map<FileKey, Snap | null>();
  let watcher: FSWatcher | null = null;
  let stopped = false;

  const statOf = async (key: FileKey): Promise<Snap | null> => {
    try {
      const st = await stat(store.path(key));
      return { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, ino: st.ino };
    } catch {
      return null;
    }
  };

  const check = async (key: FileKey) => {
    // Stat before reading, and record that stat as the snapshot below -- not one taken after
    // the read. An edit landing between a read-then-stat order would be invisible forever: its
    // write could complete after the read but before the stat, so the recorded snapshot would
    // match the file's new (already-edited) state even though the content just read was the
    // old one, and no later poll tick would ever see a difference to re-check. Stat-first means
    // the recorded snapshot can only be as fresh as what was actually read, so a write landing
    // in the gap always leaves the live file's stat different from it, and the next tick retries.
    const pre = await statOf(key);
    try {
      const data = await store.read(key);
      store.announce(key, data.rev);
    } catch (e) {
      if (e instanceof CorruptFileError) {
        // Forget the rev we last announced, so a restore at the same rev still announces.
        store.forget(key);
        store.emit("corrupt", { file: FILES[key].name, message: e.message } satisfies CorruptEvent);
      }
    } finally {
      // Record the state from before the read, whatever it was, so the poll doesn't reprocess
      // the same unchanged (including still-broken) file.
      snaps.set(key, pre);
    }
  };

  // Seed the starting rev and stat snapshot for every file, so the poll below
  // treats "nothing has changed since the server started" as nothing changed,
  // rather than announcing every file's current state as a fresh edit. Seeding
  // happens after the server is already listening, not before, so a real hand
  // edit can in principle land in that narrow gap -- but the worst case is one
  // duplicate change event once this seed and fs.watch both notice it, and
  // `announce` already deduplicates by rev, so nothing is lost or double-sent.
  // A file already broken at startup is left for a later edit to surface, same
  // as before this watcher existed.
  await Promise.all(
    (Object.keys(FILES) as FileKey[]).map(async (key) => {
      snaps.set(key, await statOf(key));
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
  // Set for the duration of one poll tick's stat sweep, so a hung stat (a dropped network
  // drive, say) can never cause ticks to pile up on top of each other -- the next tick is still
  // scheduled on time below, but it sees this flag set and skips its own sweep entirely.
  let polling = false;
  const poll = () => {
    if (stopped) return;
    pollTimer = setTimeout(poll, pollMs);
    pollTimer.unref?.();
    if (polling) return;
    polling = true;
    void (async () => {
      try {
        for (const key of Object.keys(FILES) as FileKey[]) {
          const current = await statOf(key);
          if (!sameSnap(current, snaps.get(key) ?? null)) void check(key);
        }
      } finally {
        polling = false;
      }
    })();
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
