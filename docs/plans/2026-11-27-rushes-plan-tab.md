# Plan tab for people (§38) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Brief, Storyboard and Script readable and markable for people: an At a glance brief with film briefs, a one-shot-at-a-time storyboard with box/pin notes, and a script with word diffs and versions.

**Architecture:** Server parses `brief.md` further (At a glance, project brief for later films) and keeps script snapshots in `.rushes/script-versions.json`. A new note stage `storyboard` rides the existing notes pipeline. The web pages reuse Visuals' drag-to-shape helpers and the desk's NotesPanel.

**Tech Stack:** TypeScript, Node server (`src/`), Preact (`web/src/`), zod, vitest, Playwright.

**Spec:** `docs/specs/2026-11-27-rushes-plan-tab.md`

## Global Constraints

- Approve is set only from the dashboard (never a tool or CLI).
- Every existing project loads unchanged: new data optional with defaults; a missing `script-versions.json` means no versions yet.
- `.rushes/script-versions.json`: `{ schema: 1, films: { "<film id>": [{ id, at, sections: [{ id, start, end, text }] }] } }`, max 50 versions per film, oldest dropped.
- Storyboard notes: `stage: "storyboard"`, `video` = film, `version: null`, `on: "shot/<n>"`, `shot: { n, name }`, `scope: "whole"`, optional `box` or `pin`, `still` = path drawn on.
- `wordDiff` falls back to one `del` + one `ins` past 2,000 words a side.
- At a glance lines: `- Label: value`; fallback = first sentence of the first five sections, never written to the file.
- Copy: plain English; labelled buttons Edit, Done, Show all, Overview, Use this line, Back to newest.

## Review Focus

- A brief.md with no `## At a glance` and sections that start with a list or code block: the fallback still yields readable sentences (test in Task 2).
- A later film whose `films/<id>/brief.md` is missing while the root brief is missing too: page says there is no brief, no crash (Task 3 e2e).
- A storyboard note whose shot was renumbered or removed: still listed, found by name or under "Shots no longer in the storyboard" (Task 5 unit).
- A shot whose still changed after a box was drawn: box not drawn, note marked "on the earlier still" (Task 6 e2e).
- The agent sets the script with identical words (only timing changed): no new version (Task 7 unit).

---

### Task 1: Word diff

**Files:** Modify `web/src/lib.ts`, `web/src/ui/Planning.tsx`, `web/src/styles.css`. Test `test/web/wordDiff.test.ts`.

**Interfaces — Produces:** `export type DiffRun = { kind: "same" | "del" | "ins"; text: string }`; `export function wordDiff(before: string, after: string): DiffRun[]`; `export function Diff({ before, after }: { before: string; after: string })`; `EditedMark` renders `<Diff>` per baseline (Baseline gains `after: string`).

- [ ] Tests: identical → one `same`; `"the cat sat"`→`"the dog sat"` gives `same "the "`, `del "cat"`, `ins "dog"`, `same " sat"`; empty before → one `ins`; 2,001-word input → exactly `[del, ins]`; whitespace preserved when runs joined (`same+ins` joined = after, `same+del` joined = before).
- [ ] Implement LCS over tokens `/\s+|\S+/g`, merge adjacent runs of a kind.
- [ ] `Diff` renders `<span class="dsame">`, `<del class="ddel">`, `<ins class="dins">`; tokens in styles for red/green in light and dark.
- [ ] Replace `<del>{b.text}</del>` in `EditedMark` with `<Diff before={b.text} after={b.after} />`; update Brief/Storyboard/Script callers to pass `after`.
- [ ] `npx vitest run test/web/wordDiff.test.ts` passes; `npm run typecheck` clean. Commit.

### Task 2: Brief core: At a glance and the project brief

**Files:** Modify `src/core/brief.ts`, `src/server/brief.ts`, server state for films (where `brief` is put on state per film), `web/src/types.ts`. Test `test/core/brief-glance.test.ts`, `test/server/brief-films.test.ts` (or the existing server brief test file).

