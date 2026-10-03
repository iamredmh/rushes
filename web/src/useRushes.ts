import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError, eventsUrl } from "./api.js";
import type { Asset, State } from "./types.js";

export interface Live {
  state: State | null;
  /** Every asset in the project (screenshots, cuts, takes, voice, music, sfx), for the Assets tab. */
  assets: Asset[];
  /** Set when the server can't be reached or a data file is broken. */
  problem: string | null;
  /** Set once a request comes back `wrong_project`: this tab belongs to a project that
   *  isn't the one answering on this port any more. `state` keeps its last good value. */
  wrongProject: boolean;
  /** Fetch the latest state now (after a write the page made itself). */
  refresh(): Promise<void>;
}

/** The project's state, kept current from the server's change events. */
export function useRushes(): Live {
  const [state, setState] = useState<State | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [wrongProject, setWrongProject] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  // Number each request so a slow one that lands after a newer one can't overwrite it.
  const seq = useRef(0);
  const applied = useRef(0);
  // Guards refresh() calls made from an EventSource error so a burst of them (the
  // browser retries every few seconds) never overlaps or piles up.
  const refreshingFromError = useRef(false);
  // Self-heals a transient fetch failure (a local dev server that's momentarily slow to accept
  // or reset a connection -- common when many Rushes servers and browser tabs are competing for
  // the same CPU) without waiting on the next SSE "change" event, which may never come if nothing
  // else writes to the project afterwards. Single timer: only the most recently applied refresh()
  // gets to schedule or clear it, so a burst of concurrent calls can't pile up retries.
  const retryTimer = useRef<number | undefined>(undefined);

  const refresh = async () => {
    const id = ++seq.current;
    // State and assets are fetched together but handled independently: a failed assets
    // fetch must never blank the state (or vice versa), so each settles on its own.
    const [stateResult, assetsResult] = await Promise.all([
      api.get<State>("/api/state").then(
        (data) => ({ ok: true as const, data }),
        (e) => ({ ok: false as const, error: e as Error }),
      ),
      api.get<{ assets: Asset[] }>("/api/assets").then(
        (data) => ({ ok: true as const, assets: data.assets }),
        (e) => ({ ok: false as const, error: e as Error }),
      ),
    ]);
    if (id < applied.current) return;
    applied.current = id;
    let wrongProjectNow = false;
    if (stateResult.ok) {
      setState(stateResult.data);
      setProblem(null);
      setWrongProject(false);
    } else if (stateResult.error instanceof ApiError && stateResult.error.code === "wrong_project") {
      // The last good state stays on screen; this stops being an ordinary "problem", and isn't
      // something retrying will fix -- the project really is gone from this port.
      setWrongProject(true);
      wrongProjectNow = true;
    } else {
      setProblem(stateResult.error.message);
    }
    if (assetsResult.ok) setAssets(assetsResult.assets);

    clearTimeout(retryTimer.current);
    const settled = (stateResult.ok || wrongProjectNow) && assetsResult.ok;
    if (!settled) {
      retryTimer.current = window.setTimeout(() => void refresh(), 750);
    }
  };

  useEffect(() => {
    void refresh();
    const events = new EventSource(eventsUrl());
    events.addEventListener("change", () => {
      // Several files often change together; fetch once.
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void refresh(), 40);
    });
    events.addEventListener("corrupt", (e) => {
      const { file } = JSON.parse((e as MessageEvent).data) as { file: string };
      setProblem(`${file} has an error and wasn't loaded. Fix or restore it, and Rushes will pick it up.`);
    });
    events.onerror = () => {
      setProblem("Lost touch with the Rushes server. Retrying…");
      if (refreshingFromError.current) return;
      refreshingFromError.current = true;
      void refresh().finally(() => { refreshingFromError.current = false; });
    };
    events.onopen = () => {
      refreshingFromError.current = false;
      void refresh();
    };
    return () => {
      events.close();
      clearTimeout(timer.current);
      clearTimeout(retryTimer.current);
    };
  }, []);

  return { state, assets, problem, wrongProject, refresh };
}
