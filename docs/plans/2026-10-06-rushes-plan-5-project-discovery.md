# Rushes Plan 5: Finding the Project's Other Files — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a project is opened, Rushes scans the project folder, brings in the current set (the voiceover, music and effects that go with the cut) unpicked, and lists everything else in Assets › Found for the user to tick and bring in.

**Architecture:**
- **Scan engine.** A pure, bounded scan-and-score module in `src/core/found.ts`. It walks the folder, classifies each file, and scores audio against a cut.
- **Server service.** A background scanner keeps candidates in memory, with only the dismissed list on disk (`.rushes/found.json`). It adopts the current set through the existing `addVariant`/`addVersion` code, and serves routes, state and SSE.
- **Agent surface.** MCP tools and CLI commands.
- **Dashboard.** An Assets › Found folder, a header chip and a line on locked tabs.

**Tech Stack:** TypeScript (ESM, NodeNext), Hono, zod, Preact 10, Vite 8, ffprobe (optional), vitest, Playwright (Chromium and WebKit).

**Spec:** `docs/specs/2026-10-02-rushes-design.md` §20, which is binding. It refers back to §16 (Assets library), §17.8 (`on` values), §18 (rounds) and §19.1 (locked tabs).

## Global Constraints

- **Language and type:** UK English in all copy and docs. Type is 15px or larger everywhere.
- **Dependencies:** runtime dependencies stay exactly `@hono/node-server`, `@modelcontextprotocol/sdk`, `hono` and `zod`.
- **ffmpeg and ffprobe:** optional. Spawn them with an args array only, never a shell. Without ffprobe, durations are unknown and nothing crashes.
- **The scan stays inside the project folder:**
  - every path is checked against the folder's real path;
  - symlinks are never followed, and symlinked files are skipped;
  - file contents are never read.
- **Never wait on the scan.** `GET /api/state` and the dashboard never wait on a scan. Long work runs in the background, two probes at a time, and announces itself with the existing `change` SSE event.
- **Rendering:** grids use explicit tracks (`minmax(0,1fr)`), and there's no per-frame React state.
- **Tests:**
  - Tests never open apps (`RUSHES_NO_REVEAL=1`).
  - e2e must pass 5 consecutive default-parallel runs with `--retries=0`, in Chromium and WebKit.
  - Never touch ports 4410, 4430–4434 or 8765.
- **Privacy:** no client or brand names and no personal paths in tracked files. Test fixtures are generated into temp folders from invented names.
- **Git:** commit with the repo's existing identity; never change git config. Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- **Large or long jobs on the user's machine:** need visible progress. The scan shows a "Looking through the folder…" state in the Found folder.
- **Nothing pending is ever dropped:** `notePending` stays the single definition.

## Review Focus

1. **A folder with a huge tree, or a symlink loop.** The scan must finish within its limits (5,000 files examined, 8 levels, a 3 s first pass) and never hang. *(Task 1 unit, Task 2 server.)*
2. **A symlink or `../` path pointing outside the project.** It must never be listed, served by `/media`, or registrable through `bring-in`. *(Tasks 1, 2 and 3.)*
3. **A file registered twice under different spellings** (relative vs absolute, different case on macOS, Unicode normalisation). It must never be offered again or added twice. *(Task 3.)*
4. **A file that vanishes between the scan and "Bring in".** That file gets a clear error, and the others in the same request still go in. *(Task 3.)*
5. **File names with spaces, accents, or the macOS narrow no-break space (U+202F) before AM/PM.** They scan, play and register correctly. *(Tasks 1 and 3.)*

---

## File structure

