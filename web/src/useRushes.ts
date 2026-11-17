import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError, eventsUrl, projectId } from "./api.js";
import { mergeProxyJob, proxyProgress, settleProxyJobs, testFlags, type ProxyJobs } from "./lib.js";
import { connectLive, type LiveRole } from "./live.js";
import type { AgentStatus, Asset, ProxyEvent, ProxyJob, State } from "./types.js";

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
  /** §19.5: every proxy job this tab knows of, one per cut, from the SSE `proxy` events (so
   *  every open tab shows the same progress), seeded from the state's running jobs. */
  proxyJobs: ProxyJobs;
  /** Folds a job a route just returned (Create proxy, Cancel) in, ahead of its SSE event. */
  noteProxyJob(job: ProxyJob): void;
  /** §28: the agent's status, from GET /api/agent and then the SSE `agent` events. Null until the first answer,
   *  and from a server older than Send to AI (404). */
  agent: AgentStatus | null;
  /** Folds in a status an agent route just returned (setup, fresh, a rule removed), ahead of any SSE event. */
  noteAgent(status: AgentStatus): void;
}

declare global {
  interface Window {
    /** Test-only (`?test=1`): which tab holds the shared event stream (§19.8). */
    __rushesLive?: { role(): LiveRole };
  }
}

/** The project's state, kept current from the server's change events, heard through one
 *  connection that every open tab on the project shares (live.ts). */
export function useRushes(): Live {
  const [state, setState] = useState<State | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [wrongProject, setWrongProject] = useState(false);
  const [proxyJobs, setProxyJobs] = useState<ProxyJobs>({});
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const timer = useRef<number | undefined>(undefined);
  // Every status is numbered when asked for or heard, so a slow GET can't overwrite a newer SSE event.
  const agentSeq = useRef(0);
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
  const retryDelay = useRef(750);

  const refresh = async () => {
    const id = ++seq.current;
    // Proxy news that arrives while this fetch is out is newer than what it brings back.
    const since = performance.now();
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
      const data = stateResult.data;
      setState(data);
      const hasProxy = (video: string, version: string) =>
        !!data.project.videos.find((v) => v.id === video)?.versions.find((v) => v.id === version)?.proxy;
      setProxyJobs((jobs) => settleProxyJobs(jobs, data.proxies?.jobs ?? [], since, hasProxy));
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
    // A tab whose project has gone is settled: its assets fetch is refused too, and retrying
    // won't bring the project back. Otherwise back off from 750 ms to 10 s while the server
    // stays unreachable, so a stopped server isn't polled every frame of the afternoon.
    const settled = wrongProjectNow || (stateResult.ok && assetsResult.ok);
    if (settled) {
      retryDelay.current = 750;
    } else {
      retryTimer.current = window.setTimeout(() => void refresh(), retryDelay.current);
      retryDelay.current = Math.min(retryDelay.current * 2, 10_000);
    }
  };

  // The SSE stream doesn't replay, so the agent's status is fetched on first load and whenever events may have been
  // missed (open, resync). A server older than Send to AI answers 404: no agent. Any other failure keeps what we have.
  const loadAgent = async () => {
    const id = ++agentSeq.current;
    try {
      const { status } = await api.get<{ status: AgentStatus }>("/api/agent");
      if (id === agentSeq.current) setAgent(status);
    } catch (e) {
      if (id === agentSeq.current && e instanceof ApiError && e.status === 404) setAgent(null);
    }
  };

  useEffect(() => {
    void refresh();
    void loadAgent();
    const live = connectLive(projectId() ?? "", eventsUrl(), {
      change() {
        // Several files often change together; fetch once.
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => void refresh(), 40);
      },
      proxy(data) {
        const event = JSON.parse(data) as ProxyEvent;
        setProxyJobs((jobs) => mergeProxyJob(jobs, { ...event, at: performance.now() }));
      },
      corrupt(data) {
        const { file } = JSON.parse(data) as { file: string };
        setProblem(`${file} has an error and wasn't loaded. Fix or restore it, and Rushes will pick it up.`);
      },
      agent(data) {
        agentSeq.current++;
        setAgent(JSON.parse(data) as AgentStatus);
      },
      // The stream's state, heard by every tab (relayed from the leader's): a follower notices a
      // server that's gone the same way, and its refresh() failures drive the same backoff.
      error() {
        setProblem("Lost touch with the Rushes server. Retrying…");
        if (refreshingFromError.current) return;
        refreshingFromError.current = true;
        void refresh().finally(() => { refreshingFromError.current = false; });
      },
      open() {
        refreshingFromError.current = false;
        void refresh();
        void loadAgent();
      },
      // The leader went quiet (a frozen tab) and this one took over, or this page was frozen.
      resync() {
        void refresh();
        void loadAgent();
      },
    });
    if (testFlags(location.search).test) window.__rushesLive = { role: () => live.role() };
    return () => {
      live.close();
      clearTimeout(timer.current);
      clearTimeout(retryTimer.current);
    };
  }, []);

  const noteProxyJob = (job: ProxyJob) => setProxyJobs((jobs) => mergeProxyJob(jobs, proxyProgress(job, performance.now())));

  const noteAgent = (status: AgentStatus) => {
    agentSeq.current++;
    setAgent(status);
  };

  return { state, assets, problem, wrongProject, refresh, proxyJobs, noteProxyJob, agent, noteAgent };
}
