import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, ApiError, projectId } from "../api.js";
import { LOCKED_TAB, testFlags, STAGE_NAMES, agentPrompt, copyShortcut, defaultVersion, firstTab, foundChip, foundSignature, latest, lockedFound, neighbourVideo, proxyKey, snap } from "../lib.js";
import type { Batch, FoundCounts, FoundKind, Stage, Video } from "../types.js";
import { useRushes } from "../useRushes.js";
import { assetRev } from "../audio/timeline.js";
import { Assets, type FoundRequest } from "./Assets.js";
import { Icon, STAGE_ICONS } from "./Icon.js";
import { Mix } from "./Mix.js";
import { Picture, type Source } from "./Picture.js";
import { Script } from "./Script.js";
import { VariantTab } from "./VariantTab.js";
import { Voice } from "./Voice.js";
import { VersionMenu } from "./VersionMenu.js";
import { ChangeLogButton, ChangeLogDrawer, focusRow, useChangeLog } from "./ChangeLog.js";
import type { JumpTarget } from "../changelog.js";

declare global {
  interface Window {
    /** Test-only (`?test=1`): opens Assets › Found, filtered to a kind when given. */
    __rushesOpenFound?: (kind?: FoundKind) => void;
  }
}

const ORDER: Stage[] = ["script", "picture", "voice", "music", "sfx", "mix"];
// Assets isn't a review stage (§15.3): it's a dashboard-only tab after the six stages, so it's
// kept out of Stage and ORDER entirely and handled as its own case throughout this file.
type View = Stage | "assets";
const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/** §19.1: a locked tab's own page -- what it's for, what unlocks it, and a prompt to copy for your agent. */
function Locked({ tab, projectName, filmName, found, onReview, toast }: { tab: Stage | "assets"; projectName: string; filmName: string | null; found: FoundCounts | undefined; onReview: (kind: FoundKind) => void; toast: (m: string) => void }) {
  const { what, unlocks } = LOCKED_TAB[tab];
  const name = tab === "assets" ? "Assets" : STAGE_NAMES[tab];
  const icon = tab === "assets" ? "grid" : STAGE_ICONS[tab];
  const prompt = agentPrompt(tab, projectName, filmName);
  // §20.5: when the folder holds files of this tab's kind, say so, and offer to look at them.
  const files = lockedFound(tab, found);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      toast("Prompt copied");
    } catch {
      // The clipboard was refused: the prompt is selected instead, so say what to press.
      boxRef.current?.select();
      toast(`Prompt selected: press ${copyShortcut(navigator.platform)}`);
    }
  };
  return (
    <div class="empty locked">
      <Icon name={icon} />
      <h2>{name}</h2>
      <p>{what}</p>
      <p>{unlocks}</p>
      <textarea class="promptbox mono" readOnly rows={4} ref={boxRef} value={prompt} aria-label="Prompt for your agent" />
      <button class="btn primary" onClick={() => void copyPrompt()}>
        <Icon name="copy" />
        Copy prompt for your agent
      </button>
      {files && (
        <p class="foundline">
          <span>{files.text}</span>
          <button type="button" class="btn" aria-label={files.review} onClick={() => onReview(files.kind)}>
            Review
          </button>
        </p>
      )}
    </div>
  );
}

