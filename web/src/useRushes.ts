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
  // Number each request so a slow one that lands after a newer one can't overwrite it.
  const seq = useRef(0);
  const applied = useRef(0);

  const refresh = async () => {
    const id = ++seq.current;
    try {
      const data = await api.get<State>("/api/state");
      if (id < applied.current) return;
      applied.current = id;
      setState(data);
      setProblem(null);
    } catch (e) {
      if (id < applied.current) return;
      applied.current = id;
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
