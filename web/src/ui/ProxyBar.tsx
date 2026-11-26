import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../api.js";
import { formatBytes, proxyPhase, proxyReason, proxyTip, type ProxyProgress } from "../lib.js";
import { DEFAULT_PROXY_PRESET, PRESETS, proxyIsAt, type ProxyPreset } from "../../../src/core/proxyPresets.js";
import type { ProxyJob, Version, Video } from "../types.js";
import { Icon } from "./Icon.js";

/** How long "✓ Proxy ready" stays before the bar folds away. */
export const DONE_SHOWN_MS = 6000;

export interface ProxyBarProps {
  video: Video;
  version: Version;
  /** The server has ffmpeg and ffprobe. Without them nothing is offered and this renders nothing. */
  ffmpeg: boolean;
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
  /** §36.3: the project's preset, which a proxy made from here is made at. */
  preset?: ProxyPreset;
  /** §36.7: the toolbar's Proxies is on in this browser. */
  proxiesOn?: boolean;
  /** §36.7: turns the toolbar's Proxies on (the stall hint's button, and the offer's Create proxy). */
  onProxiesOn?(): void;
  /** §36.7: proxies are off and the player keeps stalling on this cut. */
  stalling?: boolean;
  /** §36.7: the stall hint was closed: it isn't shown again for this cut this session. */
  onStallDismissed?(): void;
}

const ensureStop = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/**
 * §19.5, §27 5.4 and §36.7: a message bar over the foot of the monitor. The offer and its reason; "Creating proxy" with
 * progress and Cancel (or "Waiting to make a proxy" while queued); "✓ Proxy ready", which folds away after DONE_SHOWN_MS
 * or on its ×; with Proxies on and no proxy for the cut, "No proxy for this cut" and Make proxy; with Proxies off and
 * the player stalling, "Playback is stalling. Turn on proxies?". With nothing to say it draws nothing. Picture keys this
 * by version, so nothing carries across cuts.
 */