| Area | Files |
|---|---|
| Scan engine | new `src/core/found.ts` (walk, `kindOf`, `scoreCandidate`, `pickCurrentSet`, types) |
| Server | new `src/server/found.ts` (service), `src/core/schema.ts` (`FoundFileSchema`, `FILES.found`), `src/core/store.ts` (the new file key), `src/server/app.ts` (routes, state, `/media`), `src/server/files.ts` (allow-list), `src/server/start.ts` (start, close) |
| Agent | `src/mcp/tools.ts` (`rushes_open`, `rushes_scan`, `rushes_bring_in`), `src/cli/main.ts` (`scan`, `bring-in`, `open`), `skills/rushes/SKILL.md`, `AGENTS.md` |
| Web | `web/src/types.ts`, `web/src/lib.ts` (`FOLDERS`, found helpers), new `web/src/ui/Found.tsx`, `web/src/ui/Assets.tsx`, `web/src/ui/App.tsx` (header chip, locked-tab line), `web/src/styles.css` |
| Docs | `README.md`, `AGENTS.md`, `skills/rushes/SKILL.md` |
| Tests | `test/core/found.test.ts`, `test/server/found.test.ts`, `test/cli/*`, `test/mcp/tools.test.ts`, `test/web/lib.test.ts`, `e2e/found.spec.ts`, `e2e/fixture.ts` |

---

### Task 1: The scan engine (§20.2–§20.4)

**Files:**
- Create: `src/core/found.ts`
- Test: `test/core/found.test.ts`

**Interfaces:**
- Produces:

```ts
export type FoundKind = "voice" | "music" | "sfx" | "cut" | "other";
export interface FoundFile {
  path: string;        // manifest path: relative to the project root, forward slashes, as toManifestPath gives
  abs: string;         // the real absolute path
  kind: FoundKind;
  folder: string;      // the file's folder, relative to the root ("" for the root itself)
  size: number;
  modified: number;    // ms since the epoch
  duration: number | null;
}
export interface ScanLimits { maxDepth: number; maxExamined: number; maxKept: number; budgetMs: number }
export const DEFAULT_LIMITS: ScanLimits = { maxDepth: 8, maxExamined: 5000, maxKept: 2000, budgetMs: 3000 };
export interface ScanResult { files: FoundFile[]; complete: boolean; examined: number }

/** Walks `root` within the limits. Symlinks are skipped. Never reads contents. */
export function scanFolder(root: string, opts?: { limits?: Partial<ScanLimits>; skip?: (relPath: string) => boolean; now?: () => number }): Promise<ScanResult>;

/** The kind a path suggests, from the nearest folder name or file-name word (§20.3). */
export function kindOf(relPath: string): FoundKind;

export interface Anchor { duration: number | null; modified: number; words: string[] }  // the cut being scored against
export interface Scored { file: FoundFile; score: number; reasons: string[] }
/** §20.4's scoring table for one audio candidate. `commonWords` are the words most files share. */
export function scoreCandidate(file: FoundFile, anchor: Anchor, commonWords: Set<string>): Scored;
/** The words that appear in more than half of `files`' paths: they say nothing about one cut. */
export function commonWordsOf(files: FoundFile[]): Set<string>;
/** Per kind (voice, music, sfx), the top candidate only when score ≥ 4 and it beats the runner-up by ≥ 1. */
export function pickCurrentSet(scored: Scored[]): Partial<Record<"voice" | "music" | "sfx", Scored>>;
/** The words of a name: lower-cased, split on non-letters and camel case, "v20" kept whole. */
export function wordsOf(text: string): string[];
```

