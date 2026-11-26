// §36.7, §37.5: the notes panel's Proxies tab, after Activity. The qualities (four checkboxes, one or more ticked), Make
// proxies for this cut and for all films, the project's "always make proxies" switch, Test connection, the list of cuts
// with a line per proxy, and Delete all proxies.
import { useRef, useState } from "preact/hooks";
import { api, ApiError, mediaUrl } from "../../api.js";
import { cutJobs, cutMissing, formatBytes, latestMissing, speedText, toMake, toggledPresets, type ProxyJobs, type ProxyProgress } from "../../lib.js";
import {
  LEGACY_PROXY, PRESETS, PROXY_PRESETS, hasAnyProxy, presetNames, presetsThatFit, proxyList, slotInUse, slotLabel,
  type ProxyPreset, type ProxySlot,
} from "../../../../src/core/proxyPresets.js";
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

/** One row of the list: a cut, and what proxies it has. */
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
      if (latest || hasAnyProxy(version.proxies)) rows.push({ video, version, latest });
    }
  }
  return rows.sort((a, b) => (a.version.addedAt === b.version.addedAt ? 0 : a.version.addedAt < b.version.addedAt ? 1 : -1));
}

/** The size Test connection fetches: enough to time a slow link, small enough to finish in seconds on one. */
export const TEST_BYTES = 16 * 1024 * 1024;

const cutPath = (video: string, version: string) => `/api/videos/${encodeURIComponent(video)}/versions/${encodeURIComponent(version)}/proxy`;