export function ProxyBar({
  video, version, ffmpeg, job, broken, duration, toast, onChanged, noteProxyJob, hidden = false,
  preset = DEFAULT_PROXY_PRESET, proxiesOn = false, onProxiesOn, stalling = false, onStallDismissed,
}: ProxyBarProps) {
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // The jobs this view has seen running (or started itself): only those end in "✓ Proxy ready".
  // An existing proxy, met on opening the film, says nothing.
  const watched = useRef(new Set<string>());
  if (job?.state === "running" || job?.state === "queued") watched.current.add(job.job);
  // The finished job whose "✓ Proxy ready" has been folded away, by time or by its ×.
  const [dismissed, setDismissed] = useState<string | null>(null);
  // §36.7: the job made from the offer: once it is ready (and recorded), Proxies goes on so it plays. Cancelled or
  // failed, nothing changes, and the offer comes back as in §19.5.
  const turnOnWhenReady = useRef<string | null>(null);

  // A finished job whose record hasn't arrived yet (the cut still shows its old proxy, or none) is still "working".
  const hasProxy = !!version.proxy && (job?.state !== "done" || proxyIsAt(version.proxy, job.preset));
  const phase = proxyPhase({
    ffmpeg,
    need: version.proxyNeed,
    broken,
    hasProxy,
    job,
    starting,
    // Once its "✓ Proxy ready" has been folded away, a finished job says nothing more: the bar is free for what comes
    // next (the stall hint, "No proxy for this cut").
    watched: !!job && watched.current.has(job.job) && dismissed !== job.job,
    proxiesOn,
    stalling,
  });
  const doneJob = phase === "done" && job ? job.job : null;
  useEffect(() => {
    if (doneJob && turnOnWhenReady.current === doneJob) {
      turnOnWhenReady.current = null;
      onProxiesOn?.();
    }
  }, [doneJob]);
  useEffect(() => {
    if (!doneJob) return;
    const timer = window.setTimeout(() => setDismissed(doneJob), DONE_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [doneJob]);

  if (!ffmpeg) return null;

  const shown = phase;
  const reason = proxyReason(version.proxyNeed, broken);
  const pct = job?.state === "running" ? job.pct : job?.state === "done" ? 100 : 0;
  const active = job?.state === "running" || job?.state === "queued" ? job : null;
  // Nothing to say: the bar keeps its place in the tree (its state survives) but draws nothing.
  const empty = shown === "none" || (shown === "offer" && !reason) || (shown === "done" && !version.proxy);

  const create = async (turnOn: boolean) => {
    if (starting) return;
    setStarting(true);
    try {
      const { job: started } = await api.post<{ job: ProxyJob }>(
        `/api/videos/${encodeURIComponent(video.id)}/versions/${encodeURIComponent(version.id)}/proxy`,
        { preset },
      );
      watched.current.add(started.id);
      noteProxyJob(started);
      // §36.7: a proxy asked for from the offer is one you mean to watch: Proxies goes on once it is ready.
      if (turnOn) turnOnWhenReady.current = started.id;
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!active || cancelling) return;
    setCancelling(true);
    try {
      const { job: ended } = await api.del<{ job: ProxyJob }>(`/api/proxy-jobs/${encodeURIComponent(active.job)}`);
      noteProxyJob(ended);
    } catch (e) {
      // Already over (finished, failed, or cancelled from another tab): the state says how it ended.
      if (e instanceof ApiError && e.code === "not_found") onChanged();
      else toast((e as Error).message);
    } finally {
      setCancelling(false);
    }
  };

  const turnOn = () => {
    onProxiesOn?.();
    onStallDismissed?.();
    if (!version.proxy) void create(false);
  };

  return (
    <div class="proxybar" hidden={hidden || empty}>
      <div class={`proxyrow ${shown}`}>
        {shown === "offer" && reason && (
          <>
            <span class="why"><b>This cut may play slowly.</b> {ensureStop(reason)}</span>
            <button class="btn primary tip-wrap tip-end" aria-label="Create proxy" data-tip={proxyTip(version.duration ?? duration, preset)} onClick={() => void create(true)}>Create proxy</button>
          </>
        )}
        {shown === "missing" && (
          <>
            <span class="why"><b>No proxy for this cut.</b> Playing the original.</span>
            <button class="btn primary tip-wrap tip-end" aria-label="Make proxy" data-tip={proxyTip(version.duration ?? duration, preset)} onClick={() => void create(false)}>Make proxy</button>
          </>
        )}
        {shown === "stall" && (
          <>
            <span class="why"><b>Playback is stalling.</b> Turn on proxies?</span>
            <button class="btn primary tip-wrap tip-end" aria-label="Turn on proxies" data-tip={`Plays a lighter ${PRESETS[preset].label} copy of each cut. Your originals aren't changed.`} onClick={turnOn}>Turn on proxies</button>
            <button class="btn ghost ib" aria-label="Dismiss" data-tip="Dismiss" onClick={() => onStallDismissed?.()}><Icon name="x" /></button>
          </>
        )}
        {shown === "working" && (
          <>
            <span>{job?.state === "queued" ? "Waiting to make a proxy" : "Creating proxy"}</span>
            <div class="pbar" role="progressbar" aria-label="Proxy progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <i style={{ width: `${pct}%` }} />
            </div>
            <span class="mono">{pct}%</span>
            <button class="btn" aria-disabled={!active || cancelling} onClick={() => void cancel()}>Cancel</button>
          </>
        )}
        {shown === "done" && version.proxy && (
          <>
            <span class="ok">✓ Proxy ready</span>
            <span class="why">Saved to <span class="mono">{version.proxy.file}</span> ({formatBytes(version.proxy.bytes)}).</span>
            <button class="btn ghost ib" aria-label="Dismiss" data-tip="Dismiss" onClick={() => setDismissed(doneJob)}><Icon name="x" /></button>
          </>
        )}
      </div>
    </div>
  );
}