- **Skipped by default:**
  - hidden folders (a leading `.`), `node_modules`, `.rushes`, `proxies`, `screenshots` and `exports` (the project's own folders);
  - files with other extensions (audio: `wav mp3 m4a aif aiff flac ogg opus`; video: `mp4 mov m4v webm`);
  - symlinks (use `lstat`).
- **The reasons are plain words**, built exactly as the spec's examples read: "same length as the cut (68.6 s vs 68.7 s)", "made 12 min before it", "name shares “jules”", "close to the cut's length", "a short line (4 s)". Keep each reason a short clause. Round times to the nearest minute, or hours when longer.
- **Scoring** (from §20.4): length within 2 % of `d` is +3, within 10 % is +2, within 25 % is +1 (none for `sfx`). Modified within 6 hours before to 1 hour after `m` is +2; within the 24 hours before `m` is +1. A shared non-common name word is +1 each, up to +2; the same version word (`/^v\d+[a-z]?$/`) is +2.
- **`kindOf`:** the nearest folder name or file-name word that matches wins (`vo_jules/jules-read.wav` is voice, because `vo` is nearer the file than anything else; a file called `bed-A.wav` inside `vo/` is music, because the file-name word is nearest). Keywords are in §20.3.

- [ ] **Step 1: Write the failing tests** (`test/core/found.test.ts`). Generate a fixture tree in a temp folder from invented names, modelled on the real layout:
  - `vo/` (6 short line files), `vo_jules/` (a full read plus lines), `bed/` (3 beds), `audition/` (take-01…), `sfx/` (2), `hyperframes/out/` (2 renders), `.git/x.wav`, `node_modules/y.wav`, `proxies/p.mp4`, and a symlink `link.wav` to a file outside the root.
  - **`kindOf` cases:**
    - `vo/line-03.wav` is voice;
    - `bed/bed-A.wav` is music;
    - `vo/bed-A.wav` is music;
    - `sfx/whoosh-1.wav` is sfx;
    - `audition/take-01.wav` is other;
    - `render.mp4` is cut;
    - `Narration Take 2.wav` is voice.
  - **`wordsOf`:** "harbour-launch-reel-v20J-jules-phone" gives `["harbour","launch","reel","v20j","jules","phone"]`; camel case splits ("juLesRead" gives "ju", "les", "read"; just assert "GreatVoice" gives "great","voice").
  - **`scanFolder` cases:**
    - skips `.git`, `node_modules`, `proxies` and the symlink;
    - finds the right files and kinds;
    - respects `maxDepth`;
    - stops at `maxExamined` and sets `complete: false`;
    - stops at the time budget (inject `now`) and sets `complete: false`;
    - never lists a path outside the root (assert on a `../` symlink to a folder);
    - handles a file named with U+202F (`Screen Recording 2026-10-02 at 3.04.05 PM.mov`).
  - **`scoreCandidate`:**
    - a 68.6 s file vs a 68.7 s cut made 12 min before the cut scores 5 or more with reasons containing "same length" and "made 12 min before";
    - a 4 s line scores below 4;
    - an sfx file gets no length score;
    - a shared word counts only when not common, and the version word adds 2.
  - **`pickCurrentSet`:**
    - the top candidate wins only at score ≥ 4 and a lead ≥ 1;
    - a tie gives none for that kind;
    - at most one per kind.
  - **A performance test:** a generated tree of 5,000 small files scans inside 2 s.
- [ ] **Step 2: Run them and see them fail.** Run: `npx vitest run test/core/found.test.ts`. Expected: FAIL, with the module missing.
- [ ] **Step 3: Implement** `src/core/found.ts`. Walk with `readdir` (`withFileTypes`) and `lstat`, level by level, yielding to the event loop every 200 entries so the server stays responsive. Count `examined` for every directory entry.
- [ ] **Step 4: Run the gates.** `npm run build && npx vitest run && npm run typecheck`. All green.
- [ ] **Step 5: Commit.** `feat(core): scan a project folder for audio and cuts, classify them and score them against a cut`.

---

### Task 2: The scanner service, routes and state (§20.1, §20.5 data, §20.6)

**Files:**
- Modify: `src/core/schema.ts` (`FoundFileSchema`, `FILES.found`, its type), `src/core/store.ts` (the new key; `found.json` is created on first write, default `{ schema: 1, rev: 0, dismissed: [] }`)
- Create: `src/server/found.ts`
- Modify: `src/server/app.ts` (routes, `GET /api/state` gets `found`, SSE), `src/server/files.ts` (the `/media` allow-list), `src/server/start.ts` (build the service, run the first scan, close it)
- Test: `test/server/found.test.ts`, `test/core/store.test.ts` (the new file key), `test/server/files.test.ts`

**Interfaces:**
- **Consumes (Task 1):** `scanFolder`, `kindOf`, `FoundFile`, `scoreCandidate`, `commonWordsOf`, `pickCurrentSet`.
- **The service:**

```ts
export interface FoundCounts { voice: number; music: number; sfx: number; cut: number; other: number }
export interface FoundSummary { scanning: boolean; scannedAt: string | null; complete: boolean; counts: FoundCounts; broughtIn: string[] }
export interface FoundEntry extends FoundFile { score: number | null; reasons: string[]; suggested: boolean }
export class FoundScanner {
  constructor(opts: { store: Store; probe: (abs: string) => Promise<number | null>; announce: () => void; limits?: Partial<ScanLimits> });
  /** Scans now (or joins a scan already running). Resolves when the first pass is done. */
  scan(opts?: { film?: string }): Promise<void>;
  summary(): Promise<FoundSummary>;
  list(): Promise<FoundEntry[]>;                       // not registered, not dismissed; best score first; capped at 2000
  has(rel: string): boolean;                           // is `rel` a current found candidate (for /media)
  dismiss(paths: string[]): Promise<void>;             // updates found.json
  restore(paths: string[]): Promise<void>;
  close(): void;
}
```

- **Behaviour:**
  - The scan runs in the background. `scan()` returns after the first pass (walk and kinds), and probing then continues at two files at a time, announcing `change` when it lands. The probe results are cached by path, size and mtime.
  - **Already registered** files (cuts, variants, takes, library files) are matched by real path (`realpath`, so case or symlink spellings can't slip through) and left out of `list()`. Dismissed paths are left out as well.
  - **The anchor** is the opened film's newest cut (`film` names a video id or name; otherwise the newest cut of the first film). Its duration comes from the version, else a probe. With no registered cut there's no anchor, so nothing is scored and `suggested` is false for every file.
  - **Scoring** uses `commonWordsOf` over all candidates. `suggested` is true for the files `pickCurrentSet` chose.
- **Routes** (all behind the existing project-identity guard):
  - `GET /api/found` returns `{ files: FoundEntry[] }`.
  - `POST /api/found/scan` (body `{ film?: string }`) returns `{ ok: true }` immediately and scans in the background.
  - `POST /api/found/dismiss` and `POST /api/found/restore` (body `{ paths: string[] }`, each ≤ 500 paths).
  - `GET /api/state` gains `found: FoundSummary`.
  - `/media` also serves a path that `scanner.has()` says is a current candidate (so it can be auditioned), with the usual sandbox headers and the same refusal of symlinks and paths outside the root.
- **Start-up.** The server runs a first scan when it starts. It never delays startup.
- **`found.json`** is validated by zod like the other files. A hand-edited bad file is reported as corrupt through the existing mechanism.

- [ ] **Step 1: Write the failing tests** (`test/server/found.test.ts`), using an injected fake probe and a temp project:
  - `scan()` lists the files, excludes registered ones (register a variant by path, then expect it gone), and `GET /api/state` never waits on a slow probe (use a probe that never resolves, and assert the state request returns within 500 ms).
  - Probing runs two at a time, and `change` is announced when results land.
  - Dismiss and restore: a dismissed path is gone from `list()`, and `found.json` holds it, as a manifest path; restoring brings it back.
  - A path that's both a case-different spelling of a registered file and a symlink to it doesn't appear (Review Focus 3).
  - `/media`: a found candidate can be fetched with the sandbox headers; a path outside the root, a symlink and a dismissed or unknown path give 404 (Review Focus 2).
  - A scan that stops at its limits reports `complete: false`.
  - With no registered cut, no file is `suggested`.
  - The route identity guard still applies (wrong project is 409).
  - `store` test: `found.json` round-trips and a corrupt one is reported.
- [ ] **Step 2: Run them and see them fail.** Run: `npx vitest run test/server/found.test.ts test/core/store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the zod schema `{ schema: z.literal(1), rev, dismissed: z.array(z.string().max(1024)).max(10000).default([]) }`. Keep all service state in memory except `dismissed`.
- [ ] **Step 4: Run the gates.** Build, vitest, typecheck, then one e2e run (behaviour for the dashboard is unchanged; the existing tests must still pass). All green.
- [ ] **Step 5: Commit.** `feat(server): a background scanner lists the project's other files, with dismiss and restore`.

---

### Task 3: Bringing files in, and the current set (§20.4, §20.5 actions)

**Files:**
- Modify: `src/server/found.ts` (adds `bringIn`, `adoptCurrentSet`), `src/server/app.ts` (route; adopt on the scan route and at start-up)
- Test: `test/server/found.test.ts` (extended), `test/core/project.test.ts` if a helper is added

**Interfaces:**
- **Consumes:** Tasks 1 and 2, plus `addVersion`, `addVariant` and `store.update("project", …)` (the single writer), `toManifestPath`.
- **Added to the service:**

```ts
export interface BringInItem { path: string; kind?: "voice" | "music" | "sfx" | "cut" | "doc"; round?: string }
export interface BringInResult { added: { path: string; kind: string; lane?: string; variant?: string; video?: string; version?: string }[]; failed: { path: string; reason: string }[] }
bringIn(items: BringInItem[], opts?: { reasons?: Map<string, string[]>; film?: string }): Promise<BringInResult>;
/** §20.4: adopts the top candidate per kind for the anchor cut, unpicked. Idempotent per file. */
adoptCurrentSet(opts?: { film?: string }): Promise<BringInResult>;
```

- **`POST /api/found/bring-in`** takes `{ files: BringInItem[], film?: string }` (up to 60 items) and returns the `BringInResult`.
- **What bringing in does:**
  - Every path must be a current candidate or lie inside the root (checked with `realpath`), and must still exist. Otherwise that item fails with a clear reason ("That file isn't in the project folder", "That file has gone"), and the others still go in.
  - **Voice** goes through `addVariant({ stage: "voice", round, name, file, description })`. The round defaults to the file's folder name, humanised ("vo_jules" becomes "Vo Jules"). The variant's name is the file name without its extension. The description is the reasons joined with " · ", or empty when none are known.
  - **Music** goes into the `music` lane and **sfx** into the `sfx` lane, the same way.
  - **Cut** goes through `addVersion` on the anchor film, with the file's duration if known.
  - **`doc`** goes through the existing library-file registration, with kind `doc`.
  - **12 per kind per request.** Beyond that, the extra items fail with "Up to 12 at a time, so the tabs stay quick."
  - Nothing is ever picked.
  - Already-registered files are skipped, not duplicated (by real path). They come back in `failed` with the reason "Already in the project."
  - After a bring-in, the in-memory list drops them and the service announces `change`.
- **Adopting the current set:** `adoptCurrentSet` calls `bringIn` for the `suggested` files with their reasons. It runs after each scan that has an anchor, including the start-up scan. It adds at most one file per kind per scan. It returns what it added, and `FoundSummary.broughtIn` accumulates the paths added during this server session (not persisted).

- [ ] **Step 1: Write the failing tests:**
  - Bringing in a voice file creates a lane named from the folder with that file as a variant, with the description from its reasons, and `picks.json` is unchanged (nothing picked).
  - Music and sfx go into their lanes. A cut becomes a new version on the anchor film.
  - The 13th file of one kind in a request fails with the cap message, and the first 12 go in.
  - A path outside the root (`../x.wav`), a symlink to outside the root and a missing file each fail with their reason, while the valid items in the same request still go in (Review Focus 2 and 4).
  - A file registered earlier under another spelling (case, relative vs absolute, composed vs decomposed Unicode, a U+202F name) is skipped as "Already in the project" and never doubled (Review Focus 3 and 5).
  - `adoptCurrentSet` adds the suggested file per kind, adds nothing when there's a tie, and a second call adds nothing new (idempotent).
  - `POST /api/found/bring-in` respects the identity guard, validates the body (more than 60 items gives 400) and returns the result shape.
  - `GET /api/state` shows `found.broughtIn`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Do the project change in one `store.update("project", …)` per request, so a request is atomic, and compute failures before the update.
- [ ] **Step 4: Run the gates.** Build, vitest, typecheck, and the e2e suite once. All green.
- [ ] **Step 5: Commit.** `feat(server): bring found files in as unpicked variants and cuts; adopt the current set when a cut is known`.

---

### Task 4: The agent surface (§20.7)

**Files:**
- Modify: `src/mcp/tools.ts`, `src/cli/main.ts`
- Modify: `AGENTS.md`, `skills/rushes/SKILL.md` (the short guidance only; the full docs are Task 6)
- Test: `test/mcp/tools.test.ts`, `test/cli/main.test.ts`

**Interfaces:**
- **Consumes:** the routes from Tasks 2 and 3.
- **`rushes_open`:**
  - Gains optional `film: string` and `include: { path: string; kind?: "voice"|"music"|"sfx"|"cut"|"doc"; round?: string }[]`.
  - Flow: ensure the server, then `POST /api/found/scan { film }` and wait for the first pass, then bring in any `include` items (these win over the scoring), then adopt the current set. It returns `{ url, broughtIn: BringInResult["added"], failed, found: FoundCounts }`.
  - Its description says what it does: "Starts Rushes if needed, brings in the current set of files that go with the cut, and opens it. Pass `include` for files you know belong."
- **`rushes_scan`:** `{ project?, film?, limit?: number (default 100, max 200) }` returns `{ files: FoundEntry[] }`, best score first, and the `FoundCounts`.
- **`rushes_bring_in`:** `{ project?, files: BringInItem[] , film? }` returns the `BringInResult`. It refuses paths outside the project with the same message the route gives.
- **CLI:**
  - `rushes scan [--film NAME] [--json]` prints the counts and the top candidates; `--json` prints the full result.
  - `rushes bring-in <file>… [--kind voice|music|sfx|cut|doc] [--round NAME]`.
  - `rushes open` also scans and adopts, and prints one line: `Brought in: …` and `Found, left for you: N files — open Assets › Found.`
- **Guidance** (AGENTS.md and SKILL.md, short): when asked to open or review work in Rushes, call `rushes_open`, then tell the user what it brought in and what it left. Pass `include` for files you made for this cut.

- [ ] **Step 1: Write the failing tests:**
  - **MCP:** the three tool descriptions and schemas; `rushes_open` returns `broughtIn` and `found` against a fake server or a real temp project; `include` wins over the scoring; `rushes_bring_in` reports outside-project failures.
  - **CLI:** `scan --json` parses; `bring-in` posts its items with `--kind` and `--round`; `open` prints the two lines.
  - **The docs test:** SKILL.md and AGENTS.md contain `rushes_open` guidance with `include`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the gates.** Build, vitest, typecheck. All green.
- [ ] **Step 5: Commit.** `feat(agent): rushes_open brings in the current set; rushes_scan and rushes_bring_in; scan and bring-in on the CLI`.

---

### Task 5: Assets › Found in the dashboard (§20.5)

**Files:**
- Create: `web/src/ui/Found.tsx`
- Modify: `web/src/types.ts`, `web/src/lib.ts`, `web/src/ui/Assets.tsx`, `web/src/ui/App.tsx` (the header chip), `web/src/useRushes.ts` (nothing new to subscribe to; `found` arrives in state; the list is fetched on demand), `web/src/styles.css`
- Test: `test/web/lib.test.ts`, `e2e/found.spec.ts`, `e2e/fixture.ts` (a helper that writes a generated media tree into the project folder)

**Interfaces:**
- **Consumes:** the server API from Tasks 2 and 3.
- **UI:** follow `.superpowers/sdd/<plan workspace>/approved-mockup.html`, the controller copies it in. The look matters:
  - **The Found folder** is first in the Assets sidebar, with its count, in the accent colour.
  - **The "Brought in with this cut" card:** its rows are what `state.found.broughtIn` lists, shown with their reasons (these are registered variants, so take the reasons from their `description`). It collapses.
  - **Groups** by folder, "Other cuts" last. Each group shows its count and can collapse.
  - **Rows:** checkbox, play button, file name (with a tooltip), a kind chip that cycles on click or opens a small menu (voice, music, sfx, other audio, cut, doc), the reasons line, a duration (mono) and a size.
  - **The bar:** a search box, kind filters with counts, a "Look again" icon button, **Not these** and **Bring in N** (disabled at 0).
  - **Footer line:** "Up to 12 files of each kind at a time, so the tabs stay quick. Each voiceover folder becomes its own round."
  - **While scanning:** a quiet "Looking through the folder…" line, and the list fills as results land.
  - **Hidden files:** a "Hidden (N)" link opens a list with a Restore button for each.
  - **Header chip:** "N brought in · M more found" (accent soft, with a dot). It shows only when `broughtIn.length + found count > 0` and the user hasn't opened Found since the last change. It opens Assets › Found.
- **Playing:** a found file plays through the same one-player bus as other inline audio, from `/media`. Video candidates have no play button (they're cuts to bring in).
- **After Bring in:** a toast like "Brought in 3 files" or, with failures, "Brought in 2 files. 1 couldn't be added: that file has gone." The rows leave the list.
- **Keyboard:** rows are reachable; Space on a focused checkbox ticks it; the play button is a real button.
- **State:** the list is fetched when Found opens and refetched on `change` while it's open.

- [ ] **Step 1: Write the failing tests:**
  - **Unit:** pure helpers in `lib.ts`: `groupFound(files)` (by folder, cuts last, stable order), `humanFolder("vo_jules")` gives "Vo Jules", `foundChip(summary)` returns the chip text or null.
  - **e2e** (both browsers), with a generated tree (invented names; make small WAVs with the existing `makeWav`, and tiny MP4s only where needed):
    1. A project with one cut and a `vo/`, `bed/` and `audition/` folder: Found is first in the sidebar with the right count; the groups and reasons show; the header chip shows.
    2. Tick two rows, press Bring in. The rows leave the list, the Voiceover and Music tabs unlock and show those reads, nothing is picked (`/api/picks` unchanged), and a toast reports it.
    3. **Not these** hides a file; **Hidden (1)** restores it.
    4. Change a row's kind, bring it in, and it lands in the right tab.
    5. Play: pressing play on a found row starts audio (`inspect` or the bus), and pressing play on another stops the first.
    6. Search and kind filters.
    7. The 13th ticked file of one kind: the toast reports the cap, and 12 are in.
    8. With the server's probe unavailable (no ffprobe), the list still shows, with durations "—".
    9. The page stays within 1440×900 with Found open (no horizontal scroll).
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the gates.** Build, vitest, typecheck, then the e2e suite in both projects 5×. All green.
- [ ] **Step 5: Screenshot and commit.** Save a 1440×900 screenshot of Assets › Found to the scratchpad path given in the dispatch. Commit `feat(web): Assets › Found lists the project's other files, with a header chip`.

---

### Task 6: Locked tabs, docs and the end-to-end check (§20.5, docs)

**Files:**
- Modify: `web/src/ui/App.tsx` (`Locked`), `web/src/lib.ts` (the line's wording)
- Modify: `README.md`, `AGENTS.md`, `skills/rushes/SKILL.md`
- Test: `e2e/found.spec.ts` (extended), `test/package.test.ts` (docs checks)

**Behaviour:**
- **Locked tabs.** When files of that tab's kind were found, the locked page adds one line under its prompt: "14 music files found in this project" with a **Review** button that opens Assets › Found filtered to that kind. Voiceover, Music and Sound effects only. Singular for one file: "1 music file found in this project".
- **Docs.**
  - README: a short "Finding your other files" section (what Rushes does on open, the current set, Assets › Found, Bring in, Not these), and the new commands `scan` and `bring-in`.
  - AGENTS.md: the open-and-review flow, `include`, `rushes_scan`, `rushes_bring_in`, and the 12-per-kind cap.
  - SKILL.md: the same essentials in brief.
  - Check every tool, flag and field against `src/mcp/tools.ts` and `src/cli/main.ts`.
  - No client names and no personal paths.
- **A realistic-size check.** Never copy real client files. Generate a tree in a temp folder that mirrors the shape of a busy project (a dozen audio folders, 130 small audio files, 20 renders as tiny MP4s, all with invented names). Run `rushes open` (no browser) against it. Check that the scan finishes in under 3 s, that the current set is sensible, and that the dashboard stays responsive. Paste the results in the report.

- [ ] **Step 1: Write the failing tests:**
  - e2e: a project with a cut and music files but no registered music: the locked Music page shows "N music files found in this project", and Review opens Found filtered to music; with none found the line is absent; singular wording for one.
  - Docs test: README, AGENTS and SKILL mention `rushes_scan`, `rushes_bring_in` and `include`, and contain no `/Users/`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the gates.** Build, vitest, typecheck, the e2e suite in both projects 5×, and `npm pack --dry-run` (the allow-list is unchanged). All green.
- [ ] **Step 5: Commit.** `feat(web): locked tabs say when matching files were found; docs for finding your files`.

The version bump and the release are decided by the controller at release time. This plan doesn't bump the version.
