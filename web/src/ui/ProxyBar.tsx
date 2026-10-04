import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../api.js";
import { formatBytes, proxyPhase, proxyReason, proxyTip, type ProxyProgress } from "../lib.js";
import type { ProxyJob, Version, Video } from "../types.js";

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
}

const ensureStop = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/**
 * §19.5's bar under the player: the offer and its reason, "Creating proxy" with progress and
 * Cancel, then "✓ Proxy ready", and the checkbox that makes proxies for new cuts automatically.
 * Rendered inside Picture, which is keyed by film, so "✓ Proxy ready" lasts until the film changes.
 */
export function ProxyBar({ video, version, ffmpeg, autoProxy, job, broken, duration, toast, onChanged, noteProxyJob }: ProxyBarProps) {
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [auto, setAuto] = useState(autoProxy);
  useEffect(() => setAuto(autoProxy), [autoProxy]);
  // The jobs this view has seen running (or started itself): only those end in "✓ Proxy ready".
  // An existing proxy, met on opening the film, just brings the Proxy/Original switch.
  const watched = useRef(new Set<string>());
  if (job?.state === "running") watched.current.add(job.job);

  if (!ffmpeg) return null;

  const phase = proxyPhase({
    ffmpeg,
    need: version.proxyNeed,
    broken,
    hasProxy: !!version.proxy,
    job,
    starting,
    watched: !!job && watched.current.has(job.job),
  });
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

  return (
    <div class={`proxybar${phase === "none" ? " quiet" : ""}`}>
      {phase === "offer" && reason && (
        <div class="proxyrow offer">
          <span class="why"><b>This cut may play slowly.</b> {ensureStop(reason)}</span>
          <button class="btn primary tip-wrap tip-end" aria-label="Create proxy" data-tip={proxyTip(version.duration ?? duration)} onClick={() => void create()}>Create proxy</button>
        </div>
      )}
      {phase === "working" && (
        <div class="proxyrow working">
          <span>Creating proxy</span>
          <div class="pbar" role="progressbar" aria-label="Proxy progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <i style={{ width: `${pct}%` }} />
          </div>
          <span class="mono">{pct}%</span>
          <button class="btn" aria-disabled={!running || cancelling} onClick={() => void cancel()}>Cancel</button>
        </div>
      )}
      {phase === "done" && version.proxy && (
        <div class="proxyrow done">
          <span class="ok">✓ Proxy ready</span>
          <span class="why">
            Saved to <span class="mono">{version.proxy.file}</span> ({formatBytes(version.proxy.bytes)}). Grab Frame still uses the original, at full quality.
          </span>
        </div>
      )}
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
    </div>
  );
}