export function ProxiesTab({ project, ffmpeg, jobs, noteProxyJob, current, toast, onChanged }: ProxiesTabProps) {
  const ticked = project.proxyPresets;
  const [busy, setBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [lastRefused, setLastRefused] = useState(false);
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
  const allCount = latestMissing(project, ticked, jobs);
  const onScreen = current && project.videos.find((v) => v.id === current.video);
  const onScreenVersion = onScreen?.versions.find((v) => v.id === current!.version);
  const cutCount = cutMissing(project, current, ticked, jobs);
  const total = project.videos.reduce((n, v) => n + v.versions.reduce((m, x) => m + proxyList(x.proxies).reduce((k, e) => k + e.proxy.bytes, 0), 0), 0);
  const fits = speed.state === "done" && speed.mbps !== undefined ? new Set(presetsThatFit(speed.mbps)) : null;

  const settings = async (change: { alwaysProxy?: boolean; proxyPresets?: ProxyPreset[] }) => {
    try {
      const r = await api.put<{ jobs: ProxyJob[] }>("/api/project/settings", change);
      for (const j of r.jobs ?? []) noteProxyJob(j);
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const toggle = (id: ProxyPreset) => {
    const next = toggledPresets(ticked, id);
    if (!next) {
      setLastRefused(true);
      return;
    }
    setLastRefused(false);
    void settings({ proxyPresets: next });
  };
  const run = async (work: () => Promise<ProxyJob[]>) => {
    if (busy) return;
    setBusy(true);
    try {
      for (const j of await work()) noteProxyJob(j);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const makeAll = () => (allCount > 0 ? run(async () => (await api.post<{ jobs: ProxyJob[] }>("/api/proxies")).jobs) : undefined);
  const makeCut = () =>
    current && cutCount.length > 0 ? run(async () => (await api.post<{ jobs: ProxyJob[] }>(cutPath(current.video, current.version))).jobs) : undefined;
  const make = (row: Row, preset: ProxyPreset) => run(async () => [(await api.post<{ job: ProxyJob }>(cutPath(row.video.id, row.version.id), { preset })).job]);
  const cancel = async (job: ProxyProgress) => {
    try {
      const r = await api.del<{ job: ProxyJob }>(`/api/proxy-jobs/${encodeURIComponent(job.job)}`);
      noteProxyJob(r.job);
    } catch (e) {
      if (e instanceof ApiError && e.code === "not_found") onChanged();
      else toast((e as Error).message);
    }
  };
  const remove = async (row: Row, slot: ProxySlot) => {
    try {
      await api.del(`${cutPath(row.video.id, row.version.id)}?preset=${slot}`);
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

  const cutName = onScreen && onScreenVersion ? `${onScreen.name} ${onScreenVersion.id}` : "";
  const cutTip = !current || !onScreenVersion
    ? "Open a cut to make its proxies"
    : cutCount.length > 0
      ? `Makes ${presetNames(cutCount)} for ${cutName}`
      : `${cutName} has every ticked quality, or it's being made`;
  const allTip = allCount > 0 ? "Makes the ticked qualities each film's latest cut is missing" : "Every film's latest cut has the ticked qualities, or they're being made";
  const cutOff = cutCount.length === 0 || busy;
  const allOff = allCount === 0 || busy;

  return (
    <div class="proxtab">
      <section class="proxsec" aria-labelledby="prox-quality">
        <h3 id="prox-quality" class="proxh">Quality</h3>
        <div role="group" aria-labelledby="prox-quality" class="proxpresets">
          {PROXY_PRESETS.map((id) => {
            const on = ticked.includes(id);
            return (
              <label key={id} class={`proxpreset${on ? " on" : ""}`}>
                <input type="checkbox" name="proxy-preset" value={id} checked={on} onChange={(e) => {
                    // The last ticked one stays ticked: the box is put back, and the line under the group says why.
                    if (!toggledPresets(ticked, id)) (e.currentTarget as HTMLInputElement).checked = true;
                    toggle(id);
                  }} />
                <span class="pname">
                  {PRESETS[id].label}
                  {fits && (fits.has(id) ? <span class="pfit" aria-label="should play smoothly from here"><Icon name="check" /></span> : null)}
                </span>
                <span class="phint">{PRESETS[id].hint}</span>
              </label>
            );
          })}
        </div>
        <p class="proxnote proxlast" role="status">{lastRefused ? "Keep at least one quality ticked." : ""}</p>
        <div class="proxmake">
          <button type="button" class={`btn${cutOff ? "" : " primary"} tip-wrap`} aria-disabled={cutOff} data-tip={cutTip} onClick={() => void makeCut()}>
            Make proxies for this cut{cutCount.length > 0 && <span class="count">{cutCount.length}</span>}
          </button>
          <button type="button" class={`btn${allOff ? "" : " primary"} tip-wrap`} aria-disabled={allOff} data-tip={allTip} onClick={() => void makeAll()}>
            Make proxies for all films{allCount > 0 && <span class="count">{allCount}</span>}
          </button>
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
            ? `Every new cut gets ${presetNames(ticked)} straight away.`
            : "Proxies are made only when you ask."}
        </p>
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
              <ProxyListRow
                key={`${row.video.id}/${row.version.id}`}
                row={row}
                ticked={ticked}
                jobs={cutJobs(jobs, row.video.id, row.version.id)}
                onMake={(p) => void make(row, p)}
                onCancel={(j) => void cancel(j)}
                onDelete={(slot) => void remove(row, slot)}
              />
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

/** §37.5: one cut: a line per proxy it has and per quality being made, then a Make button per ticked quality it lacks. */
function ProxyListRow({ row, ticked, jobs, onMake, onCancel, onDelete }: {
  row: Row;
  ticked: readonly ProxyPreset[];
  jobs: readonly ProxyProgress[];
  onMake(preset: ProxyPreset): void;
  onCancel(job: ProxyProgress): void;
  onDelete(slot: ProxySlot): void;
}) {
  const { video, version } = row;
  const label = `${video.name} · ${version.id}`;
  const active = jobs.filter((j) => j.state === "queued" || j.state === "running");
  const making = new Set(active.map((j) => j.preset));
  const have = proxyList(version.proxies).filter((e) => !(e.slot !== LEGACY_PROXY && making.has(e.slot)));
  const lacking = toMake(version.proxies, ticked, making);
  return (
    <li class="proxrow" data-cut={`${video.id}/${version.id}`}>
      <span class="pnm" dir="auto">{label}</span>
      {have.length === 0 && active.length === 0 && <span class="pline none"><span class="pstate">No proxy</span></span>}
      {have.map(({ slot, proxy }) => {
        const inUse = slotInUse(slot, ticked);
        return (
          <div key={slot} class={`pline ${inUse ? "ready" : "unused"}`} data-preset={slot}>
            <span class="pstate">{slotLabel(slot)} · {formatBytes(proxy.bytes)}{inUse ? "" : " · Not in use"}</span>
            <button type="button" class="btn ghost ib" aria-label={`Delete the ${slotLabel(slot)} proxy for ${label}`} data-tip="Delete proxy (the original is kept)" onClick={() => onDelete(slot)}>
              <Icon name="trash" />
            </button>
          </div>
        );
      })}
      {active.map((job) => (
        <div key={job.job} class={`pline ${job.state === "queued" ? "queued" : "making"}`} data-preset={job.preset}>
          <span class="pstate">{job.state === "queued" ? `Queued · ${PRESETS[job.preset].label}` : `Making ${PRESETS[job.preset].label} · ${job.pct}%`}</span>
          <button type="button" class="btn" aria-label={`Cancel the ${PRESETS[job.preset].label} proxy for ${label}`} onClick={() => onCancel(job)}>Cancel</button>
          {job.state === "running" && (
            <div class="pbar" role="progressbar" aria-label={`Proxy progress for ${label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.pct}>
              <i style={{ width: `${job.pct}%` }} />
            </div>
          )}
        </div>
      ))}
      {lacking.length > 0 && (
        <div class="pmake">
          {lacking.map((p) => (
            <button key={p} type="button" class="btn sm" aria-label={`Make the ${PRESETS[p].label} proxy for ${label}`} onClick={() => onMake(p)}>
              Make {PRESETS[p].label}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}
