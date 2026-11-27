import { renameRetry } from "../core/fsRetry.js";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Store, ChangeEvent } from "../core/store.js";
import { RushesError, InvalidError, NotFoundError } from "../core/errors.js";
import { hostname } from "node:os";
import { addFile, addFormat, addVariant, addVersion, ensureProjectIdOnce, inPlay, lockPicture, noteInPlay, resolveCut, resolveVideo, setShots, setVariantFilms, shelveFilm, shotAt } from "../core/project.js";
import { addTake, allSections, editSection, filmScript, filmScriptDraft, setSections } from "../core/script.js";
import { chooseFilm, filmPlace, firstFilm, noteOnFilm } from "../core/films.js";
import { moveToFirstFilmOnce } from "./films.js";
import { addNote, applyReply, applyUserEdit, byFilm, checkNoteFormat, filterNotes } from "../core/notes.js";
import { FORMAT_ID_RE, MAX_FORMATS, isPictureSize, labelOfId, versionFormats } from "../core/formats.js";
import { createBatch, latestBatch } from "../core/batches.js";
import { markSent, noteState, NOTE_STATES, withState, type NoteState } from "../core/noteState.js";
import { exportFileName, notesMarkdown } from "../core/exportNotes.js";
import { tabStates } from "../core/tabs.js";
import { addVisualVersion, checkVisualNote, registerVisual, visualNoteView, visualRatios, type PageInput, type PictureInput } from "../core/visuals.js";
import { readPicture } from "./visuals.js";
import { shotNoteLabel, shotNoteWhere } from "../core/shotNotes.js";
import { filmKey, recordVersion, shownVersions } from "../core/scriptVersions.js";
import { fromManifestPath, toManifestPath } from "../core/paths.js";
import { AUDIO_FORMATS, PROBE_TIMEOUT_MS, VIDEO_EXT, giveUpAfter, probe, probeVideo, videoGaveUp, type VideoProbe, type VideoProber } from "../core/media.js";
import { PROXY_PATH, ProxyJobs, type ProxyEvent, type ProxyJob } from "./proxy.js";
import { ladderOrder, missingPresets, proxyList } from "../core/proxyPresets.js";
import { PeakJobs } from "./peaks.js";
import { lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GRAB_PATH, OUTSIDE_CUT_EXT, OUTSIDE_MEDIA_EXT, SCREENSHOT_PATH, contentDisposition, contentType, cutOnlyFiles, foundMediaFile, inside, isInlineSafeType, mediaSecurityHeaders, registeredMedia, sendFile, servableFile } from "./files.js";
import { BRING_IN_MAX, FoundScanner, type BringInFailure, type BringInKind, ffprobeDuration, foundAnnouncer, type FoundEntry } from "./found.js";
import { candidatePaths, listAssets, fpsFor, screenshotName } from "./assets.js";
import { osRevealer, osOpener, OPEN_SAFE_EXT, type Revealer, type Opener } from "./reveal.js";
import type { CorruptEvent } from "./watch.js";
import { inUse, setInUse } from "../core/picks.js";
import { filmTakes, putAway } from "../core/takes.js";
import { AGENTS, AgentPermissionsSchema, ProxyPresetSchema, PROXY_PRESETS, LEGACY_PROXY, type ProxyPreset, type ProxySlot, type Version, AlwaysRuleSchema, LaneStageSchema, SectionStatusSchema, StageSchema, BoxSchema, PinSchema, FileKindSchema, MarkSchema, ProjectIdSchema, ShotSchema, LEVEL_MIN, LEVEL_MAX, LEVEL_STEP, lanesForVideo, picksForVideo, variantFilms, type InUse, type Levels, type Batch, type Note, type Picks, type Project, type VisualsFile } from "../core/schema.js";
import { LABEL_MAX, oneLineOf } from "../core/labels.js";
import { byOf, logBookFor } from "./logbook.js";
import { briefRecords, storyboardRecords, type BriefRecords, type StoryboardRecords } from "./plans.js";
import type { BriefService } from "./brief.js";
import type { StoryboardService } from "./storyboard.js";
import { slugify, uniqueId } from "../core/ids.js";
import { buildState, planWarning } from "../core/plan.js";
import {
  broughtInEvent, cutEvent, fileEvent, filmEvent, formatEvent, lineEvent, lockEvent, notesSentEvent, picksEvent, repliesEvent, scriptEvent, takeEvent, variantEvent, variantFilmsEvent, visualEvent,
} from "../core/logEvents.js";
import { LOG_AREAS, LOG_MAX, changeLogFileName, logText, recentChanges } from "../core/logText.js";
import { defaultRunner, measureMix, type LoudnessRunner } from "./loudness.js";
import { balanceFilm, type FilmBalance } from "./balance.js";
import { balanceSummary } from "../core/balance.js";
import type { LogEvent } from "../core/log.js";
import type { AgentRunner, AgentStatus, SendResult } from "./agent/runner.js";
import { clearDetectCache, detectAgents, type AgentInfo } from "./agent/detect.js";
import { AGENT_HELP, signInLabel } from "../core/agentHelp.js";
import type { ConnectorStatus } from "./agent/connectors.js";
import type { AgentId, Section } from "../core/schema.js";
import { openInTerminal, type TerminalOpener } from "./agent/terminal.js";
import { ATTENTION_TITLE_MAX, raiseAttention, replySettles, resolveAttention } from "../core/attention.js";
import { resumeFor } from "./agent/resume.js";
import { agentRulesFor } from "./agent/rules.js";
import { adoptAgentDefaultsOnce, rememberDefault } from "./agent/setupOnce.js";
import { notifyWhenWaiting, osNotifier, type Notifier } from "./agent/notify.js";

import { VERSION } from "../version.js";
export { VERSION };

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new InvalidError("Request body must be JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new InvalidError("Request body is invalid", parsed.error.issues);
  return parsed.data;
}

const t = z.number().nonnegative();
// §21.3: a format id, "9x16" or "2.39x1". Capped like the schema's own id.
const formatId = z.string().max(16).regex(FORMAT_ID_RE);
/** The longest path a format may be registered under (FoundItem and FoundPathsBody use the same). */
const MAX_PATH = 1024;

/** §25.5: a note on a visual with where it is, in words, and the picture to open: what an agent reading the batch needs. */
// Every note the server hands out carries its lifecycle state (noteState.ts), worked out, never stored.
function withVisualViews<T extends Note>(notes: T[], visuals: Pick<VisualsFile, "visuals">): ((T & { state: NoteState }) | (T & { state: NoteState; visual: ReturnType<typeof visualNoteView> }))[] {
  return notes.map((n) =>
    n.stage === "visuals"
      ? { ...withState(n), visual: visualNoteView(n, visuals) }
      : // §38.4: a storyboard note says which shot and where on its still, in words, for the agent.
        n.stage === "storyboard"
        ? { ...withState(n), shotLabel: shotNoteLabel(n), where: shotNoteWhere(n) }
        : withState(n),
  );
}

const NewNoteBody = z.object({
  stage: StageSchema,
  video: z.string().nullish(),
  version: z.string().nullish(),
  on: z.string().nullish(),
  scope: z.enum(["point", "range", "whole"]),
  t: t.nullish(),
  tOut: t.nullish(),
  frame: z.number().int().nonnegative().nullish(),
  text: z.string(),
  box: BoxSchema.nullish(),
  pin: PinSchema.nullish(),
  grab: z.string().nullish(),
  marks: z.array(MarkSchema).max(4).optional(),
  format: formatId.nullish(),
});

// §25.5: a new visual (a name) or a new version of one (a visual), with the pages that are new or changed.
const VisualBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    visual: z.string().trim().min(1).max(80).optional(),
    kind: z.enum(["still", "carousel"]).optional(),
    label: z.string().trim().max(LABEL_MAX).optional(),
    pages: z.array(z.object({ n: z.number().int().positive().optional(), files: z.array(z.string().min(1).max(1024)).min(1).max(MAX_FORMATS) })).min(1).max(100),
  })
  .refine((b) => (b.name !== undefined) !== (b.visual !== undefined), { message: "send name (a new visual) or visual (a new version of one), not both" })
  .refine((b) => b.name !== undefined || b.kind === undefined, { message: "kind is for a new visual" });

const UserEditBody = z.object({
  text: z.string().optional(),
  box: BoxSchema.nullable().optional(),
  pin: PinSchema.nullable().optional(),
  grab: z.string().nullable().optional(),
  scope: z.enum(["point", "range", "whole"]).optional(),
  t: t.nullable().optional(),
  tOut: t.nullable().optional(),
  marks: z.array(MarkSchema).max(4).optional(),
  status: z.enum(["todo", "done"]).optional(),
  format: formatId.nullable().optional(),
});

