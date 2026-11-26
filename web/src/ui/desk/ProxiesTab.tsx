// §36.7: the notes panel's Proxies tab, after Activity. The quality (four presets), the project's "always make proxies"
// switch, Make proxies now, Test connection, the list of cuts with their proxies, and Delete all proxies.
import { useRef, useState } from "preact/hooks";
import { api, ApiError, mediaUrl } from "../../api.js";
import { formatBytes, proxyKey, speedText, type ProxyJobs, type ProxyProgress } from "../../lib.js";
import { PRESETS, PROXY_PRESETS, presetsThatFit, proxyIsAt, proxyQuality, type ProxyPreset } from "../../../../src/core/proxyPresets.js";
import type { Project, ProxyJob, Version, Video } from "../../types.js";
import { Icon } from "../Icon.js";

export interface ProxiesTabProps {
  project: Project;
  /** The server has ffmpeg and ffprobe. */
  ffmpeg: boolean;
  /** Every proxy job this tab knows of. */
  jobs: ProxyJobs;
  noteProxyJob(job: ProxyJob): void;
  /** The cut on screen, for Test connection; the newest cut when none is. */
  current: { video: string; version: string } | null;
  toast(message: string): void;
  onChanged(): void;
}

/** One row of the list: a cut, and what its proxy is. */
interface Row {
  video: Video;
  version: Version;
  latest: boolean;
}

/** Each film's latest cut, plus every cut that has a proxy, newest first. Shelved films only for a proxy they hold. */
export function proxyRows(project: Project): Row[] {
  const rows: Row[] = [];
  for (const video of project.videos) {
    const last = video.versions[video.versions.length - 1];
    for (const version of video.versions) {
      const latest = version === last && !video.shelved;
      if (latest || version.proxy) rows.push({ video, version, latest });
    }
  }
  return rows.sort((a, b) => (a.version.addedAt === b.version.addedAt ? 0 : a.version.addedAt < b.version.addedAt ? 1 : -1));
}

/** How many films' latest cuts have no proxy at `preset` (Make proxies now's count). */
export function latestMissing(project: Project, preset: ProxyPreset, jobs: ProxyJobs): number {
  return project.videos.filter((video) => {
    if (video.shelved) return false;
    const v = video.versions[video.versions.length - 1];
    if (!v || proxyIsAt(v.proxy, preset)) return false;
    const j = jobs[proxyKey(video.id, v.id)];
    return !(j && (j.state === "queued" || j.state === "running") && j.preset === preset);
  }).length;
}

/** The size Test connection fetches: enough to time a slow link, small enough to finish in seconds on one. */
export const TEST_BYTES = 16 * 1024 * 1024;

const cutPath = (video: string, version: string) => `/api/videos/${encodeURIComponent(video)}/versions/${encodeURIComponent(version)}/proxy`;