export function App() {
  const { state, assets, problem, wrongProject, refresh, proxyJobs, noteProxyJob } = useRushes();
  const [stage, setStage] = useState<View | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [toastText, setToastText] = useState<string | null>(null);
  const [sent, setSent] = useState<Batch | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  // True while Rushes, not you, is holding the cut on screen because marks are pending.
  const [held, setHeld] = useState(false);
  // Where the next film's player should seek to once loaded, restoring that film's playhead.
  const [startAt, setStartAt] = useState(0);
  // Each film's pending grab (a screenshot waiting to be attached to its next note), keyed by
  // video id. This is the single source of truth: Picture holds no copy of its own, so there's
  // nothing for a remount to get stale against, and a film's entry survives a switch away and
  // back, or a trip to another tab, without needing to be threaded through per-switch memory.
  const [grabs, setGrabs] = useState<Record<string, string | null>>({});
  const toastTimer = useRef<number | undefined>(undefined);
  // Per-film memory: playhead, version choice and hold state, so switching films and coming
  // back doesn't lose your place. Keyed by video id.
  const memory = useRef(new Map<string, { versionId: string | null; held: boolean; t: number }>());
  // The playing <video> element, forwarded up from Picture, so a switch can read its live
  // currentTime directly (never stale) and pause it before it unmounts.
  const playerRef = useRef<HTMLVideoElement | null>(null);
  // Tells Picture whenever its pending grab changes, so App can remember it per film.
  const setGrabFor = (forVideo: string, grab: string | null) => setGrabs((g) => ({ ...g, [forVideo]: grab }));
  // §19.5: each film's Proxy/Original choice, in memory only. Proxy unless you've picked Original.
  const [sources, setSources] = useState<Record<string, Source>>({});
  const setSourceFor = (forVideo: string, source: Source) => setSources((s) => ({ ...s, [forVideo]: source }));
  // Proxy jobs whose failure has already been toasted, so each is said once.
  const toastedFailures = useRef(new Set<string>());

  // `ms`: how long it stays, for a message that takes longer than a glance to read.
  const toast = (message: string, ms = 2400) => {
    setToastText(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastText(null), ms);
  };
  // §20.5: a request to open Assets › Found (the header chip), and what the chip last said while Found was open.
  const [foundRequest, setFoundRequest] = useState<FoundRequest>({ n: 0, pending: false });
  const [foundSeen, setFoundSeen] = useState<string | null>(null);
  // §22.8: the Change Log drawer, and whether lines arrived since it was last open.
  const changeLog = useChangeLog(projectId() ?? "", state?.log);
  const changeLogButton = useRef<HTMLButtonElement>(null);

  // §19.5: a proxy that fails says why, in whichever tab is open; the bar returns to the offer.
  useEffect(() => {
    for (const p of Object.values(proxyJobs)) {
      if (p.state !== "failed" || toastedFailures.current.has(p.job)) continue;
      toastedFailures.current.add(p.job);
      toast(p.reason ?? "Couldn't make the proxy");
    }
  }, [proxyJobs]);

  // First load: pick a tab and a video.
  useEffect(() => {
    if (!state) return;
    if (stage === null) setStage(firstTab(state.tabs));
    if (videoId === null && state.project.videos[0]) setVideoId(state.project.videos[0].id);
  }, [state]);

  // The tab's title follows the project's name as soon as it's known.
  useEffect(() => {
    if (state?.project.name) document.title = `${state.project.name} · Rushes`;
  }, [state?.project.name]);

  // Follow the locked version if there is one, otherwise the newest, unless you've chosen another.
  const video = state?.project.videos.find((v) => v.id === videoId) ?? state?.project.videos[0];
  const newest = latest(video);
  const target = defaultVersion(video);
  const version = video?.versions.find((v) => v.id === versionId) ?? target;
  const locked = !!video?.lockedVersion;
  const fps = version?.fps ?? state?.project.fps ?? 30;
  // §19.9: the cut's file as Assets lists it: its size and revision, for the Picture waveform.
  const cutAsset = version ? assets.find((a) => a.kind === "cut" && a.path === version.file) : undefined;

  // A new cut arriving mid-review mustn't rewind the player or drop pending marks. So the
  // moment something's pending, hold the cut on screen; a newer one then waits behind a chip.
  // Holding before the cut arrives means the player never renders the new cut, even once.
  useEffect(() => {
    if (pending && versionId === null && target) {
      setVersionId(target.id);
      setHeld(true);
    } else if (!pending && held && versionId === target?.id) {
      setVersionId(null);
      setHeld(false);
    }
  }, [pending, versionId, target?.id]);
  // A version pin that now matches where the film would follow anyway — e.g. one left over
  // from peeking at a newer cut via the "vN ready" chip, now that an unlock has made that
  // cut the default — is cleared. Otherwise it would keep overriding "follow" even once it's
  // redundant, silently stopping the film from auto-following the next cut that arrives.
  useEffect(() => {
    if (!held && versionId !== null && versionId === target?.id) setVersionId(null);
  }, [target?.id, held, versionId]);
  // The chip shows whenever a newer cut than the one on screen exists, and either the video is
  // locked (so nothing would otherwise tell you a newer one arrived) or the cut is held.
  const readyVersionId = newest && version && newest.id !== version.id && (locked || held) ? newest.id : null;
  const jumpToReady = () => {
    // Always the newest, even when locked: this views it without touching the lock.
    if (newest) setVersionId(newest.id);
    setHeld(false);
  };

  /** Switches to another film, remembering this one's place and restoring the other's. Refused while marks are pending. */
  const switchFilm = (newId: string) => {
    if (!video || newId === video.id) return;
    if (pending) return toast(`Add or clear your note on ${video.name} first`);
    // Read the live element directly, and pause it before it unmounts: React state for the
    // playhead can lag behind what's actually on screen (e.g. mid-play, or a burst of seeks),
    // so this is the only way to be sure what's saved matches what was really showing.
    const el = playerRef.current;
    el?.pause();
    const t = el ? snap(el.currentTime, fps) : (memory.current.get(video.id)?.t ?? 0);
    memory.current.set(video.id, { versionId, held, t });
    const saved = memory.current.get(newId);
    setVideoId(newId);
    setVersionId(saved?.versionId ?? null);
    setHeld(saved?.held ?? false);
    setStartAt(saved?.t ?? 0);
  };

  const toggleLock = async () => {
    if (!video || !version) return;
    try {
      await api.put<{ video: Video }>(`/api/videos/${video.id}/lock`, { version: video.lockedVersion ? null : version.id });
      void refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  /** §22.8 (R18): a Change Log row opens what it's about: a cut on Picture at its version, a variant on its tab. */
  const jump = (to: JumpTarget) => {
    if (pending) return toast("Add or clear your note first");
    if (to.tab === "assets") return showAssets();
    if (to.video && to.video !== video?.id) switchFilm(to.video);
    if (to.version) {
      const film = state?.project.videos.find((v) => v.id === (to.video ?? video?.id));
      setVersionId(to.version === defaultVersion(film)?.id ? null : to.version);
      setHeld(false);
    }
    setStage(to.tab);
    setSent(null);
    if (to.row) focusRow(to.row);
  };

  const tabs = state?.tabs ?? [];
  const tab = (s: Stage) => tabs.find((t) => t.stage === s);
  const chip = foundChip(state?.found);
  // Found files are worth opening Assets for even before anything is registered: the chip leads there.
  const assetsUnlocked = assets.length > 0 || chip !== null;
  // Leaving a tab unmounts it, so a note in the making there (the same `pending` that holds the
  // film and New take) would be lost: refuse the switch instead, by click or by 1–7. A locked
  // tab always opens (§19.1): it shows its own page rather than a toast.
  const show = (s: Stage) => {
    if (pending && s !== stage) return toast("Add or clear your note first");
    setStage(s);
    setSent(null);
  };
  const showAssets = () => {
    if (pending && stage !== "assets") return toast("Add or clear your note first");
    setStage("assets");
    setSent(null);
  };
  /** Opens Assets › Found, filtered to one kind when given (the header chip; a locked tab's Review). */
  const openFound = (kind?: FoundKind) => {
    if (pending && stage !== "assets") return toast("Add or clear your note first");
    setFoundRequest((r) => ({ n: r.n + 1, kind, pending: true }));
    setStage("assets");
    setSent(null);
  };

  // Test-only (`?test=1`): what a locked tab's Review button does, which has no way in from the page yet.
  const openFoundRef = useRef(openFound);
  openFoundRef.current = openFound;
  useEffect(() => {
    if (testFlags(location.search).test) window.__rushesOpenFound = (kind) => openFoundRef.current(kind);
  }, []);

  // A layout effect, not a plain one: a plain effect's re-registration is deferred past the next
  // paint, so a key pressed right after a DOM update that this same closure needs (e.g. `]` then
  // `[` again, both switching films) could still hit the previous render's stale closure. The
  // layout effect re-binds synchronously with the commit instead.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 6) show(ORDER[n - 1]);
      else if (n === 7) showAssets();
      if ((e.key === "[" || e.key === "]") && state) {
        const nxt = neighbourVideo(state.project.videos, videoId, e.key === "]" ? 1 : -1);
        if (nxt) switchFilm(nxt);
      }
      if (e.key === "?") setKeysOpen((o) => !o);
      if (e.key === "Escape") {
        setKeysOpen(false);
        setSent(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Where the page body starts (below the header, tabs and any banner), as --body-top, so Picture
  // can cap its player at the window's height (fix round 1: a tall cut leaves room for the timeline
  // and the note box). Read after every render (a banner moves it), on resize, whenever the header
  // or the tabs change size without a render (a wrapped crumb, say), and once the web fonts have
  // loaded; written only when it changes.
  const bodyRef = useRef<HTMLElement>(null);
  const headRef = useRef<HTMLElement>(null);
  const tabsRef = useRef<HTMLElement>(null);
  const placeBody = () => {
    const el = bodyRef.current;
    if (!el) return;
    const top = `${Math.round(el.getBoundingClientRect().top + window.scrollY)}px`;
    const root = document.documentElement.style;
    if (root.getPropertyValue("--body-top") !== top) root.setProperty("--body-top", top);
  };
  useLayoutEffect(placeBody);
  useEffect(() => {
    const onResize = () => placeBody();
    window.addEventListener("resize", onResize);
    let live = true;
    void document.fonts?.ready.then(() => { if (live) placeBody(); });
    return () => {
      live = false;
      window.removeEventListener("resize", onResize);
    };
  }, []);
  // The header and tabs exist once the project has loaded, so they're observed from then on.
  const shellUp = !!state && !!stage;
  useEffect(() => {
    if (!shellUp) return;
    const ro = new ResizeObserver(() => placeBody());
    for (const el of [headRef.current, tabsRef.current]) if (el) ro.observe(el, { box: "border-box" });
    return () => ro.disconnect();
  }, [shellUp]);

  const send = async () => {
    if (!stage || stage === "assets") return;
    setKeysOpen(false);
    try {
      const { batch } = await api.post<{ batch: Batch }>("/api/batches", { stage });
      setSent(batch);
      setCopied(false);
      void refresh();
    } catch (e) {
      toast(e instanceof ApiError && e.code === "empty_batch" ? `Nothing open on ${STAGE_NAMES[stage]} to send` : (e as Error).message);
    }
  };
  const copy = async () => {
    if (!sent) return;
    try {
      await navigator.clipboard.writeText(sent.prompt);
      setCopied(true);
    } catch {
      toast("Couldn't reach the clipboard. Select the text and copy it.");
    }
  };

  if (!state || !stage) {
    return (
      <div class="shell">
        {problem ? <div class="banner"><Icon name="alert" />{problem}</div> : <div class="empty"><p>Loading…</p></div>}
      </div>
    );
  }

  const pictureNotes = state.notes.notes.filter((n) => n.stage === "picture" && (!n.video || n.video === video?.id));
  const hasTodo = (vid: string) => state.notes.notes.some((n) => n.stage === "picture" && n.status === "todo" && (!n.video || n.video === vid));
  const unlocked = stage === "assets" ? assetsUnlocked : (tab(stage)?.unlocked ?? false);
  const open = stage === "assets" ? 0 : (tab(stage)?.todo ?? 0);

  return (
    <div class="shell">
      <header class="head" ref={headRef}>
        <span class="logo"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg></span>
        <nav class="crumb" aria-label="Project">
          <span>{state.project.name}</span>
          {state.project.id && <span class="pid mono">{state.project.id}</span>}
          {video && state.project.videos.length === 1 && (
            <>
              <span class="slash">/</span>
              <span class="sel">{video.name}</span>
            </>
          )}
        </nav>
        {chip !== null && foundSignature(state.found) !== foundSeen && (
          <button type="button" class="foundchip" data-tip="Open the other files found in this project" onClick={() => openFound()}>
            <span class="dot" />
            {chip}
          </button>
        )}
        {video && state.project.videos.length > 1 && (
          <nav class="pack" aria-label="Films">
            {state.project.videos.map((v, i) => (
              <button class="pill" aria-pressed={v.id === video.id} onClick={() => switchFilm(v.id)}>
                <span class="n">{i + 1}</span>
                <span class="pname">{v.name}</span>
                {hasTodo(v.id) && <span class="dot" />}
              </button>
            ))}
          </nav>
        )}
        {video && (
          <>
            <span class="plabel">Picture</span>
            {version && (
              <VersionMenu
                versions={video.versions}
                shown={version}
                lockedVersion={video.lockedVersion}
                onPick={(id) => {
                  // Picking the version the film would follow anyway collapses back to "follow"
                  // (null); picking anything else pins it explicitly — including the newest, on a
                  // locked film, which must show what you asked for rather than snap back to the lock.
                  setVersionId(id === target?.id ? null : id);
                  setHeld(false);
                }}
              />
            )}
            {version && (
              <button
                class="btn ib lockbtn"
                aria-pressed={locked}
                aria-label={locked ? `Picture locked at ${video.lockedVersion} · unlock` : `Lock picture at ${version.id}`}
                data-tip={locked ? `Picture locked at ${video.lockedVersion} · unlock` : `Lock picture at ${version.id}`}
                onClick={() => void toggleLock()}
              >
                <Icon name={locked ? "lock" : "unlock"} />
              </button>
            )}
            {readyVersionId && (
              <button class="chipx go" aria-label={`${readyVersionId} is ready`} data-tip="Switch to the newest cut" onClick={jumpToReady}>
                <Icon name="new" />
                {readyVersionId} ready
              </button>
            )}
          </>
        )}
        <span class="sp" />
        <button class="btn ghost ib tip-below" data-tip="Shortcuts  ?" aria-label="Keyboard shortcuts" onClick={() => { setSent(null); setKeysOpen(!keysOpen); }}>
          <Icon name="kbd" />
        </button>
        <ChangeLogButton log={changeLog} buttonRef={changeLogButton} />
        <button
          class="btn primary"
          aria-disabled={stage === "assets"}
          tabIndex={stage === "assets" ? -1 : undefined}
          data-tip={stage === "assets" ? "Nothing to send from Assets" : undefined}
          onClick={() => void send()}
        >
          Send to agent{open > 0 && <span class="count">{open}</span>}
        </button>
      </header>
      <ChangeLogDrawer
        log={changeLog}
        projectId={projectId() ?? ""}
        head={state.log}
        project={state.project}
        stage={stage}
        header={headRef}
        buttonRef={changeLogButton}
        toast={toast}
        onJump={jump}
      />

      {sent && (
        <div class="pop" role="dialog" aria-label="Sent to agent">
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <h3>Batch {sent.id} is ready</h3>
            <span class="sp" />
            <button class="btn ghost ib sm" aria-label="Close" onClick={() => setSent(null)}><Icon name="x" /></button>
          </div>
          <pre>{sent.prompt}</pre>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button class="btn primary" onClick={() => void copy()}><Icon name="copy" />{copied ? "Copied" : "Copy prompt"}</button>
          </div>
        </div>
      )}
      {keysOpen && (
        <div class="pop" role="dialog" aria-label="Keyboard shortcuts" style={{ width: "300px" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <h3>Shortcuts</h3>
            <span class="sp" />
            <button class="btn ghost ib sm" aria-label="Close" onClick={() => setKeysOpen(false)}><Icon name="x" /></button>
          </div>
          <div class="keys">
            <span><kbd>Space</kbd></span><span>Play or pause</span>
            <span><kbd>←</kbd> <kbd>→</kbd></span><span>Step one frame (Shift: ten)</span>
            <span><kbd>I</kbd> <kbd>O</kbd></span><span>Set in and out</span>
            <span><kbd>B</kbd></span><span>Draw a box</span>
            <span><kbd>G</kbd></span><span>Grab frame</span>
            <span><kbd>N</kbd></span><span>New note</span>
            <span><kbd>1</kbd>–<kbd>7</kbd></span><span>Switch tab</span>
            <span><kbd>[</kbd> <kbd>]</kbd></span><span>Previous or next film</span>
            <span><kbd>?</kbd></span><span>Shortcuts</span>
            <span><kbd>Esc</kbd></span><span>Close</span>
          </div>
        </div>
      )}
      {toastText && <div class="toast" role="status">{toastText}</div>}

      {wrongProject && (
        <div class="banner lost" role="alert">
          <Icon name="alert" />
          {`This tab is for ${state.project.name}, which isn't running here any more. Ask your agent to open it again.`}
        </div>
      )}

      <nav class="tabs" ref={tabsRef} role="tablist" aria-label="Stages">
        {ORDER.map((s) => {
          const t = tab(s);
          return (
            <button
              class="tab"
              role="tab"
              aria-selected={stage === s}
              data-locked={t?.unlocked ? undefined : "true"}
              data-tip={t?.unlocked ? undefined : `Locked: ask your agent for ${LOCKED_TAB[s].ask}`}
              onClick={() => show(s)}
            >
              <Icon name={STAGE_ICONS[s]} />
              {STAGE_NAMES[s]}
              {t?.unlocked ? (
                t.todo > 0 && <span class="dot" title={`${t.todo} open`} />
              ) : (
                <>
                  <Icon name="lock" class="lk" />
                  {/* Visually hidden, not aria-hidden: an enabled, clickable tab is announced as
                      locked (Safari's aria-description support is patchy, so a hidden span instead). */}
                  <span class="vh"> Locked</span>
                </>
              )}
            </button>
          );
        })}
        {/* Assets: the last tab, after Mix. Not a review stage, so it's never counted in ORDER
            and never shows a to-do dot — just locked, or not. */}
        <button
          class="tab"
          role="tab"
          aria-selected={stage === "assets"}
          data-locked={assetsUnlocked ? undefined : "true"}
          data-tip={assetsUnlocked ? undefined : `Locked: ask your agent for ${LOCKED_TAB.assets.ask}`}
          onClick={() => showAssets()}
        >
          <Icon name="grid" />
          Assets
          {!assetsUnlocked && (
            <>
              <Icon name="lock" class="lk" />
              <span class="vh"> Locked</span>
            </>
          )}
        </button>
      </nav>
      {problem && !wrongProject && <div class="banner"><Icon name="alert" />{problem}</div>}

      <main class="body" ref={bodyRef}>
        {stage === "assets" ? (
          unlocked ? (
            <Assets
              assets={assets}
              videos={state.project.videos}
              state={state}
              foundRequest={foundRequest}
              onFoundRequestUsed={() => setFoundRequest((r) => (r.pending ? { n: r.n, pending: false } : r))}
              onFoundSeen={setFoundSeen}
              toast={toast}
              onChanged={() => void refresh()}
            />
          ) : (
            <Locked tab="assets" projectName={state.project.name} filmName={video?.name ?? null} found={state.found?.counts} onReview={openFound} toast={toast} />
          )
        ) : !unlocked ? (
          <Locked tab={stage} projectName={state.project.name} filmName={video?.name ?? null} found={state.found?.counts} onReview={openFound} toast={toast} />
        ) : stage === "picture" && video && version ? (
          <Picture
            key={video.id}
            video={video}
            version={version}
            fps={fps}
            notes={pictureNotes}
            toast={toast}
            onChanged={() => void refresh()}
            onPendingChange={setPending}
            startAt={startAt}
            grab={grabs[video.id] ?? null}
            onGrabChange={setGrabFor}
            playerRef={playerRef}
            ffmpeg={state.proxies?.ffmpeg ?? false}
            autoProxy={state.project.autoProxy}
            proxyJob={proxyJobs[proxyKey(video.id, version.id)]}
            noteProxyJob={noteProxyJob}
            source={sources[video.id] ?? "proxy"}
            onSourceChange={setSourceFor}
            fileSize={cutAsset?.size ?? null}
            fileRev={cutAsset ? assetRev(cutAsset) : undefined}
          />
        ) : stage === "script" ? (
          <Script script={state.script} toast={toast} onChanged={() => void refresh()} />
        ) : stage === "voice" ? (
          // Its own engine, disposed (and stopped) when you leave, like the other audio tabs.
          <Voice
            key="voice"
            state={state}
            assets={assets}
            video={video ?? null}
            toast={toast}
            onChanged={() => void refresh()}
            onPendingChange={setPending}
          />
        ) : stage === "mix" ? (
          // Mute and solo live here: leaving the tab resets them, and stops and releases its engine.
          <Mix
            key="mix"
            state={state}
            assets={assets}
            video={video ?? null}
            toast={toast}
            onChanged={() => void refresh()}
            onPendingChange={setPending}
          />
        ) : stage === "music" || stage === "sfx" ? (
          // Keyed by stage: each audio tab gets its own engine, disposed (and stopped) when you leave.
          <VariantTab
            key={stage}
            stage={stage}
            state={state}
            assets={assets}
            video={video ?? null}
            toast={toast}
            onChanged={() => void refresh()}
            onPendingChange={setPending}
          />
        ) : null}
      </main>
    </div>
  );
}
