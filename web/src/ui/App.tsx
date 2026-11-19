import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, ApiError, projectId } from "../api.js";
import {
  LOCKED_BRIEF, LOCKED_STORYBOARD, LOCKED_TAB, testFlags, STAGE_NAMES, agentPrompt, briefPrompt, briefSendPrompt, copyShortcut, currentFormat, defaultVersion, filmLanes, filmPicks, firstView, formatChips, formatPrompt, foundChip, foundSignature, foundTotal,
  filmAfterShelving, inPlay, isPlanPage, labelOfId, latest, lockedFound, neighbourFormat, neighbourVideo, planProgress, planTarget, previousVersion, proxyKey, readyPrompt, storySendPrompt, storyboardPrompt, versionFormats, type PlanPage,
} from "../lib.js";
import { onLabel } from "../../../src/core/notes.js";
import { deskPlace, deskView, noteTarget, takeCount, takeGroups, undeliveredBatches, unsentCount, unsentEdits, viewForKey, type DeskView } from "../desk.js";
import type { AgentStatus, Batch, BriefView, FoundCounts, FoundKind, Note, SendHandOver, Stage, StoryboardView, Video } from "../types.js";
import { useRushes } from "../useRushes.js";
import { Assets, type FoundRequest } from "./Assets.js";
import { Brief } from "./Brief.js";
import { FormatToggle } from "./FormatToggle.js";
import { Icon, STAGE_ICONS } from "./Icon.js";
import { Picture, type Source } from "./Picture.js";
import { Storyboard } from "./Storyboard.js";
import { PLAN_PANEL_ID, PlanSwitch, planTabId, type PlanTabRow } from "./Planning.js";
import { Script } from "./Script.js";
import { VariantTab } from "./VariantTab.js";
import { Voice } from "./Voice.js";
import { Visuals } from "./Visuals.js";
import { focusRow, useChangeLog } from "./ChangeLog.js";
import type { JumpTarget } from "../changelog.js";
import { CutMenu } from "./desk/CutMenu.js";
import { NoCutTimeline } from "./desk/NoCut.js";
import { AllShelved, FilmSelect, ShelvedBanner } from "./desk/FilmSelect.js";
import { MoreMenu } from "./desk/MoreMenu.js";
import { NotesPanel, PanelContext, PanelToggle, usePanelPlace, type NotesPanelProps, type PanelShared } from "./desk/NotesPanel.js";
import { ReviewTabs, type ReviewTabRow } from "./desk/ReviewTabs.js";
import { StatusBar } from "./desk/StatusBar.js";
import { TopBar } from "./desk/TopBar.js";
import { AgentChip } from "./agent/AgentChip.js";
import { useNewCut, usePlaying } from "./agent/useNewCut.js";
import { actOnSend, askNotificationsOnce, planLead, useFirstSend, WhyLine } from "./agent/FirstSend.js";
import { useAskNotify } from "../notify.js";
import { Workspaces } from "./desk/Workspaces.js";
import type { ReviewClock } from "./desk/frame.js";
import type { MixView } from "./desk/useMix.js";

declare global {
  interface Window {
    /** Test-only (`?test=1`): opens Assets › Found, filtered to a kind when given. */
    __rushesOpenFound?: (kind?: FoundKind) => void;
  }
}

