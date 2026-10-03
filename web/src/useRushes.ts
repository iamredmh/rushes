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
        () => ({ ok: false as const }),
      ),
    ]);
    if (id < applied.current) return;
    applied.current = id;
    if (stateResult.ok) {
      setState(stateResult.data);
      setProblem(null);
      setWrongProject(false);
    } else if (stateResult.error instanceof ApiError && stateResult.error.code === "wrong_project") {
      // The last good state stays on screen; this stops being an ordinary "problem".
      setWrongProject(true);
    } else {
      setProblem(stateResult.error.message);
    }
    if (assetsResult.ok) setAssets(assetsResult.assets);
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
    };
  }, []);

  return { state, assets, problem, wrongProject, refresh };
}