export function ProxiesTab({ project, ffmpeg, jobs, noteProxyJob, current, toast, onChanged }: ProxiesTabProps) {
  const preset = project.proxyPreset;
  const [busy, setBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [speed, setSpeed] = useState<{ state: "idle" | "testing" | "done" | "failed"; mbps?: number }>({ state: "idle" });
  const testing = useRef<AbortController | null>(null);

  if (!ffmpeg) {
    return (
      <div class="proxtab">
        <p class="proxnote">Proxies need ffmpeg, which isn't installed on the computer running Rushes. Run <span class="mono">rushes doctor</span> for how to add it.</p>
      </div>
    );
  }

  const rows = proxyRows(project);
  const missing = latestMissing(project, preset, jobs);
  const total = project.videos.reduce((n, v) => n + v.versions.reduce((m, x) => m + (x.proxy?.bytes ?? 0), 0), 0);
  const fits = speed.state === "done" && speed.mbps !== undefined ? new Set(presetsThatFit(speed.mbps)) : null;

  const settings = async (change: { alwaysProxy?: boolean; proxyPreset?: ProxyPreset }) => {
    try {
      const r = await api.put<{ jobs: ProxyJob[] }>("/api/project/settings", change);
      for (const j of r.jobs ?? []) noteProxyJob(j);
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const makeNow = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.post<{ jobs: ProxyJob[] }>("/api/proxies");
      for (const j of r.jobs) noteProxyJob(j);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const make = async (row: Row) => {
    try {
      const r = await api.post<{ job: ProxyJob }>(cutPath(row.video.id, row.version.id), { preset });
      noteProxyJob(r.job);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const cancel = async (job: ProxyProgress) => {
    try {
      const r = await api.del<{ job: ProxyJob }>(`/api/proxy-jobs/${encodeURIComponent(job.job)}`);
      noteProxyJob(r.job);
    } catch (e) {
      if (e instanceof ApiError && e.code === "not_found") onChanged();
      else toast((e as Error).message);
    }
  };
  const remove = async (row: Row) => {
    try {
      await api.del(cutPath(row.video.id, row.version.id));
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const removeAll = async () => {
    setConfirmAll(false);
    try {
      await api.del("/api/proxies");
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  // §36.7: times a ranged, uncached fetch of the cut on screen from this browser. It only reports; it changes nothing.
  const testConnection = async () => {
    const target = current ?? (rows[0] ? { video: rows[0].video.id, version: rows[0].version.id } : null);
    const version = target && project.videos.find((v) => v.id === target.video)?.versions.find((v) => v.id === target.version);
    if (!version) return toast("Add a cut first: the test times a download of it");
    testing.current?.abort();
    const controller = new AbortController();
    testing.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 60_000);
    setSpeed({ state: "testing" });
    try {
      const started = performance.now();
      const r = await fetch(mediaUrl(version.file), { headers: { Range: `bytes=0-${TEST_BYTES - 1}` }, cache: "no-store", signal: controller.signal });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const reader = r.body.getReader();
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes >= TEST_BYTES) {
          await reader.cancel();
          break;
        }
      }
      const seconds = (performance.now() - started) / 1000;
      setSpeed({ state: "done", mbps: (bytes * 8) / Math.max(seconds, 0.001) / 1e6 });
    } catch {
      setSpeed({ state: controller.signal.aborted && testing.current !== controller ? "idle" : "failed" });
    } finally {
      clearTimeout(timer);
      if (testing.current === controller) testing.current = null;
    }
  };

  return (
    <div class="proxtab">
      <section class="proxsec" aria-labelledby="prox-quality">
        <h3 id="prox-quality" class="proxh">Quality</h3>
        <div role="radiogroup" aria-labelledby="prox-quality" class="proxpresets">
          {PROXY_PRESETS.map((id) => (
            <label key={id} class={`proxpreset${id === preset ? " on" : ""}`}>
              <input type="radio" name="proxy-preset" value={id} checked={id === preset} onChange={() => void settings({ proxyPreset: id })} />
              <span class="pname">
                {PRESETS[id].label}
                {fits && (fits.has(id) ? <span class="pfit" aria-label="should play smoothly from here"><Icon name="check" /></span> : null)}
              </span>
              <span class="phint">{PRESETS[id].hint}</span>
            </label>
          ))}
        </div>
      </section>

      <section class="proxsec">
        <button
          type="button"
          role="switch"
          class="proxswitch"
          aria-checked={project.alwaysProxy}
          onClick={() => void settings({ alwaysProxy: !project.alwaysProxy })}
        >
          <span class="track" aria-hidden="true"><i /></span>
          <span>Always make proxies for this project</span>
        </button>
        <p class="proxnote">
          {project.alwaysProxy
            ? `Every new cut gets a ${PRESETS[preset].label} proxy straight away.`
            : "Proxies are made only when you ask."}
        </p>
        {!project.alwaysProxy && missing > 0 && (
          <button type="button" class="btn" aria-disabled={busy} onClick={() => void makeNow()}>
            Make proxies now <span class="count">{missing}</span>
          </button>
        )}
      </section>

      <section class="proxsec proxtest">
        <button type="button" class="btn" aria-disabled={speed.state === "testing"} onClick={() => void testConnection()} data-tip="Times a short download of the cut on screen, from this browser">
          {speed.state === "testing" ? "Testing…" : "Test connection"}
        </button>
        <span class="proxspeed" role="status">
          {speed.state === "done" && speed.mbps !== undefined && speedText(speed.mbps)}
          {speed.state === "failed" && "Couldn't time a download from here"}
        </span>
      </section>

      <section class="proxsec" aria-labelledby="prox-list">
        <h3 id="prox-list" class="proxh">Cuts</h3>
        {rows.length === 0 ? (
          <p class="proxnote">No cuts yet.</p>
        ) : (
          <ul class="proxlist">
            {rows.map((row) => (
              <ProxyListRow key={`${row.video.id}/${row.version.id}`} row={row} preset={preset} job={jobs[proxyKey(row.video.id, row.version.id)]} onMake={() => void make(row)} onCancel={(j) => void cancel(j)} onDelete={() => void remove(row)} />
            ))}
          </ul>
        )}
        <div class="proxfoot">
          <span class="proxtotal">{total > 0 ? `Proxies use ${formatBytes(total)}` : "No proxies on disk"}</span>
          {total > 0 && !confirmAll && (
            <button type="button" class="btn ghost" onClick={() => setConfirmAll(true)}>Delete all proxies</button>
          )}
          {confirmAll && (
            <span class="aconfirm" role="group" aria-label="Delete all proxies?" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setConfirmAll(false); } }}>
              <span>Delete all proxies? Originals are kept.</span>
              <button type="button" class="btn danger" onClick={() => void removeAll()}>Delete all</button>
              <button type="button" class="btn ghost" onClick={() => setConfirmAll(false)}>Keep</button>
            </span>
          )}
        </div>
      </section>
    </div>
  );
}

function ProxyListRow({ row, preset, job, onMake, onCancel, onDelete }: {
  row: Row;
  preset: ProxyPreset;
  job: ProxyProgress | undefined;
  onMake(): void;
  onCancel(job: ProxyProgress): void;
  onDelete(): void;
}) {
  const { video, version } = row;
  const proxy = version.proxy;
  const active = job && (job.state === "queued" || job.state === "running") ? job : null;
  const older = !!proxy && !proxyIsAt(proxy, preset);
  const state = active ? (active.state === "queued" ? "queued" : "making") : proxy ? (older ? "older" : "ready") : "none";
  const label = `${video.name} · ${version.id}`;
  return (
    <li class={`proxrow ${state}`} data-cut={`${video.id}/${version.id}`}>
      <div class="pcut">
        <span class="pnm" dir="auto">{label}</span>
        <span class="pstate">
          {state === "none" && "No proxy"}
          {state === "queued" && `Queued · ${PRESETS[active!.preset].label}`}
          {state === "making" && `Making ${PRESETS[active!.preset].label} · ${active!.pct}%`}
          {state === "ready" && `${proxyQuality(proxy!)} · ${formatBytes(proxy!.bytes)}`}
          {state === "older" && `Older quality (${proxyQuality(proxy!)}, ${formatBytes(proxy!.bytes)}), remake?`}
        </span>
        {state === "making" && (
          <div class="pbar" role="progressbar" aria-label={`Proxy progress for ${label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={active!.pct}>
            <i style={{ width: `${active!.pct}%` }} />
          </div>
        )}
      </div>
      <div class="pacts">
        {active ? (
          <button type="button" class="btn" aria-label={`Cancel the proxy for ${label}`} onClick={() => onCancel(active)}>Cancel</button>
        ) : (
          <>
            {state !== "ready" && (
              <button type="button" class="btn" aria-label={`${proxy ? "Remake" : "Make"} the proxy for ${label}`} onClick={onMake}>{proxy ? "Remake" : "Make"}</button>
            )}
            {proxy && (
              <button type="button" class="btn ghost ib" aria-label={`Delete the proxy for ${label}`} data-tip="Delete proxy (the original is kept)" onClick={onDelete}>
                <Icon name="trash" />
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}