const RepliesBody = z.object({
  replies: z
    .array(
      z.object({
        id: z.string(),
        reply: z.string().optional(),
        status: z.enum(["todo", "done"]).optional(),
        fixT: t.nullable().optional(),
        fixVersion: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

// §22.4: `label` is a short label for the version list (R2: the limit is enforced here, not in the file).
const VersionBody = z.object({
  video: z.string().min(1),
  file: z.string().min(1),
  note: z.string().optional(),
  // Cleaned to one line first, so padding and invisible characters don't count, then counted in characters.
  label: z
    .string()
    .transform(oneLineOf)
    .refine((s) => Array.from(s).length <= LABEL_MAX, `label is ${LABEL_MAX} characters at most: put the detail in note`)
    .optional(),
  // §21.4: the other shapes of this same cut, registered in the same call. `file` is the main one.
  formats: z.array(z.object({ file: z.string().min(1).max(MAX_PATH) })).max(MAX_FORMATS - 1).optional(),
});
// §21.4: `label` here is only a hint for the ratio's name ("2.39:1"), not a version's short label.
const FormatBody = z.object({
  video: z.string().min(1).max(200).optional(),
  version: z.string().min(1).max(64).optional(),
  file: z.string().min(1).max(MAX_PATH),
  label: z.string().trim().min(1).max(16).optional(),
});
const VariantBody = z.object({
  stage: LaneStageSchema,
  lane: z.string().optional(),
  round: z.string().min(1).max(64).optional(),
  name: z.string().min(1),
  file: z.string().min(1),
  meta: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  description: z.string().min(1).max(200).optional(),
  // One film or several: a bed is often fitted to more than one.
  video: z.union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).min(1).max(100)]).optional(),
  // §23.6: a cue's file has no length cap here. The 1024 limit applies to the stored (manifest) form,
  // which checkCueFile enforces with a 400 naming the cue.
  cues: z.array(z.object({ name: z.string().min(1), t, file: z.string().min(1).optional() })).optional(),
});
const VariantFilmsBody = z.object({ videos: z.array(z.string().min(1).max(200)).max(100) });
// §31.6: the script, brief and storyboard are a film's: a write names its film (`video`, an id or a name). With one
// film it may be left out; with several, leaving it out is refused with the films listed.
const filmRef = z.string().min(1).max(200).optional();
const ScriptBody = z.object({
  video: filmRef,
  wordsPerSecond: z.number().positive().optional(),
  replace: z.boolean().optional(),
  sections: z.array(z.object({ id: z.string().min(1).optional(), start: t, end: t, current: z.string() })),
});
const SectionEditBody = z.object({
  video: filmRef,
  proposed: z.string().nullable().optional(),
  direction: z.string().optional(),
  status: SectionStatusSchema.optional(),
});
const TakeBody = z.object({ file: z.string().min(1), video: filmRef });
// §24 step 2: a save of one brief.md section, and the approval. `hash` proves the page saw the current file.
const BriefSectionBody = z.object({ video: filmRef, heading: z.string().min(1).max(200), text: z.string().max(100_000), hash: z.string().min(1).max(64) });
const BriefStatusBody = z.object({ video: filmRef, status: z.enum(["draft", "approved"]), hash: z.string().min(1).max(64) });
// §24.12: a change to one storyboard shot: its words, its direction, its status, in any combination.
const StoryboardShotBody = z
  .object({
    video: filmRef,
    heading: z.string().min(1).max(200),
    description: z.string().max(100_000).optional(),
    direction: z.string().max(1000).optional(),
    status: z.enum(["draft", "approved"]).optional(),
    hash: z.string().min(1).max(64),
  })
  .refine((b) => b.description !== undefined || b.direction !== undefined || b.status !== undefined, { message: "Nothing to change" });
// A pick is a variant or take id; null clears it. picks.json itself only ever holds strings.
const PickMap = z.record(z.string(), z.string().nullable());
// §19.6: a level is −24..6 dB in 0.5 dB steps; null resets it to 0 (removes the key).
const LevelValue = z.number().min(LEVEL_MIN).max(LEVEL_MAX).multipleOf(LEVEL_STEP);
const LevelsBody = z.object({ voice: LevelValue.nullable(), music: LevelValue.nullable(), sfx: LevelValue.nullable() }).partial();
const PutAwayBody = z.object({ away: z.boolean() });
const PicksBody = z.object({ video: z.string().min(1).max(200).optional(), lanes: PickMap.optional(), sections: PickMap.optional(), levels: LevelsBody.optional() });
// §28: the Send to AI switch, the agent and what it may do unasked.
// `batch` (I3): the filed batch the copy dialog was showing when its Set up opened the sheet. Once Send to AI is on, it is
// handed to the agent, as Send would have.
// §32: `prompt`: the first-Send sheet's Copy a prompt (off, and no agent for new projects either). The switch turned off
// sends no `prompt`, so it leaves the Mac-wide default as it is.
const AgentSetupBody = z.object({ on: z.boolean(), agent: z.enum(AGENTS).optional(), permissions: AgentPermissionsSchema.optional(), batch: z.string().min(1).optional(), prompt: z.boolean().optional() });

// No stage: every tab's open notes (Send). A stage: that tab's only. §31.2.2: `video`, the film Send is pressed on:
// only its notes and its script go. Without one, every film in play (an older client).
const BatchBody = z.object({ stage: StageSchema.optional(), video: filmRef });
// §38.7: Send to agent from a Plan page: the prompt the page would copy, and what the turn is called.
const AskBody = z.object({ prompt: z.string().trim().min(1).max(4000), label: z.string().trim().min(1).max(80), video: filmRef });

const NoteQuery = z.object({
  stage: StageSchema.optional(),
  status: z.enum(["todo", "done"]).optional(),
  state: z.enum(NOTE_STATES).optional(),
  batch: z.string().optional(),
  version: z.string().optional(),
  // §21.4: a format's notes, with the all-format notes unless onlyThisFormat (R14: Picture only).
  format: formatId.optional(),
  onlyThisFormat: z.enum(["true", "false"]).optional(),
  // §26: the notes of a shelved film are left out unless asked for (or a batch is: it lists what it sent).
  includeShelved: z.enum(["true", "false"]).optional(),
  // §31.6: one film's notes (and the visuals', which are on every film).
  video: z.string().min(1).max(200).optional(),
});
// §31.6: the film a read is about, for the routes that take ?video= alone.
const VideoQuery = z.object({ video: z.string().min(1).max(200).optional() });

// ShotSchema's own limits (name trimmed 1-80 chars, tag at most 24) apply at the boundary; `n` is server-assigned.
const ShotsBody = z.object({
  version: z.string().optional(),
  shots: z.array(ShotSchema.omit({ n: true })).max(200),
});

const LockBody = z.object({ version: z.string().nullable() });
const ShelveBody = z.object({ shelved: z.boolean() });

const MixLoudnessBody = z.object({ lanes: z.array(LaneStageSchema).min(1), video: z.string().min(1).max(200).optional() });
const BalanceBody = z.object({ video: z.string().min(1).max(200).optional() });

// §36.5, §37.4: the project's proxy settings. `autoProxy` is §19.5's name for `alwaysProxy`, and `proxyPreset` §36's
// one quality (a one-item `proxyPresets`), both still taken from an older client.
const SettingsBody = z
  .object({
    alwaysProxy: z.boolean().optional(),
    proxyPresets: z.array(ProxyPresetSchema).max(8).optional(),
    proxyPreset: ProxyPresetSchema.optional(),
    autoProxy: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.alwaysProxy !== undefined || b.proxyPresets !== undefined || b.proxyPreset !== undefined || b.autoProxy !== undefined, { message: "Nothing to change" });
const ProxyBody = z.object({ preset: ProxyPresetSchema.optional() }).strict();
const ProxySlotSchema = z.enum([...PROXY_PRESETS, LEGACY_PROXY]);
// A time in seconds, 0 to 24 h: an empty value, NaN, Infinity or anything huge is a 400.
const FrameQuery = z.object({
  t: z.string().min(1).pipe(z.coerce.number<string>().finite().min(0).max(86400)),
  // R12: the format whose own file the frame is read from. The cut's primary when left out.
  format: formatId.optional(),
});

const GrabBody = z.object({
  video: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  version: z.string().regex(/^v\d+$/),
  // Capped well short of where it would print in exponent form in the grab's filename.
  frame: z.number().int().nonnegative().max(10_000_000),
  /** PNG bytes, base64, with or without a data: prefix. */
  png: z.string().min(1),
  // §21.5: the format on screen when it isn't the cut's primary. Must be one of the cut's shapes.
  format: formatId.optional(),
});

const RevealBody = z.union([z.object({ path: z.string().min(1) }), z.object({ project: z.literal(true) })]);
const OpenBody = z.object({ path: z.string().min(1) });
const AddFileBody = z.object({
  kind: FileKindSchema,
  file: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  note: z.string().max(500).optional(),
  video: z.string().optional(),
});

// §20.6: the found routes. A scan may name the film whose newest cut anchors the scoring.
const FoundItem = z.object({
  path: z.string().min(1).max(1024),
  kind: z.enum(["voice", "music", "sfx", "cut", "doc"]).optional(),
  round: z.string().trim().min(1).max(64).optional(),
});
// §20.7: `wait` makes the scan answer once it and the adoption are done, with what's in and what's
// left. `include` (only with `wait`) brings in files the agent knows belong, before adopting.
const FoundScanBody = z
  .object({
    film: z.string().min(1).max(200).optional(),
    wait: z.boolean().optional(),
    include: z.array(FoundItem).max(BRING_IN_MAX).optional(),
  })
  .refine((b) => b.include === undefined || b.wait === true, { message: "include needs wait: true", path: ["include"] });
const FoundPathsBody = z.object({ paths: z.array(z.string().min(1).max(1024)).min(1).max(500) });
const FoundBringInBody = z.object({
  files: z.array(FoundItem).min(1).max(BRING_IN_MAX),
  film: z.string().min(1).max(200).optional(),
});

// §22.7: the Change Log's routes. A line is made one line and cut to 160 characters by the server (R21).
// Ruling a: a query it can't use is a 400 that says what to send, never a quiet default.
const LIMIT_WORDS = `limit must be a whole number from 1 to ${LOG_MAX}`;
/** 2026-10-07, optionally with a time (minutes, seconds, fractions) and a zone (Z or ±hh[:]mm). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const LogQuery = z.object({
  limit: z.string({ error: LIMIT_WORDS }).regex(/^\d+$/, LIMIT_WORDS).pipe(z.coerce.number<string>().int(LIMIT_WORDS).min(1, LIMIT_WORDS).max(LOG_MAX, LIMIT_WORDS)).optional(),
  area: z.enum(LOG_AREAS, { error: `area must be one of ${LOG_AREAS.join(", ")}` }).optional(),
  // ISO style only: Date.parse alone would read "0" or "1" as a year (M4).
  since: z
    .string()
    .refine((s) => ISO_DATE.test(s) && Number.isFinite(Date.parse(s)), "since must be a date and time, e.g. 2026-10-07T09:00:00Z")
    .optional(),
  // §31.6: the lines Activity shows on this film: its own and the project's.
  video: z.string().min(1).max(200).optional(),
});
const LogLineBody = z.object({
  text: z.string().max(2000),
  area: z.enum(LOG_AREAS, { error: `area must be one of ${LOG_AREAS.join(", ")}` }).optional(),
  video: z.string().min(1).max(200).nullish(),
  version: z.string().min(1).max(64).nullish(),
  ref: z.string().min(1).max(300).nullish(),
});

// Big enough for a full-quality frame of a 4K original from the frame endpoint (§19.5), which
// Picture posts here as the grab: 3840×2160 RGB is 24.9 MB before PNG compression.
const MAX_GRAB_BYTES = 64 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Where the built dashboard lives: <package>/web-dist, next to dist/ and src/. */
export const DEFAULT_WEB_DIR = fileURLToPath(new URL("../../web-dist/", import.meta.url));

/** How long a waiting scan (§20.7) answers at most, before it says it is still scanning. */
export const FOUND_WAIT_MS = 20_000;

export interface AppOptions {
  /** §24 step 2, §31.3: every film's brief.md service. startServer passes its own so it can poll the files and stop on close. */
  briefs?: BriefRecords;
  /** The root brief.md's service (the first film's), when the caller has made one (tests). */
  brief?: BriefService;
  /** The root storyboard.md's service, the same way. */
  storyboard?: StoryboardService;
  /** §24.12, §31.3: every film's storyboard.md service, the same way. */
  storyboards?: StoryboardRecords;
  /** Overrides FOUND_WAIT_MS (tests). */
  foundWaitMs?: number;
  /** Folder with the built dashboard (index.html + assets/). */
  webDir?: string;
  /** Called after POST /api/shutdown has replied. */
  onShutdown?: () => void;
  /**
   * The project's id, already ensured. `startServer` sets this on the same options object it
   * passed in, as soon as it has won the project's lock and ensured the id, so every request
   * from then on reads it straight off. Left unset only by in-process app tests that construct
   * `createApp(store)` directly without it, which fall back to `ensureProjectIdOnce` below — the
   * same store-keyed, de-duplicated path `startServer` itself uses, so even a direct test
   * calling this concurrently from several requests never ensures (and so never writes) the id
   * twice.
   */
  projectId?: string;
  /** Reveals a file in the system file manager for POST /api/reveal. Defaults to osRevealer. */
  reveal?: Revealer;
  /** Opens a file in its default application for POST /api/open. Defaults to osOpener. */
  open?: Opener;
  /** Runs ffmpeg for POST /api/mix/loudness. Defaults to a real ffmpeg spawn. Tests inject a fake. */
  loudnessRunner?: LoudnessRunner;
  /** Kills a loudness ffmpeg run after this many ms, returning 504. Defaults to 60s; tests set it low. */
  loudnessTimeoutMs?: number;
  /**
   * §29: balance a film again by itself when the take in use for one of its sounds changes, while its levels are
   * still the last balance's own (or unset). startServer turns it on; a bare createApp (most tests) leaves it off.
   */
  autoBalance?: boolean;
  /** §29: told when an automatic balance has finished (null: it didn't write: ffmpeg missing, levels moved, a newer pick). */
  onAutoBalance?(video: string | undefined, summary: string | null): void;
  /** §19.5's proxy jobs (and the ffmpeg/ffprobe they use). startServer passes its own so it can cancel them on close; tests inject fakes. */
  proxyJobs?: ProxyJobs;
  /** §19.9's waveform jobs. startServer passes its own so it can stop them on close; defaults to the proxy jobs' ffmpeg. */
  peakJobs?: PeakJobs;
  /** §20's scanner for the project's other files. startServer passes its own (it runs the first scan and closes it); tests inject one with a fake probe. */
  found?: FoundScanner;
  /** §21: reads a render's shape on screen for formats. Defaults to ffprobe (probeVideo); tests inject a fake. */
  formatProbe?: VideoProber;
  /** How long a render's read may take before Rushes gives up on it. Defaults to PROBE_TIMEOUT_MS; tests set it low. */
  formatProbeTimeoutMs?: number;
  /**
   * §28: the project's one agent runner. startServer passes its own so it can close it and keep the server up
   * while it works. Without one (in-process app tests) there is no agent: Send says Send to AI is off, and the
   * routes that drive an agent answer 503. Nothing is subscribed to the store, so nothing is left open.
   */
  agent?: AgentControl;
  /** §28: which agents are installed and signed in, for setup and sign-in. Defaults to detectAgents; tests inject a fake. */
  detect?: () => Promise<AgentInfo[]>;
  /** §34: each agent's connector fetch, for the desk's "Getting ready". Defaults to ready (no fetch: tests, the fake agent). */
  connectors?: (agent: AgentId) => ConnectorStatus;
  /** §28: opens a terminal with an agent's login command for "Sign in". Defaults to openInTerminal; tests inject a fake. */
  terminal?: TerminalOpener;
  /**
   * §35.5: the key that proves a desk was opened on this computer (the server's lock token; see lock.ts hereKey). Without
   * one (tests, a server with no lock yet) no desk counts as local, and an Attention item's click shows the command.
   */
  here?: () => string | undefined;
  /** §35.5: whether the request came from this computer. Defaults to its socket's address being a loopback one. */
  fromHere?: (c: Context) => boolean;
  /** §35.5: this computer's short name, for "Run this on <host>". Defaults to os.hostname() up to its first dot. */
  hostname?: () => string;
  /** §28: how long Send waits for the agent to take the batch before answering `starting: true`. Defaults to SEND_WAIT_MS. */
  sendWaitMs?: number;
  /**
   * Spec §5.4: tells the Mac when the agent waits on the user (an ask, or a run ending in a question) and no desk
   * has the events stream open. Only with an `agent`. Defaults to osNotifier; tests inject a fake.
   */
  notify?: Notifier;
}

/** What the routes use of the agent runner. */
export type AgentControl = Pick<AgentRunner, "status" | "reload" | "send" | "resend" | "stop" | "answer" | "removeRule" | "workingOn">;

/**
 * What Send's response says about the agent: the runner's own result, or, when the agent is still starting after
 * SEND_WAIT_MS, `starting: true`. The batch is then queued; a later failure reaches the desk as the agent status.
 */
export type SendHandOver = SendResult | { handedTo: AgentId | null; starting: true };

/** How long Send's response waits for the agent to take the batch (a first start can take minutes). */
export const SEND_WAIT_MS = 5_000;

// `asked`: with no runner there is nothing to set up, so Send never opens the first-Send sheet.
const OFF_STATUS: AgentStatus = {
  on: false, agent: null, phase: "off", batches: [], current: { note: null, doing: null }, asks: [], lines: [], error: null, session: null,
  asked: true, permissions: "project-edits", always: [],
};

/** The stand-in when no runner is given: Send to AI is off, and nothing can drive an agent. */
function noAgent(): AgentControl {
  const none = () => Promise.reject(new RushesError("Send to AI runs only in a Rushes server.", 503, "agent_unavailable"));
  return {
    status: () => structuredClone(OFF_STATUS),
    reload: async () => structuredClone(OFF_STATUS),
    send: async () => ({ handedTo: null, why: "Send to AI is off" }),
    resend: async () => null,
    stop: async () => undefined,
    answer: none,
    removeRule: none,
    workingOn: none,
  };
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

/** Hostname of "host[:port]" or a full origin URL, lowercased, or null when it doesn't parse. */
function hostnameOf(value: string, isUrl: boolean): string | null {
  try {
    return new URL(isUrl ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** §35.5: the request's socket is this computer's own (127.0.0.0/8 or ::1). A tunnel's requests are too: see `here`. */
export function peerIsLoopback(c: Context): boolean {
  const addr = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? "";
  return addr === "::1" || /^(::ffff:)?127\./.test(addr);
}

/** "Reds-Mac-mini.local" -> "Reds-Mac-mini". */
export const shortHostname = (): string => hostname().split(".")[0] || hostname();

export function createApp(store: Store, opts: AppOptions = {}): Hono {
  const webDir = opts.webDir ?? DEFAULT_WEB_DIR;
  const reveal = opts.reveal ?? osRevealer;
  const open = opts.open ?? osOpener;
  const jobs = opts.proxyJobs ?? new ProxyJobs(store);
  const peaks = opts.peakJobs ?? new PeakJobs(store, { run: jobs.run, available: () => jobs.available() });
  const found = opts.found ?? new FoundScanner({ store, probe: ffprobeDuration, announce: foundAnnouncer(store) });
  const briefs = opts.briefs ?? briefRecords(store, opts.brief);
  const storyboards = opts.storyboards ?? storyboardRecords(store, opts.storyboard);
  // §28: made before any route is reachable, so every agent route and Send has it.
  const agent = opts.agent ?? noAgent();
  const sendWaitMs = opts.sendWaitMs ?? SEND_WAIT_MS;
  const detect = opts.detect ?? (() => detectAgents());
  const terminal = opts.terminal ?? openInTerminal;
  const here = opts.here ?? (() => undefined);
  const fromHere = opts.fromHere ?? peerIsLoopback;
  const hostname = opts.hostname ?? shortHostname;
  const connectors = opts.connectors ?? ((): ConnectorStatus => ({ state: "ready" }));
  /** §24.12, §31.5: whether a film's plan (its brief, script and storyboard) is approved, from the files as they are now. */
  const planBuild = async (video?: string | null) => {
    const project = await store.read("project");
    const place = filmPlace(project, video);
    const [b, script, sb] = await Promise.all([briefs.at(place).view(), store.read("script"), storyboards.at(place).view()]);
    return buildState({ brief: b, script: filmScript(script, project, place.video).sections, storyboard: sb });
  };
  /**
   * §31.6: the film a request for a film's material is about: the one it names, or the only one. With several films
   * and none named, a 400 that lists them. Null while the project has no film.
   */
  const filmOf = async (given: string | null | undefined, what?: string): Promise<string | null> => chooseFilm(await store.read("project"), given, what)?.id ?? null;
  /** The whole script's sections, for what must know every take whichever film it is in (the log, refs). */
  const everySection = (script: Awaited<ReturnType<typeof store.read<"script">>>) => ({ sections: allSections(script) });
  // §22: the Change Log, shared with the found scanner (logBookFor keeps one per store).
  const log = logBookFor(store);
  const by = (c: Context) => byOf(c.req.header("x-rushes-project"));
  /** §35.5: clears the open Attention items on these notes. A log that can't be written is reported, not thrown: the note's change stands. */
  const settleAttention = (notes: Set<string>) =>
    log.change((f) => resolveAttention(f, (e) => !!e.note && notes.has(e.note), new Date())).catch((e: unknown) => console.error(`Rushes: couldn't clear an attention item: ${(e as Error).message}`));
  /** R17: writes exports/change-log-YYYY-MM-DD.md (a same-day export replaces it) and returns its path. Written as Export notes writes. */
  async function exportChangeLog(now: Date): Promise<string> {
    const [project, script] = await Promise.all([store.read("project"), store.read("script")]);
    const md = await log.markdown({ project, script: everySection(script) }, now);
    const name = changeLogFileName(now);
    const dir = join(store.root, "exports");
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${name}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tmp, md, "utf8");
    await renameRetry(tmp, join(dir, name));
    return `exports/${name}`;
  }
  const prober: VideoProber = opts.formatProbe ?? ((abs, signal) => probeVideo(abs, { signal }));
  const proberTimeout = opts.formatProbeTimeoutMs ?? PROBE_TIMEOUT_MS;
  /**
   * Every read of a render (review I2): given up on like any ffprobe, so a stalled drive never holds
   * a request, and stopped when the server closes or `stop` aborts.
   */
  const readVideo = (abs: string, stop?: AbortSignal): Promise<VideoProbe> =>
    jobs.tracked((closing) => {
      const signal = stop ? AbortSignal.any([closing, stop]) : closing;
      if (signal.aborted) return Promise.resolve(videoGaveUp("aborted"));
      return giveUpAfter(prober(abs, signal), { timeout: proberTimeout, signal, gaveUp: videoGaveUp });
    });
  const isPlainFile = (abs: string) => stat(abs).then((s) => s.isFile(), () => false);
  /**
   * §21.3/§21.6: a render's shape on screen, length and rate, or the refusal in the user's words.
   * Only a plain file on disk reaches the probe, and a format must have a video extension; the
   * cut's own file (`primary`) is judged as it is without formats, by what ffprobe makes of it.
   * The size comes back untouched: addFormat judges it (a size that isn't a picture is its RushesError).
   */
  async function readRender(
    given: string,
    how: { primary?: boolean; stop?: AbortSignal } = {},
  ): Promise<{ file: string; width: number; height: number; duration: number | null; fps: number | null }> {
    const file = toManifestPath(store.root, given);
    const abs = fromManifestPath(store.root, file);
    if (!how.primary && !VIDEO_EXT.has(extname(file).toLowerCase().replace(/^\./, ""))) throw new RushesError(`${file} isn't a video file.`, 400, "not_video", { path: file });
    if (!(await isPlainFile(abs))) throw new RushesError(`File not found: ${file}`, 404, "missing_file", { path: file });
    const r = await readVideo(abs, how.stop);
    if (!r.ok) {
      if (r.code === "no_ffprobe") throw new RushesError("Registering a format needs ffprobe to read the ratio. Run `rushes doctor` for how to add it.", 501, "no_ffprobe");
      if (r.code === "not_video") throw new RushesError(`${file} isn't a video: ${r.reason}.`, 400, "not_video", { path: file });
      throw new RushesError(`ffprobe couldn't read ${file}: ${r.reason}`, 422, "unreadable", { path: file });
    }
    return { file, width: r.width, height: r.height, duration: r.duration, fps: r.fps };
  }
  const app = new Hono();
  // Every SSE client adds a change listener, so lift Node's default limit of ten.
  store.setMaxListeners(0);

  // The project's id never changes once set. When startServer has already ensured and passed
  // it in, this is immediate; otherwise it shares project.ts's one in-flight ensure (see M3).
  async function getProjectId(): Promise<string> {
    return opts.projectId ?? ensureProjectIdOnce(store);
  }

  async function dashboardHtml(): Promise<string> {
    const index = join(webDir, "index.html");
    if (existsSync(index)) return readFile(index, "utf8");
    return `<!doctype html><title>Rushes</title><p>Rushes is running for <code>${escapeHtml(store.root)}</code>. The dashboard isn't built: run <code>npm run build</code>.</p>`;
  }

  /** The "this address belongs to a project not running here" page: always 404, id always escaped. */
  function wrongProjectPage(c: Context, id: string) {
    return c.html(
      `<!doctype html><title>Rushes</title><p>The Rushes project this address belongs to isn't running on this port. Ask your agent to open it again.</p><p><code>${escapeHtml(id)}</code></p>`,
      404,
    );
  }

  app.onError((err, c) => {
    if (err instanceof RushesError) return c.json({ error: err.code, message: err.message, ...err.detail }, err.status as 400);
    console.error(err);
    return c.json({ error: "internal", message: (err as Error).message }, 500);
  });

  // The server is for this machine only. Checking Host stops DNS rebinding;
  // requiring JSON and a local Origin on writes stops other websites posting
  // to it from the user's browser (a JSON content type forces a CORS preflight,
  // which this server never answers).
  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    const hostname = hostnameOf(host, false);
    if (!hostname || !LOCAL_HOSTS.has(hostname)) {
      return c.json({ error: "forbidden_host", message: `Rushes only answers requests to 127.0.0.1 or localhost, not "${host}"` }, 403);
    }
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const type = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (type !== "application/json") {
        return c.json({ error: "unsupported_media_type", message: "Requests that change data must send Content-Type: application/json" }, 415);
      }
      const origin = c.req.header("origin");
      if (origin !== undefined) {
        const from = hostnameOf(origin, true);
        if (!from || !LOCAL_HOSTS.has(from)) {
          return c.json({ error: "forbidden_origin", message: `Rushes doesn't accept changes from pages on "${origin}"` }, 403);
        }
      }
    }
    await next();
  });

  // Each dashboard tab carries this project's id (header on fetches, query param
  // where headers can't be set, e.g. SSE and <img>/<video> src). A request naming
  // a different project is refused; one with no id (MCP, CLI, curl) is unaffected.
  app.use("*", async (c, next) => {
    const given = c.req.header("x-rushes-project") ?? c.req.query("project");
    if (given !== undefined && given !== (await getProjectId())) {
      return c.json({ error: "wrong_project", message: "This page is for a different Rushes project" }, 409);
    }
    await next();
  });

  // ---- dashboard ----
  app.get("/", async (c) => c.redirect(`/p/${await getProjectId()}/`, 302));

  // No trailing slash: just add it, once the id's shape is valid. The id is never
  // substituted for this server's own (a stale tab from a different project must
  // still land on /p/:id/ and see the "isn't running here" page there, never be
  // silently carried over to this project), and an invalid id is never reflected
  // into a Location header — it gets the same 404 page the slash route would give it.
  app.get("/p/:id", (c) => {
    const id = c.req.param("id");
    const parsed = ProjectIdSchema.safeParse(id);
    if (!parsed.success) return wrongProjectPage(c, id);
    return c.redirect(`/p/${parsed.data}/`, 302);
  });

  app.get("/p/:id/", async (c) => {
    const id = c.req.param("id");
    if (id !== (await getProjectId())) return wrongProjectPage(c, id);
    return c.html(await dashboardHtml());
  });

  app.get("/assets/*", async (c) => {
    const raw = new URL(c.req.url).pathname.slice(1);
    let rel: string;
    try {
      rel = decodeURIComponent(raw);
    } catch {
      throw new NotFoundError("asset", raw);
    }
    const file = inside(webDir, rel);
    if (!file) throw new NotFoundError("asset", rel);
    const res = await sendFile(file, undefined, contentType(file));
    if (res.status === 404) throw new NotFoundError("asset", rel);
    res.headers.set("cache-control", "public, max-age=31536000, immutable");
    return res;
  });

  // ---- media: only files the project registered, plus its own screenshots and grabs ----
  app.get("/media", async (c) => {
    const path = c.req.query("path") ?? "";
    const [project, script] = await Promise.all([store.read("project"), store.read("script")]);
    // Fast path (no filesystem reads beyond the file itself): registeredMedia is a project.json
    // lookup, and GRAB_PATH/SCREENSHOT_PATH are plain regexes. This covers every cut, take,
    // variant and registered library file, and every screenshot/grab -- by far the common case,
    // and the one a byte-range video seek hits over and over. Only a path that misses all three
    // falls through to candidatePaths, which does the readdir-backed discovery (§16.2's
    // auto-discovered docs/captions/exports) that a registered path never needs.
    let known = registeredMedia(project, script).has(path) || GRAB_PATH.test(path) || SCREENSHOT_PATH.test(path);
    // §25.7: a registered visual's pictures. Read visuals.json only when the above missed, so a cut's seeks never touch it.
    if (!known && registeredMedia(project, script, await store.read("visuals")).has(path)) known = true;
    // §24.12: a picture storyboard.md names (a safe, project-relative image path) is served too, registered or not.
    // §31.3: any film's storyboard.
    if (!known) {
      for (const sb of await storyboards.all()) {
        if ((await sb.stills()).has(path)) {
          known = true;
          break;
        }
      }
    }
    // The file on disk to send. For a found file it's exactly the path that was checked.
    let file = fromManifestPath(store.root, path);
    let viaFound = false;
    if (!known) {
      if (found.has(path)) {
        // §20.5: a found file can be auditioned before it's brought in -- only one the last scan
        // recorded (and not dismissed), only as a plain file inside the project folder, never
        // through a symlink. Served with the same headers as everything else below.
        const checked = await foundMediaFile(store.root, path);
        if (!checked) throw new NotFoundError("media", path);
        file = checked;
        viaFound = true; // already refused any symlink outright
      } else {
        const candidates = await candidatePaths(store, project, script);
        if (!candidates.has(path)) throw new NotFoundError("media", path);
      }
    }
    if (!viaFound) {
      // §15.5: a registered file reached through a symlink out of the project is served only if it is media.
      // Final review M2: a cut or format that resolves outside the project is served only as video or audio.
      const servable = await servableFile(store.root, file, cutOnlyFiles(project, script).has(path) ? OUTSIDE_CUT_EXT : OUTSIDE_MEDIA_EXT);
      if (!servable) throw new NotFoundError("media", path);
      file = servable;
    }
    // C1: a type a browser could render as a document (HTML, XML, SVG -- an SVG can carry
    // script -- or anything this server doesn't otherwise recognise) is never served inline,
    // whatever asked for it: exports/ in particular takes any file with no extension filter, so
    // without this an exports/x.html would be served as text/html on the dashboard's own origin,
    // free to call its API. Forced to a generic download instead, regardless of ?download=1.
    // §19.5: a proxy is a file this server wrote into proxies/. A symlink planted at that name
    // (or anything that isn't a plain file) is never followed.
    if (PROXY_PATH.test(path)) {
      const info = await lstat(fromManifestPath(store.root, path)).catch(() => null);
      if (!info || !info.isFile() || info.isSymbolicLink()) throw new NotFoundError("media", path);
    }
    const type = contentType(path);
    const inlineSafe = isInlineSafeType(type);
    const res = await sendFile(file, c.req.header("range"), inlineSafe ? type : "application/octet-stream");
    res.headers.set("cross-origin-resource-policy", "same-origin");
    for (const [name, value] of Object.entries(mediaSecurityHeaders())) res.headers.set(name, value);
    if (res.status !== 404 && (!inlineSafe || c.req.query("download") === "1")) {
      res.headers.set("content-disposition", contentDisposition(basename(path)));
    }
    return res;
  });

  app.post("/api/grabs", async (c) => {
    const b = await body(c, GrabBody);
    const bytes = Buffer.from(b.png.replace(/^data:image\/png;base64,/, ""), "base64");
    if (bytes.length > MAX_GRAB_BYTES) throw new InvalidError(`Frame grab is over ${MAX_GRAB_BYTES / 1024 / 1024} MB`);
    if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new InvalidError("Frame grab must be a PNG");
    const project = await store.read("project");
    const fps = fpsFor(project, b.video, b.version);
    // §21.5: a grab of a format is named with its ratio; the format must be one of this cut's. The
    // dashboard names only a non-primary format (Task 2 review M4: an older cut with formats but no
    // stored size has no primary id), so a grab with none is the primary's, which carries its own
    // ratio whenever the cut has other formats and the primary's shape is known.
    const version = project.videos.find((v) => v.id === b.video)?.versions.find((v) => v.id === b.version);
    const shapes = version ? versionFormats(version) : [];
    if (b.format !== undefined && !shapes.some((f) => f.id === b.format)) throw new NotFoundError("format", b.format);
    const primary = version && version.formats.length > 0 ? shapes.find((f) => f.primary)?.id ?? null : null;
    const name = screenshotName(b.video, b.version, b.frame, fps, b.format ?? primary);
    const grab = `screenshots/${name}`;
    await mkdir(join(store.root, "screenshots"), { recursive: true });
    // Written to a temp name in the same directory, then renamed into place. Writing the
    // final name directly would follow a symlink planted there (by a hand edit, say) and land
    // the bytes wherever it points; rename() replaces the directory entry itself rather than
    // the symlink's target, so the write can never escape screenshots/ that way. It also means
    // nothing ever lists a half-written PNG. The temp name starts with "." and ends in ".tmp",
    // which SCREENSHOT_PATH (the safe-name filter) already excludes from both /media and the
    // Assets listing. The random part keeps two grabs of the same frame in the same instant (a
    // double-click on the camera) from sharing one temp file: the second rename would find it gone.
    const tmp = join(store.root, "screenshots", `.${name}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tmp, bytes);
    await renameRetry(tmp, fromManifestPath(store.root, grab));
    return c.json({ grab }, 201);
  });

  // ---- assets: the Assets tab and rushes_list_assets ----
  app.get("/api/assets", async (c) => {
    const [project, script, visuals] = await Promise.all([store.read("project"), store.read("script"), store.read("visuals")]);
    let assets = await listAssets(store, project, script, visuals);
    const kind = c.req.query("kind");
    if (kind) assets = assets.filter((a) => a.kind === kind);
    // §31.6: one film's files: its own, the shared visuals, and (naming no film) the first film's.
    const video = c.req.query("video");
    if (video) {
      const film = chooseFilm(project, video)!.id;
      const first = firstFilm(project);
      assets = assets.filter((a) => a.shared || (a.videos ? a.videos.includes(film) : a.video ? a.video === film : film === first));
    }
    return c.json({ assets });
  });

  app.post("/api/reveal", async (c) => {
    const b = await body(c, RevealBody);
    // §16.5: { project: true } reveals the project root itself, with no asset-list check --
    // it's always the folder this server is running for, never user-supplied.
    if ("project" in b) {
      await reveal(store.root);
      return c.json({ ok: true });
    }
    const [project, script] = await Promise.all([store.read("project"), store.read("script")]);
    // Exact string equality against a path /api/assets would list: no path logic beyond this is
    // needed to reject traversal, absolute paths and anything unregistered. candidatePaths is
    // cheap (no stat calls), so a request for an unlisted path never touches the filesystem at
    // all; only the one path that matches gets stat'ed, instead of rebuilding the whole index.
    const candidates = await candidatePaths(store, project, script);
    if (!candidates.has(b.path)) throw new NotFoundError("asset", b.path);
    const abs = fromManifestPath(store.root, b.path);
    const exists = await stat(abs).then(() => true, () => false);
    if (!exists) throw new NotFoundError("asset", b.path);
    await reveal(abs);
    return c.json({ ok: true });
  });

  // §16.3: open a listed asset in its default app. The listed-path check and the safe-extension
  // check both happen before any stat or spawn, so an unsafe or unlisted path never touches disk.
  app.post("/api/open", async (c) => {
    const b = await body(c, OpenBody);
    const [project, script] = await Promise.all([store.read("project"), store.read("script")]);
    const candidates = await candidatePaths(store, project, script);
    if (!candidates.has(b.path)) throw new NotFoundError("asset", b.path);
    const ext = extname(b.path).toLowerCase().replace(/^\./, "");
    if (!OPEN_SAFE_EXT.has(ext)) throw new RushesError(`Rushes won't open "${b.path}": unsafe file type`, 415, "unsafe_type", { path: b.path });
    const abs = fromManifestPath(store.root, b.path);
    // lstat, not stat: a symlink must never be followed here, whatever its own extension says --
    // a "brief.md" that's really a link to an .app (or to any directory or executable) must be
    // refused, not opened through to its target. Refused the same way an unsafe extension is
    // (415 unsafe_type), so a bad target can't be told apart from a merely unsafe type; a file
    // that simply isn't there any more stays 404.
    let info;
    try {
      info = await lstat(abs);
    } catch {
      throw new NotFoundError("asset", b.path);
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new RushesError(`Rushes won't open "${b.path}": unsafe file type`, 415, "unsafe_type", { path: b.path });
    }
    // Refuse anything with an execute bit set (M6): a safe extension can still be a script
    // someone chmod +x'd by hand, and Windows has no execute bit to check (file associations
    // there run off the extension alone, already covered above), so this only applies elsewhere.
    if (process.platform !== "win32" && (info.mode & 0o111) !== 0) {
      throw new RushesError(`Rushes won't open "${b.path}": unsafe file type`, 415, "unsafe_type", { path: b.path });
    }
    await open(abs);
    return c.json({ ok: true });
  });

  // ---- library: §16.2 registered files, and §16.4 notes export ----
  app.post("/api/files", async (c) => {
    const b = await body(c, AddFileBody);
    const file = toManifestPath(store.root, b.file);
    // §31.2.4: with several films, a file that names none is the first film's.
    const { result } = await store.update("project", (p) => addFile(p, { ...b, file, video: b.video ?? (p.videos.length > 1 ? p.videos[0].id : undefined) }));
    await log.add(() => fileEvent(result), by(c));
    return c.json(result, 201);
  });

  app.post("/api/exports/notes", async (c) => {
    const [project, notesFile, script, picks, visuals] = await Promise.all([
      store.read("project"), store.read("notes"), store.read("script"), store.read("picks"), store.read("visuals"),
    ]);
    const now = new Date();
    // §31.3: a note on the script names a line of its own film's script.
    const md = notesMarkdown(project, notesFile.notes, now, (video) => filmScript(script, project, video), picks, visuals);
    const name = exportFileName(project.name, now);
    const dir = join(store.root, "exports");
    await mkdir(dir, { recursive: true });
    // Written to a temp name in the same directory, then renamed into place -- same atomic
    // write the grabs route uses, so exporting again the same day cleanly replaces the file. A
    // process id alone isn't unique enough here (M1): two concurrent exports in the same process
    // -- two agents calling rushes_export_notes back to back, say -- would share one temp name
    // and race each other's write. randomUUID() makes every export's temp name its own.
    const tmp = join(dir, `.${name}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tmp, md, "utf8");
    await renameRetry(tmp, join(dir, name));
    // §22.7: Export notes also writes the change log, newest first, one heading per day. The notes
    // are written by now, so a change log that can't be is left out (null), never a failed export.
    const changeLog = await exportChangeLog(now).catch((e: unknown) => {
      console.error(`Rushes: couldn't export the Change Log: ${(e as Error).message}`);
      return null;
    });
    return c.json({ path: `exports/${name}`, changeLog }, 201);
  });

  // §22.8: the drawer's Export as Markdown.
  app.post("/api/exports/change-log", async (c) => c.json({ path: await exportChangeLog(new Date()) }, 201));

  app.post("/api/shutdown", (c) => {
    if (opts.onShutdown) setImmediate(opts.onShutdown);
    return c.json({ ok: true, stopping: !!opts.onShutdown });
  });

  // Event streams open now. Only `?test=1` shows it, so the e2e suite can check that a browser's
  // tabs share one stream (§19.8).
  let streams = 0;
  // §5.4: with a runner, the Mac is told when the agent waits on the user and no desk is open to show it.
  if (opts.agent) notifyWhenWaiting(store, opts.notify ?? osNotifier(), () => streams);
  app.get("/api/health", async (c) => {
    const [project, id] = await Promise.all([store.read("project"), getProjectId()]);
    // Ruling e: Change Log lines that couldn't be written are counted for `rushes doctor`, only when there are any.
    const health = { ok: true, app: "rushes", version: VERSION, root: store.root, id, name: project.name, ...(log.failures ? { logFailures: log.failures } : {}) };
    return c.json(c.req.query("test") === "1" ? { ...health, sse: streams } : health);
  });

  app.get("/api/state", async (c) => {
    // §20.6: found is what the last scan left in memory; it never waits on a scan or a probe.
    // §22.8: the log's head is read-only, so a state request never writes (R6).
    const [project, scriptFile, notes, picks, batches, ffmpeg, foundSummary, logHead, visuals, keptVersions] = await Promise.all([
      store.read("project"), store.read("script"), store.read("notes"), store.read("picks"), store.read("batches"), jobs.available(), found.summary(), log.head(), store.read("visuals"), store.read("scriptVersions"),
    ]);
    // §31.5: everything Plan and Review show for each film: its script, brief, storyboard and plan state, its tabs
    // (counts, to-do dots, unlocking) and its Activity head (the "new" dot). The desk picks the film on screen.
    const heads = await log.filmHeads({ videos: project.videos, lanes: project.lanes, notes: notes.notes });
    // §38.3: the project brief is the root brief.md (the first film's); every other film builds on it.
    const projectBrief = await briefs.at(filmPlace(project, null)).view();
    const planOf = async (video: string | null) => {
      const place = filmPlace(project, video);
      const [b, sb] = await Promise.all([briefs.at(place).view(), storyboards.at(place).view()]);
      const s = filmScript(scriptFile, project, place.video);
      return {
        script: s,
        brief: b,
        projectBrief: place.first ? null : projectBrief,
        // §38.5: the script's versions, oldest first, by id and time (the page fetches a version's lines when it shows one).
        scriptVersions: shownVersions(keptVersions.films[filmKey(place.video)] ?? [], s.sections).map((v) => ({ id: v.id, at: v.at })),
        storyboard: sb,
        build: buildState({ brief: b, script: s.sections, storyboard: sb }),
        tabs: tabStates(project, s, notes, visuals, place.video, sb.exists),
        log: (place.video && heads[place.video]) ?? logHead,
        // Where the agent finds this film's plan files.
        paths: { brief: place.brief, storyboard: place.storyboard },
      };
    };
    const films: Record<string, Awaited<ReturnType<typeof planOf>>> = {};
    for (const v of project.videos) films[v.id] = await planOf(v.id);
    // The first film's (or, with no film yet, the project's) plan, at the top level as before, with the whole
    // project's tabs and Activity head.
    const first = project.videos.length > 0 ? films[project.videos[0].id] : await planOf(null);
    const script = first.script;
    const briefView = first.brief;
    const storyboardView = first.storyboard;
    const tabs = tabStates(project, filmScript(scriptFile, project, null), notes, visuals);
    // §19.5: why each cut may play badly (or null). Never waits on a probe: an unprobed cut is
    // null until its background probe lands, which then announces a change (ruling B).
    const videos = await Promise.all(
      project.videos.map(async (v) => ({
        ...v,
        versions: await Promise.all(v.versions.map(async (ver) => ({ ...ver, proxyNeed: await jobs.needNow(fromManifestPath(store.root, ver.file)) }))),
      })),
    );
    return c.json({ version: VERSION, project: { ...project, videos }, script, notes, picks: withUse(project, picks), batches, tabs, visuals, proxies: { ffmpeg, jobs: jobs.list(), encoder: ffmpeg ? await jobs.encoder() : null }, found: foundSummary, log: logHead, brief: briefView, storyboard: storyboardView, build: first.build, scriptVersions: first.scriptVersions, films });
  });

  // ---- found: the project's other files (§20) ----
  app.get("/api/found", async (c) => {
    // `abs` stays on the server: the list speaks in manifest paths, as /media and the actions do.
    const files = (await found.list()).map(({ abs: _abs, ...rest }: FoundEntry) => rest);
    // The hidden ones ride along, so Assets › Found can list them and restore any.
    const hidden = (await found.hidden()).map(({ abs: _abs, ...rest }) => rest);
    return c.json({ files, hidden });
  });

  app.post("/api/found/scan", async (c) => {
    const b = await body(c, FoundScanBody);
    if (b.wait) {
      // §20.7. What the agent included wins over the scoring: its kinds are settled for the cut
      // first (kept in found.json, ahead of any adoption), then the first pass, then the included
      // files, then the current set. `added` is everything brought in this session, so a start-up
      // adoption racing this request is never missed. Waiting stops at the cap: the rest carries
      // on in the background and the answer says `scanning`.
      const failed: BringInFailure[] = [];
      const alreadyIn: string[] = [];
      const work = (async () => {
        const settling = b.include?.length ? found.settleKinds(b.include, b.film) : Promise.resolve<BringInKind[]>([]);
        const [, kinds] = await Promise.all([found.scan({ film: b.film }), settling]);
        let skipKinds = kinds;
        if (b.include?.length) {
          const included = await found.bringIn(b.include, { film: b.film, origin: "include" });
          for (const f of included.restored ?? []) await log.add(() => filmEvent(f, false), by(c));
          if (included.added.length) await log.add(() => broughtInEvent(included.added, null), by(c));
          // An included cut becomes the cut the scoring is matched to, and a project with no cut
          // had nothing to record against: settle again now that the cut exists.
          if (included.added.some((a) => a.kind === "cut")) skipKinds = await found.settleKinds(b.include, b.film);
          for (const f of included.failed) {
            if (f.code === "already") alreadyIn.push(f.path);
            else failed.push(f);
          }
        }
        // The kinds are also passed on, so this adoption holds back whatever happens to the record.
        failed.push(...(await found.adoptCurrentSet({ film: b.film, skipKinds })).failed);
      })();
      work.catch(() => undefined); // after the cap, a failure has nobody to tell
      let timer: NodeJS.Timeout | undefined;
      const capped = await Promise.race([
        work.then(() => false),
        new Promise<boolean>((r) => {
          timer = setTimeout(() => r(true), opts.foundWaitMs ?? FOUND_WAIT_MS);
          timer.unref?.();
        }),
      ]).finally(() => clearTimeout(timer));
      return c.json({
        ok: true,
        added: found.broughtInDetail(),
        alreadyIn,
        failed,
        found: (await found.summary()).counts,
        ...(capped ? { scanning: true } : {}),
      });
    }
    // Answers at once; the scan runs in the background and announces a change when it lands.
    // Then §20.4's current set is adopted (a no-op without a cut, or when it's already in).
    void found
      .scan({ film: b.film })
      .then(() => found.adoptCurrentSet({ film: b.film }))
      .catch(() => undefined);
    return c.json({ ok: true });
  });

  app.post("/api/found/bring-in", async (c) => {
    const b = await body(c, FoundBringInBody);
    const r = await found.bringIn(b.files, { film: b.film });
    for (const f of r.restored ?? []) await log.add(() => filmEvent(f, false), by(c));
    if (r.added.length) await log.add(() => broughtInEvent(r.added, null), by(c));
    return c.json(r);
  });

  app.post("/api/found/dismiss", async (c) => {
    const b = await body(c, FoundPathsBody);
    await found.dismiss(b.paths);
    return c.json({ ok: true });
  });

  app.post("/api/found/restore", async (c) => {
    const b = await body(c, FoundPathsBody);
    await found.restore(b.paths);
    return c.json({ ok: true });
  });

  // §31.6: ?video= is one film's: its tabs, its brief, storyboard and plan. Without one, the first film's plan (with
  // one film, the same as ever) and the whole project's tabs.
  app.get("/api/tabs", async (c) => {
    const q = VideoQuery.safeParse(c.req.query());
    if (!q.success) throw new InvalidError("Query is invalid", q.error.issues);
    const [project, script, notes, visuals] = await Promise.all([store.read("project"), store.read("script"), store.read("notes"), store.read("visuals")]);
    const film = q.data.video ? chooseFilm(project, q.data.video)!.id : null;
    const place = filmPlace(project, film);
    const [b, sb] = await Promise.all([briefs.at(place).view(), storyboards.at(place).view()]);
    const own = filmScript(script, project, place.video);
    return c.json({
      tabs: tabStates(project, film ? own : filmScript(script, project, null), notes, visuals, film, sb.exists),
      // §26: every film and whether it is shelved, so an agent leaves the shelved ones alone.
      films: project.videos.map((v) => ({ id: v.id, name: v.name, shelved: v.shelved ?? null })),
      // §31.3: where each film's own brief and storyboard are.
      plans: Object.fromEntries(project.videos.map((v) => {
        const p = filmPlace(project, v.id);
        return [v.id, { brief: p.brief, storyboard: p.storyboard }];
      })),
      ...(film ? { film } : {}),
      brief: { exists: b.exists, status: b.status, changed: b.changed },
      storyboard: { exists: sb.exists, shots: sb.total, approved: sb.approved, changed: sb.changed },
      build: buildState({ brief: b, script: own.sections, storyboard: sb }),
    });
  });

  // ---- brief: brief.md is the file of record (§24 step 2); §31.3: each film has its own ----
  const videoQuery = (c: Context) => {
    const q = VideoQuery.safeParse(c.req.query());
    if (!q.success) throw new InvalidError("Query is invalid", q.error.issues);
    return q.data.video;
  };
  app.get("/api/brief", async (c) => {
    const film = await filmOf(videoQuery(c), "the brief");
    const place = filmPlace(await store.read("project"), film);
    return c.json({ brief: await briefs.at(place).view(), film, path: place.brief });
  });
  app.put("/api/brief/sections/:index", async (c) => {
    const index = Number(c.req.param("index"));
    if (!Number.isInteger(index) || index < 0) throw new InvalidError("Section index must be a whole number from 0");
    const b = await body(c, BriefSectionBody);
    const brief = await briefs.of(await filmOf(b.video, "the brief"));
    return c.json({ brief: await brief.setSection(index, b.heading, b.text, b.hash) });
  });

  // ---- storyboard: storyboard.md is the file of record (§24.12); §31.3: each film has its own ----
  app.get("/api/storyboard", async (c) => {
    const film = await filmOf(videoQuery(c), "the storyboard");
    const place = filmPlace(await store.read("project"), film);
    return c.json({ storyboard: await storyboards.at(place).view(), film, path: place.storyboard });
  });
  app.put("/api/storyboard/shots/:index", async (c) => {
    const index = Number(c.req.param("index"));
    if (!Number.isInteger(index) || index < 0) throw new InvalidError("Shot index must be a whole number from 0");
    const b = await body(c, StoryboardShotBody);
    const storyboard = await storyboards.of(await filmOf(b.video, "the storyboard"));
    return c.json({ storyboard: await storyboard.setShot(index, b.heading, { description: b.description, direction: b.direction, status: b.status }, b.hash) });
  });

  app.put("/api/brief/status", async (c) => {
    const b = await body(c, BriefStatusBody);
    const brief = await briefs.of(await filmOf(b.video, "the brief"));
    return c.json({ brief: await brief.setStatus(b.status, b.hash) });
  });

  // ---- notes ----
  app.get("/api/notes", async (c) => {
    const q = NoteQuery.safeParse(c.req.query());
    if (!q.success) throw new InvalidError("Query is invalid", q.error.issues);
    const [{ notes }, visuals, project] = await Promise.all([store.read("notes"), store.read("visuals"), store.read("project")]);
    const video = q.data.video ? chooseFilm(project, q.data.video)!.id : undefined;
    const listed = filterNotes(notes, { ...q.data, video, videos: project.videos, onlyThisFormat: q.data.onlyThisFormat === "true" }).filter((n) => q.data.includeShelved === "true" || q.data.batch !== undefined || noteInPlay(n, project));
    return c.json({ notes: withVisualViews(listed, visuals) });
  });

  app.post("/api/notes", async (c) => {
    const b = await body(c, NewNoteBody);
    // The client never sends shot; the server stamps it from the version's shots.
    let shot: Note["shot"] = null;
    // §38.4: and on a storyboard note, the shot and its still, from the film's storyboard as it is now.
    let still: string | null = null;
    // §25.4: a note on a visual is checked against the visual, its version, its page and its ratios.
    if (b.stage === "storyboard") {
      const project = await store.read("project");
      const board = await storyboards.at(filmPlace(project, b.video ?? null)).view();
      const m = /^shot\/(\d+)$/.exec(b.on ?? "");
      const found = m ? board.shots.find((s) => s.n === Number(m[1])) : undefined;
      if (!found) throw new InvalidError(`There is no ${b.on ? `shot ${b.on.replace(/^shot\//, "")}` : "shot"} in this film's storyboard`);
      shot = { n: found.n, name: found.name };
      still = found.still;
    } else if (b.stage === "visuals") checkVisualNote({ stage: b.stage, on: b.on ?? null, version: b.version ?? null, format: b.format ?? null, box: b.box ?? null, pin: b.pin ?? null }, await store.read("visuals"));
    else if (b.stage === "picture" || b.format != null) {
      const project = await store.read("project");
      // §21.3: a format must be one of this cut's, and on a cut with formats a box belongs to one.
      checkNoteFormat({ next: { stage: b.stage, video: b.video ?? null, version: b.version ?? null, format: b.format ?? null, box: b.box ?? null } }, project);
      if (b.stage === "picture" && b.video && b.version && b.t != null) {
        const version = project.videos.find((v) => v.id === b.video)?.versions.find((v) => v.id === b.version);
        if (version) shot = shotAt(version.shots, b.t);
      }
    }
    // §31.2.4: nothing is made on no film. A note that names none, in a project with several films, is the first film's
    // (a visual's is on every film and names none). With one film, or none yet, it is left as it is.
    let video = b.video ?? null;
    if (!video && b.stage !== "visuals") {
      const project = await store.read("project");
      if (project.videos.length > 1) video = project.videos[0].id;
    }
    const { result } = await store.update("notes", (f) => addNote(f, { ...b, video, shot, ...(b.stage === "storyboard" ? { still } : {}), by: "user" }));
    return c.json({ note: withState(result) }, 201);
  });

  app.patch("/api/notes/:id", async (c) => {
    const b = await body(c, UserEditBody);
    // §21.3 and R7: a change of format or box is checked against the note's cut as it is now.
    const project = b.format !== undefined || b.box !== undefined || b.pin !== undefined ? await store.read("project") : null;
    const visuals = project ? await store.read("visuals") : null;
    const check = project && visuals ? (next: Note, prev: Note) => (next.stage === "visuals" ? checkVisualNote(next, visuals) : checkNoteFormat({ next, prev, boxRedrawn: b.box !== undefined }, project)) : undefined;
    const { result } = await store.update("notes", (f) => applyUserEdit(f, { id: c.req.param("id"), ...b }, check));
    // §35.5: ticked done by the user: its Attention items clear.
    if (result.status === "done") await settleAttention(new Set([result.id]));
    return c.json({ note: withState(result) });
  });

  // §35: notes go one way. There is no route for the user's answer on a note (§28.5's POST /api/notes/:id/replies).

  // ---- §35.5: Attention items ----
  app.post("/api/attention", async (c) => {
    const b = await body(c, z.object({ title: z.string().trim().min(1).max(ATTENTION_TITLE_MAX), note: z.string().min(1).optional(), film: z.string().optional() }));
    let video: string | null;
    if (b.note) {
      const n = (await store.read("notes")).notes.find((x) => x.id === b.note);
      if (!n) throw new NotFoundError("note", b.note);
      // A note on the shared Visuals is on no one film: it is the film named, or the only one.
      video = n.video ?? (await filmOf(b.film, "attention item"));
    } else video = await filmOf(b.film, "attention item");
    const { entry, created } = await log.change((f) => raiseAttention(f, { title: b.title, note: b.note ?? null, video }, new Date()));
    return c.json({ attention: entry, created }, created ? 201 : 200);
  });
  app.post("/api/attention/:id/dismiss", async (c) => {
    const id = c.req.param("id");
    const cleared = await log.change((f) => {
      const e = f.entries.find((x) => x.id === id && x.kind === "attention");
      if (!e) throw new NotFoundError("attention item", id);
      return resolveAttention(f, (x) => x.id === id, new Date());
    });
    return c.json({ cleared: cleared.length });
  });
  /**
   * §35.5: back to the agent's conversation. On this computer (the desk's here key matches, and the request comes from
   * here) a terminal opens in the project folder resuming it; otherwise, or if no terminal opens, the answer carries
   * the command for the desk to show.
   */
  app.post("/api/attention/:id/open", async (c) => {
    const id = c.req.param("id");
    const line = (await store.read("log")).entries.find((x) => x.id === id && x.kind === "attention");
    if (!line) throw new NotFoundError("attention item", id);
    const settings = await store.read("agent");
    const resume = resumeFor(settings.session, store.root, process.platform);
    const where = { host: hostname(), folder: store.root };
    const key = here();
    const local = !!key && c.req.header("x-rushes-here") === key && fromHere(c);
    if (!resume) return c.json({ opened: false, local, ...where, agent: settings.agent ?? null, session: null, command: null });
    if (local) {
      const info = (await detect().catch(() => [])).find((a) => a.id === resume.agent);
      try {
        await terminal(resume.command, info?.path ? [info.path, ...resume.args] : undefined, { cwd: store.root, name: "resume" });
        return c.json({ opened: true, local, ...where, agent: resume.agent, session: resume.session, command: resume.command });
      } catch {
        // No terminal here: the desk shows the command instead.
      }
    }
    return c.json({ opened: false, local, ...where, agent: resume.agent, session: resume.session, command: resume.command });
  });

  app.post("/api/replies", async (c) => {
    const b = await body(c, RepliesBody);
    const { result } = await store.update("notes", (f) => b.replies.map((r) => applyReply(f, r)));
    // §30: one line per film, so each film's Activity counts only its own notes.
    for (const [film, notes] of byFilm(result, (n) => n.video)) await log.add(() => repliesEvent(notes, film), by(c));
    // §35.5: a note marked done, or fixed in a version, clears its Attention items.
    const settled = new Set(b.replies.filter(replySettles).map((r) => r.id));
    if (settled.size > 0) await settleAttention(settled);
    return c.json({ notes: result.map(withState) });
  });

  // ---- media ----
  app.post("/api/versions", async (c) => {
    const b = await body(c, VersionBody);
    // §21.4 (R11): with formats, every file is read first and one refusal refuses the whole call.
    // The refusal names the first refused file in the order given, never whichever read happened to
    // finish first, so a call always gives the same message (CI run 37724786490). So a refusal stops
    // only the reads after it (review M6): they can't change the answer. The ones before it run on,
    // each bounded by its own give-up, since one of them may be the file to name.
    let shapes: Awaited<ReturnType<typeof readRender>>[] | null = null;
    if (b.formats?.length) {
      const files = [b.file, ...b.formats.map((f) => f.file)];
      const stops = files.map(() => new AbortController());
      const settled = await Promise.allSettled(
        files.map((f, i) =>
          readRender(f, { primary: i === 0, stop: stops[i].signal }).catch((e: unknown) => {
            for (const later of stops.slice(i + 1)) later.abort();
            throw e;
          }),
        ),
      );
      // The first rejection in order is always a refusal of its own: only an earlier one stops a read.
      const refused = settled.find((s) => s.status === "rejected");
      if (refused) throw refused.reason;
      shapes = settled.map((s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof readRender>>>).value);
      const own = shapes[0];
      if (!isPictureSize(own.width, own.height)) {
        throw new RushesError(
          `${own.file} measures ${own.width}×${own.height}, which isn't a picture size, so Rushes can't tell its formats' shapes from it.`,
          422, "no_primary_size", { path: own.file },
        );
      }
    }
    const file = shapes ? shapes[0].file : toManifestPath(store.root, b.file);
    const abs = fromManifestPath(store.root, file);
    // The proxy jobs' probe is ffprobe (tests inject a fake), so the cut's need is read from the same
    // answer. §21.3 (R2): the primary's shape on screen is stored too, when it is a file that can be read.
    const readOwn = async () => {
      if (!(await isPlainFile(abs))) return null;
      const r = await readVideo(abs);
      // Final review I1: a file ffprobe reads as another kind of container (a playlist or a GIF
      // named .mp4) is not a cut. Anything else it can't read comes in with no size, as before.
      if (!r.ok && r.container) throw new RushesError(`${file} isn't a video: ${r.reason}.`, 400, "not_video", { path: file });
      return r.ok ? r : null;
    };
    const [read, info] = await Promise.all([shapes ? Promise.resolve(shapes[0]) : readOwn(), jobs.probe(abs)]);
    // Only a real picture size is stored; a plain cut without one goes in with no size, as cuts did
    // before formats (a formats call was refused above).
    const size = read && isPictureSize(read.width, read.height) ? read : null;
    const formatWarnings: string[] = [];
    // §24.12: the storyboard's shots, read before the write so the write itself waits for nothing. §31.3: the film's
    // own storyboard, and only for its first cut: work out which film the cut is for, as addVersion will.
    const before = await store.read("project");
    const known = before.videos.find((v) => v.id === b.video || v.id === slugify(b.video));
    const plannedFor = known?.id ?? uniqueId(slugify(b.video), before.videos.map((v) => v.id));
    const planned = known && known.versions.length > 0
      ? []
      : await storyboards.at(filmPlace({ videos: known ? before.videos : [...before.videos, { id: plannedFor }] }, plannedFor)).cutShots();
    let lockedVersion: string | null = null;
    let alwaysProxy = false;
    let presets: ProxyPreset[] = ["1080l"];
    let films = 1;
    let restored = false;
    const { result } = await store.update("project", (p) => {
      const out = addVersion(p, {
        video: b.video, file, note: b.note, label: b.label, duration: info.duration ?? read?.duration ?? null, fps: info.fps ?? read?.fps ?? null,
        width: size?.width ?? null, height: size?.height ?? null,
      });
      // Throwing here leaves project.json unwritten: the cut and its formats land together or not at all.
      for (const s of shapes?.slice(1) ?? []) {
        let added;
        try {
          added = addFormat(p, { video: out.video.id, version: out.version.id, ...s });
        } catch (e) {
          // Final review M7: the version is new, so the shape it "already has" came from this same
          // call. Name the two files; the version is never created, so never name it.
          if (e instanceof RushesError && e.code === "same_ratio") {
            throw new RushesError(`${s.file} has the same shape as ${e.detail.file} (${e.detail.label}). Register one render of each shape.`, 409, "same_ratio", { path: s.file, with: e.detail.file });
          }
          throw e;
        }
        if (added.warning) formatWarnings.push(added.warning);
      }
      // A film's first cut starts with the storyboard's shots, once (never recomputed). Those at or past the cut's end are left out.
      if (planned.length && out.video.id === plannedFor && out.video.versions.length === 1 && out.version.shots.length === 0) {
        const reachable = planned.filter((s) => out.version.duration === null || s.start < out.version.duration);
        if (reachable.length) setShots(p, out.video.id, out.version.id, reachable);
      }
      lockedVersion = out.video.lockedVersion;
      restored = out.restored;
      alwaysProxy = p.alwaysProxy;
      presets = p.proxyPresets;
      films = p.videos.length;
      if (info.fps && p.videos.length === 1 && p.videos[0].versions.length === 1) p.fps = info.fps;
      return out;
    });
    // One write, one line (R4): a cut that comes with its other shapes says so on its own line
    // ("v2 and its 9:16 added: …"), rather than a line per shape.
    // §26: a cut on a shelved film brings it back; the Change Log says so, then says what was added.
    if (restored) await log.add(() => filmEvent(result.video, false), by(c));
    await log.add(() => cutEvent(films, result.video, result.version, result.version.formats.map((f) => f.label)), by(c));
    // §19.5: say when the cut is likely to play badly. §37.4: with the project's switch on, every new cut gets a proxy
    // at every ticked quality straight away, whatever the criteria say. Without ffmpeg, nothing is offered or made.
    // §19.9: its waveform is made in the background; nothing here waits for it.
    void peaks.queueCut(result.video.id, result.version.id, file).catch(() => undefined);
    const reason = await jobs.needFrom(abs, info);
    const proxy: { proxySuggested?: true; proxyReason?: string; proxyJobs?: ProxyJob[] } = {};
    if (reason) {
      proxy.proxySuggested = true;
      proxy.proxyReason = reason;
    }
    if (alwaysProxy && !jobs.isClosing && (await jobs.available())) {
      proxy.proxyJobs = presets.map((preset) => jobs.start(result.video.id, result.version.id, { preset, addedAt: result.version.addedAt }));
    }
    // §24.12: a soft nudge, never a refusal: the plan (brief, script, storyboard) is not all approved yet.
    const planNote = planWarning(await planBuild(result.video.id));
    // §31.4: a project that has just gained its second film moves what was on no film to the first one.
    if (films > 1) await moveToFirstFilmOnce(store, log).catch((e: unknown) => console.error(`Rushes: couldn't move what was on no film: ${(e as Error).message}`));
    const warnings = { ...(formatWarnings.length ? { formatWarnings } : {}), ...(planNote ? { planWarning: planNote } : {}) };
    const reply = { video: result.video, version: result.version, ...(restored ? { restored: true } : {}) };
    if (lockedVersion) return c.json({ ...reply, ...proxy, ...warnings, warning: `Picture is locked at ${lockedVersion}` }, 201);
    return c.json({ ...reply, ...proxy, ...warnings }, 201);
  });

  // ---- formats (§21.4) ----
  app.post("/api/formats", async (c) => {
    const b = await body(c, FormatBody);
    const render = await readRender(b.file);
    // The cut it joins, pinned now, and its own shape when it has none yet (a cut from before formats).
    const cut = resolveCut(await store.read("project"), b.video, b.version);
    let primarySize: { width: number; height: number } | null = null;
    if (cut.version.width === null || cut.version.height === null) {
      const own = fromManifestPath(store.root, cut.version.file);
      const r = (await isPlainFile(own)) ? await readVideo(own) : null;
      if (r?.ok && !isPictureSize(r.width, r.height)) {
        throw new RushesError(
          `${cut.version.file} measures ${r.width}×${r.height}, which isn't a picture size, so Rushes can't tell a new shape from it.`,
          422, "no_primary_size", { version: cut.version.id },
        );
      }
      if (r?.ok) primarySize = { width: r.width, height: r.height };
    }
    // Inside the update, so two registrations of one shape at once can't both land: the second
    // sees the first's format and gets §21.3's sentence.
    let films = 1;
    const { result } = await store.update("project", (p) => {
      films = p.videos.length;
      return addFormat(p, { ...render, video: cut.video.id, version: cut.version.id, label: b.label, primarySize });
    });
    // §22.5: "9:16 added to v2".
    await log.add(() => formatEvent(films, result.video, result.version.id, result.format), by(c));
    return c.json(
      {
        video: { id: result.video.id, name: result.video.name },
        version: result.version,
        format: result.format,
        ...(result.warning ? { warning: result.warning } : {}),
        ...(result.labelNote ? { labelNote: result.labelNote } : {}),
      },
      201,
    );
  });

  // ---- proxies (§19.5) ----
  /** The cut a proxy or frame route names, or a 404. The video may be given by id, slug or name. */
  async function cutOf(videoRef: string, versionId: string) {
    const project = await store.read("project");
    const video = resolveVideo(project, videoRef);
    const version = video.versions.find((v) => v.id === versionId);
    if (!version) throw new NotFoundError("version", versionId);
    return { project, video, version };
  }

  /**
   * §37.4: queues, for one cut, each of `presets` it has no proxy at and none being made at. Returns the jobs, the ones
   * already being made included, so a caller can show them.
   */
  function queueCut(video: string, version: Version, presets: readonly ProxyPreset[]): ProxyJob[] {
    return missingPresets(version.proxies, presets).map((preset) => jobs.start(video, version.id, { preset, addedAt: version.addedAt }));
  }

  /**
   * §37.4: queues every one of `presets` the latest version of each film in play is missing. Older versions are only
   * made when asked.
   */
  function queueLatest(project: Project, presets: readonly ProxyPreset[]): ProxyJob[] {
    const started: ProxyJob[] = [];
    for (const video of project.videos) {
      if (!inPlay(video)) continue;
      const v = video.versions[video.versions.length - 1];
      if (!v) continue;
      for (const preset of missingPresets(v.proxies, presets)) {
        if (jobs.find(video.id, v.id, preset)) continue;
        started.push(jobs.start(video.id, v.id, { preset, addedAt: v.addedAt }));
      }
    }
    return started;
  }

  app.post("/api/videos/:video/versions/:version/proxy", async (c) => {
    await jobs.requireFfmpeg();
    // §19.5's clients POST with no body (or {}): §37.4, every ticked quality the cut is missing.
    const raw = await c.req.text();
    let b: z.infer<typeof ProxyBody> = {};
    if (raw.trim() !== "") {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new InvalidError("Request body must be JSON");
      }
      const parsed = ProxyBody.safeParse(json);
      if (!parsed.success) throw new InvalidError("Request body is invalid", parsed.error.issues);
      b = parsed.data;
    }
    const { project, video, version } = await cutOf(c.req.param("video"), c.req.param("version"));
    if (b.preset) {
      // One job per cut and quality (Review Focus 2): a second press, from this tab or another, joins the first.
      const joined = !!jobs.find(video.id, version.id, b.preset);
      const job = jobs.start(video.id, version.id, { preset: b.preset, addedAt: version.addedAt });
      return c.json({ job, jobs: [job] }, joined ? 200 : 202);
    }
    const missing = missingPresets(version.proxies, project.proxyPresets);
    if (missing.length === 0) {
      throw new RushesError(`${video.name} ${version.id} already has every ticked quality`, 409, "nothing_to_make");
    }
    const joined = missing.every((p) => !!jobs.find(video.id, version.id, p));
    const started = queueCut(video.id, version, project.proxyPresets);
    return c.json({ job: started[0], jobs: started }, joined ? 200 : 202);
  });

  // §37.4: Make proxies for all films -- every ticked quality each film's latest cut is missing.
  app.post("/api/proxies", async (c) => {
    await jobs.requireFfmpeg();
    const project = await store.read("project");
    return c.json({ jobs: queueLatest(project, project.proxyPresets) }, 202);
  });

  // §36.6: Delete all proxies. Every job is cancelled first, then every proxy file and record goes. Originals stay.
  app.delete("/api/proxies", async (c) => {
    await Promise.all(jobs.list().map((j) => jobs.cancel(j.id).catch(() => undefined)));
    const removed: string[] = [];
    const before = await store.read("project");
    if (before.videos.some((video) => video.versions.some((v) => proxyList(v.proxies).length > 0))) {
      await store.update("project", (p) => {
        for (const video of p.videos) {
          for (const v of video.versions) {
            for (const { proxy } of proxyList(v.proxies)) removed.push(proxy.file);
            v.proxies = {};
          }
        }
      });
    }
    // Only ever files this server wrote into proxies/: never an original, even from a hand-edited record.
    await Promise.all(removed.filter((f) => PROXY_PATH.test(f)).map((f) => rm(fromManifestPath(store.root, f), { force: true }).catch(() => undefined)));
    return c.json({ deleted: removed.length });
  });

  app.delete("/api/proxy-jobs/:job", async (c) => {
    const job = await jobs.cancel(c.req.param("job"));
    return c.json({ job });
  });

  // §37.4: ?preset=720l deletes one quality (or ?preset=legacy, §19.5's); without it, every proxy of the cut.
  app.delete("/api/videos/:video/versions/:version/proxy", async (c) => {
    const { video, version } = await cutOf(c.req.param("video"), c.req.param("version"));
    const q = c.req.query("preset");
    const slot = q === undefined ? null : ProxySlotSchema.safeParse(q);
    if (slot && !slot.success) throw new InvalidError(`Unknown proxy quality "${q}"`);
    const only: ProxySlot | null = slot?.success ? slot.data : null;
    const matches = (s: ProxySlot) => only === null || s === only;
    const running = jobs.forCut(video.id, version.id).filter((j) => matches(j.preset));
    await Promise.all(running.map((j) => jobs.cancel(j.id).catch(() => undefined)));
    // Checked before writing, so a delete of nothing never bumps project.json's rev. (A job that
    // finished just as it was cancelled has recorded its proxy by now, and is deleted below.)
    const fresh = await cutOf(video.id, version.id);
    if (!proxyList(fresh.version.proxies).some((x) => matches(x.slot))) {
      if (running.length) return c.json({ version: fresh.version });
      throw new NotFoundError("proxy", `${video.id} ${version.id}${only ? ` ${only}` : ""}`);
    }
    const removed: string[] = [];
    const { result } = await store.update("project", (p) => {
      const v = p.videos.find((x) => x.id === video.id)?.versions.find((x) => x.id === version.id);
      if (!v) return undefined;
      for (const { slot: s, proxy } of proxyList(v.proxies)) {
        if (!matches(s)) continue;
        removed.push(proxy.file);
        delete v.proxies[s];
      }
      return removed.length ? v : undefined;
    });
    if (!result) throw new NotFoundError("proxy", `${video.id} ${version.id}`);
    // Only ever a file this server wrote into proxies/: the original is never touched, even if
    // project.json was hand-edited to point the record somewhere else.
    await Promise.all(removed.filter((f) => PROXY_PATH.test(f)).map((f) => rm(fromManifestPath(store.root, f), { force: true })));
    return c.json({ version: result });
  });

  app.put("/api/project/settings", async (c) => {
    const b = await body(c, SettingsBody);
    const always = b.alwaysProxy ?? b.autoProxy;
    const wanted = b.proxyPresets ?? (b.proxyPreset ? [b.proxyPreset] : undefined);
    if (wanted && wanted.length === 0) throw new RushesError("Keep at least one quality ticked.", 400, "no_quality");
    let wasOn = false;
    let was: ProxyPreset[] = [];
    const { data } = await store.update("project", (p) => {
      wasOn = p.alwaysProxy;
      was = p.proxyPresets;
      if (always !== undefined) p.alwaysProxy = always;
      if (wanted) p.proxyPresets = ladderOrder(wanted);
    });
    // §37.4: turning the switch on queues every ticked quality for the latest cut of each film; ticking a quality while
    // it's on queues that one. Unticking deletes nothing: those proxies show "Not in use".
    const fresh = data.alwaysProxy && !wasOn ? data.proxyPresets : data.alwaysProxy ? data.proxyPresets.filter((p) => !was.includes(p)) : [];
    const queued = fresh.length && !jobs.isClosing && (await jobs.available()) ? queueLatest(data, fresh) : [];
    return c.json({ alwaysProxy: data.alwaysProxy, proxyPresets: data.proxyPresets, jobs: queued });
  });

  // Grab Frame's still, always from the original at full quality: the exact frame round(t*fps),
  // whichever file is playing. Returns the PNG only; Picture posts it to /api/grabs to save it.
  app.get("/api/videos/:video/versions/:version/frame", async (c) => {
    const q = FrameQuery.safeParse(c.req.query());
    if (!q.success) throw new InvalidError("Query is invalid: t must be a time in seconds", q.error.issues);
    await jobs.requireFfmpeg();
    const { project, version } = await cutOf(c.req.param("video"), c.req.param("version"));
    // R12: Grab Frame on a format reads that format's own file. Frames are counted at the cut's fps.
    const view = q.data.format ? versionFormats(version).find((f) => f.id === q.data.format) : undefined;
    if (q.data.format && !view) throw new NotFoundError("format", q.data.format);
    const source = view && !view.primary ? view.file : version.file;
    const orig = fromManifestPath(store.root, source);
    const exists = await stat(orig).then((s) => s.isFile(), () => false);
    if (!exists) throw new RushesError("The original file is missing", 404, "missing_file", { path: source });
    const fps = version.fps ?? project.fps;
    let frame = Math.round(q.data.t * fps);
    // A time at or past the end lands on the last frame rather than on nothing.
    const length = view?.duration ?? version.duration;
    if (length !== null) frame = Math.min(frame, Math.max(0, Math.ceil(length * fps - 1e-6) - 1));
    const png = await jobs.frame(orig, frame / fps);
    if (!png) throw new RushesError(`ffmpeg couldn't read frame ${frame}`, 422, "no_frame", { frame });
    return new Response(new Uint8Array(png), {
      status: 200,
      headers: { "content-type": "image/png", "cache-control": "no-store", "x-rushes-frame": String(frame), "content-length": String(png.length) },
    });
  });

  // §19.9: the cut's own audio as about 2000 peaks, for the waveform in Picture's timeline. 200 with
  // the peaks, 202 while they're being made (a `change` goes out when they land), 204 when the cut
  // has no audio, 501 without ffmpeg (the dashboard then decodes a small file itself).
  app.get("/api/videos/:video/versions/:version/peaks", async (c) => {
    const { video, version } = await cutOf(c.req.param("video"), c.req.param("version"));
    if (!(await peaks.available())) {
      throw new RushesError("The waveform needs ffmpeg, which isn't installed. Run `rushes doctor` for how to add it.", 501, "no_ffmpeg");
    }
    const a = await peaks.answer(video.id, version.id, version.file);
    switch (a.state) {
      case "ready":
        return c.json(a.data, 200, { "cache-control": "no-store" });
      case "computing":
        return c.json({ state: "computing" }, 202, { "cache-control": "no-store" });
      case "silent":
        return c.body(null, 204, { "cache-control": "no-store" });
      case "missing":
        throw new RushesError("The original file is missing", 404, "missing_file", { path: version.file });
      case "failed":
        throw new RushesError(a.reason, 422, "no_peaks");
    }
  });

  app.put("/api/videos/:video/shots", async (c) => {
    const b = await body(c, ShotsBody);
    const { result } = await store.update("project", (p) => setShots(p, c.req.param("video"), b.version, b.shots));
    return c.json({ version: result });
  });

  app.put("/api/videos/:video/lock", async (c) => {
    const b = await body(c, LockBody);
    let before: string | null = null;
    let films = 1;
    const { result } = await store.update("project", (p) => {
      before = resolveVideo(p, c.req.param("video")).lockedVersion;
      films = p.videos.length;
      return lockPicture(p, c.req.param("video"), b.version);
    });
    // R10: a lock that changes nothing isn't logged.
    if (result.lockedVersion !== before) await log.add(() => lockEvent(films, result), by(c));
    return c.json({ video: result });
  });

  // §26: shelve a film, or restore it. The same call twice is the same as once, and only a change is logged.
  app.put("/api/videos/:video/shelve", async (c) => {
    const b = await body(c, ShelveBody);
    let before = false;
    const { result } = await store.update("project", (p) => {
      before = !!resolveVideo(p, c.req.param("video")).shelved;
      return shelveFilm(p, c.req.param("video"), b.shelved);
    });
    if (!!result.shelved !== before) await log.add(() => filmEvent(result, b.shelved), by(c));
    return c.json({ video: result });
  });

  app.post("/api/variants", async (c) => {
    const b = await body(c, VariantBody);
    // §23: a cue's file is stored as a manifest path, like the variant's own.
    const cues = b.cues?.map((q) => (q.file === undefined ? q : { ...q, file: toManifestPath(store.root, q.file) }));
    const { result } = await store.update("project", (p) => {
      const added = addVariant(p, { ...b, cues, file: toManifestPath(store.root, b.file) });
      // §31.2.4: nothing is made on no film. With more than one film, one that names none and can't be told from its
      // names goes on the first film: say so, so the agent names one next time (or moves it with rushes_set_films).
      let warning: string | undefined;
      if (variantFilms(added.variant).length === 0 && p.videos.length > 1) {
        const first = p.videos[0];
        added.variant.videos = [first.id];
        const what = added.lane.stage === "voice" ? "read" : added.lane.stage === "music" ? "bed" : "pass";
        warning = `No film was named, and none could be told from the names, so this ${what} is on ${first.name}, the project's first film. Pass \`video\` (a film's id or name, or a list of them) to put it on the films it was made for, or move it with rushes_set_films.`;
      }
      return { ...added, ...(warning ? { warning } : {}) };
    });
    await log.add(() => variantEvent(result.lane, result.variant), by(c));
    return c.json(result, 201);
  });

  // Put a read, bed or pass on exactly these films. A film it leaves drops its pick of it.
  app.put("/api/variants/:lane/:variant/films", async (c) => {
    const b = await body(c, VariantFilmsBody);
    const { result, data } = await store.update("project", (p) => setVariantFilms(p, c.req.param("lane"), c.req.param("variant"), b.videos));
    if (result.left.length > 0) {
      await store.update("picks", (k) => {
        for (const film of result.left) {
          const own = k.videos[film];
          // Through setInUse, so the take in use for that sound goes with the pick (§27.6).
          if (own?.lanes[result.lane.id] === result.variant.id) setInUse(own, data.lanes, result.lane, null, new Date());
        }
      });
    }
    const names = variantFilms(result.variant).map((id) => data.videos.find((v) => v.id === id)?.name ?? id);
    await log.add(() => variantFilmsEvent(result.lane, result.variant, names), by(c));
    return c.json({ lane: result.lane, variant: result.variant });
  });

  // §27.6: put a read, bed or pass away (hidden, never deleted), or bring it back. The take in use
  // on any film stays where it can be seen: choose another first.
  app.put("/api/variants/:lane/:variant/put-away", async (c) => {
    const b = await body(c, PutAwayBody);
    const laneId = c.req.param("lane");
    const variantId = c.req.param("variant");
    const picks = await store.read("picks");
    const { result } = await store.update("project", (p) => {
      const stage = p.lanes.find((l) => l.id === laneId)?.stage;
      const isIt = (use: InUse) => stage !== undefined && use[stage]?.lane === laneId && use[stage]?.variant === variantId;
      const usedOn = p.videos.filter((v) => isIt(filmUse(p, picks, v.id))).map((v) => v.name);
      if (p.videos.length === 0 && isIt(filmUse(p, picks, undefined))) usedOn.push("this film");
      return putAway(p, laneId, variantId, b.away, usedOn);
    });
    return c.json({ variant: result });
  });

  // ---- script ----
  // §31.3: each film has its own script. ?video= (or `video` in a write's body) names it: with one film it may be
  // left out; with several, leaving it out is refused with the films listed (§31.6).
  app.get("/api/script", async (c) => {
    const [project, file] = await Promise.all([store.read("project"), store.read("script")]);
    const film = chooseFilm(project, videoQuery(c), "the script")?.id ?? null;
    const own = filmScript(file, project, film);
    // §38.5: the newest script version's id, so the agent can say which version it worked from.
    const versions = shownVersions((await store.read("scriptVersions")).films[filmKey(film)] ?? [], own.sections);
    // The shape it always had (schema, rev, wordsPerSecond, sections), now one film's, with the film named.
    return c.json({ script: { schema: file.schema === 1 && film === firstFilm(project) ? 1 : 2, rev: file.rev, ...own, ...(film ? { video: film } : {}), version: versions.at(-1)?.id ?? null } });
  });

  // §38.5: a film's script versions, oldest first, each the script as the agent wrote it.
  app.get("/api/script/versions", async (c) => {
    const [project, file, kept] = await Promise.all([store.read("project"), store.read("script"), store.read("scriptVersions")]);
    const film = chooseFilm(project, videoQuery(c), "the script")?.id ?? null;
    return c.json({ versions: shownVersions(kept.films[filmKey(film)] ?? [], filmScript(file, project, film).sections) });
  });

  app.put("/api/script", async (c) => {
    const b = await body(c, ScriptBody);
    const project = await store.read("project");
    const film = chooseFilm(project, b.video, "the script")?.id ?? null;
    let prior: Section[] = [];
    const { result } = await store.update("script", (f) => {
      const s = filmScriptDraft(f, project, film);
      prior = s.sections.map((x) => ({ ...x }));
      if (b.wordsPerSecond) s.wordsPerSecond = b.wordsPerSecond;
      return setSections(s, b.sections, { replace: b.replace });
    });
    // §38.5: the agent wrote the script: keep it as a new version when its words changed.
    const at = new Date().toISOString();
    await store.update("scriptVersions", (f) => {
      const key = filmKey(film);
      const next = recordVersion(f.films[key] ?? [], result, at, prior);
      if (next !== f.films[key]) f.films[key] = next;
    });
    // The film is named on the line only with several films, so a one-film project's log reads as it always did.
    await log.add(() => scriptEvent(result.length, project.videos.length > 1 ? film : null), by(c));
    return c.json({ sections: result, ...(film ? { video: film } : {}) });
  });

  app.patch("/api/script/:id", async (c) => {
    const { video, ...b } = await body(c, SectionEditBody);
    const project = await store.read("project");
    const film = chooseFilm(project, video, "the script")?.id ?? null;
    const { result } = await store.update("script", (f) => editSection(filmScriptDraft(f, project, film), c.req.param("id"), b));
    return c.json({ section: result });
  });

  app.post("/api/script/:id/takes", async (c) => {
    const b = await body(c, TakeBody);
    const project = await store.read("project");
    const film = chooseFilm(project, b.video, "the take")?.id ?? null;
    const file = toManifestPath(store.root, b.file);
    const info = await probe(fromManifestPath(store.root, file), { formats: AUDIO_FORMATS });
    const { data, result } = await store.update("script", (f) => addTake(filmScriptDraft(f, project, film), c.req.param("id"), { file, duration: info.duration }));
    await log.add(() => {
      const section = filmScript(data, project, film).sections.find((s) => s.id === c.req.param("id"))!;
      return takeEvent(section, result, section.takes.findIndex((t) => t.id === result.id) + 1);
    }, by(c));
    return c.json({ take: result }, 201);
  });

  // ---- picks ----
  // ?video=<id> reads one film's picks as a plain picks file (lanes and levels are that film's own).
  // §27.6: every reader gets the take in use already worked out, per film, so the dashboard, an
  // agent and the loudness readout can never disagree about it.
  // Always among the takes the film hears (lanesForVideo), which is what Mix plays and the readout
  // measures: a take that has left the film is never its take in use.
  const filmUse = (project: Project, picks: Picks, video: string | undefined): InUse =>
    inUse({ lanes: lanesForVideo(project.lanes, video, project.videos) }, picksForVideo(picks, video));
  const withUse = (project: Project, picks: Picks, video?: string): Picks => {
    if (video) return { ...picksForVideo(picks, video), use: filmUse(project, picks, video) };
    const videos: Picks["videos"] = {};
    for (const [id, v] of Object.entries(picks.videos)) videos[id] = { ...v, use: filmUse(project, picks, id) };
    return { ...picks, use: filmUse(project, picks, undefined), videos };
  };

  // An agent's reading also lists every take with its state (in-use, new, earlier, put-away: takes.ts), as the
  // desk's lists show them: per film, or for one film with ?video=.
  app.get("/api/picks", async (c) => {
    const [project, picks] = await Promise.all([store.read("project"), store.read("picks")]);
    const video = c.req.query("video");
    const read = withUse(project, picks, video);
    if (video) return c.json({ ...read, takes: filmTakes(project, picks, video) });
    const videos: Record<string, object> = {};
    for (const [id, v] of Object.entries(read.videos)) videos[id] = { ...v, takes: filmTakes(project, picks, id) };
    for (const v of project.videos) videos[v.id] ??= { lanes: {}, levels: {}, takes: filmTakes(project, picks, v.id) };
    return c.json({ ...read, takes: filmTakes(project, picks, undefined), videos });
  });

  app.put("/api/picks", async (c) => {
    const b = await body(c, PicksBody);
    // Merged key by key: a string sets that pick, null removes it, anything not named is kept.
    const merge = (into: Record<string, string>, from: Record<string, string | null> = {}) => {
      for (const [k, v] of Object.entries(from)) {
        if (v === null) delete into[k];
        else into[k] = v;
      }
    };
    const mergeLevels = (into: Levels) => {
      // §19.6: same merge rule as lanes/sections -- a number sets the level, null resets it to 0
      // (deletes the key), anything not named is kept.
      for (const stage of ["voice", "music", "sfx"] as const) {
        const v = b.levels?.[stage];
        if (v === undefined) continue;
        if (v === null) delete into[stage];
        else into[stage] = v;
      }
    };
    let before: Record<string, string> = {};
    // The lanes' sounds come from project.json: a pick in a lane it knows also settles which take
    // is in use for that sound (§27.6). If it can't be read now, the pick still stands, plainly.
    const projectBefore = await store.read("project").catch(() => null);
    const lanes = projectBefore?.lanes ?? [];
    const now = new Date();
    let usedBefore: InUse = {};
    const { data } = await store.update("picks", (p) => {
      if (projectBefore) usedBefore = filmUse(projectBefore, p, b.video);
      merge(p.sections, b.sections);
      if (b.video) {
        // A film's picks and levels are its own: another film's are never touched.
        const own = (p.videos[b.video] ??= { lanes: {}, levels: {} });
        before = { ...own.lanes };
        for (const [k, v] of Object.entries(b.lanes ?? {})) {
          const lane = lanes.find((l) => l.id === k);
          if (lane) setInUse(own, lanes, lane, v, now);
          else merge(own.lanes, { [k]: v });
        }
        mergeLevels(own.levels);
        return;
      }
      // No film named: a project with no cut yet (or an older client). The same rule, in the project-wide set.
      before = { ...p.lanes };
      for (const [k, v] of Object.entries(b.lanes ?? {})) {
        const lane = lanes.find((l) => l.id === k);
        if (lane) setInUse(p, lanes, lane, v, now);
        else merge(p.lanes, { [k]: v });
      }
      mergeLevels(p.levels);
    });
    const after = b.video ? (data.videos[b.video]?.lanes ?? {}) : data.lanes;
    // §22.5: a change of what's picked is logged; levels alone aren't (R10).
    // The names come from project.json; if it can't be read now, the pick still stands (ruling e).
    const project = await store.read("project").catch(() => null);
    // §27.6: what the log tells is the take in use for each sound, so a pick that changes nothing in
    // `lanes` (an earlier take brought back) is still a change, and a round's leftover pick is not news.
    const usedNow = project ? filmUse(project, data, b.video) : {};
    const sameUse = (["voice", "music", "sfx"] as const).every((s) => usedBefore[s]?.lane === usedNow[s]?.lane && usedBefore[s]?.variant === usedNow[s]?.variant);
    const changed = Object.keys({ ...before, ...after }).some((k) => before[k] !== after[k]) || !sameUse;
    // §29: a new take in use is balanced against the others by itself, unless a fader has been moved by hand.
    if (opts.autoBalance && project && !sameUse && b.levels === undefined) {
      const own = b.video ? data.videos[b.video] : data;
      if (own && balanceOwned(own)) autoBalance(b.video, by(c));
    }
    if (changed) {
      const inUseLanes = Object.fromEntries(Object.values(usedNow).map((u) => [u.lane, u.variant]));
      if (project) await log.add(() => picksEvent(project, inUseLanes, project.videos.find((v) => v.id === b.video)), by(c));
      else log.failures += 1;
    }
    return c.json(project ? withUse(project, data, b.video) : b.video ? picksForVideo(data, b.video) : data);
  });

  // ---- §29: balance ----
  // Levels are the balance's own while none are set, or while they still equal what the last balance set
  // (an unset level is 0 dB). Moving a fader by hand ends that until Balance is pressed again.
  const sameLevels = (a: Levels, b: Levels) => (["voice", "music", "sfx"] as const).every((k) => (a[k] ?? 0) === (b[k] ?? 0));
  const balanceOwned = (own: { levels: Levels; balanced?: { levels: Levels } }) =>
    own.balanced ? sameLevels(own.levels, own.balanced.levels) : (["voice", "music", "sfx"] as const).every((k) => (own.levels[k] ?? 0) === 0);
  /**
   * Measures the film's takes in use and sets its levels to the house balance (core/balance.ts). `guard` (the
   * automatic run) is asked again inside the write, against the picks as they are then: if a fader was moved or
   * another take picked while ffmpeg ran, nothing is written.
   */
  const runBalance = async (
    video: string | undefined,
    who: ReturnType<typeof by>,
    guard?: (own: { levels: Levels; balanced?: { levels: Levels } }, picks: Picks, project: Project) => boolean,
  ): Promise<{ result: FilmBalance; written: boolean; project: Project; picks: Picks }> => {
    const [project, picks] = await Promise.all([store.read("project"), store.read("picks")]);
    const heard = { ...project, lanes: lanesForVideo(project.lanes, video, project.videos) };
    const result = await balanceFilm(heard, picksForVideo(picks, video), store.root, opts.loudnessRunner ?? defaultRunner, opts.loudnessTimeoutMs);
    if (!result.available) return { result, written: false, project, picks };
    let written = false;
    const { data } = await store.update("picks", (p) => {
      const own = video ? (p.videos[video] ??= { lanes: {}, levels: {} }) : p;
      if (guard && !guard(own, p, project)) return;
      // Each sound in use takes its balanced level (0 dB is stored as unset, as a fader reset is); the others keep theirs.
      for (const stage of ["voice", "music", "sfx"] as const) {
        const v = result.levels[stage];
        if (v === undefined) continue;
        if (v === 0) delete own.levels[stage];
        else own.levels[stage] = v;
      }
      own.balanced = { levels: { ...own.levels }, at: new Date().toISOString() };
      written = true;
    });
    if (written) {
      const film = project.videos.find((v) => v.id === video);
      const event: LogEvent = { area: "mix", kind: "entry", merge: "replace", subject: `balance:${film?.id ?? ""}`, video: film?.id ?? null, version: null, text: `Mix balanced${film ? ` for ${film.name}` : ""}: ${balanceSummary(result.report)}` };
      await log.add(() => event, who);
    }
    return { result, written, project, picks: data };
  };
  // The automatic run, one at a time per film: a pick arriving while one is measuring runs again after it.
  const autoRuns = new Map<string, Promise<void>>();
  const autoBalance = (video: string | undefined, who: ReturnType<typeof by>) => {
    const key = video ?? "";
    const prev = autoRuns.get(key) ?? Promise.resolve();
    const run = prev.then(async () => {
      const before = await store.read("picks").catch(() => null);
      const project = await store.read("project").catch(() => null);
      if (!before || !project) return opts.onAutoBalance?.(video, null);
      const useAt = JSON.stringify(filmUse(project, before, video));
      const { result, written } = await runBalance(video, who, (own, p, proj) => balanceOwned(own) && JSON.stringify(filmUse(proj, p, video)) === useAt);
      opts.onAutoBalance?.(video, written && result.available ? balanceSummary(result.report) : null);
    }).catch(() => opts.onAutoBalance?.(video, null));
    autoRuns.set(key, run);
    void run.finally(() => {
      if (autoRuns.get(key) === run) autoRuns.delete(key);
    });
  };

  app.post("/api/mix/balance", async (c) => {
    const b = await body(c, BalanceBody);
    if (b.video) {
      const project = await store.read("project");
      if (!project.videos.some((v) => v.id === b.video)) throw new RushesError(`No film "${b.video}"`, 404, "not_found");
    }
    const { result, project, picks } = await runBalance(b.video, by(c));
    if (!result.available) return c.json({ available: false, summary: "Install ffmpeg to balance the mix." });
    return c.json({ available: true, levels: result.levels, report: result.report, summary: balanceSummary(result.report), picks: withUse(project, picks, b.video) });
  });

  // ---- mix loudness (§17.6) ----
  app.post("/api/mix/loudness", async (c) => {
    const b = await body(c, MixLoudnessBody);
    const [project, picks] = await Promise.all([store.read("project"), store.read("picks")]);
    const run = opts.loudnessRunner ?? defaultRunner;
    // A film hears only its own reads, beds and passes, as its Mix tab plays them.
    const heard = { ...project, lanes: lanesForVideo(project.lanes, b.video, project.videos) };
    const result = await measureMix(heard, picksForVideo(picks, b.video), b.lanes, store.root, run, opts.loudnessTimeoutMs);
    return c.json(result);
  });

  // ---- batches ----
  // A batch touches two files (notes and batches), so batch creation runs one at a time. The batch
  // is recorded first and the notes are marked second: if the second write fails, the notes are
  // still unsent and go out again in the next batch. The other way round, a failure stranded notes
  // naming a batch that was never recorded, and the next batch reused its id.
  // §28: once filed, the batch goes to the agent runner (with Send to AI off it says so and the desk copies
  // the prompt). The hand-over starts inside the queue, so two Sends reach the runner in the order they were
  // filed, but the queue doesn't wait for it: an agent starting up never holds the next Send's filing.
  let batchQueue: Promise<unknown> = Promise.resolve();
  /**
   * What a hand-over says to the desk. It never fails because of the agent: an error becomes the reason it wasn't
   * handed over, and an agent still starting after sendWaitMs never holds the answer (it says so, and the run carries on).
   */
  const handOverOf = async <T extends SendResult | null>(handing: Promise<T>): Promise<SendHandOver | Exclude<T, SendResult>> => {
    const handed = handing.catch((e: unknown): SendResult => ({ handedTo: null, why: e instanceof Error ? e.message : String(e) }));
    let timer: NodeJS.Timeout | undefined;
    const late = Symbol("late");
    const waited = new Promise<typeof late>((ok) => { timer = setTimeout(() => ok(late), sendWaitMs); });
    const settled = await Promise.race([handed, waited]).finally(() => clearTimeout(timer));
    return settled === late ? { handedTo: agent.status().agent, starting: true } : (settled as SendHandOver | Exclude<T, SendResult>);
  };
  app.post("/api/batches", async (c) => {
    const { stage, video } = await body(c, BatchBody);
    // §32: a Send before the desk has read the agent still goes where the Mac-wide default says.
    await adoptAgentDefaultsOnce(store);
    // §31.2.2: Send on a film sends that film's notes and script alone, and the batch carries the film.
    const film = video ? chooseFilm(await store.read("project"), video)!.id : null;
    let handing: Promise<SendResult> | undefined;
    const run = batchQueue.catch(() => undefined).then(async (): Promise<Batch> => {
      const [project, script, notes, batches] = await Promise.all([store.read("project"), store.read("script"), store.read("notes"), store.read("batches")]);
      // createBatch marks the notes it takes and files the batch in `batches`; on copies, it only
      // tells us what goes in.
      const result = createBatch({ project, script: filmScript(script, project, film), notes: structuredClone(notes), batches: structuredClone(batches), video: film }, stage);
      // R11: the prompt ends with the last five lines of the log, from before this send. A log that
      // can't be read adds nothing: the batch must still be sent. §31.5: with a film, the lines Activity shows on it.
      const recent = await Promise.all([store.read("project"), store.read("script")])
        .then(async ([projectNow, scriptNow]) =>
          recentChanges((await log.view({ limit: 5, ...(film ? { video: film } : {}) }, { project: projectNow, script: everySection(scriptNow), films: { videos: projectNow.videos, lanes: projectNow.lanes, notes: notes.notes } })).entries),
        )
        .catch(() => "");
      if (recent) result.prompt = `${result.prompt}\n\n${recent}`;
      await store.update("batches", (f) => { f.batches.push(result); });
      await store.update("notes", (f) => markSent(f.notes, result));
      // §30: one line per film the batch's notes are on (its script edits go with the notes on no film). §31.2.2: a
      // batch sent on a film is that film's alone: one line, script edits and the shared visuals' notes included.
      const noteFilm = new Map(notes.notes.map((n) => [n.id, n.video ?? null]));
      const stageOf = new Map(notes.notes.map((n) => [n.id, n.stage]));
      const own = film && project.videos.length > 1 ? film : null;
      const groups: [string | null, string[]][] = own ? [[own, result.noteIds]] : byFilm(result.noteIds, (id) => noteFilm.get(id));
      const takesEdits = (f: string | null) => f === null || f === own;
      if (groups.length === 0 || (result.sectionIds.length > 0 && !groups.some(([f]) => takesEdits(f)))) groups.push([own, []]);
      for (const [lineFilm, ids] of groups) {
        const sectionIds = takesEdits(lineFilm) ? result.sectionIds : [];
        // Each film's line names the tab its own notes came from ("from Picture"), not the whole batch's.
        const stages = new Set([...ids.map((id) => stageOf.get(id)), ...(sectionIds.length ? ["script" as const] : [])]);
        const stage = stages.size === 1 ? ([...stages][0] ?? result.stage) : result.stage;
        const part = { ...result, stage, noteIds: ids, sectionIds };
        await log.add(() => notesSentEvent(part, lineFilm), by(c));
      }
      handing = (async () => agent.send(result))();
      return result;
    });
    batchQueue = run;
    const batch = await run;
    return c.json({ batch, agent: await handOverOf(handing!) }, 201);
  });

  // §38.7: Send to agent from a Plan page (a film's brief to write, an At a glance to add, a storyboard to sketch). It is
  // a batch with no notes, filed in turn with Send's, so the agent's turn, Activity and Stop work as for any batch; with
  // Send to AI off it says why and the page copies the prompt instead.
  app.post("/api/agent/ask", async (c) => {
    const { prompt, label, video } = await body(c, AskBody);
    await adoptAgentDefaultsOnce(store);
    // With Send to AI off nothing is filed: the page copies the prompt.
    if (!agent.status().on) return c.json({ batch: null, agent: { handedTo: null, why: "Send to AI is off" } });
    const film = video ? chooseFilm(await store.read("project"), video)!.id : null;
    let handing: Promise<SendResult> | undefined;
    const run = batchQueue.catch(() => undefined).then(async (): Promise<Batch> => {
      const batches = await store.read("batches");
      const id = `b_${batches.batches.length + 1}`;
      const batch: Batch = { id, stage: null, noteIds: [], sectionIds: [], sentAt: new Date().toISOString(), prompt: `${prompt}\n\n(This is request ${id} from the Rushes desk. It has no notes: do what it asks, then say what you did.)`, label, ...(film ? { video: film } : {}) };
      await store.update("batches", (f) => { f.batches.push(batch); });
      handing = (async () => agent.send(batch))();
      return batch;
    });
    batchQueue = run;
    const batch = await run;
    return c.json({ batch, agent: await handOverOf(handing!) }, 201);
  });

  // I3, Send again: a batch whose hand-over was refused while Send to AI was on (its `undelivered` mark), or whose turn
  // ended with notes unanswered (§35.7, `unfinished`), goes to the
  // agent now, while notes of it still wait. The mark is in batches.json, so this works after a restart too. Refused
  // again (still not signed in), it says why and keeps the mark, as Send does.
  app.post("/api/batches/:id/resend", async (c) => {
    const id = c.req.param("id");
    const [batches, notes] = await Promise.all([store.read("batches"), store.read("notes")]);
    const batch = batches.batches.find((b) => b.id === id);
    if (!batch) throw new NotFoundError("batch", id);
    if (!notes.notes.some((n) => n.batch === id && noteState(n) === "sent")) {
      throw new RushesError(`Nothing in ${id} is waiting for the agent any more.`, 409, "batch_not_waiting");
    }
    // §35.7: a batch whose turn ended with notes of it unanswered (its `unfinished` mark) can go again too.
    if (!batch.undelivered && !batch.unfinished) throw new RushesError(`${id} already reached the agent.`, 409, "batch_delivered");
    const handed = await handOverOf(agent.resend(batch, { unfinished: true }));
    // Null: another Send again took it a moment ago.
    if (!handed) throw new RushesError(`${id} already reached the agent.`, 409, "batch_delivered");
    // Refused because the agent is still on this film (§35.7): the marks stay, and the answer says why.
    if (handed.handedTo === null && "busy" in handed && handed.busy) return c.json({ batch, agent: handed });
    return c.json({ batch: { ...batch, undelivered: null, unfinished: null }, agent: handed });
  });

  app.get("/api/batches/:id", async (c) => {
    const [batches, notes, script, visuals, project] = await Promise.all([store.read("batches"), store.read("notes"), store.read("script"), store.read("visuals"), store.read("project")]);
    const id = c.req.param("id");
    const batch = id === "latest" ? latestBatch(batches) : batches.batches.find((b) => b.id === id);
    if (!batch) throw new NotFoundError("batch", id);
    // §31.6: a batch is about one film (its `video`): its sections are that film's script's, and the film is named so an
    // agent working the batch passes it on. A batch from before names none: its sections are the first film's.
    const film = batch.video ? project.videos.find((v) => v.id === batch.video) : undefined;
    return c.json({
      batch,
      ...(film ? { film: { id: film.id, name: film.name } } : {}),
      notes: withVisualViews(notes.notes.filter((n) => batch.noteIds.includes(n.id)), visuals),
      sections: filmScript(script, project, batch.video ?? null).sections.filter((s) => batch.sectionIds.includes(s.id)),
    });
  });

  // ---- visuals (§25) ----
  app.post("/api/visuals", async (c) => {
    const b = await body(c, VisualBody);
    // Every picture is read first, one after the other in the order given, so a refusal always names the first bad one and writes nothing.
    const pages: PageInput[] = [];
    for (const p of b.pages) {
      const files: PictureInput[] = [];
      for (const f of p.files) files.push(await readPicture(store.root, f));
      pages.push({ n: p.n, files });
    }
    const { result } = await store.update("visuals", (f) =>
      b.name !== undefined ? registerVisual(f, { name: b.name, kind: b.kind, label: b.label, pages }) : addVisualVersion(f, { visual: b.visual!, label: b.label, pages }),
    );
    await log.add(() => visualEvent(result.visual, { id: result.version.id, note: "", file: "", label: result.version.label }), by(c));
    return c.json({ visual: { id: result.visual.id, name: result.visual.name, kind: result.visual.kind }, version: { id: result.version.id, label: result.version.label }, pages: result.version.pages.length, ratios: visualRatios(result.version).map(labelOfId) }, 201);
  });

  // ---- the Change Log (§22.7) ----
  app.get("/api/log", async (c) => {
    const q = LogQuery.safeParse(c.req.query());
    if (!q.success) throw new InvalidError(q.error.issues.map((i) => i.message).join("; "), q.error.issues);
    const [project, script, notes] = await Promise.all([store.read("project"), store.read("script"), store.read("notes")]);
    const video = q.data.video ? chooseFilm(project, q.data.video)!.id : undefined;
    return c.json(await log.view({ ...q.data, video }, { project, script: everySection(script), films: { videos: project.videos, lanes: project.lanes, notes: notes.notes } }));
  });

  app.post("/api/log", async (c) => {
    const b = await body(c, LogLineBody);
    // What's refused is named back on one clean line, never with the control characters it came with.
    const shown = (s: string) => Array.from(oneLineOf(s)).slice(0, 80).join("");
    const text = logText(b.text);
    if (!text) throw new InvalidError("text is empty: say what happened in one line");
    let video: string | null = null;
    let version: string | null = null;
    if (b.version && !b.video) throw new InvalidError("version needs video");
    // Read only when something must be checked against it, so a plain line never depends on project.json (M5).
    const project = b.video || b.ref ? await store.read("project") : null;
    if (project && b.video) {
      let v;
      try {
        v = resolveVideo(project, b.video);
      } catch {
        throw new NotFoundError("video", shown(b.video));
      }
      video = v.id;
      if (b.version) {
        if (!v.versions.some((x) => x.id === b.version)) throw new NotFoundError("version", shown(b.version));
        version = b.version;
      }
    }
    // A jump goes only to a variant ("<lane>/<variant>") or a take ("<section>:<take>") that exists.
    if (project && b.ref) {
      const script = await store.read("script");
      const refs = new Set([
        ...project.lanes.flatMap((l) => l.variants.map((x) => `${l.id}/${x.id}`)),
        ...allSections(script).flatMap((s) => s.takes.map((x) => `${s.id}:${x.id}`)),
      ]);
      if (!refs.has(b.ref)) throw new NotFoundError("ref", shown(b.ref));
    }
    const entry = await log.add(() => lineEvent(text, b.area ?? "project", { video, version, ref: b.ref ?? null }), by(c));
    if (!entry) throw new RushesError("The Change Log couldn't be written. Run `rushes doctor`.", 500, "log_unwritable");
    return c.json({ entry }, 201);
  });

  // ---- Send to AI (§28) ----
  const agentStatusOf = async () => ({ status: await agent.reload() });
  // §32: the desk reads this as it loads: a project with no rules of its own starts from the Mac-wide default first.
  app.get("/api/agent", async (c) => {
    await adoptAgentDefaultsOnce(store);
    return c.json(await agentStatusOf());
  });
  // ?fresh=1 checks again now (after the user signs in), not from the last 30 s.
  app.get("/api/agent/detect", async (c) => {
    if (c.req.query("fresh") === "1") clearDetectCache();
    const agents = await detect();
    // §34: the platform names the sign-in button; each agent's connector says whether it is still downloading.
    return c.json({ agents: agents.map((a) => ({ ...a, connector: connectors(a.id) })), platform: process.platform });
  });
  app.post("/api/agent/setup", async (c) => {
    const b = await body(c, AgentSetupBody);
    const filed = b.batch === undefined ? null : (await store.read("batches")).batches.find((x) => x.id === b.batch);
    if (filed === undefined) throw new NotFoundError("batch", b.batch!);
    const rules = agentRulesFor(store);
    // Consent fix: a change of the level alone (the agent menu's, which names no agent) changes the level and nothing
    // else. It never chooses an agent, never keeps one the user didn't choose, and leaves the switch as it is.
    const permissions = b.permissions;
    if (permissions !== undefined && b.agent === undefined) {
      const { data } = await rules.update((f) => void (f.permissions = permissions));
      // §32: the menu's choice is the default for new projects too.
      await rememberDefault({ permissions }, data);
      return c.json(await agentStatusOf());
    }
    // The row's switch names no agent: it turns on the one agent.json names, so it can't stand in for the sheet's "who"
    // and "what may it do" until the user has answered the sheet once (a prepared project shows Set up, not a switch).
    if (b.on && b.agent === undefined && !(await rules.read()).setUp) {
      throw new RushesError("Choose who should get the notes first: Set up Send to AI.", 409, "agent_not_set_up");
    }
    let checked: AgentId | null = null;
    if (b.on) {
      const id = b.agent ?? (await store.read("agent")).agent;
      if (!id) throw new InvalidError("Choose an agent to turn Send to AI on");
      // Checked again now, so a user who has just signed in isn't refused from the cache.
      clearDetectCache();
      const info = (await detect()).find((a) => a.id === id);
      const name = info?.name ?? (id === "claude" ? "Claude Code" : "Codex");
      if (!info?.installed) throw new RushesError(`${name} is not installed.`, 409, "agent_not_installed", { agent: id });
      if (info.outdated) throw new RushesError(`${name} ${info.version} is too old for Send to AI. Update it with: ${AGENT_HELP[id].update}`, 409, "agent_outdated", { agent: id });
      if (!info.signedIn) throw new RushesError(`${name} is not signed in. Choose ${signInLabel(process.platform)}, then try again.`, 409, "agent_not_signed_in", { agent: id });
      checked = id;
    }
    // R10, I1 and the consent fix: the user's answer to the first-Send sheet, the agent they turned on (none after Copy a
    // prompt or switching off) and what it may do are kept in their own rules file, outside the project, where neither
    // the agent nor a project folder from someone else can set them. Revoke first, grant last: switching off clears the
    // agent before agent.json is written, so a failure between the two leaves nothing chosen; turning on writes it only
    // once agent.json took the change, so a refused setup (409) leaves the file as it was.
    const consent = () => rules.update((f) => {
      f.setUp = true;
      f.agent = checked;
      if (permissions !== undefined) f.permissions = permissions;
    });
    if (!b.on) await consent();
    await store.update("agent", (f) => {
      // Turned on only for the agent that was checked: one changed meanwhile (another tab) is refused.
      if (b.on && (b.agent ?? f.agent) !== checked) throw new RushesError("The agent changed. Try again.", 409, "agent_changed");
      f.on = b.on;
      // Another agent can't continue this one's conversation.
      if (b.agent !== undefined && b.agent !== f.agent) {
        f.agent = b.agent;
        f.session = null;
      }
    });
    if (b.on) await consent();
    // §32: the user's choice is Send to AI's default for every new project on this Mac (last choice wins): the agent
    // turned on, with what it may do, or no agent after Copy a prompt. Turning the switch off leaves it as it is.
    if (b.on || b.prompt) {
      const now = await rules.read();
      await rememberDefault({ agent: b.on ? checked : null, ...(permissions !== undefined ? { permissions } : {}) }, now);
    }
    // I3: the batch the dialog showed goes to the agent now, if its hand-over was refused and it hasn't gone since (the
    // runner takes it from its refused set once, under its send lock), while notes of it still wait.
    if (b.on && filed && (await store.read("notes")).notes.some((n) => n.batch === filed.id && noteState(n) === "sent")) {
      const handed = await handOverOf(agent.resend(filed));
      if (handed) return c.json({ ...(await agentStatusOf()), agent: handed });
    }
    return c.json(await agentStatusOf());
  });
  // Start a fresh conversation: the next Send starts a new session.
  app.post("/api/agent/fresh", async (c) => {
    await store.update("agent", (f) => { f.session = null; });
    return c.json(await agentStatusOf());
  });
  app.post("/api/agent/stop", async (c) => {
    await agent.stop();
    return c.json(await agentStatusOf());
  });
  app.post("/api/agent/permission/:id", async (c) => {
    const { choice } = await body(c, z.object({ choice: z.enum(["once", "always", "no"]) }));
    await agent.answer(c.req.param("id"), choice);
    return c.json(await agentStatusOf());
  });
  // T6: a rule is named by what it is, so two tabs removing rules never take out the wrong one.
  app.delete("/api/agent/always", async (c) => {
    const rule = await body(c, AlwaysRuleSchema);
    await agent.removeRule(rule);
    return c.json(await agentStatusOf());
  });
  // The command is the agent's own login command from detection, never text from the request.
  app.post("/api/agent/sign-in", async (c) => {
    const b = await body(c, z.object({ agent: z.enum(AGENTS) }));
    const info = (await detect()).find((a) => a.id === b.agent);
    if (!info) throw new InvalidError(`Rushes doesn't know how to sign in to ${b.agent}`);
    // §34: the detected path, so the sign-in runs the same agent Send to AI will.
    await terminal(info.signIn, info.path ? [info.path, ...AGENT_HELP[info.id].signInArgs] : undefined);
    return c.body(null, 204);
  });
  app.post("/api/agent/working-on", async (c) => {
    const b = await body(c, z.object({ note: z.string().min(1), doing: z.string().min(1).max(200) }));
    await agent.workingOn(b.note, b.doing);
    return c.body(null, 204);
  });

  // ---- live updates ----
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const send = (e: ChangeEvent) => void stream.writeSSE({ event: "change", data: JSON.stringify(e) });
      const corrupt = (e: CorruptEvent) => void stream.writeSSE({ event: "corrupt", data: JSON.stringify(e) });
      const proxy = (e: ProxyEvent) => void stream.writeSSE({ event: "proxy", data: JSON.stringify(e) });
      const agentStatus = (s: AgentStatus) => void stream.writeSSE({ event: "agent", data: JSON.stringify(s) });
      store.on("change", send);
      store.on("corrupt", corrupt);
      store.on("proxy", proxy);
      store.on("agent", agentStatus);
      streams++;
      stream.onAbort(() => {
        streams--;
        store.off("change", send);
        store.off("corrupt", corrupt);
        store.off("proxy", proxy);
        store.off("agent", agentStatus);
      });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ root: store.root }) });
      while (!stream.aborted) await stream.sleep(15000).then(() => stream.writeSSE({ event: "ping", data: "" }));
    }),
  );

  return app;
}