// §26: the tabs that look at a film, and so are view-only while it is shelved (the others are not about one film).
const SHELVED_VIEW_ONLY: ReadonlySet<string> = new Set(["picture", "voice", "music", "sfx", "mix"]);
// §27, 5.4: Review's tabs, in order, with their names on the desk. The mix plays on the timeline (5.6): it has no tab.
const REVIEW_TABS: { view: Exclude<Stage, "script" | "visuals" | "mix">; label: string }[] = [
  { view: "picture", label: "Timeline" },
  { view: "voice", label: "Voice" },
  { view: "music", label: "Music" },
  { view: "sfx", label: "Effects" },
];
// Assets isn't a review stage (§15.3): it's a dashboard-only view, kept out of Stage and handled as its own case throughout this file.
type View = DeskView;
/** What Send shows: a batch, or (from the Brief page) a message that is not recorded anywhere. */
type Sent = Pick<Batch, "id" | "prompt"> & { title?: string; why?: string | null; lead?: string | null };
const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/** §19.1: a locked tab's own page -- what it's for, what unlocks it, and a prompt to copy for your agent. */
function Locked({ tab, projectName, filmName, found, onReview, toast }: { tab: Stage | "assets" | "brief" | "storyboard"; projectName: string; filmName: string | null; found: FoundCounts | undefined; onReview: (kind: FoundKind) => void; toast: (m: string) => void }) {
  const planning = tab === "brief" || tab === "storyboard";
  const { what, unlocks } = tab === "brief" ? LOCKED_BRIEF : tab === "storyboard" ? LOCKED_STORYBOARD : LOCKED_TAB[tab];
  const name = tab === "assets" ? "Assets" : tab === "brief" ? "Brief" : tab === "storyboard" ? "Storyboard" : STAGE_NAMES[tab];
  const icon = tab === "assets" ? "grid" : tab === "brief" ? "brief" : tab === "storyboard" ? "story" : STAGE_ICONS[tab];
  const prompt = tab === "brief" ? briefPrompt(projectName, filmName) : tab === "storyboard" ? storyboardPrompt(projectName, filmName) : agentPrompt(tab, projectName, filmName);
  // §20.5: when the folder holds files of this tab's kind, say so, and offer to look at them.
  const files = planning ? null : lockedFound(tab, found);
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
    <div class="emptypage locked">
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

/**
 * The Plan pages' notes panel. A half-typed note in it is pending, as in Review's views (final review I2): the desk refuses
 * a switch that would unmount it or aim it elsewhere, and lets go once the panel itself goes.
 */
function PlanNotesPanel({ onPendingChange, ...props }: NotesPanelProps & { onPendingChange(pending: boolean): void }) {
  useEffect(() => () => onPendingChange(false), []);
  return <NotesPanel {...props} onTextChange={onPendingChange} />;
}

export function App() {
  const { state, assets, problem, wrongProject, refresh, proxyJobs, noteProxyJob, agent, noteAgent } = useRushes();
  // §28: the agent menu's opener, which the Send to AI row puts here.
  const agentMenu = useRef<(() => void) | null>(null);
  const [stage, setStage] = useState<View | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [toastText, setToastText] = useState<string | null>(null);
  // §26: a toast may carry one action (Undo after shelving a film).
  const [toastAction, setToastAction] = useState<{ label: string; run(): void } | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  // §24: the planning page you were last on, which key 1 returns to (Script, the old key 1, until you open Brief).
  const [planLast, setPlanLast] = useState<PlanPage>("script");
  // §27, 5.3: the Review tab you were last on, which the Review workspace opens on.
  const [reviewLast, setReviewLast] = useState<View>("picture");
  // The Brief and Storyboard pages register how to wait for their saves here, for Send.
  const planSettle = useRef<(() => Promise<unknown>) | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  // True while Rushes, not you, is holding the cut on screen because marks are pending.
  const [held, setHeld] = useState(false);
  // §27, 5.5 (final review I3): each film's one playhead across the Review tabs, keyed by video id ("" with no film). The
  // mounted Review tab hands over its live time (liveClock) and leaves it here when it goes; the next tab starts here.
  const reviewTimes = useRef(new Map<string, number>());
  const liveClock = useRef<{ film: string; read: () => number } | null>(null);
  const reviewClock = useRef<ReviewClock>({
    at: (film) => reviewTimes.current.get(film) ?? 0,
    attach: (film, read) => {
      const mine = { film, read };
      liveClock.current = mine;
      return () => {
        reviewTimes.current.set(film, read());
        if (liveClock.current === mine) liveClock.current = null;
      };
    },
  }).current;
  // The Timeline's mute and solo for the film on screen: kept across the Review tabs, let go by a film switch.
  const mixView = useRef<MixView | null>(null);
  // Each film's pending grab (a screenshot waiting to be attached to its next note), keyed by
  // video id. This is the single source of truth: Picture holds no copy of its own, so there's
  // nothing for a remount to get stale against, and a film's entry survives a switch away and
  // back, or a trip to another tab, without needing to be threaded through per-switch memory.
  const [grabs, setGrabs] = useState<Record<string, string | null>>({});
  const toastTimer = useRef<number | undefined>(undefined);
  // Per-film memory: version choice and hold state, so switching films and coming back doesn't
  // lose your place (the playhead is reviewTimes'). Keyed by video id.
  const memory = useRef(new Map<string, { versionId: string | null; held: boolean }>());
  // The playing <video> element, forwarded up from Picture, so a switch can pause it before it unmounts.
  const playerRef = useRef<HTMLVideoElement | null>(null);
  // Tells Picture whenever its pending grab changes, so App can remember it per film.
  const setGrabFor = (forVideo: string, grab: string | null) => setGrabs((g) => ({ ...g, [forVideo]: grab }));
  // §19.5: each film's Proxy/Original choice, in memory only. Proxy unless you've picked Original.
  const [sources, setSources] = useState<Record<string, Source>>({});
  const setSourceFor = (forVideo: string, source: Source) => setSources((s) => ({ ...s, [forVideo]: source }));
  // §21.5: each film's chosen format, in memory only; a fresh load shows the primary.
  const [formatChoice, setFormatChoice] = useState<Record<string, string>>({});
  // R2: the primary's shape as the player measured it, for a cut stored with no size.
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  // R7: a drawn box belongs to the format on screen, so a switch waits for it.
  const [boxPending, setBoxPending] = useState(false);
  // m2: an In, a range or a box marked on the Timeline, which another cut would drop: the Cut menu waits for them.
  const [marksPending, setMarksPending] = useState(false);
  // Proxy jobs whose failure has already been toasted, so each is said once.
  const toastedFailures = useRef(new Set<string>());

  // `ms`: how long it stays, for a message that takes longer than a glance to read.
  const toast = (message: string, ms = 2400, action: { label: string; run(): void } | null = null) => {
    setToastText(message);
    setToastAction(action);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => {
      setToastText(null);
      setToastAction(null);
    }, ms);
  };
  // I3: a batch handed over from the dialog's Set up closes the dialog (a toast says what became of it).
  const firstSend = useFirstSend(agent, noteAgent, toast, (f) => setSent((s) => s && (f && !f.dialog ? null : { ...s, why: f?.why ?? null })));
  useAskNotify(agent);
  // §20.5: a request to open Assets › Found (the header chip), and what the chip last said while Found was open.
  const [foundRequest, setFoundRequest] = useState<FoundRequest>({ n: 0, pending: false });
  const [foundSeen, setFoundSeen] = useState<string | null>(null);
  // §27, 5.7: the notes panel, in Review and Plan: its width and whether it is shown, and its Activity tab (the Change Log),
  // whose dot says lines arrived since it was last on screen.
  const panel = usePanelPlace();
  const panelHere = !!stage && (deskPlace(stage).workspace === "review" || deskPlace(stage).workspace === "plan");
  const changeLog = useChangeLog(projectId() ?? "", state?.log, (open) => open && panelHere && panel.shown);
  // Send is to be brought into view and focused once the notes panel it opened is on screen (the status bar's Send).
  const [reveal, setReveal] = useState(false);
  const panelToggle = useRef<HTMLButtonElement>(null);
  // A note box to focus once the panel that holds it is on screen (revealNotes).
  const afterReveal = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const then = afterReveal.current;
    if (!then) return;
    afterReveal.current = null;
    then();
  });
  // §27, 5.8: the script line a note on a Plan page is about, picked by working in its row.
  const [planLine, setPlanLine] = useState<{ id: string; label: string } | null>(null);

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
    if (stage === null) {
      const first = deskView(firstView(state.tabs, state.brief)) as Stage | "brief";
      setStage(first);
      // Opened on a planning page, so key 1 comes back to it rather than to Script.
      if (isPlanPage(first)) setPlanLast(first);
    }
    // §26: open on a film in play. With every film shelved nothing is open until one is picked from the Shelved list.
    const first = state.project.videos.find(inPlay);
    if (videoId === null && first) setVideoId(first.id);
  }, [state]);

  // The tab's title follows the project's name as soon as it's known.
  useEffect(() => {
    if (state?.project.name) document.title = `${state.project.name} · Rushes`;
  }, [state?.project.name]);

  // Follow the locked version if there is one, otherwise the newest, unless you've chosen another.
  // §26: a shelved film is the current one only when it was opened from the Shelved list; otherwise the first film in play.
  const video = state?.project.videos.find((v) => v.id === videoId) ?? state?.project.videos.find(inPlay);
  const newest = latest(video);
  const target = defaultVersion(video);
  const version = video?.versions.find((v) => v.id === versionId) ?? target;
  const locked = !!video?.lockedVersion;
  const fps = version?.fps ?? state?.project.fps ?? 30;
  // §21: this cut's formats, the chips and the one on screen.
  const filmNotes = state?.notes.notes.filter((n) => n.stage === "picture" && (!n.video || n.video === video?.id)) ?? [];
  const views = version ? versionFormats(version, measured[version.file]) : [];
  const before = video && version ? previousVersion(video, version.id) : undefined;
  const format = currentFormat(views, video ? formatChoice[video.id] : undefined);
  const missingFiles = new Set(assets.filter((a) => a.kind === "cut" && a.missing).map((a) => a.path));
  const chips = version
    ? formatChips({ views, previous: before ? versionFormats(before) : [], current: format, versionDuration: version.duration, notes: filmNotes, missing: missingFiles })
    : [];
  /** Switches the format on screen; false when it's refused (a drawn box waits), so focus can stay put. */
  const switchFormat = (id: string): boolean => {
    if (!video || id === format) return false;
    if (boxPending) {
      toast(`Add or clear your box on ${format ? labelOfId(format) : "this format"} first`);
      return false;
    }
    setFormatChoice((c) => ({ ...c, [video.id]: id }));
    return true;
  };

  const [playing, onSoundPlaying] = usePlaying(playerRef);
  // A new cut arriving mid-review mustn't rewind the player or drop pending marks. So the
  // moment something's pending, hold the cut on screen; a newer one then waits behind a chip.
  // Holding before the cut arrives means the player never renders the new cut, even once.
  useEffect(() => {
    if ((pending || playing) && versionId === null && target) {
      setVersionId(target.id);
      setHeld(true);
    } else if (!pending && !playing && held && versionId === target?.id) {
      setVersionId(null);
      setHeld(false);
    }
  }, [pending, playing, versionId, target?.id]);
  // A version pin that now matches where the film would follow anyway — e.g. one left over
  // from peeking at a newer cut via the "vN ready" chip, now that an unlock has made that
  // cut the default — is cleared. Otherwise it would keep overriding "follow" even once it's
  // redundant, silently stopping the film from auto-following the next cut that arrives.
  useEffect(() => {
    if (!held && versionId !== null && versionId === target?.id) setVersionId(null);
  }, [target?.id, held, versionId]);
  // §27, 5.2: the Cut button carries a dot whenever a newer cut than the one on screen exists, and either the video is
  // locked (so nothing would otherwise tell you a newer one arrived) or the cut is held.
  const readyVersionId = newest && version && newest.id !== version.id && (locked || held) ? newest.id : null;
  // m2: another cut would drop a marked In, range or box on the Timeline: it waits for them, as the Film menu does. A
  // half-typed note is kept across a cut, so it does not hold the menu. Picking the version the film would follow anyway
  // collapses back to "follow" (null); anything else pins it, including the newest on a locked film (what you asked for).
  const pickCut = (id: string) => (marksPending ? toast("Add or clear your note first") : (setVersionId(id === target?.id ? null : id), setHeld(false)));
  // §28: a new cut from the agent switches, or waits behind a Show and a dot while the picture is held.
  const unseenCut = useNewCut({ film: video?.id ?? null, versions: video?.versions.map((v) => v.id) ?? [], shown: version?.id, busy: playing || pending || marksPending || locked, select: pickCut, toast });

  /** Switches to another film, remembering this one's place and restoring the other's. Refused while marks are pending. */
  const switchFilm = (newId: string) => {
    if (newId === video?.id) return;
    if (video && pending) return toast(`Add or clear your note on ${video.name} first`);
    // Read the mounted Review tab's live time directly, and pause the picture before it unmounts: React state for the
    // playhead can lag behind what's actually on screen (e.g. mid-play, or a burst of seeks), so this is the only way
    // to be sure what's saved matches what was really showing. The other film's tabs start at its own playhead.
    if (video) {
      playerRef.current?.pause();
      const live = liveClock.current;
      if (live && live.film === video.id) reviewTimes.current.set(video.id, live.read());
      memory.current.set(video.id, { versionId, held });
    }
    const saved = memory.current.get(newId);
    mixView.current = null;
    setVideoId(newId);
    setVersionId(saved?.versionId ?? null);
    setHeld(saved?.held ?? false);
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

  // §26: shelve a film, or restore it. The Film menu acts on the film you are in; the Shelved list can restore any.
  const [shelvedRequest, setShelvedRequest] = useState(0);
  // m6: a request to open the Cut menu on its lock row (the status bar's "lock picture").
  // The latest switchFilm, for the Undo on a toast made a render ago (its own closure would still see the old film).
  const switchFilmRef = useRef(switchFilm);
  switchFilmRef.current = switchFilm;
  /** True when the change was made: Undo goes back to the film only then. */
  const setShelved = async (film: Video, shelved: boolean): Promise<boolean> => {
    if (!state) return false;
    // Shelving the film you are in moves you to another film, so it waits for a half-typed note, as switching films does.
    if (shelved && film.id === video?.id && pending) return toast(`Add or clear your note on ${film.name} first`), false;
    try {
      await api.put<{ video: Video }>(`/api/videos/${film.id}/shelve`, { shelved });
      if (shelved && film.id === video?.id) {
        const next = filmAfterShelving(state.project.videos, film.id);
        if (next) switchFilm(next);
        else setVideoId(null);
      }
      void refresh();
      if (shelved) {
        toast(`“${film.name}” shelved`, 6000, { label: "Undo", run: () => void setShelved(film, false).then((ok) => ok && switchFilmRef.current(film.id)) });
      } else {
        toast(`“${film.name}” restored`);
      }
      return true;
    } catch (e) {
      toast((e as Error).message);
      return false;
    }
  };
  const toggleShelved = () => {
    if (video) void setShelved(video, !video.shelved);
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
    const view = deskView(to.tab);
    setStage(view);
    if (deskPlace(view).workspace === "review") setReviewLast(view);
    setSent(null);
    if (to.row) focusRow(to.row);
  };

  const tabs = state?.tabs ?? [];
  const tab = (s: Stage) => tabs.find((t) => t.stage === s);
  const chip = foundChip(state?.found);
  // Found files are worth opening Assets for even before anything is registered: More's Bring in leads there.
  const assetsUnlocked = assets.length > 0 || chip !== null;
  // Leaving a view unmounts it, so a note in the making there (the same `pending` that holds the
  // film and New take) would be lost: refuse the switch instead, by click or by number key. A locked
  // tab always opens (§19.1): it shows its own page rather than a toast.
  const show = (asked: Stage | "brief" | "storyboard") => {
    const s = deskView(asked) as Stage | "brief" | "storyboard";
    if (pending && s !== stage) return toast("Add or clear your note first");
    setStage(s);
    setSent(null);
    if (isPlanPage(s)) setPlanLast(s);
    if (deskPlace(s).workspace === "review") setReviewLast(s);
  };
  /** Key 1: the planning page last used if it has something in it, else the first that does. */
  const planKey = () => {
    const open = { brief: !!state?.brief.exists, script: !!tab("script")?.unlocked, storyboard: !!state?.storyboard.exists };
    show(planTarget(planLast, open));
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
      // §21.5 (R1): Alt+← and Alt+→ step through the formats; [ and ] stay with films (§14.2).
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        if (stage !== "picture" || typing(e.target)) return;
        e.preventDefault();
        const next = neighbourFormat(chips, format, e.key === "ArrowRight" ? 1 : -1);
        if (next) switchFormat(next);
        return;
      }
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      // §27, 5.3: the number keys keep their places. 1 Plan (the page last used), 2 and 6 the timeline, 3 to 5 the sounds, 7 Visuals, 8 Assets.
      const to = viewForKey(e.key, planLast);
      if (e.key === "1") planKey();
      else if (to === "assets") showAssets();
      else if (to) show(to);
      // Not on key repeat: a held key would shelve the next film too, and the next.
      if (e.key === "S" && e.shiftKey && !e.repeat) toggleShelved();
      if ((e.key === "[" || e.key === "]") && state) {
        const nxt = neighbourVideo(state.project.videos, videoId, e.key === "]" ? 1 : -1);
        if (nxt) switchFilm(nxt);
      }
      if (e.key === "?") setKeysOpen((o) => !o);
      // §27, 5.7: \ hides and shows the notes panel (the drawer, under 1100 px), where there is one.
      if (e.key === "\\" && panelHere && !e.repeat) {
        e.preventDefault();
        panel.toggle();
      }
      if (e.key === "Escape") {
        setKeysOpen(false);
        setSent(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const headRef = useRef<HTMLElement>(null);
  // §27, 5.1: the room inside the work area, as --work-h on it, so Picture can cap its player at it (the timeline and the
  // note box stay on screen with a tall cut) and Visuals can fill it. It follows the work area's own size: a banner, a
  // taller top bar or a resized window all change it without a render.
  const bodyRef = useRef<HTMLElement>(null);
  const shellUp = !!state && !!stage;
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const place = () => {
      const cs = getComputedStyle(el);
      const h = `${Math.max(0, Math.round(el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)))}px`;
      if (el.style.getPropertyValue("--work-h") !== h) el.style.setProperty("--work-h", h);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shellUp]);

  // Send sends the whole project from whichever tab it is pressed on: every tab's open notes
  // on every film in play and the changed script lines (one batch), plus what changed in the brief and
  // the storyboard. Those two have no batch: their files are the record, so they are only lines to paste.
  const send = async ({ asked = agent?.asked !== false, status = agent }: { asked?: boolean; status?: AgentStatus | null } = {}) => {
    if (!state || !stage) return;
    setKeysOpen(false);
    if (!asked && unsent > 0) return firstSend.open();
    if (status?.on) askNotificationsOnce();
    // The Brief or Storyboard page waits for what you just typed to be saved, and is read as the server then has it.
    const settled = stage === "brief" || stage === "storyboard" ? await planSettle.current?.() : undefined;
    const brief = (stage === "brief" ? (settled as BriefView | undefined) : undefined) ?? state.brief;
    const board = (stage === "storyboard" ? (settled as StoryboardView | undefined) : undefined) ?? state.storyboard;
    // On its own page, the brief's or storyboard's line always goes; elsewhere, only when something in it changed.
    const planning = [
      brief.exists && (stage === "brief" || brief.changed > 0) ? briefSendPrompt(state.project.name, video?.name ?? null, brief) : null,
      board.exists && (stage === "storyboard" || board.changed > 0) ? storySendPrompt(state.project.name, video?.name ?? null, board) : null,
    ].filter((line): line is string => line !== null);
    let batch: Batch | null = null;
    let handOver: SendHandOver | undefined;
    try {
      ({ batch, agent: handOver } = await api.post<{ batch: Batch; agent?: SendHandOver }>("/api/batches", {}));
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "empty_batch")) return toast((e as Error).message);
    }
    // §28: the agent has the batch, or Stop or a failed start took it back: no dialog, only planning lines left to paste.
    const follow = batch ? actOnSend(handOver, status, toast) : null;
    if (follow && !follow.dialog) {
      void refresh();
      if (planning.length === 0) return;
      batch = null;
    }
    if (!batch && planning.length === 0) {
      if (stage === "brief" && !brief.exists) return toast("There's no brief yet: copy the prompt on this page for your agent");
      if (stage === "storyboard" && !board.exists) return toast("There's no storyboard yet: copy the prompt on this page for your agent");
      return toast("Nothing open to send on any tab");
    }
    setSent(batch ? { id: batch.id, prompt: [batch.prompt, ...planning].join("\n\n"), why: follow?.why } : { id: "plan", title: "Message for your agent", prompt: planning.join("\n\n"), lead: planLead(follow, status) });
    setCopied(false);
    if (batch) void refresh();
  };
  // I3, Send again: each batch whose hand-over was refused (Send to AI on, agent not signed in…) goes to the agent again,
  // oldest first. Refused again, the copy dialog opens for that batch with why, as after Send.
  const sendAgain = async (waiting: Batch[], status: AgentStatus | null = agent) => {
    setKeysOpen(false);
    for (const b of waiting) {
      let handOver: SendHandOver | undefined;
      try {
        ({ agent: handOver } = await api.post<{ batch: Batch; agent: SendHandOver }>(`/api/batches/${encodeURIComponent(b.id)}/resend`, {}));
      } catch (e) {
        // Gone meanwhile (another tab sent it, or its notes were marked done): nothing to send for this one.
        if (e instanceof ApiError && (e.code === "batch_delivered" || e.code === "batch_not_waiting")) continue;
        void refresh();
        return toast((e as Error).message);
      }
      const follow = actOnSend(handOver, status, toast);
      if (follow.dialog) {
        setSent({ id: b.id, prompt: b.prompt, why: follow.why });
        setCopied(false);
        void refresh();
        return;
      }
    }
    void refresh();
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
        {problem ? <div class="banner"><Icon name="alert" />{problem}</div> : <div class="emptypage"><p>Loading…</p></div>}
      </div>
    );
  }

  // §27, 5.6: the Timeline tab lists the notes on the mix with the picture's.
  const pictureNotes = state.notes.notes.filter((n) => (n.stage === "picture" || n.stage === "mix") && (!n.video || n.video === video?.id));
  /** A film's open notes on the tabs that look at it, for the Film menu and the status bar. */
  const openNotes = (vid: string) => state.notes.notes.filter((n) => n.status === "todo" && SHELVED_VIEW_ONLY.has(n.stage) && (!n.video || n.video === vid)).length;
  // §27, 5.6: with no cut, the Timeline tab still opens when the film has a take in use or a note on the mix: the takes
  // play together there (what the Mix tab did), with the engine as the clock.
  const filmUse = filmPicks(state.picks, video?.id).use;
  const mixNotes = state.notes.notes.filter((n) => n.stage === "mix" && (!n.video || n.video === video?.id));
  const soundOnly = !version && (!!(filmUse?.voice || filmUse?.music || filmUse?.sfx) || mixNotes.length > 0) && (!!video || state.project.videos.length === 0);
  const timelineOpen = !!tab("picture")?.unlocked || soundOnly;
  const unlocked = stage === "assets" ? assetsUnlocked : stage === "brief" ? state.brief.exists : stage === "storyboard" ? state.storyboard.exists : stage === "picture" ? timelineOpen : (tab(stage)?.unlocked ?? false);
  // §27: the Plan switch's pages, each with its tick and its dot, and the Plan workspace's tick (all three approved) and dot.
  const hasCut = !!tab("picture")?.unlocked;
  const progress = planProgress(state.brief, state.script.sections, state.storyboard);
  const approved = progress.brief === "ok" && progress.script === "ok" && progress.storyboard === "ok";
  // Ready to build shows while planning has begun (a brief or a storyboard) and no cut exists yet.
  const planning = state.build.started && !hasCut;
  const scriptTodo = tab("script")?.todo ?? 0;
  const planRows: PlanTabRow[] = [
    { page: "brief", name: "Brief", icon: "brief", unlocked: state.brief.exists, ask: LOCKED_BRIEF.ask, approved: progress.brief === "ok", open: state.brief.changed },
    { page: "script", name: "Script", icon: STAGE_ICONS.script, unlocked: !!tab("script")?.unlocked, ask: LOCKED_TAB.script.ask, approved: progress.script === "ok", open: scriptTodo },
    { page: "storyboard", name: "Storyboard", icon: "story", unlocked: state.storyboard.exists, ask: LOCKED_STORYBOARD.ask, approved: progress.storyboard === "ok", open: state.storyboard.changed },
  ];
  const planOpen = state.brief.changed + state.storyboard.changed + scriptTodo;
  const copyReady = async () => {
    try {
      await navigator.clipboard.writeText(readyPrompt(state.project.name, video?.name ?? null));
      toast("Prompt copied");
    } catch {
      toast("Couldn't reach the clipboard. Ask your agent to build the film from the approved plan.");
    }
  };

  // §27: where the view sits on the desk, and each sound's takes on this film.
  const place = deskPlace(stage);
  const lanes = filmLanes(state.project.lanes, video?.id, state.project.videos.length);
  const use = filmUse;
  const sounds = {
    voice: takeGroups(lanes, "voice", use?.voice, video),
    music: takeGroups(lanes, "music", use?.music, video),
    sfx: takeGroups(lanes, "sfx", use?.sfx, video),
  };
  // What Send would send that has not been sent yet: Send's count.
  const inPlayIds = new Set(state.project.videos.filter(inPlay).map((v) => v.id));
  const unsentFrom = { notes: state.notes.notes, inPlay: inPlayIds, scriptTodo: tab("script")?.todo ?? 0, briefChanged: state.brief.changed, storyboardChanged: state.storyboard.changed };
  const unsent = unsentCount(unsentFrom);
  // I3: notes Send filed that never reached the agent (refused while Send to AI was on): Send again offers them.
  const undelivered = undeliveredBatches(state.batches.batches, state.notes.notes);
  const again = undelivered.length === 0 ? null : {
    count: undelivered.reduce((sum, x) => sum + x.notes, 0),
    why: undelivered[undelivered.length - 1].batch.undelivered?.why ?? "",
    onSendAgain: () => void sendAgain(undelivered.map((x) => x.batch)),
  };
  // Where Send is, for the status bar's Send on a page with no notes panel (Visuals, Assets): Plan when only the plan's
  // edits wait, else Review.
  const planOnly = state.notes.notes.every((n) => n.stage === "script" || n.status !== "todo" || n.batch !== null || (!!n.video && !inPlayIds.has(n.video)));
  const sendTo: View = planOnly && unsent > 0 && (state.brief.changed + state.storyboard.changed + (tab("script")?.todo ?? 0)) > 0
    ? (isPlanPage(stage) ? stage : planLast)
    : reviewLast;
  // Red, round 2: the status bar no longer says what is next. It keeps one thing: on a page with no notes panel, a way to
  // Send what waits, since Send lives in the panel.
  const statusSend = unsent > 0 && !panelHere ? { text: `Send ${unsent} ${unsentEdits(unsentFrom) > 0 ? (unsent === 1 ? "change" : "changes") : unsent === 1 ? "note" : "notes"}` } : null;
  const goSend = () => {
    if (pending) return toast("Add or clear your note first");
    show(sendTo as Stage);
    panel.setShown(true);
    changeLog.setOpen(false);
    setReveal(true);
  };
  const reviewRows: ReviewTabRow[] = REVIEW_TABS.map(({ view, label }) => ({
    view,
    label,
    icon: STAGE_ICONS[view],
    locked: view === "picture" ? !timelineOpen : !tab(view)?.unlocked,
    ask: LOCKED_TAB[view].ask,
    takes: view === "voice" || view === "music" || view === "sfx" ? takeCount(sounds[view]) : null,
    // The timeline holds the mix's notes too (§27, 5.6).
    todo: (tab(view)?.todo ?? 0) + (view === "picture" ? (tab("mix")?.todo ?? 0) : 0),
  }));
  // §27, 5.3: before there is anything to review (no cut, no takes), Review is the page that asks for cut 1, with no tabs.
  const reviewTabsShown = place.workspace === "review" && reviewRows.some((r) => !r.locked);
  // The format on screen; with one format, that one.
  const formatLabel = (views.find((f) => f.id === format) ?? views.find((f) => f.primary) ?? views[0])?.label ?? null;
  const foundUnseen = chip !== null && foundSignature(state.found) !== foundSeen && foundTotal(state.found?.counts) > 0;

  // §27, 5.7: what every notes panel shares, wherever it is mounted.
  const panelShared: PanelShared = {
    log: changeLog,
    activity: {
      projectId: projectId() ?? "",
      head: state.log,
      project: state.project,
      // §30: Activity on a film shows its own lines and the project's.
      film: video?.id ?? null,
      notes: state.notes.notes,
      // The Change Log has no Brief or Storyboard area: a line added from either goes under Script, its neighbour in Plan.
      stage: stage === "brief" || stage === "storyboard" ? "script" : stage,
      toast,
      onJump: (to) => {
        jump(to);
        // In the drawer the jump's destination is underneath: the drawer closes on it, and focus goes back to its button
        // (a lane row the jump opens takes it a frame later).
        if (panel.narrow) {
          panel.setShown(false);
          panelToggle.current?.focus();
        }
      },
    },
    // On its own page Send always carries the brief's or storyboard's line (send()), so it shows there whenever that file exists.
    send: { count: unsent, always: (stage === "brief" && state.brief.exists) || (stage === "storyboard" && state.storyboard.exists), onSend: () => void send(), again },
    // §28: Set up Send to AI opens the first-Send sheet.
    agent: agent && { status: agent, onSetUp: firstSend.open, menu: agentMenu, onStatus: noteAgent, toast },
    shown: panel.shown,
    narrow: panel.narrow,
    setShown: panel.setShown,
    width: panel.width,
    setWidth: panel.setWidth,
    reveal,
    onRevealed: () => setReveal(false),
    revealNotes: (then) => {
      afterReveal.current = then;
      panel.setShown(true);
      if (changeLog.open) changeLog.setOpen(false, false);
      else if (panel.shown) {
        afterReveal.current = null;
        then();
      }
    },
  };
  /** A page with no notes of its own (a locked page, a Plan page): it sits beside a notes panel the desk mounts for it. */
  const withPanel = (page: ComponentChildren, side: ComponentChildren = <NotesPanel notes={[]} version={null} placeholder="" readOnly toast={toast} onAdd={async () => undefined} onChanged={() => void refresh()} />) => (
    <div class="split deskcols">
      {/* A Plan page is the Plan switch's tab panel. */}
      <div class="wsmain" {...(isPlanPage(stage) ? { role: "tabpanel", id: PLAN_PANEL_ID, "aria-labelledby": planTabId(stage) } : {})}>{page}</div>
      {side}
    </div>
  );
  // §27, 5.8: the Plan pages' notes are the script's: on a line picked in Script, or on the script as a whole.
  const scriptNotes = state.notes.notes.filter((n) => n.stage === "script");
  const planTargetNow = planLine && stage === "script" ? noteTarget({ kind: "line", ...planLine }, null) : { stage: "script" as const, on: null, scope: "whole" as const, t: null, tOut: null, label: "The script" };
  // m7 (ruling): the Brief and Storyboard pages take no notes of their own; a note on the plan is written on the Script page.
  const planBox = stage === "script";
  const planPanel = (
    <PlanNotesPanel
      notes={scriptNotes}
      version={null}
      placeholder={`Note on ${planTargetNow.label}`}
      fixedTimes
      toast={toast}
      // The line a note is about, in the words export and the CLI use; nothing when the section has gone.
      onLabel={(n: Note) => (n.on === null ? "The script" : onLabel(n, { project: state.project, script: state.script }))}
      target={{ label: planTargetNow.label, onClear: planLine && stage === "script" ? () => setPlanLine(null) : undefined }}
      onAdd={async (text) => {
        await api.post("/api/notes", { stage: "script", video: null, version: null, on: planTargetNow.on, scope: "whole", t: null, tOut: null, text });
        void refresh();
      }}
      onChanged={() => void refresh()}
      onPendingChange={setPending}
      readOnly={!planBox}
      instead={planBox ? undefined : "Notes on the plan are written on the Script page."}
    />
  );

  return (
    <PanelContext.Provider value={panelShared}>
    <div class={`shell${panelHere && !panel.narrow && !panel.shown ? " nhidden" : ""}`} style={{ "--notes-w": `${panel.width}px` }}>
      <TopBar
        barRef={headRef}
        project={state.project.name}
        projectId={state.project.id ?? null}
        film={
          state.project.videos.length > 0 ? (
            <FilmSelect
              films={state.project.videos}
              currentId={video?.id ?? null}
              openNotes={openNotes}
              onSwitch={switchFilm}
              onRestore={(id) => {
                const film = state.project.videos.find((v) => v.id === id);
                if (film) void setShelved(film, false);
              }}
              shelvedRequest={shelvedRequest}
            />
          ) : null
        }
        cut={
          video && version ? (
            <CutMenu
              video={video}
              shown={version}
              newer={readyVersionId ?? unseenCut}
              onPick={pickCut}
              onToggleLock={() => void toggleLock()}
            />
          ) : null
        }
        workspaces={
          <Workspaces
            current={place.workspace}
            plan={{ approved, open: planOpen, locked: planRows.every((r) => !r.unlocked) }}
            hasVisuals={!!tab("visuals")?.unlocked}
            assetsUnlocked={assetsUnlocked}
            found={foundUnseen ? { count: foundTotal(state.found?.counts), text: chip! } : null}
            onPick={(ws) => (ws === "plan" ? planKey() : ws === "assets" ? showAssets() : ws === "visuals" ? show("visuals") : show(reviewLast as Stage))}
          />
        }
        agent={
          <AgentChip
            status={agent}
            notes={state.notes.notes}
            onOpen={() => {
              // §28: the run's lines are in Activity, in the notes panel (Review's when this page has none).
              if (!panelHere) show(reviewLast as Stage);
              panel.setShown(true);
              changeLog.setOpen(true, false);
            }}
            onStop={() => void api.post("/api/agent/stop", {}).catch((e) => toast((e as Error).message))}
          />
        }
        notesToggle={panelHere ? <PanelToggle shown={panel.shown} onToggle={panel.toggle} buttonRef={panelToggle} /> : null}
        more={
          <MoreMenu
            found={chip}
            onBringIn={() => openFound()}
            video={video}
            onToggleShelved={toggleShelved}
            autoProxy={state.project.autoProxy}
            onKeys={() => {
              setSent(null);
              setKeysOpen(true);
            }}
            toast={toast}
            onChanged={() => void refresh()}
          />
        }
      />

      {firstSend.sheet(unsent > 0, (s) => void send({ asked: true, status: s }))}
      {sent && !firstSend.shown && (
        <div class="pop" role="dialog" aria-label="Sent to agent">
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <h3>{sent.title ?? `Batch ${sent.id} is ready`}</h3>
            <span class="sp" />
            <button class="btn ghost ib sm" aria-label="Close" data-tip="Close" onClick={() => setSent(null)}><Icon name="x" /></button>
          </div>
          {sent.why && <WhyLine why={sent.why} onSetUp={() => firstSend.open(sent.id)} />}
          {sent.lead && <p class="slead">{sent.lead}</p>}
          <pre>{sent.prompt}</pre>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button class="btn primary" onClick={() => void copy()}><Icon name="copy" />{copied ? "Copied" : "Copy prompt"}</button>
          </div>
        </div>
      )}
      {keysOpen && (
        <div class="pop" role="dialog" aria-label="Keyboard shortcuts" style={{ width: "320px" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <h3>Shortcuts</h3>
            <span class="sp" />
            <button class="btn ghost ib sm" aria-label="Close" data-tip="Close" onClick={() => setKeysOpen(false)}><Icon name="x" /></button>
          </div>
          <div class="keys">
            <span><kbd>Space</kbd></span><span>Play or pause</span>
            <span><kbd>←</kbd> <kbd>→</kbd></span><span>Step one frame (Shift: ten)</span>
            <span><kbd>I</kbd> <kbd>O</kbd></span><span>Set in and out</span>
            <span><kbd>B</kbd></span><span>Draw a box</span>
            <span><kbd>G</kbd></span><span>Grab frame</span>
            <span><kbd>N</kbd></span><span>New note</span>
            <span><kbd>V</kbd></span><span>Select</span>
            <span><kbd>F</kbd></span><span>Full screen</span>
            <span><kbd>1</kbd></span><span>Plan</span>
            <span><kbd>2</kbd>–<kbd>6</kbd></span><span>Review: Timeline, Voice, Music, Effects, Timeline</span>
            <span><kbd>7</kbd> <kbd>8</kbd></span><span>Visuals, Assets</span>
            <span><kbd>[</kbd> <kbd>]</kbd></span><span>Previous or next film</span>
            <span><kbd>Shift</kbd> <kbd>S</kbd></span><span>Shelve or restore the film</span>
            <span><kbd>Alt</kbd> <kbd>←</kbd> <kbd>→</kbd></span><span>Previous or next format</span>
            <span><kbd>\\</kbd></span><span>Hide or show the notes panel</span>
            <span><kbd>?</kbd></span><span>Shortcuts</span>
            <span><kbd>Esc</kbd></span><span>Close</span>
          </div>
        </div>
      )}
      {toastText && (
        <div class="toast" role="status">
          {toastText}
          {toastAction && (
            <button
              type="button"
              class="toastact"
              onClick={() => {
                setToastText(null);
                setToastAction(null);
                toastAction.run();
              }}
            >
              {toastAction.label}
            </button>
          )}
        </div>
      )}

      <div class="work">
        {wrongProject && (
          <div class="banner lost" role="alert">
            <Icon name="alert" />
            {`This tab is for ${state.project.name}, which isn't running here any more. Ask your agent to open it again.`}
          </div>
        )}
        {problem && !wrongProject && <div class="banner"><Icon name="alert" />{problem}</div>}

        {place.workspace === "plan" && (
          <div class="rtabrow planrow">
            <PlanSwitch rows={planRows} selected={isPlanPage(stage) ? stage : null} onPick={(p) => show(p)} />
            {planning && state.build.ready && (
              <div class="planready">
                <span class="rd">
                  <Icon name="check" />
                  Ready to build
                </span>
                <button type="button" class="btn" onClick={() => void copyReady()}>
                  <Icon name="copy" />
                  Copy prompt for your agent
                </button>
              </div>
            )}
          </div>
        )}
        {reviewTabsShown && (
          <div class="rtabrow">
            <ReviewTabs rows={reviewRows} selected={stage} onPick={(v) => show(v as Stage)} />
          </div>
        )}

        {video?.shelved && SHELVED_VIEW_ONLY.has(stage) && <ShelvedBanner video={video} onRestore={() => void setShelved(video, false)} />}

        <main class={`body${video?.shelved ? " fshelved" : ""}`} ref={bodyRef}>
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
            withPanel(<Locked tab={stage} projectName={state.project.name} filmName={video?.name ?? null} found={state.found?.counts} onReview={openFound} toast={toast} />)
          ) : stage === "picture" && soundOnly ? (
            <NoCutTimeline
              key={video?.id ?? "project"}
              state={state}
              assets={assets}
              video={video ?? null}
              notes={mixNotes}
              prompt={agentPrompt("picture", state.project.name, video?.name ?? null)}
              readOnly={!!video?.shelved}
              toast={toast}
              onChanged={() => void refresh()}
              onPendingChange={setPending}
              clock={reviewClock}
              mixView={mixView}
            />
          ) : stage === "picture" && !video ? (
            withPanel(<AllShelved onOpen={() => setShelvedRequest((n) => n + 1)} />)
          ) : stage === "picture" && video && version ? (
            <Picture
              key={video.id}
              readOnly={!!video.shelved}
              video={video}
              version={version}
              fps={fps}
              notes={pictureNotes}
              toast={toast}
              onChanged={() => void refresh()}
              onPendingChange={setPending}
              clock={reviewClock}
              mixView={mixView}
              grab={grabs[video.id] ?? null}
              onGrabChange={setGrabFor}
              playerRef={playerRef}
              ffmpeg={state.proxies?.ffmpeg ?? false}
              proxyJob={proxyJobs[proxyKey(video.id, version.id)]}
              noteProxyJob={noteProxyJob}
              source={sources[video.id] ?? "proxy"}
              onSourceChange={setSourceFor}
              formats={views}
              format={format}
              formatMissing={!!format && missingFiles.has(views.find((f) => f.id === format)?.file ?? "")}
              onPrimarySize={(file, width, height) => setMeasured((m) => (m[file] ? m : { ...m, [file]: { width, height } }))}
              onBoxPendingChange={setBoxPending}
              onMarksPendingChange={setMarksPending}
              onFormatChange={switchFormat}
              // §27, 5.4: on the monitor, and only when there is more than one shape to choose between or to explain.
              formatSwitch={chips.length > 1 ? (
                <FormatToggle chips={chips} versionId={version.id} prompt={formatPrompt(state.project.name, video.name, version.id)} onSelect={switchFormat} toast={toast} />
              ) : null}
              state={state}
              assets={assets}
            />
          ) : stage === "brief" ? (
            withPanel(<Brief brief={state.brief} toast={toast} onChanged={() => void refresh()} settle={planSettle} />, planPanel)
          ) : stage === "storyboard" ? (
            withPanel(<Storyboard board={state.storyboard} brief={state.brief} toast={toast} onChanged={() => void refresh()} settle={planSettle} />, planPanel)
          ) : stage === "visuals" ? (
            <Visuals state={state} toast={toast} onChanged={() => void refresh()} onPendingChange={setPending} />
          ) : stage === "script" ? (
            withPanel(<Script script={state.script} toast={toast} onChanged={() => void refresh()} onPickLine={setPlanLine} />, planPanel)
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
              onPlayingChange={onSoundPlaying}
              clock={reviewClock}
              version={version ?? null}
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
              onPlayingChange={onSoundPlaying}
              clock={reviewClock}
              version={version ?? null}
            />
          ) : null}
        </main>
      </div>
      <StatusBar
        send={statusSend ? { text: statusSend.text, onGo: goSend } : null}
        cut={video && version ? { format: formatLabel, fps, id: version.id, lockedAt: video.lockedVersion } : null}
        // §27, 5.9: with one shape and so no switch on the monitor, the status bar's shape offers the request for the others.
        shapes={stage === "picture" && video && version && chips.length === 1 ? { prompt: formatPrompt(state.project.name, video.name, version.id), toast } : null}
      />
      {state.version && <span class="ver" aria-label={`Rushes version ${state.version}`}>v{state.version}</span>}
    </div>
    </PanelContext.Provider>
  );
}