**Interfaces — Produces:**
- `export interface GlanceItem { label: string | null; values: string[] }` and `export function parseGlance(body: string): GlanceItem[]` (labels grouped in first-seen order; non `- Label: value` lines are `label: null`).
- `export function glanceFallback(sections: { heading: string; body: string }[]): { heading: string; sentence: string }[]` (first five sections that are not At a glance, first sentence of the first prose line, list markers and Markdown emphasis stripped, max 200 chars).
- `BriefView` gains `glance: { from: "section" | "fallback"; items: GlanceItem[]; fallback: { heading: string; sentence: string }[]; index: number | null }`.
- Film state gains `projectBrief: BriefView | null` (the root brief, only for a film that is not the first) and `briefFile: string` (the film's brief path).

- [ ] Tests for `parseGlance` (repeat labels merge, plain bullet), `glanceFallback` (skips At a glance, list-first section, code fence ignored, 5 max), and the server: second film without its own brief gets `brief.exists=false` and `projectBrief.exists=true`.
- [ ] Implement; At a glance is matched case-insensitively on the heading.
- [ ] Tests pass, typecheck clean. Commit.

### Task 3: Brief page

**Files:** Modify `web/src/ui/Brief.tsx`, `web/src/ui/App.tsx` (props), `web/src/styles.css`; `skills/rushes/SKILL.md` (or the repo's skill path), `AGENTS.md`, `README.md` if it shows the brief format; `e2e/planning.spec.ts`.

**Interfaces — Consumes:** Task 2 view fields, Task 1 `Diff`, `safeMarkdownHtml`.

- [ ] Page order: film strip ("Builds on the project brief" + Show/Hide, read-only glance card) or no-own-brief notice (copy prompt naming `films/<id>/brief.md`, project brief read-only, no Approve); At a glance card (label grid; fallback marked "From the sections" + "Ask your agent for an At a glance summary" copy button); contents chips scrolling to sections; section cards: heading, rendered body, Edit/Done, Show all over ~12 lines, Edited by you with Diff + Revert; Approve at foot as now.
- [ ] Editing At a glance uses the same section save path.
- [ ] E2E: glance card from section; fallback; Edit → type → Done saves and shows diff; second film without brief shows notice + project brief and no Approve; second film with brief shows strip and Show reveals the project glance.
- [ ] Skill/AGENTS: brief.md starts with `## At a glance` (`- Ask:`, `- Length:`, `- Audience:`, `- Deliver:`, `- Must:`, `- Never:`); a new film started in chat gets `films/<id>/brief.md` first, holding only what differs.
- [ ] Run planning e2e (chromium + webkit), unit, typecheck. Commit.

### Task 4: Storyboard carousel and overview

**Files:** Rewrite `web/src/ui/Storyboard.tsx`; `web/src/styles.css`; `e2e/storyboard.spec.ts`.

**Interfaces — Produces:** `Storyboard` props add `current: number` + `onCurrent(i)` lifted to App (so the notes panel knows the shot), and `onShape?(shape: Shape | null)` (filled in Task 6). Overview flag stored in localStorage key `rushes:sb-overview:<projectId>` (try/catch).

- [ ] Frame (still fitted, kept ratio, empty frame message), head line (`03 · NAME`, tag, length, status), nav (Previous, `03 / 09`, Overview, Next), thumbnail strip with open-note badges, arrow keys when no field focused; below: description rendered with Edit/Done, Direction input, EditedMark with Diff, approve tick; Overview grid with planned-length bar at head, click opens shot.
- [ ] Update existing storyboard e2e to the new layout; add: arrows move shots, Overview opens and a click returns to frame, approve tick still writes `Status: approved`.
- [ ] e2e both browsers, typecheck. Commit.

### Task 5: The `storyboard` note stage

**Files:** `src/core/schema.ts` (STAGES, NoteSchema `still`, pin allowed on storyboard, storyboard must be scope whole), `src/core/notes.ts` (label "Shot 03 · Offline", region/point), `src/core/batches.ts`, `src/core/exportNotes.ts`, `src/core/logText.ts`, `src/core/logEvents.ts`, `src/core/tabs.ts`, `src/core/films.ts`, `src/server/app.ts` (POST /api/notes validation), `src/mcp/tools.ts` descriptions, web `tabNotes.ts`, `changelog.ts`, `desk.ts`, `lib.ts` where stages are listed. Tests in `test/core/` alongside the visuals equivalents.

**Interfaces — Produces:** `export function shotOfNote(shots: { n: number; name: string }[], note: Pick<Note, "on" | "shot">): number | null` (index into shots: same n+name, else unique name, else null) in `src/core/storyboard.ts`; label helper `storyboardNoteLabel(note)`.

- [ ] Tests: schema accepts a storyboard note with pin and with box, refuses scope point; label "Shot 03 · Offline · region"; batch prompt line names the still path; export lists it; `shotOfNote` renumbered/renamed/removed cases.
- [ ] Implement, following each place `"visuals"` is handled for a parallel case.
- [ ] Full unit suite passes, typecheck clean. Commit.

### Task 6: Drawing and notes on the storyboard

**Files:** `web/src/ui/Storyboard.tsx`, `web/src/ui/App.tsx` (planPanel per page), `web/src/visuals.ts` (reuse `shapeFromDrag`), `e2e/storyboard.spec.ts`.

- [ ] Drag on the still = box, click = pin (via `shapeFromDrag`), Escape clears; draft shape drawn; saved notes' marks drawn when `note.still === shot.still`.
- [ ] App: on Storyboard the panel lists the film's storyboard notes (current shot first, others faded), target label `Shot 03 · Offline` (+ `· region`/`· point`), onAdd posts the storyboard note; clicking a note of another shot moves the carousel. Brief panel text: "Notes on the plan are written on the Script or Storyboard page."
- [ ] Orphaned notes listed under "Shots no longer in the storyboard"; notes on a changed still show "on the earlier still".
- [ ] E2E: draw box, write note, it appears numbered on the still and in the panel; Send includes it (batch has it); change the still file → box not drawn.
- [ ] e2e both browsers. Commit.

### Task 7: Script versions core

**Files:** Create `src/core/scriptVersions.ts`; modify `src/core/store.ts` (file), the server script service where `setSections` is called for the agent (MCP/CLI/API agent path), `src/mcp/tools.ts` (`rushes_get_script` returns `version`), state for the web (`scriptVersions: { id, at }[]` and the selected film's full versions via `GET /api/script/versions?video=`). Tests `test/core/scriptVersions.test.ts`, server test.

**Interfaces — Produces:** `export interface ScriptVersion { id: string; at: string; sections: { id: string; start: number; end: number; text: string }[] }`; `export function nextVersion(list: ScriptVersion[], sections: Section[], at: string): ScriptVersion[]` (appends only when some line's words differ from the last, keeps 50); `snapshotOf(sections)`.

- [ ] Tests: first snapshot = v1; same words new timings → unchanged list; changed word → v2; 51st drops oldest but ids keep counting (`v51`).
- [ ] Record on every agent write of a film's script and on first view when a film has sections and no versions. Dashboard edits never record.
- [ ] Unit + typecheck. Commit.

### Task 8: Script page: diff, pill, looking back

**Files:** `web/src/ui/Script.tsx`, `web/src/styles.css`, `e2e/planning.spec.ts` (script cases).

- [ ] Rows use EditedMark with Diff (Task 1). Head: `Script v3` pill + menu (newest first, time, "newest"); older version view: read-only rows with Diff older→newest, *removed since*, *new in vN*, banner + Back to newest, **Use this line** patches `proposed` on the newest line by id (disabled with reason when gone).
- [ ] E2E: set script twice via API → pill shows v2; open v1, Use this line → newest row shows Edited by you with that wording.
- [ ] e2e both browsers. Commit.

### Task 9: Finish

- [ ] Spec gets a "38.10 As built" section with any deviations; CHANGELOG/README lines if the repo keeps them.
- [ ] Full: `npm run typecheck`, `npx vitest run`, `npm run test:e2e` (both browsers). Fix failures.
- [ ] Run a copy of the Cloud Engines shorts project on a spare port and look at Brief, Storyboard (always-running), Script on a project with a script.
