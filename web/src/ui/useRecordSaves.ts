// §24: the save path shared by the Brief and Storyboard pages, whose files are the record. Every save goes through
// one queue and passes the newest hash on, so two edits in a row never fail against each other's result. A save
// refused because the agent rewrote the file is built again from the file as it now is, and tried once more.
import { useEffect, useRef } from "preact/hooks";
import { api, ApiError } from "../api.js";
import type { State } from "../types.js";

type Key = "brief" | "storyboard";

/** What a save asks the server for, built from the record as it is now (so it can be built again from a newer one); null when the item has gone. */
export type Request<V> = (view: V) => { path: string; body: Record<string, unknown> } | null;

export interface SaveOptions {
  toast(message: string): void;
  onChanged(): void;
  /** Where Send to agent finds how to wait for these saves: it resolves once every queued save has landed, with the record as the server then has it. */
  settle: { current: (() => Promise<unknown>) | null };
}

export function useRecordSaves<K extends Key>(key: K, view: State[K], o: SaveOptions) {
  const hash = useRef(view.hash);
  const latest = useRef(view);
  latest.current = view;
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    hash.current = view.hash;
  }, [view.hash]);
  useEffect(() => {
    o.settle.current = async () => {
      await queue.current.catch(() => undefined);
      return (await api.get<State>("/api/state"))[key];
    };
    return () => {
      o.settle.current = null;
    };
  }, []);

  const put = async (build: Request<State[K]>): Promise<void> => {
    let from = latest.current;
    for (let attempt = 0; ; attempt++) {
      const req = build(from);
      if (!req) throw new Error(`that part is no longer in ${key}.md`);
      try {
        const r = await api.put<Record<K, State[K]>>(req.path, { ...req.body, hash: hash.current });
        hash.current = r[key].hash;
        return;
      } catch (e) {
        // The agent rewrote the file while you were typing: take it as it is now, find the part again, and try once more.
        if (e instanceof ApiError && e.code === `${key}_changed` && attempt === 0) {
          from = (await api.get<State>("/api/state"))[key];
          hash.current = from.hash;
          continue;
        }
        throw e;
      }
    }
  };

  const enqueue = (what: string, build: Request<State[K]>) => {
    queue.current = queue.current
      .catch(() => undefined)
      .then(() => put(build))
      .catch((e) => o.toast(`Couldn't save ${what}: ${(e as Error).message}`))
      .finally(o.onChanged);
  };

  return { latest, enqueue };
}
