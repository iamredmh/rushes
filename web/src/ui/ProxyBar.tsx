import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../api.js";
import { formatBytes, proxyPhase, proxyReason, proxyTip, type ProxyProgress } from "../lib.js";
import type { ProxyJob, Version, Video } from "../types.js";
import { Icon } from "./Icon.js";

/** How long "✓ Proxy ready" stays before the bar folds back to the checkbox alone. */
export const DONE_SHOWN_MS = 6000;

export interface ProxyBarProps {
  video: Video;
  version: Version;
  /** The server has ffmpeg and ffprobe. Without them nothing is offered and this renders nothing. */
  ffmpeg: boolean;
  /** project.autoProxy, for the checkbox. */
  autoProxy: boolean;
  /** This cut's proxy job, as this tab last heard of it. */
  job: ProxyProgress | undefined;
  /** The browser refused the file that's playing. */
  broken: boolean;
  /** The cut's length in seconds, for the size in Create proxy's tooltip. */
  duration: number;
  toast(message: string): void;
  onChanged(): void;
  noteProxyJob(job: ProxyJob): void;
  /** §21.5 (review M4): hidden, not unmounted, while another format than the primary is on screen. */
  hidden?: boolean;
}

const ensureStop = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/**
 * §19.5's bar under the player, one row so the timeline and the note box stay on screen: the offer
 * and its reason, "Creating proxy" with progress and Cancel, or "✓ Proxy ready", each followed by
 * the checkbox that makes proxies for new cuts automatically (which wraps after the button, never
 * before it, when there's no room). "✓ Proxy ready" folds away after DONE_SHOWN_MS or on its ×,
 * leaving the checkbox alone. Picture keys this by version, so nothing carries across cuts.
 */
export function ProxyBar({ video, version, ffmpeg, autoProxy, job, broken, duration, toast, onChanged, noteProxyJob, hidden = false }: ProxyBarProps) {
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [auto, setAuto] = useState(autoProxy);
  useEffect(() => setAuto(autoProxy), [autoProxy]);
  // The jobs this view has seen running (or started itself): only those end in "✓ Proxy ready".
  // An existing proxy, met on opening the film, just brings the Proxy/Original switch.
  const watched = useRef(new Set<string>());
  if (job?.state === "running") watched.current.add(job.job);
  // The finished job whose "✓ Proxy ready" has been folded away, by time or by its ×.
  const [dismissed, setDismissed] = useState<string | null>(null);

  const phase = proxyPhase({
    ffmpeg,
    need: version.proxyNeed,
    broken,
    hasProxy: !!version.proxy,
    job,
    starting,
    watched: !!job && watched.current.has(job.job),
  });
  const doneJob = phase === "done" && job ? job.job : null;
  useEffect(() => {
    if (!doneJob) return;
    const timer = window.setTimeout(() => setDismissed(doneJob), DONE_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [doneJob]);

  if (!ffmpeg) return null;

  const shown = doneJob && dismissed === doneJob ? "none" : phase;
  const reason = proxyReason(version.proxyNeed, broken);
  const pct = job?.state === "running" ? job.pct : job?.state === "done" ? 100 : 0;
  const running = job?.state === "running" ? job : null;

  const create = async () => {
    if (starting) return;
    setStarting(true);
    try {
      const { job: started } = await api.post<{ job: ProxyJob }>(`/api/videos/${encodeURIComponent(video.id)}/versions/${encodeURIComponent(version.id)}/proxy`);
      watched.current.add(started.id);
      noteProxyJob(started);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!running || cancelling) return;
    setCancelling(true);
    try {
      const { job: ended } = await api.del<{ job: ProxyJob }>(`/api/proxy-jobs/${encodeURIComponent(running.job)}`);
      noteProxyJob(ended);
    } catch (e) {
      // Already over (finished, failed, or cancelled from another tab): the state says how it ended.
      if (e instanceof ApiError && e.code === "not_found") onChanged();
      else toast((e as Error).message);
    } finally {
      setCancelling(false);
    }
  };

  const toggleAuto = async (on: boolean) => {
    setAuto(on);
    try {
      await api.put("/api/project/settings", { autoProxy: on });
      onChanged();
    } catch (e) {
      setAuto(!on);
      toast((e as Error).message);
    }
  };

  const check = (
    <label class="check">
      <input
        type="checkbox"
        checked={auto}
        onChange={(e) => {
          const el = e.currentTarget as HTMLInputElement;
          // So Space, ←/→ and the other keys go back to the player, as after picking a version.
          el.blur();
          void toggleAuto(el.checked);
        }}
      />
      Create proxies for new cuts like this automatically
    </label>
  );

  return (
    <div class={`proxybar${shown === "none" ? " quiet" : ""}`} hidden={hidden}>
      <div class={`proxyrow${shown === "none" ? "" : ` ${shown}`}`}>
        {shown === "offer" && reason && (
          <>
            <span class="why"><b>This cut may play slowly.</b> {ensureStop(reason)}</span>
            <button class="btn primary tip-wrap tip-end" aria-label="Create proxy" data-tip={proxyTip(version.duration ?? duration)} onClick={() => void create()}>Create proxy</button>
          </>
        )}
        {shown === "working" && (
          <>
            <span>Creating proxy</span>
            <div class="pbar" role="progressbar" aria-label="Proxy progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <i style={{ width: `${pct}%` }} />
            </div>
            <span class="mono">{pct}%</span>
            <button class="btn" aria-disabled={!running || cancelling} onClick={() => void cancel()}>Cancel</button>
          </>
        )}
        {shown === "done" && version.proxy && (
          <>
            <span class="ok">✓ Proxy ready</span>
            <span class="why">Saved to <span class="mono">{version.proxy.file}</span> ({formatBytes(version.proxy.bytes)}).</span>
            <button class="btn ghost ib" aria-label="Dismiss" data-tip="Dismiss" onClick={() => setDismissed(doneJob)}><Icon name="x" /></button>
          </>
        )}
        {check}
      </div>
    </div>
  );
}
