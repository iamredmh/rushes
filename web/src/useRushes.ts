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
