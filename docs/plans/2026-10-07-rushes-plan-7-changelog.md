# Rushes Plan 7: Short Version Labels and the Change Log — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every cut gets a short label and Picture's wall-of-text dropdown becomes a one-line-per-version list; Rushes writes a Change Log as things happen, which agents read and write and people open from a drawer in the header.

**Architecture:**
- **Labels first, as their own shippable increment (Tasks 1–2).** A new, import-free `src/core/labels.ts` holds `shortLabel` (§22.4) and the one-line clipping the log reuses. `Version.label` is additive. The dashboard imports `labels.ts` at runtime through a new `web/src/versions.ts`, and a new `web/src/ui/VersionMenu.tsx` replaces the native `<select>`.
- **The log's engine (Task 3)** is pure and lives in new files:
  - `src/core/logText.ts`: import-free apart from `labels.ts`; areas, words, dates and the Markdown.
  - `src/core/logEvents.ts`: one builder per thing Rushes logs.
  - `src/core/log.ts`: appending with collapsing, the 5000 cap, the backfill and reading a page back.
  The file is `.rushes/log.json`, a new `FILES` key created on its first write.
- **The server (Task 4).** A new `src/server/logbook.ts` (`LogBook`, one per store) owns backfill, corrupt handling and a stat-keyed cache. Every write route in `app.ts` gains one `log.add(...)` line after its write. `GET`/`POST /api/log`, `POST /api/exports/change-log`, a `log` head in `GET /api/state`, the Recent changes block in the batch prompt, the found scanner's adoption line, and doctor.
- **Agents (Task 5).** `rushes_log`, `rushes_get_log`, `rushes log` and `rushes log add`, and the docs.
- **The drawer (Task 6).** New `web/src/changelog.ts` (pure) and `web/src/ui/ChangeLog.tsx` (button, drawer, `useChangeLog`). Styles for Tasks 2 and 6 live in a new `web/src/changes.css`, so `styles.css` is untouched.
- **Docs, the realistic check and CI (Task 7).**

**Tech Stack:** TypeScript (ESM, NodeNext; the dashboard on Bundler), Hono, zod 4, Preact 10, Vite 8, vitest, Playwright (Chromium and WebKit).

**Spec:** `docs/specs/2026-10-07-rushes-changelog.md` (§22, binding) and the approved mockup `docs/specs/2026-10-07-rushes-changelog-mockup.html` (the UI must match it). It extends `docs/specs/2026-10-02-rushes-design.md`:
- §5: notes and field ownership.
- §14.2: films and the hold logic around the version control.
- §16.1: the Assets folders.
- §19.4: Safari.
- §19.8: Space on buttons.
- §20: the found scanner's current set.

## Global Constraints

- **Dependencies:** runtime dependencies stay exactly four: `@hono/node-server`, `@modelcontextprotocol/sdk`, `hono` and `zod`.
- **Language:** UK English in all copy, docs and comments.
- **Type:** 15 px or larger everywhere, including the area tags, the times and the "N new" pill.
- **Accessibility:** every control has an accessible name and works from the keyboard.
- **Privacy:** no client names and no personal paths anywhere in the repo or tests. Use invented names only ("Lumen launch film", "Hero", "Teaser", "Night drive"), and generate media into temp folders.
- **Tests:** tests use `RUSHES_NO_REVEAL=1` (`vitest.config.ts` and `e2e/fixture.ts` already set it) and never open apps.
- **Schemas are additive only:** every new zod field is optional or has a default, so every 0.2.x file loads unchanged.
- **Commits:** use `git -c user.name=iamredmh -c user.email=17407420+iamredmh@users.noreply.github.com commit`. Every message ends with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never change git config.
- **`rushes setup`:** never run it against the real home without `--dry-run`.
- **Ports:** never use 4410, 4430–4434 or 8765. Tests use port 0.
- **No version bump:** `package.json`, `VERSION` in `src/server/app.ts`, `.claude-plugin/plugin.json` and `package-lock.json` stay at 0.2.2.
- **e2e runs in Chromium and WebKit.** Run it locally only when the machine is quiet: load average below `sysctl -n hw.ncpu`, and `pgrep -fl 'playwright|ffmpeg'` prints nothing. CI on the pushed branch is the final word.
- **Setup:** the worktree needs `npm ci` first.
- **Rendering (Safari):** grids use explicit tracks (`minmax(0,1fr)`), and there's no per-frame React state.
- **Parallel work (Plan 6, formats):** new logic goes in new files. Edits to shared files stay small and additive, at the regions listed under "Overlap with Plan 6". Nothing here depends on Plan 6 or uses its names.
- **The gate for every task:** `npm run build && npm run typecheck && npx vitest run`, then the e2e suite in both projects where the task touches the dashboard.

## Rulings (where the real code left the spec open)

- **R1: `notes` is an area.** §22.3's area list has no `notes`, but §22.5's table logs "Notes are sent" and "The agent replies" under it, and the mockup's chips and tags use it. `LOG_AREAS` is `script, picture, voice, music, sfx, mix, notes, assets, project`.
- **R2: the stored label has no length limit.** §22.3 writes `label: max(48)`, but §22.9 says a hand-edited longer one is *shown* cut at 48. A `max(48)` in `VersionSchema` would make that file fail to load, and fail every later write. So:
  - the schema stores `label: z.string().default("")`;
  - the limit is enforced where labels come in: `POST /api/versions`, `rushes_add_version` and `rushes add version --label`, with the message "label is 48 characters at most: put the detail in note";
  - `shortLabel` clips anything longer.
- **R3: extra additive log fields.**
  - `LogEntry` gains `tab` (the tab a Notes line opens), `n` (how many events the line stands for) and `subject` (what a run of them is about), all defaulted.
  - `LogFile` gains `backfilled` (§22.6's marker), `undated` (see R5) and `dropped` (how many the cap removed, for §22.9's "Earlier entries were removed").
- **R4: how collapsing works.** An event merges into the **newest entry with the same kind, area and writer** whose time is within the window (2 minutes; picks 10 minutes). It doesn't have to be the very last line, so interleaved music and sound-effects registrations collapse into two lines, not ten. The merged entry moves to the top. Each kind merges one way:
  - **count** (`cut`, `variant`, `take`, `files`, `notes-sent`): the counts add up and the line is rewritten ("Music: 3 variants added to night-drive"). The subject (lane, section, film, folder, tab) stays if it's the same, and drops out if not.
  - **replace** (`lock`, `script`, `picks`): the newest line wins, for the same subject only, so a lock on another film is its own line.
  - **once** (`replies`, `entry`): never merged, except that an identical line from the same writer within the window isn't doubled (§22.9, a retried request). This keeps "one entry per reply call" (§22.5).
- **R5: "Before the log".** The *identity* of what was already there is recorded once, at backfill, as `undated` refs (`"<lane>/<variant>"`, `"<section>:<take>"`). The *lines* are computed when read (§22.6), from the refs that still exist. A live event about a ref (its `ref`, or a bring-in's `clears`) removes it from `undated`. That way a variant is never both dated and undated, whatever order the first write and the backfill happen in.
- **R6: when the backfill happens.**
  - It happens on the first read or write of the log: `GET /api/log`, `rushes_get_log` or any `LogBook.add`. It reads in only items dated before the moment this server's `LogBook` was made (`since`), so nothing logged live is read in twice.
  - The header's dot reads the log's head without backfilling, so opening a project never writes to it until the log is read or written.
  - Batches are dated by `sentAt` (§22.6 says `createdAt`; the real field is `sentAt`).
  - Items whose dates don't parse are skipped.
- **R7: a corrupt `log.json`.**
  - It is moved to `log.json.bad` (replacing an older `.bad`), and a fresh log starts with `backfilled: true`. It "reads as empty" (§22.9), so there's no second backfill.
  - Only the log's own read or write fixes it. The state's head just reports `null`.
  - The dashboard's existing corrupt banner clears on the next write.
  - `rushes doctor` reports `log.json.bad` as a non-required ✗. A corrupt `log.json` is non-required too: the log is never a reason for doctor to fail.
- **R8: who caused an event.**
  - `user`: requests carrying `x-rushes-project` (only the dashboard sends it, `web/src/api.ts`).
  - `agent`: everything else (MCP, the CLI, curl), including `rushes log add` typed by a person.
  - `rushes`: the found scanner's automatic current set, and the backfill.
- **R9: the words of each line.** These are fixed in Task 3's tests:
  - names in curly quotes (“Night drive”);
  - the film's name before the version when a project has more than one film ("Teaser v2 added: …");
  - a take names its section id and the opening of its line ("Voiceover: take 2 added to S1 “Every launch starts with a…”");
  - "to <lane>" is left out for a stage's default lane ("Music", "Voiceover", "Sound effects");
  - a bring-in, by hand or by the current set, is "Brought in N files [with v6]" (area `assets`, kind `files`).
- **R10: not logged.** Beyond §22.5's list, these aren't logged:
  - `PATCH /api/script/:id` (the user's proposed lines are their notes on the script; they reach the log when sent);
  - shots, settings and proxies;
  - a picks change that only moves levels;
  - a lock request that changes nothing.
- **R11: the prompt.** `shortLabel` reaches the Send-to-agent prompt through the Recent changes block: cut lines are built from it. `buildPrompt` and `createBatch` are unchanged. The `POST /api/batches` route appends the block, built from the log *before* the send is logged. An empty log adds no block.
- **R12: the version list and the drawer don't close each other** (the mockup's demo script does that, but the drawer is non-modal and keeps its open state per session). The list layers above the drawer.
- **R13: Esc closes the drawer** when the key comes from inside it, from its button, or from the page body. Anywhere else (the note box, a field) Esc keeps its own meaning.
- **R14: rows that go somewhere are buttons.** Rows with nowhere to go are plain text, so Tab doesn't stop on 5000 lines. A line somebody wrote (`kind: "entry"`) goes somewhere only when it carries `video`, `version` or `ref`.
- **R15: a line added in the drawer** is about the tab on screen (Assets is `assets`), `by: "user"`, with no link.
- **R16: how much the drawer loads.** It shows the newest 1000 matching lines, and the footer says so when there are more. **Export as Markdown** and `rushes log --md` include them all. `GET /api/log` takes `limit` 1–5000 (default 30); `rushes_get_log` caps it at 200, as §22.7 says.
- **R17: the export file** is `exports/change-log-YYYY-MM-DD.md` (no project slug, as §22.7 writes it). It's written by **Export notes** (`POST /api/exports/notes` also returns `changeLog`) and by the drawer's button (`POST /api/exports/change-log`). A same-day export replaces it.
- **R18: jumps.**
  - A row's jump keeps the drawer open on a wide window and closes it under 560 px.
  - A cut or linked line opens Picture on that film and version. If the version has gone, it opens the film; if the film has gone, it opens Picture.
  - A variant opens its tab and focuses its lane row (`.lane[data-row="<lane>/<variant>"]`, the key `web/src/lib.ts:478` builds).
  - A Notes line opens the tab it came from (`tab`).
- **R19: the dot** compares the newest line's `id@at` (`LogHead.mark`) with the last one seen (kept in `localStorage`), so a line updated in place counts as news.
- **R20: touch.** On a screen with `(hover: none)`, the first tap on a row shows its note under it and a second tap picks it.
- **R21: `POST /api/log`.**
  - `text` is made one line and cut to 160 characters.
  - Blank text, or input over 2000 characters, is a 400.
  - `video` is resolved by id, slug or name (404 when unknown), and `version` must exist on it (404). A `version` without `video` is a 400.
  - `ref` is kept as given, up to 300 characters.
- **R22: "how long ago".** The words are "just now", "N min ago", "N h ago", "yesterday", "N days ago" (under a week), then "5 Oct" (with the year when it isn't this one).
- **R23: the note under the picture** sits under the timeline's time row in Picture's player column. **More** shows only when the text is actually clamped.
- **R24: the version control's accessible name** is "Version: v6 · launch 1.45x slower". Its options carry `data-version`, which the e2e helpers use.

## Review Focus

1. **Two first reads at once.** The dashboard's first `GET /api/log`, an agent's `rushes_get_log` and a registration can land together on a project from 0.2.2. The backfill happens exactly once, and nothing is listed twice. *(Task 4: `two first reads at once backfill once`.)*
2. **Text that isn't one clean line.** Newlines, tabs and control characters from an agent, 2000 characters, an emoji exactly at the cut, or only spaces. It's stored as one line of at most 160 code points, never splits a surrogate pair, and blank is refused. *(Task 3: `logText` and `appendEvent` units; Task 4: the `POST /api/log` route test.)*
3. **Bursts that mix things.** Interleaved music and sound-effects registrations, a retried request with the same body, two films' cuts, a lock on one film and then another. Each kind collapses, unlike things never merge, and the merged line moves to the top in time order. *(Task 3: the `appendEvent` units; Task 4: the interleaved route test.)*
4. **Lines that point at things that have gone.** A film, version or lane can be deleted by hand after it was logged. The row still shows, and its jump goes as far as it can or nowhere. Undated refs that no longer exist aren't listed. Nothing throws. *(Task 3: `undatedLines`; Task 6: `jumpOf` units.)*
5. **A long-lived project near the cap.** With 5000 entries, the next append drops one and counts it, the request still answers within 1.5 s, and the drawer renders the newest 1000 with the footer saying so. *(Task 4: the cap test; Task 6: the `footText` unit; Task 7: the measured check.)*

---

## File structure

| Area | Files |
|---|---|
| Labels | new `src/core/labels.ts`, new `web/src/versions.ts`; `src/core/schema.ts` (`Version.label`), `src/core/project.ts` (`AddVersionInput.label`), `src/server/app.ts` (`VersionBody.label`), `src/mcp/tools.ts` and `src/cli/main.ts` (`label`), `web/src/ui/AssetViews.tsx` (`cutLabel`) |
| Version list | new `web/src/ui/VersionMenu.tsx` (`VersionMenu`, `VersionNote`), new `web/src/changes.css`; `web/src/ui/App.tsx` (the select), `web/src/ui/Picture.tsx` (one line), `web/src/main.tsx` (one import) |
| Log engine | new `src/core/logText.ts`, new `src/core/logEvents.ts`, new `src/core/log.ts`; `src/core/schema.ts` (`LogEntrySchema`, `LogFileSchema`, `FILES.log`), `src/core/store.ts` (default, created on write) |
| Log server | new `src/server/logbook.ts`; `src/server/app.ts` (routes and hooks), `src/server/found.ts` (adoption line), `src/cli/doctor.ts` |
| Agent | `src/mcp/tools.ts`, `src/cli/main.ts`, `AGENTS.md`, `skills/rushes/SKILL.md` |
| Drawer | new `web/src/changelog.ts`, new `web/src/ui/ChangeLog.tsx`; `web/src/ui/App.tsx`, `web/src/types.ts`, `web/src/changes.css` |
| Tests | new `test/core/labels.test.ts`, `test/core/logText.test.ts`, `test/core/log.test.ts`, `test/server/version-label.test.ts`, `test/server/log.test.ts`, `test/mcp/changelog.test.ts`, `test/cli/log.test.ts`, `test/web/versions.test.ts`, `test/web/changelog.test.ts`, `test/web/changes-css.test.ts`, `test/docs-changelog.test.ts`, `e2e/versions.spec.ts`, `e2e/changelog.spec.ts`; edits to `e2e/fixture.ts`, `e2e/dashboard.spec.ts`, `test/cli/doctor.test.ts`, `test/mcp/tools.test.ts`, `test/package.test.ts`, `test/web/lib.test.ts`, `test/server/files.test.ts` |
| Docs | `README.md`, `AGENTS.md`, `skills/rushes/SKILL.md` |

## Overlap with Plan 6

Plan 6 (branch `formats`, mid-build) edits several of the same files. Whichever lands second rebases on these regions. Line numbers are main at 94cfcd9.

| File | What this plan touches | What Plan 6 touches nearby | Rebase note |
|---|---|---|---|
| `src/core/schema.ts` | One import under `import { z } from "zod";` (line 1). `label` after `note` in `VersionSchema` (line 39). A new block after `FoundFileSchema` (after line 283). `log` in `FILES` (285–292) and `FileData` (294–301) | Its own import at the same spot. Rewrites `VersionSchema` (33–43) into `z.object({…}).superRefine(…)` | Keep both imports. Put `label: z.string().default("")` after `note` inside Plan 6's object |
| `src/core/project.ts` | `label?: string` in `AddVersionInput` (after line 42). `label: input.label?.trim() ?? ""` after `note:` in `addVersion`'s literal (line 67) | `width`/`height` in the same interface. `width…formats` after `proxy: null` (line 69) | Different lines: keep both |
| `src/server/app.ts` | Imports (after line 27). `VersionBody` (line 85). `const log`/`by`/`exportChangeLog` after line 240. Hooks in the files (493), exports (511–514), state (533–545), scan-include (572), bring-in (611–614), replies (662–663), versions (`label` at 676; `films` and the log line around 678–681), lock (806–810), variants (814–815), script (825–827), takes (840–841), picks (847–868) and batches (885–890) routes. New `/api/log` routes before line 907 | `VersionBody.formats`. Rewrites the versions route's head and its two `return`s. `/api/formats`. Notes routes and the frame route | In the versions route, keep Plan 6's body. Add `label: b.label` to its `addVersion({...})` call, `films = p.videos.length;` after `autoProxy = p.autoProxy;`, and the `log.add(cutEvent(...))` line straight after the `store.update` block. §21's "format added" line is a later hook in `/api/formats` (R9; needs `"format"` added to `LOG_KINDS`) |
| `src/mcp/tools.ts` | `label` in `rushes_add_version`'s schema and description. `rushes_export_notes`' description. Two new tools after `rushes_export_notes` | `formats` in `rushes_add_version`. `rushes_add_format` after it. `format` and `onlyThisFormat` in `rushes_list_notes` | Keep both fields. The new tools sit apart |
| `src/cli/main.ts` | HELP (line 49 and after line 63). `OPTIONS` gets `label`, `limit`, `area` and `md`. `label: o.label` in `add version` (line 322). A new `case "log"` before `default:` | `OPTIONS.label` too. `add format`. A notes column | **Both add `label: { type: "string" }`**: keep one. `--label` means the cut's label on `add version` and the ratio hint on `add format` |
| `web/src/ui/App.tsx` | Imports (2–13). The hook after line 112. `jump` after `toggleLock` (199). Lines 362–380 (the `<select>`) become `<VersionMenu>`. `<ChangeLogButton>` after the shortcuts button (403). `<ChangeLogDrawer>` after `</header>` (413) | `FormatToggle` after the `readyVersionId` chip (397). State after `cutAsset` (143). The keydown handler. `<Picture>` props | Separate regions |
| `web/src/ui/Picture.tsx` | One import. `<VersionNote version={version} />` after the `.ends` row (548) | Many regions (frame, messages, selection) | One line |
| `web/src/ui/AssetViews.tsx` | One import. `cutLabel`'s `subtitle` (162) | Cuts sub-rows | One line |
| `web/src/types.ts` | Three `export type` lines. `log?: LogHead \| null` in `State` | `export type Format` | Keep both |
| `e2e/fixture.ts` | `type Locator` import. `versionButton` and `pickVersion` at the end | Format helpers inside the `rushes` fixture | Keep both |
| `e2e/dashboard.spec.ts` and any Plan 6 e2e spec | 24 `getByRole("combobox", { name: "Version" })` uses become `versionButton`/`pickVersion` (Task 2 Step 9) | `e2e/formats.spec.ts` may use the old combobox | If Plan 6 lands first, run Task 2 Step 9's `perl` over `e2e/formats.spec.ts` too |
| Test literals | `label: ""` at `test/web/lib.test.ts:174`, `:182` and `:338`, and `test/server/files.test.ts:353` | `width`, `height` and `formats` on the same literals | Keep every field |
| Tool counts | "nineteen" becomes "twenty-one" (`test/mcp/tools.test.ts:46`, `test/package.test.ts:82`, README, AGENTS and SKILL) | "twenty" | **Whichever lands second makes it "twenty-two"** and lists all three new tools |

`src/core/batches.ts`, `src/core/exportNotes.ts`, `src/server/start.ts`, `web/src/lib.ts` and `web/src/styles.css` are **not** touched by this plan.

---

### Task 1: Short labels (§22.3 `label`, §22.4)

**Files:**
- Create: `src/core/labels.ts`, `web/src/versions.ts`
- Modify: `src/core/schema.ts:39` (`VersionSchema.label`), `src/core/project.ts:37-45,61-70` (`AddVersionInput.label`, `addVersion`), `src/server/app.ts:85,676` (`VersionBody.label`, the `addVersion` call), `src/mcp/tools.ts:191-205` (`rushes_add_version`), `src/cli/main.ts:49,69-93,322` (`--label`), `web/src/ui/AssetViews.tsx:7,162` (`cutLabel`), `AGENTS.md`, `skills/rushes/SKILL.md`
- Modify (test literals gain `label: ""`): `test/web/lib.test.ts:174,182,338`, `test/server/files.test.ts:353`
- Create tests: `test/core/labels.test.ts`, `test/server/version-label.test.ts`, `test/mcp/changelog.test.ts`, `test/cli/log.test.ts`, `test/web/versions.test.ts`, `test/docs-changelog.test.ts`, `e2e/versions.spec.ts`

**Interfaces:**
- Consumes: `VersionSchema`, `addVersion`, `AddVersionInput` (`src/core/project.ts`), `VersionBody` (`src/server/app.ts`), `cutLabel` (`web/src/ui/AssetViews.tsx`).
- Produces (`src/core/labels.ts`, no imports at all):

```ts
export const LABEL_MAX = 48;
export interface Labelled { id: string; note: string; file: string; label?: string }
export function oneLineOf(text: string): string;              // control characters and whitespace runs → one space, trimmed
export function clip(text: string, max: number): string;      // ≤ max code points, cut at a word boundary, "…"
export function oneLine(text: string, max: number): string;   // clip(oneLineOf(text), max)
export function shortLabel(v: Labelled): string;              // §22.4
```

- Produces (`web/src/versions.ts`): `export { shortLabel, LABEL_MAX, type Labelled } from "../../src/core/labels.js"` and `export function cutSubtitle(v: Labelled | undefined): string | null`.
- Produces (schema): `Version.label: string` (default `""`, no maximum, R2). `AddVersionInput.label?: string`. `POST /api/versions` accepts `label?: string` (trimmed, ≤ 48, refused with "label is 48 characters at most: put the detail in note").

- [ ] **Step 0: Install and take a baseline.** Run `cd ~/Developer/rushes-changelog && npm ci && npm run build && npx vitest run`. Expected: every test passes.

- [ ] **Step 1: Write the failing core tests** at `test/core/labels.test.ts`:

```ts
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { LABEL_MAX, clip, oneLine, oneLineOf, shortLabel } from "../../src/core/labels.js";
import { addVersion } from "../../src/core/project.js";
import { ProjectSchema, type Project } from "../../src/core/schema.js";

const v = (id: string, note: string, extra: { label?: string; file?: string } = {}) => ({
  id, note, file: extra.file ?? "renders/lumen_v6.mp4", ...(extra.label !== undefined ? { label: extra.label } : {}),
});

describe("shortLabel (§22.4)", () => {
  it("uses the agent's label when there is one, and the note when it's blank", () => {
    expect(shortLabel(v("v6", "v6: anything", { label: "Launch slower" }))).toBe("Launch slower");
    expect(shortLabel(v("v6", "v6: launch 1.45x slower; more", { label: "   " }))).toBe("launch 1.45x slower");
  });

  it.each([
    ["v6", "v6: launch 1.45x slower; each zoomed request types itself out; crowd on a wider oval", "launch 1.45x slower"],
    ["v3", "v3 (batch b_1): zoom in on each of the first four requests and back out (New York, London, Lagos, Cape Town during the outage); crowd starts 1, 2, 3, 4", "zoom in on each of the first four requests and…"],
    ["v1", "Picture v1, silent. Night globe on demo nodes (Frankfurt, Mumbai)", "Picture v1, silent"],
    ["v2", "v2, new narrative (notes): centred button, then pull back off the globe", "new narrative"],
    ["v4", "v4 (batch b_2): softer zooms (0.95 s, eased in and out)", "softer zooms"],
    ["v6", "V6 — Slower launch, held logo", "Slower launch, held logo"],
    ["v7", "line one\nline two; the rest", "line one line two"],
  ])("%s: %j becomes %j", (id, note, label) => expect(shortLabel(v(id, note))).toBe(label));

  it("only ends a clause after its first 12 characters", () => {
    expect(shortLabel(v("v1", "v1: ok; then the long part"))).toBe("ok; then the long part");
  });

  it("never strips a version id that isn't this cut's (§22.9)", () => {
    expect(shortLabel(v("v61", "v6: not this cut"))).toBe("v6: not this cut");
    expect(shortLabel(v("v2", "v5: copied from the old cut"))).toBe("v5: copied from the old cut");
  });

  it("falls back to the file's name without its extension: no note, punctuation only, or only the id (§22.9)", () => {
    expect(shortLabel(v("v6", ""))).toBe("lumen_v6");
    expect(shortLabel(v("v6", "…;;; — --"))).toBe("lumen_v6");
    expect(shortLabel(v("v6", "v6"))).toBe("lumen_v6");
    expect(shortLabel(v("v1", "", { file: "renders/harbour_launch_reel_v20J_final_master_export_4k_graded_prores.mov" }))).toBe("harbour_launch_reel_v20J_final_master_export…");
    expect(shortLabel(v("final", "", { file: "" }))).toBe("final");
  });

  it("is never over 48 characters and never splits an emoji, whatever it's given (Review Focus 2)", () => {
    for (const note of ["word ".repeat(30), "a".repeat(200), `${"a".repeat(46)}🎬🎬🎬`, `v9: ${"tiny ".repeat(20)}`]) {
      const label = shortLabel(v("v9", note));
      expect(Array.from(label).length).toBeLessThanOrEqual(LABEL_MAX);
      expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    }
    expect(shortLabel(v("v1", `${"a".repeat(46)}🎬🎬🎬`))).toBe(`${"a".repeat(46)}🎬…`);
  });

  it("shows a hand-edited label over 48 cut at a word with an ellipsis (§22.9)", () => {
    expect(shortLabel(v("v1", "", { label: "A label somebody typed by hand that runs on far past the limit of the list" }))).toBe(
      "A label somebody typed by hand that runs on far…",
    );
  });
});

describe("clip and oneLine", () => {
  it("cuts at the last space that leaves room for the ellipsis, else at _ - /, else inside the one word", () => {
    expect(clip("short", 48)).toBe("short");
    expect(clip("Every launch starts with a single request.", 32)).toBe("Every launch starts with a…");
    expect(clip("harbour_launch_reel_v20J_final_master_export_4k", 30)).toBe("harbour_launch_reel_v20J…");
    expect(clip("a".repeat(60), 48)).toBe(`${"a".repeat(47)}…`);
  });

  it("turns control characters, tabs and newlines into single spaces", () => {
    expect(oneLineOf("  a\n\tb\u0007 c  ")).toBe("a b c");
    expect(Array.from(oneLine("x ".repeat(200), 160)).length).toBeLessThanOrEqual(160);
  });
});

describe("Version.label (§22.3, R2)", () => {
  it("a 0.2.2 project.json loads with every label empty, and a hand-edited long one still loads", () => {
    const p = ProjectSchema.parse({
      schema: 1, rev: 3, name: "Lumen launch film",
      videos: [{ id: "lumen", name: "Lumen", versions: [
        { id: "v1", file: "a.mp4", addedAt: "2026-10-05T09:00:00Z", note: "first" },
        { id: "v2", file: "b.mp4", addedAt: "2026-10-06T09:00:00Z", label: "x".repeat(80) },
      ] }],
    });
    expect(p.videos[0].versions[0].label).toBe("");
    expect(p.videos[0].versions[1].label).toHaveLength(80);
  });

  it("addVersion stores the label trimmed, and empty when there's none", () => {
    const p: Project = { schema: 1, rev: 0, name: "demo", fps: 30, videos: [], lanes: [], files: [], autoProxy: false };
    expect(addVersion(p, { video: "Hero", file: "a.mp4", label: "  Launch slower " }).version.label).toBe("Launch slower");
    expect(addVersion(p, { video: "Hero", file: "b.mp4" }).version.label).toBe("");
  });
});

// What would pull zod or Node into the web bundle: an import, a re-export from a module, a dynamic import, require.
const pullsInAModule = (js: string): boolean =>
  /^\s*import\b/m.test(js) || /^\s*export\s*(\*|\{[^}]*\})\s*from\b/m.test(js) || /\bimport\s*\(/.test(js) || /\brequire\s*\(/.test(js);

it("labels.ts compiles to JavaScript with no import at all, so the dashboard bundles it without zod or Node", () => {
  const text = readFileSync(new URL("../../src/core/labels.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, removeComments: true } }).outputText;
  expect(js).toContain("export function shortLabel");
  expect(pullsInAModule(js)).toBe(false);
  // Safari before 16.4 can't parse a lookbehind, and this file runs in the dashboard.
  expect(text).not.toMatch(/\(\?<[=!]/);
});
```

- [ ] **Step 2: Run them and see them fail.** Run: `npx vitest run test/core/labels.test.ts`. Expected: FAIL, because `src/core/labels.ts` is missing.

- [ ] **Step 3: Write `src/core/labels.ts`:**

```ts
// §22.4: a cut's short label, and the one-line clipping the Change Log shares. Pure and import-free,
// because the dashboard bundles this file: nothing here may pull zod or Node in, and no lookbehind
// (Safari before 16.4 can't parse one). test/core/labels.test.ts checks both.

/** A version's short label is at most this long (§22.3). */
export const LABEL_MAX = 48;

/** What shortLabel reads: a version as stored. `label` is optional, so a 0.2.x shape works too. */
export interface Labelled {
  id: string;
  note: string;
  file: string;
  label?: string;
}

const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
const JOINER = /[_\-/]/;
// Left at the end of a cut, these read as a broken sentence, so they go before the ellipsis.
const TRAILING = /[\s,;:.\-–—(_/]+$/u;

/** Control characters and every run of whitespace become one space; the ends are trimmed. */
export function oneLineOf(text: string): string {
  // eslint-disable-next-line no-control-regex -- the point is to match control characters.
  return text.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
}

function lastIndex(chars: string[], re: RegExp): number {
  for (let i = chars.length - 1; i > 0; i--) if (re.test(chars[i])) return i;
  return -1;
}

/**
 * `text`, at most `max` characters. They're counted as code points, so an emoji is never split.
 * The cut falls at the last word boundary that leaves room for "…" (§22.4 (4)). A boundary is a
 * space; in a name with none (a file name), an underscore, a hyphen or a slash. Only a single
 * unbroken word is cut inside it.
 */
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = chars.slice(0, max - 1);
  let cut = head.length;
  if (!SPACE.test(chars[max - 1])) {
    let at = lastIndex(head, SPACE);
    if (at <= 0) at = lastIndex(head, JOINER);
    if (at > 0) cut = at;
  }
  return head.slice(0, cut).join("").replace(TRAILING, "") + "…";
}

/** One line, clipped: how every Change Log line is stored (§22.3: 160 characters at most). */
export function oneLine(text: string, max: number): string {
  return clip(oneLineOf(text), max);
}

// §22.4 (3): a note's first clause ends at the first of these that comes after its first 12 characters.
const CLAUSE_ENDS = [";", ". ", " — ", " ("];

// `skipped` is how many characters the id and batch prefixes took off the front: the 12-character
// minimum counts the note AS WRITTEN, so "v1: first pass; rough" gives "first pass" (Task 1 ruling).
function firstClause(text: string, skipped: number): string {
  let end = text.length;
  for (const sep of CLAUSE_ENDS) {
    const i = text.indexOf(sep, Math.max(0, 12 - skipped));
    if (i >= 0 && i < end) end = i;
  }
  return text.slice(0, end).trim();
}

/** The file's name without its folder or extension: "renders/lumen_v6.mp4" gives "lumen_v6". */
function fileStem(file: string): string {
  const name = file.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * §22.4: the version's own label when it has one. Otherwise its note's first clause, without a
 * leading "v6:" that repeats the id or a "(batch b_1):". Otherwise the file's name. Always one
 * line, never over LABEL_MAX characters.
 */
export function shortLabel(v: Labelled): string {
  const own = oneLineOf(v.label ?? "");
  if (own) return clip(own, LABEL_MAX);
  const note = oneLineOf(v.note ?? "");
  let text = note;
  const n = /^v(\d+)$/i.exec(v.id)?.[1];
  if (n !== undefined) text = text.replace(new RegExp(`^v0*${Number(n)}(?![\\p{L}\\p{N}])[\\s:,.\\-–—]*`, "iu"), "");
  text = text.replace(/^\(batch[^)]*\)\s*:?\s*/i, "");
  text = firstClause(text, note.length - text.length);
  if (WORD.test(text)) return clip(text, LABEL_MAX);
  return clip(fileStem(v.file), LABEL_MAX) || v.id;
}
```

- [ ] **Step 4: Change the schema and `addVersion`.**
  - In `src/core/schema.ts`, inside `VersionSchema`, after `note: z.string().default(""),` add:

```ts
  // §22.3: a short label the agent writes, shown in the version list. The 48-character limit is
  // enforced where labels come in (the route, the tool, the CLI). A hand-edited longer one still
  // loads, and shortLabel shows it cut (§22.9, R2).
  label: z.string().default(""),
```

  - In `src/core/project.ts`, add to `AddVersionInput` after `note?: string;`:

```ts
  /** §22.4: a short label, 48 characters at most (checked by the caller). Stored trimmed. */
  label?: string;
```

  - In `addVersion`'s `version` literal, after `note: input.note ?? "",` add `label: input.label?.trim() ?? "",`.

- [ ] **Step 5: Update the test literals.** `Version` now has a required `label` in its output type. Add `label: ""` after `note: ""` (or after `note: "First pass"`) in `test/web/lib.test.ts` lines 174, 182 and 338, and in `test/server/files.test.ts` line 353.

- [ ] **Step 6: Run the core tests.** Run: `npx vitest run test/core/labels.test.ts && npm run typecheck`. Expected: PASS.

- [ ] **Step 7: Write the failing route, MCP, CLI and web tests.**

`test/server/version-label.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { tmpProject } from "../helpers/tmp.js";
import { createApp } from "../../src/server/app.js";

describe("POST /api/versions label (§22.4, §22.9)", () => {
  it("takes a label of 48 characters at most, trimmed, and refuses a longer one with the limit", async () => {
    const { store } = await tmpProject("labels");
    const app = createApp(store);
    const post = (json: unknown) =>
      app.request("/api/versions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) });
    const ok = await post({ video: "Hero", file: "renders/hero.mp4", note: "v1: the detail", label: " Launch slower " });
    expect(ok.status).toBe(201);
    expect((await ok.json()).version).toMatchObject({ label: "Launch slower", note: "v1: the detail" });
    expect((await post({ video: "Hero", file: "renders/hero.mp4", label: "x".repeat(48) })).status).toBe(201);
    const long = await post({ video: "Hero", file: "renders/hero.mp4", label: "x".repeat(49) });
    expect(long.status).toBe(400);
    expect(JSON.stringify(await long.json())).toContain("label is 48 characters at most: put the detail in note");
    const state = await (await app.request("/api/state")).json();
    expect(state.project.videos[0].versions.map((x: { label: string }) => x.label)).toEqual(["Launch slower", "x".repeat(48)]);
  });
});
```

`test/mcp/changelog.test.ts` (Task 5 appends to it):

```ts
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { tmpProject } from "../helpers/tmp.js";
import { startServer } from "../../src/server/start.js";
import { createMcpServer } from "../../src/mcp/tools.js";
import { RushesClient } from "../../src/mcp/client.js";

/** An MCP client talking to the Rushes at `url`. */
async function mcpOn(url: string) {
  const server = createMcpServer({ client: async () => new RushesClient(url), openBrowser: () => undefined, doctor: async () => [] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: !!r.isError, text: r.content[0].text };
  };
  return { client, call };
}

describe("labels for agents (§22.4)", () => {
  it("rushes_add_version takes a label of 48 characters at most, and says to put the detail in note", async () => {
    const { root } = await tmpProject("Lumen launch film");
    const s = await startServer(root, { port: 0 });
    const t = await mcpOn(s.url);
    const ok = await t.call("rushes_add_version", { video: "Lumen launch film", file: "renders/lumen_v1.mp4", note: "v1: the long detail", label: "First pass" });
    expect(ok.isError).toBe(false);
    expect(JSON.parse(ok.text).version).toMatchObject({ label: "First pass", note: "v1: the long detail" });
    const long = await t.call("rushes_add_version", { video: "Lumen launch film", file: "renders/lumen_v1.mp4", label: "x".repeat(49) });
    expect(long.isError).toBe(true);
    expect(long.text).toContain("48");
    const { tools } = await t.client.listTools();
    const add = tools.find((x) => x.name === "rushes_add_version")!;
    expect((add.inputSchema as any).properties.label).toMatchObject({ maxLength: 48 });
    expect(add.description).toMatch(/short `label`/);
    await t.client.close();
    await s.close();
  });
});
```

`test/cli/log.test.ts` (Task 5 appends to it):

```ts
import { describe, expect, it } from "vitest";
import { tmpProject } from "../helpers/tmp.js";
import { main, type Io } from "../../src/cli/main.js";
import { startServer } from "../../src/server/start.js";

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const x: Io = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    cwd,
    openBrowser: () => undefined,
    ensure: { spawnServer: () => { throw new Error("tests start the server themselves"); }, timeoutMs: 300 },
  };
  return { x, out, err };
}

describe("rushes add version --label (§22.4)", () => {
  it("sends the label, and help shows it", async () => {
    const { root } = await tmpProject("Lumen launch film");
    const s = await startServer(root, { port: 0 });
    const a = io(root);
    expect(await main(["add", "version", "renders/lumen v1.mp4", "--video", "Lumen launch film", "--label", "First pass", "--note", "v1: the detail"], a.x)).toBe(0);
    const state = await (await fetch(`${s.url}/api/state`)).json();
    expect(state.project.videos[0].versions[0]).toMatchObject({ label: "First pass", note: "v1: the detail" });
    const h = io(root);
    await main([], h.x);
    expect(h.out.join("\n")).toContain("rushes add version <file> --video NAME [--label TEXT] [--note TEXT]");
    await s.close();
  });
});
```

`test/web/versions.test.ts` (Task 2 appends to it):

```ts
import { describe, expect, it } from "vitest";
import { cutSubtitle, shortLabel } from "../../web/src/versions.js";

describe("versions.ts (§22.4)", () => {
  it("re-exports the server's shortLabel, so both sides say the same", () => {
    expect(shortLabel({ id: "v6", note: "v6: launch 1.45x slower; more", file: "a.mp4" })).toBe("launch 1.45x slower");
  });
  it("cutSubtitle is the short label, or nothing for a cut with no label and no note", () => {
    expect(cutSubtitle({ id: "v1", note: "v1: first pass; rough", file: "a.mp4", label: "" })).toBe("first pass");
    expect(cutSubtitle({ id: "v1", note: "", file: "a.mp4", label: "Agent's" })).toBe("Agent's");
    expect(cutSubtitle({ id: "v1", note: "  ", file: "a.mp4", label: "" })).toBeNull();
    expect(cutSubtitle(undefined)).toBeNull();
  });
});
```

`test/docs-changelog.test.ts` (Tasks 5 and 7 append to it):

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("shipped docs: short labels (§22.4)", () => {
  it.each(["AGENTS.md", "skills/rushes/SKILL.md"])("%s says to give every cut a short label and put the detail in note", (file) => {
    const text = read(file);
    expect(text).toMatch(/give every cut a short `label`/i);
    expect(text).toContain("48 characters");
    expect(text).toMatch(/detail in `note`/);
  });
});
```

`e2e/versions.spec.ts` (Task 2 appends to it):

```ts
import { expect, test } from "./fixture.js";

test("Assets › Cuts shows a cut's short label, not its whole note (§22.4)", async ({ page, rushes }) => {
  await rushes.addCut("v1: first pass; each zoomed request types itself out; crowd on a wider oval");
  await page.goto(rushes.url);
  await page.getByRole("tab", { name: /Assets/ }).click();
  await expect(page.locator(".aheader h2")).toContainText("Cuts");
  await expect(page.locator(".shot-meta .asub").first()).toHaveText("first pass");
});
```

- [ ] **Step 8: Run them and see them fail.** Run: `npx vitest run test/server/version-label.test.ts test/mcp/changelog.test.ts test/cli/log.test.ts test/web/versions.test.ts test/docs-changelog.test.ts`. Expected: FAIL. The route ignores `label`, the tool has no `label`, `--label` is an unknown option, `web/src/versions.ts` is missing, and the docs don't say it yet.

- [ ] **Step 9: Implement the route, tool and CLI.**
  - `src/server/app.ts`: import `LABEL_MAX` from `../core/labels.js`. Replace line 85 with:

```ts
// §22.4: `label` is a short label for the version list (R2: the limit is enforced here, not in the file).
const VersionBody = z.object({
  video: z.string().min(1),
  file: z.string().min(1),
  note: z.string().optional(),
  label: z.string().trim().max(LABEL_MAX, `label is ${LABEL_MAX} characters at most: put the detail in note`).optional(),
});
```

  - In the versions route, change `addVersion(p, { video: b.video, file, note: b.note, duration: info.duration, fps: info.fps })` to `addVersion(p, { video: b.video, file, note: b.note, label: b.label, duration: info.duration, fps: info.fps })`.
  - `src/mcp/tools.ts`, `rushes_add_version`: append to its description `" Give every cut a short \`label\` (48 characters at most) saying what changed, e.g. \"launch 1.45x slower\", and put the detail in \`note\`: the version list shows the label."`. Add to its `inputSchema` after `note`:

```ts
        label: z
          .string()
          .trim()
          .max(48, "label is 48 characters at most: put the detail in note")
          .optional()
          .describe('A short label for the version list, 48 characters at most, e.g. "launch 1.45x slower". The detail goes in note.'),
```

  - `src/cli/main.ts`:
    - add `label: { type: "string" },` to `OPTIONS` after `note`;
    - change the HELP line `  rushes add version <file> --video NAME [--note TEXT]` to `  rushes add version <file> --video NAME [--label TEXT] [--note TEXT]`;
    - in `case "add"`'s `version` branch, post `{ video: o.video, file: resolve(io.cwd, a), note: o.note, label: o.label }`.

- [ ] **Step 10: Implement the web side.**
  - Create `web/src/versions.ts`:

```ts
// §22.4 and §22.8: the version list's helpers. Pure, so they're unit-tested in Node. shortLabel comes
// from src/core/labels.ts, which has no imports at all, so nothing from the server reaches the bundle.
import { shortLabel, type Labelled } from "../../src/core/labels.js";
export { LABEL_MAX, shortLabel, type Labelled } from "../../src/core/labels.js";

/** Assets › Cuts (§22.4): a cut's subtitle is its short label. A cut with no label and no note has none, because its file name is already shown. */
export function cutSubtitle(v: Labelled | undefined): string | null {
  if (!v || !((v.label ?? "").trim() || v.note.trim())) return null;
  return shortLabel(v);
}
```

  - `web/src/ui/AssetViews.tsx`: add `import { cutSubtitle } from "../versions.js";` after the `../lib.js` import, and change line 162 to `return { title, subtitle: cutSubtitle(version) };`. Update the doc comment above `cutLabel` to say "plus its short label (§22.4)".

- [ ] **Step 11: Write the agent guidance.**
  - `AGENTS.md`, "The loop", step 1's render bullet: after "Run it again for each new cut." insert "Give every cut a short `label` (48 characters at most) that says what changed, e.g. `"launch 1.45x slower"`, and put the detail in `note`: the version list shows the label, and a longer one is refused."
  - `AGENTS.md`, step 5: change "Register the new cut with `rushes_add_version` and note what changed." to "Register the new cut with `rushes_add_version`, with a short `label` and the detail in `note`."
  - `AGENTS.md`, "Without MCP": change the `add version` example to `npx -y rushes add version renders/hero_v2.mp4 --video "Hero 60s" --label "logo hold" --note "held the logo 0.5 s longer"`.
  - `skills/rushes/SKILL.md`, step 1's first bullet: after "`rushes_add_version` for a render." insert "Give every cut a short `label` (48 characters at most) saying what changed, and put the detail in `note`."

- [ ] **Step 12: Run the unit tests and the gates.** Run: `npx vitest run test/core/labels.test.ts test/server/version-label.test.ts test/mcp/changelog.test.ts test/cli/log.test.ts test/web/versions.test.ts test/docs-changelog.test.ts`, then `npm run build && npm run typecheck && npx vitest run`. Expected: PASS. Confirm Vite bundled the core module: `grep -l "(batch" web-dist/assets/*.js` prints one file.

- [ ] **Step 13: Run the new e2e test, then the whole suite once.** Run: `npx playwright test e2e/versions.spec.ts --retries=0`, then `npx playwright test --retries=0` (both projects; the version `<select>` is unchanged so far). Expected: PASS.

- [ ] **Step 14: Commit.**

```bash
git add src/core/labels.ts src/core/schema.ts src/core/project.ts src/server/app.ts src/mcp/tools.ts src/cli/main.ts web/src/versions.ts web/src/ui/AssetViews.tsx AGENTS.md skills/rushes/SKILL.md test/core/labels.test.ts test/server/version-label.test.ts test/mcp/changelog.test.ts test/cli/log.test.ts test/web/versions.test.ts test/docs-changelog.test.ts test/web/lib.test.ts test/server/files.test.ts e2e/versions.spec.ts
git -c user.name=iamredmh -c user.email=17407420+iamredmh@users.noreply.github.com commit -m "feat: short version labels: label on a cut, derived from the note when missing, in Assets › Cuts" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

**Mutation check:** dropping the `12` from `text.indexOf(sep, 12)` must fail "only ends a clause after its first 12 characters".

---

### Task 2: The version list (§22.8, the version list)

**Files:**
- Create: `web/src/ui/VersionMenu.tsx` (`VersionMenu`, `VersionNote`), `web/src/changes.css`
- Modify: `web/src/versions.ts` (append `ago`, `typeAhead`, `moveActive`, `versionMeta`), `web/src/ui/App.tsx:13,362-380`, `web/src/ui/Picture.tsx:9,548`, `web/src/main.tsx:8`
- Modify: `e2e/fixture.ts` (`versionButton`, `pickVersion`), `e2e/dashboard.spec.ts` (the 24 version-select lines)
- Test: `test/web/versions.test.ts` (append), new `test/web/changes-css.test.ts`, `e2e/versions.spec.ts` (append)

**Interfaces:**
- Consumes (Task 1): `shortLabel`, `Labelled` from `web/src/versions.ts`.
- Produces (`web/src/versions.ts`):

```ts
export function ago(iso: string, now: Date): string;                              // R22
export function typeAhead(ids: readonly string[], typed: string): string | null;  // newest-first ids; exact number first, then prefix
export function moveActive(key: string, index: number, count: number, horizontal?: boolean): number | null;
export function versionMeta(v: { duration: number | null; shots: readonly unknown[]; addedAt: string }, now: Date): string; // "39.7 s · 11 shots · 2 h ago"
```

- Produces (`web/src/ui/VersionMenu.tsx`):

```ts
export interface VersionMenuProps { versions: Version[]; shown: Version; lockedVersion: string | null; onPick(id: string): void }
export function VersionMenu(props: VersionMenuProps): JSX.Element;    // button.vbtn[data-version], listbox "Versions", options [data-version], #vdetail
export function VersionNote(props: { version: Version }): JSX.Element | null;  // .vnote, two lines, More/Less
```

- Produces (`e2e/fixture.ts`): `export function versionButton(page: Page): Locator` and `export async function pickVersion(page: Page, id: string): Promise<void>`.

- [ ] **Step 1: Write the failing unit tests.** Append to `test/web/versions.test.ts`, and add `ago, moveActive, typeAhead, versionMeta` to its import:

```ts
describe("the version list's helpers (§22.8)", () => {
  const now = new Date(2026, 9, 7, 12, 0, 0);
  const before = (ms: number) => new Date(now.getTime() - ms).toISOString();
  it("ago (R22)", () => {
    expect(ago(before(30_000), now)).toBe("just now");
    expect(ago(before(12 * 60_000), now)).toBe("12 min ago");
    expect(ago(before(2 * 3_600_000), now)).toBe("2 h ago");
    expect(ago(before(30 * 3_600_000), now)).toBe("yesterday");
    expect(ago(before(3 * 86_400_000), now)).toBe("3 days ago");
    expect(ago(new Date(2026, 8, 27, 9, 0).toISOString(), now)).toBe("27 Sep");
    expect(ago(new Date(2025, 9, 5, 9, 0).toISOString(), now)).toBe("5 Oct 2025");
    expect(ago("", now)).toBe("");
    expect(ago(before(-60_000), now)).toBe("just now"); // a clock a little ahead
  });
  it("typeAhead finds the exact number first, then the newest that starts with it", () => {
    const ids = ["v12", "v11", "v10", "v2", "v1"];
    expect(typeAhead(ids, "1")).toBe("v1");
    expect(typeAhead(ids, "12")).toBe("v12");
    expect(typeAhead(ids, "10")).toBe("v10");
    expect(typeAhead(["v13", "v2"], "1")).toBe("v13");
    expect(typeAhead(ids, "3")).toBeNull();
  });
  it("moveActive: arrows wrap, Home and End jump, sideways arrows only when asked", () => {
    expect(moveActive("ArrowDown", 0, 3)).toBe(1);
    expect(moveActive("ArrowDown", 2, 3)).toBe(0);
    expect(moveActive("ArrowUp", 0, 3)).toBe(2);
    expect(moveActive("Home", 2, 3)).toBe(0);
    expect(moveActive("End", 0, 3)).toBe(2);
    expect(moveActive("ArrowDown", -1, 3)).toBe(0);
    expect(moveActive("ArrowUp", -1, 3)).toBe(2);
    expect(moveActive("ArrowRight", 0, 3)).toBeNull();
    expect(moveActive("ArrowRight", 2, 3, true)).toBe(0);
    expect(moveActive("ArrowLeft", 0, 3, true)).toBe(2);
    expect(moveActive("a", 0, 3)).toBeNull();
    expect(moveActive("ArrowDown", 0, 0)).toBeNull();
  });
  it("versionMeta: the length when known, the shots and how long ago", () => {
    expect(versionMeta({ duration: 39.7, shots: new Array(11).fill(0), addedAt: before(2 * 3_600_000) }, now)).toBe("39.7 s · 11 shots · 2 h ago");
    expect(versionMeta({ duration: null, shots: [0], addedAt: before(1000) }, now)).toBe("1 shot · just now");
    expect(versionMeta({ duration: 4, shots: [], addedAt: "" }, now)).toBe("4.0 s · no shots");
  });
});
```

`test/web/changes-css.test.ts` (Task 6 appends to it):

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const raw = readFileSync(new URL("../../web/src/changes.css", import.meta.url), "utf8");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

describe("changes.css (§22.8)", () => {
  it("is loaded after styles.css", () => {
    const main = readFileSync(new URL("../../web/src/main.tsx", import.meta.url), "utf8");
    expect(main.indexOf('import "./changes.css";')).toBeGreaterThan(main.indexOf('import "./styles.css";'));
  });
  it("sets no type under 15 px", () => {
    for (const m of css.matchAll(/font(?:-size)?:[^;]*?(\d+(?:\.\d+)?)px/g)) expect(Number(m[1]), m[0]).toBeGreaterThanOrEqual(15);
  });
  it("lays every grid out with explicit tracks, never a bare fr (Safari, §22.11)", () => {
    for (const m of css.matchAll(/grid-template-columns:\s*([^;]+);/g)) expect(m[1].replace(/minmax\(0,\s*1fr\)/g, ""), m[0]).not.toMatch(/\dfr\b/);
  });
  it("truncates the version label and row labels rather than wrap them", () => {
    for (const sel of [".vbtn .vlbl", ".vrow .vlbl"]) {
      const rule = css.slice(css.indexOf(`${sel} {`), css.indexOf("}", css.indexOf(`${sel} {`)));
      expect(rule, sel).toMatch(/text-overflow: ellipsis/);
      expect(rule, sel).toMatch(/white-space: nowrap/);
    }
  });
});
```

- [ ] **Step 2: Run them and see them fail.** Run: `npx vitest run test/web/versions.test.ts test/web/changes-css.test.ts`. Expected: FAIL (the names aren't exported; `changes.css` is missing).

- [ ] **Step 3: Write the helpers.** Append to `web/src/versions.ts`:

```ts
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** R22: "just now", "12 min ago", "2 h ago", "yesterday", "3 days ago", then "5 Oct" (and the year when it isn't this one). */
export function ago(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (now.getTime() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86_400) return "yesterday";
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)} days ago`;
  const d = new Date(t);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`}`;
}

/** §22.8's type-ahead on the version number: the exact number first, then the newest whose number starts with what was typed. */
export function typeAhead(ids: readonly string[], typed: string): string | null {
  const num = (id: string) => id.replace(/^v/i, "");
  return ids.find((id) => num(id) === typed) ?? ids.find((id) => num(id).startsWith(typed)) ?? null;
}

/** Where a key moves the active item in a list of `count` (§22.8): arrows wrap, Home and End jump. Left and right count only when `horizontal`. Null for any other key. */
export function moveActive(key: string, index: number, count: number, horizontal = false): number | null {
  if (count <= 0) return null;
  const next = key === "ArrowDown" || (horizontal && key === "ArrowRight");
  const prev = key === "ArrowUp" || (horizontal && key === "ArrowLeft");
  if (next) return index < 0 ? 0 : (index + 1) % count;
  if (prev) return index < 0 ? count - 1 : (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/** The detail panel's last line (§22.8): "39.7 s · 11 shots · 2 h ago". */
export function versionMeta(v: { duration: number | null; shots: readonly unknown[]; addedAt: string }, now: Date): string {
  const parts: string[] = [];
  if (v.duration !== null) parts.push(`${v.duration.toFixed(1)} s`);
  parts.push(v.shots.length === 0 ? "no shots" : `${v.shots.length} shot${v.shots.length === 1 ? "" : "s"}`);
  const when = ago(v.addedAt, now);
  if (when) parts.push(when);
  return parts.join(" · ");
}
```

- [ ] **Step 4: Run the unit tests.** Run: `npx vitest run test/web/versions.test.ts`. Expected: PASS (the CSS test still fails until Step 6).

- [ ] **Step 5: Write `web/src/ui/VersionMenu.tsx`:**

```tsx
// §22.8: Picture's version control. A menu button opens a list with one line per version (id, short
// label, how long ago, a lock on the locked one) and the full note beside it. On a touch screen the
// note shows under the row instead. It replaces the native <select>, which can't truncate. Also the
// cut's full note under the picture, two lines at most.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Version } from "../types.js";
import { ago, moveActive, shortLabel, typeAhead, versionMeta } from "../versions.js";
import { Icon } from "./Icon.js";

export interface VersionMenuProps {
  /** The film's versions, oldest first, as stored. */
  versions: Version[];
  /** The version on screen. */
  shown: Version;
  lockedVersion: string | null;
  onPick(id: string): void;
}

/** Digits typed within this long of each other make one version number (type-ahead). */
const TYPE_AHEAD_MS = 700;
const touchScreen = () => typeof matchMedia === "function" && matchMedia("(hover: none)").matches;

export function VersionMenu({ versions, shown, lockedVersion, onPick }: VersionMenuProps) {
  const rows = [...versions].reverse(); // newest at the top, as before
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(shown.id);
  const [hover, setHover] = useState<string | null>(null);
  const [touch, setTouch] = useState(false);
  const [tapped, setTapped] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const rowEls = useRef<Record<string, HTMLButtonElement | null>>({});
  const typed = useRef({ text: "", at: -Infinity });
  const now = new Date();
  const label = shortLabel(shown);

  const show = (id: string) => {
    setActive(id);
    setHover(null);
    setTapped(null);
    setTouch(touchScreen());
    setOpen(true);
  };
  const close = (focusButton: boolean) => {
    setOpen(false);
    setTapped(null);
    if (focusButton) button.current?.focus();
  };
  const pick = (id: string) => {
    close(true);
    if (id !== shown.id) onPick(id);
  };

  // Roving focus: while the list is open, the active row has it.
  useLayoutEffect(() => {
    if (open) rowEls.current[active]?.focus();
  }, [open, active]);
  // A click or focus anywhere else closes the list.
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!wrap.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("focusin", away, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("focusin", away, true);
    };
  }, [open]);

  // Every key the list handles stops here, so Space doesn't play, the arrows don't step frames and
  // the digits don't switch tabs (App's and Picture's handlers listen on window).
  const onListKey = (e: KeyboardEvent) => {
    const i = rows.findIndex((v) => v.id === active);
    const to = moveActive(e.key, i, rows.length);
    if (to !== null) {
      e.preventDefault();
      e.stopPropagation();
      setActive(rows[to].id);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      pick(active);
      return;
    }
    if (e.key === "Tab") {
      close(false);
      return;
    }
    if (/^\d$/.test(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      const text = e.timeStamp - typed.current.at < TYPE_AHEAD_MS ? typed.current.text + e.key : e.key;
      typed.current = { text, at: e.timeStamp };
      const hit = typeAhead(rows.map((v) => v.id), text);
      if (hit) setActive(hit);
    }
  };
  const onRowClick = (id: string) => {
    // R20: on a touch screen the first tap shows the row's note under it; a second tap picks it.
    if (touch && tapped !== id) {
      setTapped(id);
      setActive(id);
      return;
    }
    pick(id);
  };
  const detail = rows.find((v) => v.id === (hover ?? active)) ?? shown;

  return (
    <div class="vwrap" ref={wrap}>
      <button
        ref={button}
        type="button"
        class="vbtn"
        data-version={shown.id}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Version: ${shown.id} · ${label}`}
        onClick={() => (open ? close(false) : show(shown.id))}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            e.stopPropagation();
            show(shown.id);
          }
        }}
      >
        <span class="vid">{shown.id}</span>
        <span class="vlbl">{label}</span>
        <Icon name="chev" />
      </button>
      {open && (
        <div class={`vmenu${touch ? " touch" : ""}`}>
          <div class="vlist" role="listbox" aria-label="Versions" onKeyDown={onListKey} onMouseLeave={() => setHover(null)}>
            {rows.map((v) => (
              <button
                type="button"
                role="option"
                class="vrow"
                data-version={v.id}
                data-on={v.id === (hover ?? active) ? "true" : "false"}
                aria-selected={v.id === shown.id}
                aria-describedby={!touch && v.id === detail.id ? "vdetail" : undefined}
                tabIndex={v.id === active ? 0 : -1}
                ref={(el) => { rowEls.current[v.id] = el; }}
                onMouseEnter={() => setHover(v.id)}
                onClick={() => onRowClick(v.id)}
              >
                <span class="vid">{v.id}</span>
                <span class="vlbl">{shortLabel(v)}</span>
                <span class="vwhen">
                  {v.id === lockedVersion && (
                    <>
                      <Icon name="lock" />
                      <span class="vh">Locked, </span>
                    </>
                  )}
                  {ago(v.addedAt, now)}
                </span>
                {touch && tapped === v.id && (
                  <span class="vinline">
                    {v.note.trim() || "No note."}
                    <span class="vmeta">{versionMeta(v, now)}</span>
                  </span>
                )}
              </button>
            ))}
          </div>
          {!touch && (
            <div class="vdetail" id="vdetail">
              <h4>{detail.id}</h4>
              <p>{detail.note.trim() || "No note."}</p>
              <span class="vmeta">{versionMeta(detail, now)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** §22.8: the full note of the cut on show, under the picture. Two lines at most, with More when it's cut short (R23). */
export function VersionNote({ version }: { version: Version }) {
  const [more, setMore] = useState(false);
  const [clamped, setClamped] = useState(false);
  const text = useRef<HTMLSpanElement>(null);
  useEffect(() => setMore(false), [version.id]);
  useLayoutEffect(() => {
    const el = text.current;
    if (!el) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [version.id, version.note, more]);
  const note = version.note.trim();
  if (!note) return null;
  const id = `vnote-${version.id}`;
  return (
    <div class="vnote">
      <span ref={text} id={id} class={more ? "vtext" : "vtext vclamp"}>{note}</span>
      {(clamped || more) && (
        <button type="button" class="vmore" aria-expanded={more} aria-controls={id} onClick={() => setMore(!more)}>
          {more ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Write the styles.** Create `web/src/changes.css`, and add `import "./changes.css";` to `web/src/main.tsx` on the line after `import "./styles.css";`:

```css
/* §22.8: the version list and the cut's note under the picture (the approved mockup). Explicit grid
   tracks throughout (§22.11, Safari). Task 6 adds the Change Log below. */
.vwrap { position: relative; min-width: 0; }
.vbtn { display: inline-flex; align-items: center; gap: 8px; max-width: 340px; min-width: 0; height: 32px; padding: 0 12px; border: 1px solid var(--line-2); border-radius: 999px; background: transparent; color: var(--text); font-size: 15px; cursor: pointer; }
.vbtn:hover { background: var(--hover); }
.vbtn .vid { flex: none; font-family: var(--mono); color: var(--accent-2); }
.vbtn .vlbl { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
.vbtn .ic { flex: none; width: 15px; height: 15px; }
.vmenu { position: absolute; left: 0; top: calc(100% + 8px); z-index: 45; display: grid; width: min(700px, calc(100vw - 40px)); grid-template-columns: minmax(0, 1fr) minmax(0, 300px); background: var(--raised); border: 1px solid var(--line-2); border-radius: var(--r-lg); box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5); overflow: hidden; }
.vmenu.touch { grid-template-columns: minmax(0, 1fr); }
.vlist { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; padding: 6px; max-height: min(420px, 60vh); overflow: auto; }
.vrow { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 8px 10px; border: 0; border-radius: var(--r); background: transparent; color: var(--text); text-align: left; font-size: 15px; cursor: pointer; }
.vrow[data-on="true"] { background: var(--hover); }
.vrow .vid { font-family: var(--mono); color: var(--text-2); }
.vrow[aria-selected="true"] .vid { color: var(--accent-2); }
.vrow .vlbl { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vrow .vwhen { display: flex; gap: 6px; align-items: center; color: var(--text-3); white-space: nowrap; }
.vrow .vwhen .ic { width: 15px; height: 15px; }
.vrow .vinline { grid-column: 1 / -1; display: grid; gap: 4px; color: var(--text-2); overflow-wrap: anywhere; white-space: normal; }
.vdetail { display: grid; align-content: start; gap: 8px; min-width: 0; padding: 12px 14px; border-left: 1px solid var(--line); background: var(--app); }
.vdetail h4 { margin: 0; font: 600 15px var(--mono); color: var(--text-2); }
.vdetail p { margin: 0; overflow-wrap: anywhere; }
.vmeta { color: var(--text-3); font-family: var(--mono); }
.vnote { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; margin-top: 10px; padding: 10px 14px; border: 1px solid var(--line); border-radius: var(--r); background: var(--raised); color: var(--text-2); font-size: 15px; }
.vnote .vtext { overflow-wrap: anywhere; }
.vnote .vclamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.vnote .vmore { justify-self: start; padding: 0; border: 0; background: none; color: var(--accent-2); font-size: 15px; cursor: pointer; }
```

- [ ] **Step 7: Wire up App and Picture.**
  - `web/src/ui/App.tsx`: add `import { VersionMenu } from "./VersionMenu.js";` after the `./Voice.js` import. Replace lines 362–380 (the `{version && (<select …>…</select>)}` block) with:

```tsx
            {version && (
              <VersionMenu
                versions={video.versions}
                shown={version}
                lockedVersion={video.lockedVersion}
                onPick={(id) => {
                  // Picking the version the film would follow anyway collapses back to "follow"
                  // (null); picking anything else pins it explicitly -- including the newest, on a
                  // locked film, which must show what you asked for rather than snap back to the lock.
                  setVersionId(id === target?.id ? null : id);
                  setHeld(false);
                }}
              />
            )}
```

  - `web/src/ui/Picture.tsx`: add `import { VersionNote } from "./VersionMenu.js";` after the `./playerFloor.js` import. After line 548 (`<div class="ends"><span>0:00</span><span>{fmt(duration)}</span></div>`) add `<VersionNote version={version} />`.

- [ ] **Step 8: Add the e2e helpers.** In `e2e/fixture.ts`, change the first import to `import { test as base, expect, type Locator, type Page } from "@playwright/test";`. Append, before `export { expect };`:

```ts
/** §22.8: Picture's version control, a menu button whose accessible name starts "Version". */
export function versionButton(page: Page): Locator {
  return page.getByRole("button", { name: /^Version/ });
}

/** Picks a version from the version list, the way a person would, and waits until it's on screen. */
export async function pickVersion(page: Page, id: string): Promise<void> {
  const button = versionButton(page);
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  await page.getByRole("listbox", { name: "Versions" }).locator(`[role="option"][data-version="${id}"]`).click();
  await expect(button).toHaveAttribute("data-version", id);
}
```

- [ ] **Step 9: Move the existing tests onto the list.** The native `<select>` is gone, so the 24 uses in `e2e/dashboard.spec.ts` change. Run:

```bash
perl -0pi -e '
  s/(\w+)\.getByRole\("combobox", \{ name: "Version" \}\)/versionButton($1)/g;
  s/versionButton\((\w+)\)\)\.toHaveValue\(/versionButton($1)).toHaveAttribute("data-version", /g;
  s/expect\(versions\)\.toHaveValue\(/expect(versions).toHaveAttribute("data-version", /g;
  s/versionButton\((\w+)\)\.selectOption\(/pickVersion($1, /g;
  s/versions\.selectOption\(/pickVersion(page, /g;
' e2e/dashboard.spec.ts
grep -c 'name: "Version"' e2e/dashboard.spec.ts
```

  Expected: `0`. Then change line 5's import to `import { expect, hasFfmpeg, needsH264, pickVersion, type Rushes, test, versionButton, videoReady } from "./fixture.js";`. If Plan 6 has landed, run the same `perl` over `e2e/formats.spec.ts`, and add the imports there.

- [ ] **Step 10: Write the failing e2e tests.** Append to `e2e/versions.spec.ts`, and change its imports to:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, pickVersion, test, versionButton, videoReady } from "./fixture.js";

const LONG =
  "v2: the button morphs into a node-sized dot and rides the pull-back onto the globe; labels and bubbles drawn as sharp images so text no longer wobbles; the crowd builds to 22 all round the globe. End line B. 34.2 s, silent.";
const option = (page: import("@playwright/test").Page, id: string) => page.locator(`[role="option"][data-version="${id}"]`);
```

```ts
test("the version control shows the cut and its short label, and lists every cut newest first, one line each (§22.8)", async ({ page, rushes }) => {
  await rushes.addCut("v1: first pass; rough timing");
  await rushes.addCut(LONG);
  await rushes.api("PUT", "/api/videos/hero/lock", { version: "v1" });
  await page.goto(rushes.url);
  await videoReady(page);
  const button = versionButton(page);
  // Locked at v1: the film opens on it.
  await expect(button).toHaveAttribute("data-version", "v1");
  await expect(button).toHaveAccessibleName("Version: v1 · first pass");
  await button.click();
  const list = page.getByRole("listbox", { name: "Versions" });
  const rows = list.getByRole("option");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute("data-version", "v2");
  await expect(rows.nth(0)).toContainText("the button morphs into a node-sized dot and…");
  await expect(rows.nth(1)).toContainText("Locked");
  await expect(rows.nth(1)).toContainText("just now");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  // One line per row, however long the note.
  const heights = await rows.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(2);
  expect(heights[0]).toBeLessThan(48);
  // The full note sits beside the list for the row under the pointer.
  await rows.nth(0).hover();
  await expect(page.locator("#vdetail")).toContainText("the crowd builds to 22 all round the globe");
  await expect(page.locator("#vdetail .vmeta")).toContainText("just now");
  // Nothing pushes the page wider (Safari, §22.11).
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await button.boundingBox())!.width).toBeLessThanOrEqual(340);
  // The long label is cut by the row (an ellipsis), not wrapped.
  expect(await rows.nth(0).locator(".vlbl").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
});

test("the version list works from the keyboard: arrows, Home, End, type-ahead, Enter and Esc (§22.8)", async ({ page, rushes }) => {
  for (const note of ["first cut", "second cut", "third cut"]) await rushes.addCut(note);
  await page.goto(rushes.url);
  await videoReady(page);
  const button = versionButton(page);
  await expect(button).toHaveAttribute("data-version", "v3");
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(option(page, "v3")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(option(page, "v2")).toBeFocused();
  await page.keyboard.press("End");
  await expect(option(page, "v1")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(option(page, "v3")).toBeFocused();
  await page.keyboard.press("ArrowUp"); // wraps
  await expect(option(page, "v1")).toBeFocused();
  // Esc closes without a change and gives focus back.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute("data-version", "v3");
  // ArrowDown on the button opens it; "1" is v1, never the tab key 1 (Script).
  await page.keyboard.press("ArrowDown");
  await expect(option(page, "v3")).toBeFocused();
  await page.keyboard.press("1");
  await expect(option(page, "v1")).toBeFocused();
  await expect(page.getByRole("tab", { name: /Picture/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(button).toHaveAttribute("data-version", "v1");
  await expect(button).toBeFocused();
  await videoReady(page);
  // Closed, the arrows step frames again.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("Timecode")).toContainText("0:00.03");
});

test("the cut's full note sits under the picture, two lines at most, with More (§22.8)", async ({ page, rushes }) => {
  await rushes.addCut(LONG);
  await page.goto(rushes.url);
  await videoReady(page);
  const note = page.locator(".vnote");
  await expect(note).toContainText("the crowd builds to 22");
  const text = note.locator(".vtext");
  expect(await text.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);
  const more = note.getByRole("button", { name: "More" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(note.getByRole("button", { name: "Less" })).toHaveAttribute("aria-expanded", "true");
  expect(await text.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  // A cut with no note has no line.
  await rushes.addCut();
  await expect(versionButton(page)).toHaveAttribute("data-version", "v2");
  await expect(note).toHaveCount(0);
});

test("an agent's label wins over the derived one, and a hand-edited one over 48 is shown cut (§22.4, §22.9)", async ({ page, rushes }) => {
  await rushes.addCut("v1: first pass; rough");
  await rushes.api("POST", "/api/versions", { video: "Hero", file: "renders/hero_v1.mp4", note: "v2: the long detail", label: "Launch slower" });
  await expect(rushes.api("POST", "/api/versions", { video: "Hero", file: "renders/hero_v1.mp4", label: "x".repeat(49) })).rejects.toThrow(/48 characters at most/);
  await page.goto(rushes.url);
  await expect(versionButton(page)).toHaveAccessibleName("Version: v2 · Launch slower");
  const path = join(rushes.root, ".rushes", "project.json");
  const p = JSON.parse(await readFile(path, "utf8"));
  p.videos[0].versions[1].label = "A label somebody typed by hand that runs on far past the limit of the list";
  p.rev += 1;
  await writeFile(path, JSON.stringify(p, null, 2));
  await expect(versionButton(page)).toHaveAccessibleName("Version: v2 · A label somebody typed by hand that runs on far…");
});

test("on a touch screen the first tap shows a cut's note under its row and a second tap picks it (R20)", async ({ page, rushes }) => {
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q: string) =>
      q === "(hover: none)"
        ? ({ matches: true, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false } as unknown as MediaQueryList)
        : real(q);
  });
  await rushes.addCut("v1: first pass; rough timing");
  await rushes.addCut("v2: tighter; the end card holds longer");
  await page.goto(rushes.url);
  await videoReady(page);
  await versionButton(page).click();
  await option(page, "v1").click();
  await expect(option(page, "v1").locator(".vinline")).toContainText("first pass; rough timing");
  await expect(page.locator("#vdetail")).toHaveCount(0);
  await expect(versionButton(page)).toHaveAttribute("data-version", "v2");
  await option(page, "v1").click();
  await expect(versionButton(page)).toHaveAttribute("data-version", "v1");
});

test("pickVersion pins a cut by hand: the lock and the newest cut still don't move it (§14.2)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await rushes.addCut("second cut");
  await rushes.api("PUT", "/api/videos/hero/lock", { version: "v1" });
  await page.goto(rushes.url);
  await videoReady(page);
  await pickVersion(page, "v2");
  await videoReady(page);
  await expect(versionButton(page)).toHaveAttribute("data-version", "v2");
  expect((await rushes.api("GET", "/api/state")).project.videos[0].lockedVersion).toBe("v1");
});
```

- [ ] **Step 11: Run e2e and see it fail, then pass.** Run: `npm run build && npx playwright test e2e/versions.spec.ts --project=chromium --retries=0`. Expected: FAIL before Steps 5–9 are in; PASS after. Then run `npx playwright test e2e/versions.spec.ts --project=webkit --retries=0`. Expected: PASS.

- [ ] **Step 12: Run the gates.** Run: `npm run build && npm run typecheck && npx vitest run && npx playwright test --retries=0` (the whole suite, both projects). Expected: all green, including every migrated test in `e2e/dashboard.spec.ts`. Save a 1440×900 screenshot of the open list to the scratchpad path given in the dispatch.

- [ ] **Step 13: Commit.**

```bash
git add web/src/ui/VersionMenu.tsx web/src/changes.css web/src/versions.ts web/src/ui/App.tsx web/src/ui/Picture.tsx web/src/main.tsx e2e/fixture.ts e2e/dashboard.spec.ts e2e/versions.spec.ts test/web/versions.test.ts test/web/changes-css.test.ts
git -c user.name=iamredmh -c user.email=17407420+iamredmh@users.noreply.github.com commit -m "feat(web): a version list instead of the dropdown: one line per cut, the full note beside it and under the picture" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

**Mutation check:** removing `e.stopPropagation()` from the digit branch of `onListKey` must fail "the version list works from the keyboard" (the `1` switches to Script).

---

### Task 3: The log's engine (§22.3, §22.5, §22.6 data)

**Files:**
- Create: `src/core/logText.ts`, `src/core/logEvents.ts`, `src/core/log.ts`
- Modify: `src/core/schema.ts:1` (import), after line 283 (`LogEntrySchema`, `LogFileSchema`), `:285-301` (`FILES.log`, `FileData.log`), `src/core/store.ts:11-26,32` (default, created on write)
- Test: new `test/core/logText.test.ts`, new `test/core/log.test.ts`

**Interfaces:**
- Consumes (Task 1): `clip`, `oneLine`, `oneLineOf`, `shortLabel`.
- Produces (`src/core/logText.ts`, whose only import is `./labels.js`):

```ts
export const LOG_AREAS: readonly ["script", "picture", "voice", "music", "sfx", "mix", "notes", "assets", "project"];
export type LogArea; export const LOG_KINDS: readonly ["cut", "variant", "take", "script", "picks", "notes-sent", "replies", "lock", "files", "entry"];
export type LogKind; export const LOG_BY: readonly ["user", "agent", "rushes"]; export type LogBy;
export const LOG_MAX = 5000; export const LOG_TEXT_MAX = 160; export const MERGE_MS = 120_000; export const PICKS_MERGE_MS = 600_000;
export const AREA_LABELS: Record<LogArea, string>;   // chips and tags: Voice, Sound effects, Notes, Files …
export const BY_WORDS: Record<LogBy, string>;        // you, agent, Rushes (Markdown, CLI)
export interface LogLine { id: string; at: string; area: LogArea; kind: LogKind; text: string; video: string | null; version: string | null; ref: string | null; by: LogBy; tab?: string | null }
export interface UndatedLine { area: "voice" | "music" | "sfx"; text: string }
export function logText(text: string): string;                 // one line, ≤ 160
export function clock(d: Date): string;                        // "14:32"
export function localDate(d: Date): string;                    // "2026-10-07"
export function localStamp(d: Date): string;                   // "2026-10-07 14:32"
export function dayHeading(d: Date, now: Date, relative: boolean): string;
export function changeLogFileName(now: Date): string;          // "change-log-2026-10-07.md"
export interface LogMarkdownInput { project: string; entries: Pick<LogLine, "at" | "area" | "text" | "by">[]; undated: Pick<UndatedLine, "text">[]; dropped: number; earlier?: number; now: Date }
export function logMarkdown(i: LogMarkdownInput): string;
export function recentChanges(entries: Pick<LogLine, "at" | "text">[], max?: number): string;
```

- Produces (`src/core/log.ts`):

```ts
export interface LogEvent { area: LogArea; kind: LogKind; text: string; video?: string | null; version?: string | null; ref?: string | null; tab?: Stage | null;
  merge: "count" | "replace" | "once"; count?: number; subject?: string; many?: (n: number, subject: string) => string; windowMs?: number; clears?: string[] }
export function appendEvent(file: LogFile, event: LogEvent, by: LogBy, at: Date, id?: string): LogEntry;
export interface BackfillSource { project: Project; batches: BatchesFile; script: Script }
export function backfillLog(file: LogFile, src: BackfillSource, before: number): void;
export function undatedRefs(project: Pick<Project, "lanes">, script: Pick<Script, "sections">): string[];
export interface UndatedContext { project: Pick<Project, "lanes">; script: Pick<Script, "sections"> }
export function undatedLines(refs: readonly string[], ctx: UndatedContext): UndatedLine[];
export interface LogQuery { limit?: number; area?: LogArea; since?: string }
export interface LogView { entries: LogEntry[]; earlier: number; undated: UndatedLine[]; dropped: number; total: number }
export function logView(file: LogFile, q: LogQuery, ctx: UndatedContext): LogView;
```

- Produces (`src/core/logEvents.ts`):

```ts
export const TAB_NAMES: Record<Stage, string>;          // Script, Picture, Voiceover, Music, Sound effects, Mix
export const STAGE_WORDS: Record<LaneStage, string>;    // Voiceover, Music, Sound effects
export const FILE_FOLDERS: Record<FileKind, string>;    // §16.1 folder titles
export function cutName(films: number, video: Pick<Video, "name">, versionId: string): string;
export function cutEvent(films: number, video: Pick<Video, "id" | "name">, version: Labelled): LogEvent;
export function variantEvent(lane: Pick<Lane, "id" | "stage" | "name">, variant: Pick<Variant, "id" | "name">): LogEvent;
export function takeEvent(section: Pick<Section, "id" | "current">, take: Pick<Take, "id">, number: number): LogEvent;
export function scriptEvent(sections: number): LogEvent;
export function picksEvent(project: Pick<Project, "lanes">, lanes: Picks["lanes"]): LogEvent;
export function lockEvent(films: number, video: Pick<Video, "id" | "name" | "lockedVersion">): LogEvent;
export function notesSentEvent(batch: Pick<Batch, "stage" | "noteIds" | "sectionIds">): LogEvent;
export function repliesEvent(notes: Pick<Note, "status" | "stage">[]): LogEvent;
export function fileEvent(entry: Pick<FileEntry, "kind" | "name">): LogEvent;
export function broughtInEvent(added: { lane?: string; variant?: string }[], cut: string | null): LogEvent;
export function lineEvent(text: string, area: LogArea, link?: { video?: string | null; version?: string | null; ref?: string | null }): LogEvent;
```

- Produces (schema): `LogEntrySchema`, `type LogEntry`, `LogFileSchema`, `type LogFile`, `FILES.log` (`log.json`), `FileData.log`. The store treats `log` as created on its first write, with default `{ schema: 1, rev: 0, backfilled: false, undated: [], dropped: 0, entries: [] }`.

- [ ] **Step 1: Write the failing tests for `logText.ts`** at `test/core/logText.test.ts`:

```ts
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { AREA_LABELS, changeLogFileName, clock, dayHeading, localStamp, logMarkdown, logText, recentChanges } from "../../src/core/logText.js";

const local = (d: number, h: number, m: number, month = 9, y = 2026) => new Date(y, month, d, h, m);

describe("logText (§22.3, Review Focus 2)", () => {
  it("is one clean line of 160 at most, never splitting an emoji", () => {
    expect(logText("  Slowed the zooms\n\tbecause the first cut\u0007 felt rushed  ")).toBe("Slowed the zooms because the first cut felt rushed");
    expect(logText(`${"a".repeat(158)}🎬🎬🎬`)).toBe(`${"a".repeat(158)}🎬…`);
    expect(Array.from(logText("word ".repeat(400))).length).toBeLessThanOrEqual(160);
  });
});

describe("dates", () => {
  it("clock, stamp and file name are local", () => {
    expect(clock(local(7, 9, 5))).toBe("09:05");
    expect(localStamp(local(7, 14, 32))).toBe("2026-10-07 14:32");
    expect(changeLogFileName(local(7, 14, 32))).toBe("change-log-2026-10-07.md");
  });
  it("day headings: Today, Yesterday, then 'Mon 5 Oct' in the drawer; the full date in a file (§22.8)", () => {
    const now = local(7, 10, 0);
    expect(dayHeading(local(7, 0, 1), now, true)).toBe("Today");
    expect(dayHeading(local(6, 23, 59), now, true)).toBe("Yesterday");
    expect(dayHeading(local(5, 12, 0), now, true)).toBe("Mon 5 Oct");
    expect(dayHeading(local(31, 12, 0, 11, 2025), now, true)).toBe("Wed 31 Dec 2025");
    expect(dayHeading(local(31, 12, 0), local(1, 9, 0, 10), true)).toBe("Yesterday"); // across a month
    expect(dayHeading(local(7, 14, 32), now, false)).toBe("Wednesday 7 October 2026");
  });
});

describe("logMarkdown and recentChanges (§22.7)", () => {
  const entries = [
    { at: local(7, 14, 32).toISOString(), area: "picture" as const, text: "v6 added: launch 1.45x slower", by: "agent" as const },
    { at: local(7, 13, 5).toISOString(), area: "notes" as const, text: "3 notes sent from Picture", by: "user" as const },
    { at: local(5, 18, 10).toISOString(), area: "assets" as const, text: "2 files added: Scripts & docs", by: "rushes" as const },
  ];
  it("is newest first, one heading per day, then Before the log and the removed note", () => {
    expect(logMarkdown({ project: "Lumen launch film", entries, undated: [{ text: "Music: night-drive (3 variants)" }], dropped: 2, now: local(7, 15, 0) })).toBe(
      "# Lumen launch film — change log\nExported 2026-10-07 15:00\n\n" +
        "## Wednesday 7 October 2026\n- 14:32 · Picture · v6 added: launch 1.45x slower (agent)\n- 13:05 · Notes · 3 notes sent from Picture (you)\n\n" +
        "## Monday 5 October 2026\n- 18:10 · Files · 2 files added: Scripts & docs (Rushes)\n\n" +
        "## Before the log\n- Music: night-drive (3 variants)\n\nEarlier entries were removed.\n",
    );
    expect(logMarkdown({ project: "Lumen launch film", entries: [], undated: [], dropped: 0, now: local(7, 15, 0) })).toBe(
      "# Lumen launch film — change log\nExported 2026-10-07 15:00\n\nNothing yet.\n",
    );
    expect(logMarkdown({ project: "P", entries: entries.slice(0, 1), undated: [], dropped: 0, earlier: 4, now: local(7, 15, 0) })).toContain("\n\n4 earlier entries not shown.\n");
  });
  it("the Send-to-agent block is the last five lines, newest first, and nothing for an empty log", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ at: local(7, 10, 6 - i).toISOString(), text: `Line ${6 - i}` }));
    expect(recentChanges(six)).toBe(
      "Recent changes (newest first):\n- 2026-10-07 10:06 Line 6\n- 2026-10-07 10:05 Line 5\n- 2026-10-07 10:04 Line 4\n- 2026-10-07 10:03 Line 3\n- 2026-10-07 10:02 Line 2",
    );
    expect(recentChanges([])).toBe("");
  });
  it("the area words match the mockup's chips", () => {
    expect(AREA_LABELS).toEqual({ script: "Script", picture: "Picture", voice: "Voice", music: "Music", sfx: "Sound effects", mix: "Mix", notes: "Notes", assets: "Files", project: "Project" });
  });
});

it("logText.ts imports only labels.ts, so the dashboard can bundle it without zod or Node", () => {
  const text = readFileSync(new URL("../../src/core/logText.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, removeComments: true } }).outputText;
  const imports = js.split("\n").filter((l) => /^\s*(import|export\s*(\*|\{[^}]*\})\s*from)\b/.test(l));
  expect(imports).toEqual(['import { oneLine } from "./labels.js";']);
  expect(/\bimport\s*\(|\brequire\s*\(/.test(js)).toBe(false);
  expect(text).not.toMatch(/\(\?<[=!]/);
});
```

- [ ] **Step 2: Run them and see them fail.** Run: `npx vitest run test/core/logText.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Write `src/core/logText.ts`:**

```ts
// §22: the Change Log's shared words and dates, for the server, the CLI and the dashboard alike.
// Pure; its only import is labels.ts, which has none, because the dashboard bundles this file
// (test/core/logText.test.ts checks it).
import { oneLine } from "./labels.js";

export const LOG_AREAS = ["script", "picture", "voice", "music", "sfx", "mix", "notes", "assets", "project"] as const;
export type LogArea = (typeof LOG_AREAS)[number];
export const LOG_KINDS = ["cut", "variant", "take", "script", "picks", "notes-sent", "replies", "lock", "files", "entry"] as const;
export type LogKind = (typeof LOG_KINDS)[number];
export const LOG_BY = ["user", "agent", "rushes"] as const;
export type LogBy = (typeof LOG_BY)[number];

/** The most lines log.json keeps; past it the oldest go (§22.3). */
export const LOG_MAX = 5000;
/** A line is at most this long (§22.3). */
export const LOG_TEXT_MAX = 160;
/** §22.5: a line of the same kind and area by the same writer within this long merges (R4). */
export const MERGE_MS = 2 * 60_000;
/** §22.5: consecutive pick changes within this long are one line. */
export const PICKS_MERGE_MS = 10 * 60_000;

/** The words for an area: the filter chips, the row tags, the Markdown and the CLI (the mockup's labels). */
export const AREA_LABELS: Record<LogArea, string> = {
  script: "Script", picture: "Picture", voice: "Voice", music: "Music", sfx: "Sound effects", mix: "Mix", notes: "Notes", assets: "Files", project: "Project",
};
/** Who wrote a line, in the Markdown and the CLI. */
export const BY_WORDS: Record<LogBy, string> = { user: "you", agent: "agent", rushes: "Rushes" };

/** A Change Log line as the API sends it (the stored entry, §22.3). */
export interface LogLine {
  id: string;
  at: string;
  area: LogArea;
  kind: LogKind;
  text: string;
  video: string | null;
  version: string | null;
  ref: string | null;
  by: LogBy;
  /** The tab a Notes line opens (R3). */
  tab?: string | null;
}

/** A "Before the log" line (§22.6): audio from before the log, computed when it's read. */
export interface UndatedLine {
  area: "voice" | "music" | "sfx";
  text: string;
}

/** A line of text as the log keeps it: one line, 160 characters at most. */
export function logText(text: string): string {
  return oneLine(text, LOG_TEXT_MAX);
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "14:32", local time. */
export function clock(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "2026-10-07", the local date. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "2026-10-07 14:32", local. */
export function localStamp(d: Date): string {
  return `${localDate(d)} ${clock(d)}`;
}

/**
 * A day's heading (§22.8). In the drawer: "Today", "Yesterday", then "Mon 5 Oct" (with the year
 * when it isn't this one). In a file, where "today" goes stale: "Wednesday 7 October 2026".
 */
export function dayHeading(d: Date, now: Date, relative: boolean): string {
  if (!relative) return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  if (localDate(d) === localDate(now)) return "Today";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (localDate(d) === localDate(yesterday)) return "Yesterday";
  const year = d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${DAYS[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}${year}`;
}

/** §22.7 (R17): the export's name, dated by the local clock. */
export function changeLogFileName(now: Date): string {
  return `change-log-${localDate(now)}.md`;
}

export interface LogMarkdownInput {
  project: string;
  /** Newest first. */
  entries: Pick<LogLine, "at" | "area" | "text" | "by">[];
  undated: Pick<UndatedLine, "text">[];
  dropped: number;
  /** Lines left out of `entries` (a limited `rushes log --md`). */
  earlier?: number;
  now: Date;
}

/** §22.7: the log as Markdown. Newest first, one heading per day; what Export writes and `rushes log --md` prints. */
export function logMarkdown(i: LogMarkdownInput): string {
  const lines = [`# ${i.project} — change log`, `Exported ${localStamp(i.now)}`];
  if (i.entries.length === 0 && i.undated.length === 0) lines.push("", "Nothing yet.");
  let day = "";
  for (const e of i.entries) {
    const d = new Date(e.at);
    const heading = dayHeading(d, i.now, false);
    if (heading !== day) {
      day = heading;
      lines.push("", `## ${heading}`);
    }
    lines.push(`- ${clock(d)} · ${AREA_LABELS[e.area]} · ${e.text} (${BY_WORDS[e.by]})`);
  }
  if (i.earlier) lines.push("", `${i.earlier} earlier entr${i.earlier === 1 ? "y" : "ies"} not shown.`);
  if (i.undated.length) {
    lines.push("", "## Before the log");
    for (const u of i.undated) lines.push(`- ${u.text}`);
  }
  if (i.dropped > 0) lines.push("", "Earlier entries were removed.");
  return lines.join("\n") + "\n";
}

/** §22.7: Send to agent's "Recent changes" block. The last `max` lines, newest first; empty when there are none. */
export function recentChanges(entries: Pick<LogLine, "at" | "text">[], max = 5): string {
  const top = entries.slice(0, max);
  if (top.length === 0) return "";
  return ["Recent changes (newest first):", ...top.map((e) => `- ${localStamp(new Date(e.at))} ${e.text}`)].join("\n");
}
```

- [ ] **Step 4: Run them.** Run: `npx vitest run test/core/logText.test.ts`. Expected: PASS.

- [ ] **Step 5: Write the failing engine tests** at `test/core/log.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { appendEvent, backfillLog, logView, undatedLines, undatedRefs, type LogEvent } from "../../src/core/log.js";
import {
  FILE_FOLDERS, broughtInEvent, cutEvent, fileEvent, lineEvent, lockEvent, notesSentEvent, picksEvent, repliesEvent, scriptEvent, takeEvent, variantEvent,
} from "../../src/core/logEvents.js";
import { LogFileSchema, type BatchesFile, type LogFile, type Project, type Script } from "../../src/core/schema.js";
import { addFile, addVariant, addVersion } from "../../src/core/project.js";
import { FOLDERS } from "../../web/src/lib.js";

const empty = (): LogFile => ({ schema: 1, rev: 0, backfilled: true, undated: [], dropped: 0, entries: [] });
const T0 = Date.UTC(2026, 9, 7, 9, 0);
const at = (min: number) => new Date(T0 + min * 60_000);
const texts = (f: LogFile) => [...f.entries].reverse().map((e) => e.text);
const music = { id: "night-drive", stage: "music" as const, name: "night-drive" };
const sfx = { id: "sfx", stage: "sfx" as const, name: "Sound effects" };

describe("the words of each line (§22.5, R9)", () => {
  it("cuts: the short label, the film when there are several, and a merged count", () => {
    const one = cutEvent(1, { id: "lumen", name: "Lumen" }, { id: "v6", note: "v6: launch 1.45x slower; more", file: "a.mp4" });
    expect(one).toMatchObject({ area: "picture", kind: "cut", text: "v6 added: launch 1.45x slower", video: "lumen", version: "v6", merge: "count" });
    expect(one.many!(3, "lumen")).toBe("3 cuts added, the latest v6: launch 1.45x slower");
    const two = cutEvent(2, { id: "teaser", name: "Teaser" }, { id: "v2", note: "", file: "renders/teaser_v2.mp4", label: "Shorter end card" });
    expect(two.text).toBe("Teaser v2 added: Shorter end card");
    expect(two.many!(2, "teaser")).toBe("2 cuts added to Teaser, the latest Teaser v2: Shorter end card");
    expect(two.many!(2, "")).toBe("2 cuts added, the latest Teaser v2: Shorter end card");
  });
  it("variants and reads: the name in quotes, the lane unless it's the stage's own", () => {
    const bed = variantEvent(music, { id: "night-drive", name: "Night drive, driving drop" });
    expect(bed).toMatchObject({ area: "music", kind: "variant", text: "Music: “Night drive, driving drop” added to night-drive", ref: "night-drive/night-drive" });
    expect(bed.many!(3, "night-drive")).toBe("Music: 3 variants added to night-drive");
    expect(bed.many!(2, "")).toBe("Music: 2 variants added");
    expect(variantEvent({ id: "music", stage: "music", name: "Music" }, { id: "bed", name: "Bed" }).text).toBe("Music: “Bed” added");
    const read = variantEvent({ id: "round-2-jules", stage: "voice", name: "Round 2 · Jules" }, { id: "full", name: "Jules, full read" });
    expect(read.text).toBe("Voiceover: “Jules, full read” added to Round 2 · Jules");
    expect(read.many!(1, "Round 2 · Jules")).toBe("Voiceover: 1 read added to Round 2 · Jules");
  });
  it("takes, the script, picks and lock", () => {
    const take = takeEvent({ id: "s1", current: "Every launch starts with a single request." }, { id: "t2" }, 2);
    expect(take).toMatchObject({ area: "voice", kind: "take", text: "Voiceover: take 2 added to S1 “Every launch starts with a…”", ref: "s1:t2" });
    expect(take.many!(3, "S1")).toBe("Voiceover: 3 takes added to S1");
    expect(takeEvent({ id: "s2", current: "  " }, { id: "t1" }, 1).text).toBe("Voiceover: take 1 added to S2");
    expect(scriptEvent(6)).toMatchObject({ area: "script", kind: "script", text: "Script set: 6 sections", merge: "replace" });
    expect(scriptEvent(1).text).toBe("Script set: 1 section");
    const lanes = [
      { id: "round-1", stage: "voice" as const, name: "Round 1", variants: [{ id: "jules", name: "Vo Jules, full read", file: "a.wav", meta: {}, cues: [] }] },
      { id: "music", stage: "music" as const, name: "Music", variants: [{ id: "held", name: "Night drive, held back", file: "b.wav", meta: {}, cues: [] }] },
    ];
    expect(picksEvent({ lanes }, { "round-1": "jules", music: "held" })).toMatchObject({
      area: "mix", kind: "picks", text: "Picks: voice “Vo Jules, full read”, music “Night drive, held back”", merge: "replace", windowMs: 600_000,
    });
    expect(picksEvent({ lanes }, {}).text).toBe("Picks cleared");
    expect(lockEvent(1, { id: "lumen", name: "Lumen", lockedVersion: "v6" })).toMatchObject({ text: "Picture locked at v6", video: "lumen", version: "v6", subject: "lumen" });
    expect(lockEvent(1, { id: "lumen", name: "Lumen", lockedVersion: null }).text).toBe("Picture unlocked");
    expect(lockEvent(2, { id: "teaser", name: "Teaser", lockedVersion: "v2" }).text).toBe("Picture locked at Teaser v2");
    expect(lockEvent(2, { id: "teaser", name: "Teaser", lockedVersion: null }).text).toBe("Picture unlocked for Teaser");
  });
  it("notes sent, replies, files, bring-ins and a line somebody wrote", () => {
    expect(notesSentEvent({ stage: "picture", noteIds: ["a", "b", "c"], sectionIds: [] })).toMatchObject({ area: "notes", kind: "notes-sent", text: "3 notes sent from Picture", tab: "picture", count: 3 });
    expect(notesSentEvent({ stage: "script", noteIds: ["a"], sectionIds: ["s1", "s2"] }).text).toBe("1 note and 2 script edits sent from Script");
    expect(notesSentEvent({ stage: "script", noteIds: [], sectionIds: ["s1"] }).text).toBe("1 script edit sent from Script");
    expect(notesSentEvent({ stage: "picture", noteIds: ["a"], sectionIds: [] }).many!(5, "")).toBe("5 notes sent from several tabs");
    expect(repliesEvent([{ status: "done", stage: "picture" }, { status: "done", stage: "picture" }, { status: "todo", stage: "picture" }])).toMatchObject({
      area: "notes", kind: "replies", text: "Agent replied to 3 notes (2 done)", tab: "picture", merge: "once",
    });
    expect(repliesEvent([{ status: "todo", stage: "music" }, { status: "todo", stage: "picture" }])).toMatchObject({ text: "Agent replied to 2 notes", tab: null });
    const file = fileEvent({ kind: "doc", name: "Creative brief" });
    expect(file).toMatchObject({ area: "assets", kind: "files", text: "File added: Creative brief (Scripts & docs)" });
    expect(file.many!(2, "Scripts & docs")).toBe("2 files added: Scripts & docs");
    expect(broughtInEvent([{ lane: "music", variant: "bed" }, { lane: "vo-jules", variant: "read" }, {}], "v6")).toMatchObject({
      area: "assets", kind: "files", text: "Brought in 3 files with v6", count: 3, clears: ["music/bed", "vo-jules/read"],
    });
    expect(lineEvent("Kept the wide", "picture", { video: "hero", version: "v1" })).toMatchObject({ kind: "entry", merge: "once", area: "picture", video: "hero", version: "v1" });
  });
  it("names the Assets folders exactly as the dashboard does (§16.1)", () => {
    for (const [kind, title] of Object.entries(FILE_FOLDERS)) expect(FOLDERS.find((f) => f.id === kind)?.title, kind).toBe(title);
  });
});

describe("appendEvent (§22.5, R4, Review Focus 3)", () => {
  it("merges into the newest of its kind, area and writer within two minutes, interleaved or not, and moves it to the top", () => {
    const f = empty();
    appendEvent(f, variantEvent(music, { id: "a", name: "A" }), "agent", at(0));
    appendEvent(f, variantEvent(sfx, { id: "p", name: "Pass" }), "agent", at(0.5));
    appendEvent(f, variantEvent(music, { id: "b", name: "B" }), "agent", at(1));
    expect(texts(f)).toEqual(["Music: 2 variants added to night-drive", "Sound effects: “Pass” added"]);
    expect(f.entries[1]).toMatchObject({ n: 2, ref: "night-drive/b", at: at(1).toISOString() });
    appendEvent(f, variantEvent(music, { id: "c", name: "C" }), "agent", at(3.5)); // 2.5 min after the last music
    expect(texts(f)[0]).toBe("Music: “C” added to night-drive");
    expect(f.entries).toHaveLength(3);
  });
  it("never merges two writers, or a count across different subjects without dropping the subject", () => {
    const f = empty();
    appendEvent(f, variantEvent(music, { id: "a", name: "A" }), "agent", at(0));
    appendEvent(f, variantEvent(music, { id: "b", name: "B" }), "user", at(0.1));
    expect(f.entries).toHaveLength(2);
    appendEvent(f, variantEvent({ id: "other", stage: "music", name: "other" }, { id: "c", name: "C" }), "agent", at(0.2));
    expect(texts(f)[0]).toBe("Music: 2 variants added");
  });
  it("replace keeps the newest line for the same subject only, and picks merge within ten minutes", () => {
    const f = empty();
    appendEvent(f, lockEvent(2, { id: "hero", name: "Hero", lockedVersion: "v3" }), "user", at(0));
    appendEvent(f, lockEvent(2, { id: "hero", name: "Hero", lockedVersion: null }), "user", at(1));
    appendEvent(f, lockEvent(2, { id: "teaser", name: "Teaser", lockedVersion: "v2" }), "user", at(1.5));
    expect(texts(f)).toEqual(["Picture locked at Teaser v2", "Picture unlocked for Hero"]);
    const lanes = [{ id: "music", stage: "music" as const, name: "Music", variants: [{ id: "a", name: "A", file: "a.wav", meta: {}, cues: [] }, { id: "b", name: "B", file: "b.wav", meta: {}, cues: [] }] }];
    const p = empty();
    appendEvent(p, picksEvent({ lanes }, { music: "a" }), "user", at(0));
    appendEvent(p, picksEvent({ lanes }, { music: "b" }), "user", at(9));
    appendEvent(p, picksEvent({ lanes }, { music: "a" }), "user", at(20));
    expect(texts(p)).toEqual(["Picks: music “A”", "Picks: music “B”"]);
  });
  it("once never merges, but an identical repeat (a retried request) isn't doubled (§22.9)", () => {
    const f = empty();
    const reply = repliesEvent([{ status: "done", stage: "picture" }]);
    appendEvent(f, reply, "agent", at(0));
    appendEvent(f, reply, "agent", at(0.2));
    appendEvent(f, repliesEvent([{ status: "todo", stage: "picture" }]), "agent", at(0.3));
    expect(texts(f)).toEqual(["Agent replied to 1 note", "Agent replied to 1 note (1 done)"]);
  });
  it("stores one clean line and keeps the newest 5000, counting what it drops (Review Focus 2 and 5)", () => {
    const f = empty();
    const e = appendEvent(f, lineEvent("  A decision\nmade late\t", "project"), "agent", at(0));
    expect(e.text).toBe("A decision made late");
    for (let i = 0; i < 5001; i++) appendEvent(f, lineEvent(`Line ${i}`, "project"), "agent", at(i));
    expect(f.entries).toHaveLength(5000);
    expect(f.dropped).toBe(2);
    expect(f.entries[0].text).toBe("Line 1");
    expect(LogFileSchema.safeParse(f).success).toBe(true);
  });
  it("a live event about an undated ref dates it: it leaves Before the log (R5)", () => {
    const f = { ...empty(), undated: ["night-drive/a", "music/bed", "s1:t1"] };
    appendEvent(f, variantEvent(music, { id: "a", name: "A" }), "agent", at(0));
    appendEvent(f, broughtInEvent([{ lane: "music", variant: "bed" }], null), "rushes", at(1));
    expect(f.undated).toEqual(["s1:t1"]);
  });
});

describe("backfill and reading back (§22.6)", () => {
  const project = (): Project => {
    const p: Project = { schema: 1, rev: 0, name: "Lumen launch film", fps: 30, videos: [], lanes: [], files: [], autoProxy: false };
    addVersion(p, { video: "Hero", file: "renders/hero_v1.mp4", note: "v1: first pass; rough" }, at(-3000));
    addVersion(p, { video: "Hero", file: "renders/hero_v2.mp4", note: "v2 (batch b_1): tighter cut" }, at(-1000));
    addVersion(p, { video: "Hero", file: "renders/hero_v3.mp4", note: "v3: after the log began" }, at(10));
    addFile(p, { kind: "doc", file: "brief.md", name: "Creative brief" }, at(-3100));
    for (const name of ["Night drive", "Held back", "Quiet bed"]) addVariant(p, { stage: "music", lane: "night-drive", name, file: `audio/${name}.wav` });
    p.videos[0].versions.push({ ...p.videos[0].versions[0], id: "v9", addedAt: "" }); // a date that doesn't parse
    return p;
  };
  const batches: BatchesFile = { schema: 1, rev: 1, batches: [{ id: "b_1", stage: "picture", noteIds: ["n_1", "n_2"], sectionIds: [], sentAt: at(-2000).toISOString(), prompt: "" }] };
  const script: Script = { schema: 1, rev: 0, wordsPerSecond: 2.6, sections: [{ id: "s1", start: 0, end: 4, current: "A line.", proposed: null, direction: "", status: "draft", takes: [{ id: "t1", file: "t.wav", duration: null, forText: "A line." }] }] };

  it("reads in what is dated before `before`, in time order and by Rushes, once; skips dates that don't parse", () => {
    const f: LogFile = { schema: 1, rev: 0, backfilled: false, undated: [], dropped: 0, entries: [] };
    backfillLog(f, { project: project(), batches, script }, T0);
    expect(texts(f)).toEqual(["v2 added: tighter cut", "2 notes sent from Picture", "v1 added: first pass", "File added: Creative brief (Scripts & docs)"]);
    expect(f.entries.every((e) => e.by === "rushes")).toBe(true);
    expect(f.backfilled).toBe(true);
    expect(f.undated).toEqual(["night-drive/night-drive", "night-drive/held-back", "night-drive/quiet-bed", "s1:t1"]);
    backfillLog(f, { project: project(), batches, script }, T0);
    expect(f.entries).toHaveLength(4);
  });
  it("Before the log: one line per lane and one for takes, only for what still exists (Review Focus 4)", () => {
    const p = project();
    expect(undatedLines(undatedRefs(p, script), { project: p, script })).toEqual([
      { area: "music", text: "Music: night-drive (3 variants)" },
      { area: "voice", text: "Voiceover: 1 section with takes" },
    ]);
    expect(undatedLines(["gone/x", "night-drive/missing", "s9:t1"], { project: p, script })).toEqual([]);
    const voice: Project = { ...p, lanes: [{ id: "round-1", stage: "voice", name: "Round 1 · Voices", variants: [{ id: "jane", name: "Jane", file: "j.wav", meta: {}, cues: [] }, { id: "gerald", name: "Gerald", file: "g.wav", meta: {}, cues: [] }] }] };
    expect(undatedLines(["round-1/jane", "round-1/gerald"], { project: voice, script: { sections: [] } })).toEqual([{ area: "voice", text: "Voiceover: Round 1 · Voices (2 reads)" }]);
  });
  it("logView: newest first, limit, area, since, and how many it left out", () => {
    const f = empty();
    for (const [i, area] of (["picture", "music", "picture"] as const).entries()) appendEvent(f, lineEvent(`Line ${i}`, area), "agent", at(i * 5));
    const p = project();
    const ctx = { project: p, script };
    f.undated = ["night-drive/night-drive"];
    expect(logView(f, {}, ctx)).toMatchObject({ earlier: 0, total: 3, dropped: 0, undated: [{ area: "music", text: "Music: night-drive (1 variant)" }] });
    expect(logView(f, {}, ctx).entries.map((e) => e.text)).toEqual(["Line 2", "Line 1", "Line 0"]);
    expect(logView(f, { limit: 1 }, ctx)).toMatchObject({ earlier: 2, entries: [{ text: "Line 2" }] });
    expect(logView(f, { area: "picture" }, ctx).entries.map((e) => e.text)).toEqual(["Line 2", "Line 0"]);
    expect(logView(f, { area: "picture" }, ctx).undated).toEqual([]);
    expect(logView(f, { since: at(4).toISOString() }, ctx)).toMatchObject({ entries: [{ text: "Line 2" }, { text: "Line 1" }], undated: [] });
  });
});
```

- [ ] **Step 6: Run them and see them fail.** Run: `npx vitest run test/core/log.test.ts`. Expected: FAIL (modules missing).

- [ ] **Step 7: Add the schema and the store key.**
  - `src/core/schema.ts`: under `import { z } from "zod";` add `import { LOG_AREAS, LOG_BY, LOG_KINDS, LOG_MAX, LOG_TEXT_MAX } from "./logText.js";`. After `export type FoundFileData = …;` (line 283) add:

```ts
// §22.3: the Change Log, .rushes/log.json, oldest first on disk. Written by the server as things
// happen, created on its first write. Every field is new, so nothing older reads differently.
export const LogEntrySchema = z.object({
  id,
  at: z.string(),
  area: z.enum(LOG_AREAS),
  kind: z.enum(LOG_KINDS),
  text: z.string().min(1).max(LOG_TEXT_MAX),
  video: z.string().nullable().default(null),
  version: z.string().nullable().default(null),
  ref: z.string().max(300).nullable().default(null),
  by: z.enum(LOG_BY),
  // R3: the tab a Notes line opens, how many events the line stands for, and what a run of them
  // is about (a lane, a section, a film, a folder), so a burst collapses (§22.5).
  tab: StageSchema.nullable().default(null),
  n: z.number().int().positive().default(1),
  subject: z.string().max(200).default(""),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

export const LogFileSchema = z.object({
  schema: z.literal(1),
  rev: z.number().int().nonnegative(),
  // §22.6: set once the dated history has been read in, so it never happens twice.
  backfilled: z.boolean().default(false),
  // R5: the variants and takes already there when the log began ("<lane>/<variant>", "<section>:<take>").
  undated: z.array(z.string().max(300)).max(LOG_MAX).default([]),
  // §22.9: how many lines the 5000 cap has dropped.
  dropped: z.number().int().nonnegative().default(0),
  entries: z.array(LogEntrySchema).max(LOG_MAX).default([]),
});
export type LogFile = z.infer<typeof LogFileSchema>;
```

  - Add `log: { name: "log.json", schema: LogFileSchema },` to `FILES` after `found`, and `log: LogFile;` to `FileData` after `found`.
  - `src/core/store.ts`: in `defaults`, after the `found` case, add `case "log": return { schema: 1, rev: 0, backfilled: false, undated: [], dropped: 0, entries: [] };`. Change `CREATED_ON_WRITE` to `new Set<FileKey>(["found", "log"])`, and its comment to "Files `init` doesn't write (found.json, log.json). …".

- [ ] **Step 8: Write `src/core/logEvents.ts`:**

```ts
// §22.5: the words for each thing Rushes logs, one builder per event. Built from short labels and
// names, never from a note's or a reply's text. R9 fixes the wording.
import { clip, oneLineOf, shortLabel, type Labelled } from "./labels.js";
import type { LogEvent } from "./log.js";
import { PICKS_MERGE_MS, type LogArea } from "./logText.js";
import type { Batch, FileEntry, FileKind, Lane, LaneStage, Note, Picks, Project, Section, Stage, Take, Variant, Video } from "./schema.js";

/** The tabs' own names, as the dashboard shows them. */
export const TAB_NAMES: Record<Stage, string> = { script: "Script", picture: "Picture", voice: "Voiceover", music: "Music", sfx: "Sound effects", mix: "Mix" };
/** How a lane's stage starts a line. It's also its default lane's name (project.ts LANE_NAMES), which "to <lane>" leaves out. */
export const STAGE_WORDS: Record<LaneStage, string> = { voice: "Voiceover", music: "Music", sfx: "Sound effects" };
/** §16.1's Assets folders, by the kind of file they hold (web/src/lib.ts FOLDERS; test/core/log.test.ts keeps them equal). */
export const FILE_FOLDERS: Record<FileKind, string> = { doc: "Scripts & docs", image: "Images", caption: "Captions", export: "Exports", delivery: "Delivery", edit: "Edit files" };
const PICK_WORDS: Record<LaneStage, string> = { voice: "voice", music: "music", sfx: "sound effects" };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const quoted = (s: string) => `“${oneLineOf(s)}”`;

/** "v6" on a one-film project; "Teaser v2" when there are more (R9). */
export function cutName(films: number, video: Pick<Video, "name">, versionId: string): string {
  return films > 1 ? `${video.name} ${versionId}` : versionId;
}

/** "v6 added: launch 1.45x slower". */
export function cutEvent(films: number, video: Pick<Video, "id" | "name">, version: Labelled): LogEvent {
  const name = cutName(films, video, version.id);
  const label = shortLabel(version);
  return {
    area: "picture", kind: "cut", merge: "count", subject: video.id,
    text: `${name} added: ${label}`,
    video: video.id, version: version.id,
    many: (n, subject) => `${n} cuts added${films > 1 && subject ? ` to ${video.name}` : ""}, the latest ${name}: ${label}`,
  };
}

/** `Music: “Night drive, driving drop” added to night-drive`; a voice read is a "read". */
export function variantEvent(lane: Pick<Lane, "id" | "stage" | "name">, variant: Pick<Variant, "id" | "name">): LogEvent {
  const word = STAGE_WORDS[lane.stage];
  const [one, many] = lane.stage === "voice" ? ["read", "reads"] : ["variant", "variants"];
  const to = (name: string) => (name && name !== word ? ` to ${name}` : "");
  return {
    area: lane.stage, kind: "variant", merge: "count", subject: lane.name,
    text: `${word}: ${quoted(variant.name)} added${to(lane.name)}`,
    ref: `${lane.id}/${variant.id}`,
    many: (n, subject) => `${word}: ${plural(n, one, many)} added${to(subject)}`,
  };
}

/** `Voiceover: take 2 added to S1 “Every launch starts with a…”`. */
export function takeEvent(section: Pick<Section, "id" | "current">, take: Pick<Take, "id">, number: number): LogEvent {
  const where = section.id.toUpperCase();
  const line = oneLineOf(section.current);
  return {
    area: "voice", kind: "take", merge: "count", subject: where,
    text: `Voiceover: take ${number} added to ${where}${line ? ` ${quoted(clip(line, 32))}` : ""}`,
    ref: `${section.id}:${take.id}`,
    many: (n, subject) => `Voiceover: ${plural(n, "take", "takes")} added${subject ? ` to ${subject}` : ""}`,
  };
}

/** "Script set: 6 sections". */
export function scriptEvent(sections: number): LogEvent {
  return { area: "script", kind: "script", merge: "replace", text: `Script set: ${plural(sections, "section", "sections")}` };
}

/** `Picks: voice “Vo Jules, full read”, music “Night drive, held back”`, the whole set after the change. */
export function picksEvent(project: Pick<Project, "lanes">, lanes: Picks["lanes"]): LogEvent {
  const parts: string[] = [];
  for (const lane of project.lanes) {
    const v = lane.variants.find((x) => x.id === lanes[lane.id]);
    if (v) parts.push(`${PICK_WORDS[lane.stage]} ${quoted(v.name)}`);
  }
  return { area: "mix", kind: "picks", merge: "replace", windowMs: PICKS_MERGE_MS, text: parts.length ? `Picks: ${parts.join(", ")}` : "Picks cleared" };
}

/** "Picture locked at v6", "Picture unlocked". */
export function lockEvent(films: number, video: Pick<Video, "id" | "name" | "lockedVersion">): LogEvent {
  const text = video.lockedVersion ? `Picture locked at ${cutName(films, video, video.lockedVersion)}` : `Picture unlocked${films > 1 ? ` for ${video.name}` : ""}`;
  return { area: "picture", kind: "lock", merge: "replace", subject: video.id, text, video: video.id, version: video.lockedVersion };
}

/** "3 notes sent from Picture"; on Script, "1 note and 2 script edits sent from Script". */
export function notesSentEvent(batch: Pick<Batch, "stage" | "noteIds" | "sectionIds">): LogEvent {
  const tab = TAB_NAMES[batch.stage];
  const notes = batch.noteIds.length;
  const edits = batch.sectionIds.length;
  const what = notes && edits
    ? `${plural(notes, "note", "notes")} and ${plural(edits, "script edit", "script edits")}`
    : edits ? plural(edits, "script edit", "script edits") : plural(notes, "note", "notes");
  return {
    area: "notes", kind: "notes-sent", merge: "count", count: Math.max(1, notes + edits), subject: tab, tab: batch.stage,
    text: `${what} sent from ${tab}`,
    many: (n, subject) => `${plural(n, "note", "notes")} sent from ${subject || "several tabs"}`,
  };
}

/** "Agent replied to 3 notes (2 done)", one line per reply call (§22.5). */
export function repliesEvent(notes: Pick<Note, "status" | "stage">[]): LogEvent {
  const done = notes.filter((n) => n.status === "done").length;
  const stages = new Set(notes.map((n) => n.stage));
  return {
    area: "notes", kind: "replies", merge: "once", tab: stages.size === 1 ? [...stages][0] : null,
    text: `Agent replied to ${plural(notes.length, "note", "notes")}${done ? ` (${done} done)` : ""}`,
  };
}

/** "File added: Creative brief (Scripts & docs)"; merged, "2 files added: Scripts & docs". */
export function fileEvent(entry: Pick<FileEntry, "kind" | "name">): LogEvent {
  const folder = FILE_FOLDERS[entry.kind];
  return {
    area: "assets", kind: "files", merge: "count", subject: folder,
    text: `File added: ${oneLineOf(entry.name)} (${folder})`,
    many: (n, subject) => `${plural(n, "file", "files")} added${subject ? `: ${subject}` : ""}`,
  };
}

/** "Brought in 3 files with v6" (R9). Its variants leave Before the log (R5). */
export function broughtInEvent(added: { lane?: string; variant?: string }[], cut: string | null): LogEvent {
  return {
    area: "assets", kind: "files", merge: "count", count: Math.max(1, added.length), subject: cut ?? "",
    text: `Brought in ${plural(added.length, "file", "files")}${cut ? ` with ${cut}` : ""}`,
    clears: added.filter((a) => a.lane && a.variant).map((a) => `${a.lane}/${a.variant}`),
    many: (n, subject) => `Brought in ${plural(n, "file", "files")}${subject ? ` with ${subject}` : ""}`,
  };
}

/** A line somebody wrote (§22.7): never merged, except that an identical repeat isn't doubled. */
export function lineEvent(text: string, area: LogArea, link: { video?: string | null; version?: string | null; ref?: string | null } = {}): LogEvent {
  return { area, kind: "entry", merge: "once", text, ...link };
}
```

- [ ] **Step 9: Write `src/core/log.ts`:**

```ts
// §22.5–§22.6: the Change Log's engine. Appending with collapsing (R4) and the 5000 cap, the
// one-time backfill (R6), "Before the log" (R5) and reading a page back. Pure apart from new ids;
// the server's LogBook owns the file.
import { newId } from "./ids.js";
import { STAGE_WORDS, cutEvent, fileEvent, notesSentEvent } from "./logEvents.js";
import { LOG_MAX, MERGE_MS, logText, type LogArea, type LogBy, type LogKind, type UndatedLine } from "./logText.js";
import type { BatchesFile, LogEntry, LogFile, Project, Script, Stage } from "./schema.js";

/** One thing that happened, as a builder in logEvents.ts describes it. */
export interface LogEvent {
  area: LogArea;
  kind: LogKind;
  /** The line for this one event. It's made one line and cut to 160 characters when stored. */
  text: string;
  video?: string | null;
  version?: string | null;
  ref?: string | null;
  /** The tab a Notes line opens (R3, R18). */
  tab?: Stage | null;
  /** R4: "count" sums `count` and rewrites the line with `many`; "replace" keeps the newest line for the same `subject`; "once" only drops an identical repeat. */
  merge: "count" | "replace" | "once";
  count?: number;
  subject?: string;
  many?: (n: number, subject: string) => string;
  /** How soon after the last one this still merges (MERGE_MS unless given; picks use PICKS_MERGE_MS). */
  windowMs?: number;
  /** Undated refs this event dates, so they leave Before the log (R5). `ref` counts too. */
  clears?: string[];
}

/** The newest entry this event may merge into: same kind, area and writer, within the window (R4). */
function mergeTarget(entries: LogEntry[], event: LogEvent, by: LogBy, t: number): number {
  const window = event.windowMs ?? MERGE_MS;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!(t - Date.parse(e.at) <= window)) return -1; // older than the window, and so is everything before it
    if (e.kind === event.kind && e.area === event.area && e.by === by) return i;
  }
  return -1;
}

type Link = Pick<LogEntry, "video" | "version" | "ref" | "tab">;

function mergeInto(e: LogEntry, event: LogEvent, text: string, subject: string, count: number, link: Link): boolean {
  if (event.merge === "once") return e.text === text;
  if (event.merge === "replace") {
    if (e.subject !== subject) return false;
    e.text = text;
    e.n += 1;
    Object.assign(e, link);
    return true;
  }
  e.n += count;
  e.subject = e.subject === subject ? subject : "";
  e.text = logText(event.many ? event.many(e.n, e.subject) : text);
  Object.assign(e, link);
  return true;
}

/** §22.5: writes `event` into `file` at `at`, merging it into a recent line when R4 says so, and keeps the newest LOG_MAX. Returns the line written or updated. */
export function appendEvent(file: LogFile, event: LogEvent, by: LogBy, at: Date, id: string = newId("l")): LogEntry {
  const t = at.getTime();
  const iso = at.toISOString();
  const text = logText(event.text);
  // The schema keeps a subject to 200 characters; a lane name has no limit of its own.
  const subject = Array.from(event.subject ?? "").slice(0, 200).join("");
  const count = Math.max(1, Math.floor(event.count ?? 1));
  const link: Link = { video: event.video ?? null, version: event.version ?? null, ref: event.ref ?? null, tab: event.tab ?? null };
  const dated = [...(event.ref ? [event.ref] : []), ...(event.clears ?? [])];
  if (dated.length && file.undated.length) {
    const gone = new Set(dated);
    file.undated = file.undated.filter((r) => !gone.has(r));
  }
  const i = mergeTarget(file.entries, event, by, t);
  if (i >= 0) {
    const e = file.entries[i];
    if (mergeInto(e, event, text, subject, count, link)) {
      if (!(Date.parse(e.at) > t)) e.at = iso;
      file.entries.splice(i, 1);
      file.entries.push(e);
      return e;
    }
  }
  const entry: LogEntry = { id, at: iso, area: event.area, kind: event.kind, text, ...link, by, n: count, subject };
  file.entries.push(entry);
  const extra = file.entries.length - LOG_MAX;
  if (extra > 0) {
    file.entries.splice(0, extra);
    file.dropped += extra;
  }
  return entry;
}

export interface BackfillSource {
  project: Project;
  batches: BatchesFile;
  script: Script;
}

/**
 * §22.6: reads in, once, the history a project already has. Every cut, batch and file dated before
 * `before` (when this server's log began, R6) becomes a line by Rushes, in time order and collapsed
 * as live lines are. The variants and takes already there become `undated` (R5). A no-op once done.
 */
export function backfillLog(file: LogFile, src: BackfillSource, before: number): void {
  if (file.backfilled) return;
  const films = src.project.videos.length;
  const dated: { t: number; event: LogEvent }[] = [];
  const add = (when: string, event: LogEvent) => {
    const t = Date.parse(when);
    if (Number.isFinite(t) && t < before) dated.push({ t, event });
  };
  for (const video of src.project.videos) for (const version of video.versions) add(version.addedAt, cutEvent(films, video, version));
  for (const batch of src.batches.batches) add(batch.sentAt, notesSentEvent(batch));
  for (const entry of src.project.files) add(entry.addedAt, fileEvent(entry));
  dated.sort((a, b) => a.t - b.t);
  const past: LogFile = { schema: 1, rev: 0, backfilled: true, undated: [], dropped: 0, entries: [] };
  for (const d of dated) appendEvent(past, d.event, "rushes", new Date(d.t));
  file.entries = [...past.entries, ...file.entries];
  file.dropped += past.dropped;
  const extra = file.entries.length - LOG_MAX;
  if (extra > 0) {
    file.entries.splice(0, extra);
    file.dropped += extra;
  }
  file.undated = undatedRefs(src.project, src.script);
  file.backfilled = true;
}

/** Every variant ("<lane>/<variant>") and take ("<section>:<take>") the project has. */
export function undatedRefs(project: Pick<Project, "lanes">, script: Pick<Script, "sections">): string[] {
  const refs = [
    ...project.lanes.flatMap((l) => l.variants.map((v) => `${l.id}/${v.id}`)),
    ...script.sections.flatMap((s) => s.takes.map((t) => `${s.id}:${t.id}`)),
  ];
  return refs.slice(0, LOG_MAX);
}

export interface UndatedContext {
  project: Pick<Project, "lanes">;
  script: Pick<Script, "sections">;
}

/** §22.6's "Before the log": one line per lane, and one for takes, computed now from the refs that still exist. */
export function undatedLines(refs: readonly string[], ctx: UndatedContext): UndatedLine[] {
  const set = new Set(refs);
  const out: UndatedLine[] = [];
  for (const lane of ctx.project.lanes) {
    const n = lane.variants.filter((v) => set.has(`${lane.id}/${v.id}`)).length;
    if (n === 0) continue;
    const noun = lane.stage === "voice" ? (n === 1 ? "read" : "reads") : n === 1 ? "variant" : "variants";
    out.push({ area: lane.stage, text: `${STAGE_WORDS[lane.stage]}: ${lane.name} (${n} ${noun})` });
  }
  const sections = ctx.script.sections.filter((s) => s.takes.some((t) => set.has(`${s.id}:${t.id}`))).length;
  if (sections) out.push({ area: "voice", text: `Voiceover: ${sections} section${sections === 1 ? "" : "s"} with takes` });
  return out;
}

export interface LogQuery {
  limit?: number;
  area?: LogArea;
  /** Only lines after this date and time. */
  since?: string;
}

export interface LogView {
  /** Newest first. */
  entries: LogEntry[];
  /** Lines that matched but were left out by `limit`. */
  earlier: number;
  undated: UndatedLine[];
  dropped: number;
  /** Every line in the file. */
  total: number;
}

/** §22.7: the newest `limit` lines (default 30), newest first, matching `area` and `since`. */
export function logView(file: LogFile, q: LogQuery, ctx: UndatedContext): LogView {
  const limit = Math.min(LOG_MAX, Math.max(1, Math.floor(q.limit ?? 30)));
  const from = q.since === undefined ? null : Date.parse(q.since);
  const matching: LogEntry[] = [];
  for (let i = file.entries.length - 1; i >= 0; i--) {
    const e = file.entries[i];
    if (q.area !== undefined && e.area !== q.area) continue;
    if (from !== null && !(Date.parse(e.at) > from)) continue;
    matching.push(e);
  }
  const undated = from !== null ? [] : undatedLines(file.undated, ctx).filter((l) => q.area === undefined || l.area === q.area);
  return { entries: matching.slice(0, limit), earlier: Math.max(0, matching.length - limit), undated, dropped: file.dropped, total: file.entries.length };
}
```

- [ ] **Step 10: Run the core tests and the gates.** Run: `npx vitest run test/core`, then `npm run build && npm run typecheck && npx vitest run`. Expected: PASS. Adding `log` to `FILES` also adds a `file:log` check to doctor (valid) and a watched file to `watch.ts`; every existing test still passes.

- [ ] **Step 11: Commit.**

```bash
git add src/core/logText.ts src/core/logEvents.ts src/core/log.ts src/core/schema.ts src/core/store.ts test/core/logText.test.ts test/core/log.test.ts
git -c user.name=iamredmh -c user.email=17407420+iamredmh@users.noreply.github.com commit -m "feat(core): the Change Log's engine: log.json, one line per event, collapsing, the 5000 cap and a one-time backfill" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

**Mutation check:** changing `mergeTarget` to look at the last entry only (`return entries[i] matches ? i : -1` on the first iteration) must fail "merges into the newest of its kind, area and writer … interleaved or not".

---

### Task 4: The log on the server (§22.5 hooks, §22.6, §22.7 routes, export, prompt, §22.9)

**Files:**
- Create: `src/server/logbook.ts`
- Modify: `src/server/app.ts`:
  - imports (after line 27);
  - `const log`, `by` and `exportChangeLog` (after line 240);
  - routes: files (493), exports/notes (511–514), state (533–545), found scan include (572), bring-in (611–614), replies (662–663), versions (~678–681), lock (806–810), variants (814–815), script (825–827), takes (840–841), picks (847–868) and batches (885–890);
  - new routes `GET`/`POST /api/log` and `POST /api/exports/change-log`.
- Modify: `src/server/found.ts:20-26` (imports), `:662-682` (`adopt`)
- Modify: `src/cli/doctor.ts:324-332`
- Test: new `test/server/log.test.ts`; `test/cli/doctor.test.ts` (append)

**Interfaces:**
- Consumes (Task 3): everything in `log.ts`, `logEvents.ts` and `logText.ts`. Also `anchorCut` (`src/server/found.ts:278`) and `resolveVideo`.
- Produces (`src/server/logbook.ts`):

```ts
export interface LogHead { rev: number; mark: string | null; total: number }   // mark = `${id}@${at}` of the newest line
export function byOf(projectHeader: string | undefined): "user" | "agent";
export function logBookFor(store: Store): LogBook;                               // one per store
export class LogBook {
  constructor(store: Store);
  ready(): Promise<void>;                                                       // backfill once; set a corrupt file aside; never throws
  add(event: LogEvent, by: LogBy, at?: Date): Promise<LogEntry | null>;         // null when it couldn't write (the request still succeeds)
  view(q: LogQuery, ctx: UndatedContext): Promise<LogView>;
  head(): Promise<LogHead | null>;                                              // read-only: never backfills or fixes
  markdown(ctx: UndatedContext & { project: Pick<Project, "name"> }, now: Date): Promise<string>;
}
```

- Produces (routes):
  - **`GET /api/log`:** query `limit` (1–5000, default 30), `area` and `since`. Returns `LogView`.
  - **`POST /api/log`:** body `{ text, area?, video?, version?, ref? }`. Returns `{ entry }` with 201.
  - **`POST /api/exports/change-log`:** returns `{ path }` with 201.
  - **`POST /api/exports/notes`:** also returns `changeLog: string`.
  - **`GET /api/state`:** gains `log: LogHead | null`.
  - **`POST /api/batches`:** the prompt ends with the Recent changes block.

- [ ] **Step 1: Write the failing server tests** at `test/server/log.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { sse } from "../helpers/sse.js";
import { createApp } from "../../src/server/app.js";
import { LogBook } from "../../src/server/logbook.js";
import { startServer } from "../../src/server/start.js";
import { addFile, addVariant, addVersion } from "../../src/core/project.js";
import { lineEvent } from "../../src/core/logEvents.js";
import { Store } from "../../src/core/store.js";

async function setup(name = "Lumen launch film") {
  const { root, store } = await tmpProject(name);
  const app = createApp(store);
  const call = async (method: string, path: string, json?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: json === undefined ? headers : { "content-type": "application/json", ...headers },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const id = (await call("GET", "/api/health")).json.id as string;
  const asUser = { "x-rushes-project": id };
  const texts = async () => (await call("GET", "/api/log?limit=200")).json.entries.map((e: { text: string; by: string }) => `${e.text} | ${e.by}`);
  return { root, store, app, call, asUser, texts };
}

const DAY = 86_400_000;

describe("the server writes the log as things happen (§22.5)", () => {
  it("adds one line per change, at the moment it commits, saying who caused it (R8)", async () => {
    const { root, call, asUser, texts } = await setup();
    await call("POST", "/api/versions", { video: "Lumen launch film", file: `${root}/renders/lumen v1.mp4`, note: "v1: first pass; rough timing" });
    await call("PUT", "/api/videos/lumen-launch-film/lock", { version: "v1" }, asUser);
    await call("POST", "/api/variants", { stage: "music", lane: "night-drive", name: "Night drive", file: "audio/night.wav" });
    await call("PUT", "/api/picks", { lanes: { "night-drive": "night-drive" } }, asUser);
    await call("PUT", "/api/script", { sections: [{ start: 0, end: 4, current: "Every launch starts with a single request." }, { start: 4, end: 8, current: "Then the world asks." }] });
    await call("POST", "/api/script/s1/takes", { file: "audio/s1-take.wav" });
    await call("POST", "/api/notes", { stage: "picture", video: "lumen-launch-film", version: "v1", scope: "point", t: 1, text: "Logo lands early" }, asUser);
    const { batch } = (await call("POST", "/api/batches", { stage: "picture" }, asUser)).json;
    await call("POST", "/api/replies", { replies: [{ id: batch.noteIds[0], reply: "Held it", status: "done" }] });
    await call("POST", "/api/files", { kind: "doc", file: "brief.md", name: "Creative brief" });
    expect(await texts()).toEqual([
      "File added: Creative brief (Scripts & docs) | agent",
      "Agent replied to 1 note (1 done) | agent",
      "1 note sent from Picture | user",
      "Voiceover: take 1 added to S1 “Every launch starts with a…” | agent",
      "Script set: 2 sections | agent",
      "Picks: music “Night drive” | user",
      "Music: “Night drive” added to night-drive | agent",
      "Picture locked at v1 | user",
      "v1 added: first pass | agent",
    ]);
  });

  it("leaves out notes, shots, settings, levels, a lock that changes nothing and the user's script edits (R10)", async () => {
    const { root, call, asUser } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4`, note: "first" });
    await call("PUT", "/api/script", { sections: [{ start: 0, end: 4, current: "A line." }] });
    const count = async () => (await call("GET", "/api/log?limit=200")).json.entries.length;
    const n = await count();
    const note = (await call("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Too dark" }, asUser)).json.note;
    await call("PATCH", `/api/notes/${note.id}`, { text: "Much too dark" }, asUser);
    await call("PUT", "/api/videos/hero/shots", { shots: [{ name: "Wide", start: 0 }] });
    await call("PUT", "/api/project/settings", { autoProxy: true }, asUser);
    await call("PUT", "/api/picks", { levels: { music: -3 } }, asUser);
    await call("PUT", "/api/videos/hero/lock", { version: null }, asUser);
    await call("PATCH", "/api/script/s1", { proposed: "A better line." }, asUser);
    expect(await count()).toBe(n);
  });

  it("collapses a burst: ten variants at once are one line; interleaved music and sound effects are two (§22.11, Review Focus 3)", async () => {
    const { call, texts } = await setup();
    await Promise.all(Array.from({ length: 10 }, (_, i) => call("POST", "/api/variants", { stage: "music", name: `Bed ${i + 1}`, file: `audio/bed-${i + 1}.wav` })));
    expect(await texts()).toEqual(["Music: 10 variants added | agent"]);
    for (let i = 0; i < 3; i++) {
      await call("POST", "/api/variants", { stage: "sfx", name: `Pass ${i + 1}`, file: `audio/pass-${i + 1}.wav` });
      await call("POST", "/api/variants", { stage: "music", name: `Alt ${i + 1}`, file: `audio/alt-${i + 1}.wav` });
    }
    expect(await texts()).toEqual(["Music: 13 variants added | agent", "Sound effects: 3 variants added | agent"]);
  });

  it("a retried reply isn't doubled (§22.9)", async () => {
    const { root, call, texts } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4` });
    const note = (await call("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "x" })).json.note;
    const reply = { replies: [{ id: note.id, reply: "Fixed", status: "done" }] };
    await call("POST", "/api/replies", reply);
    await call("POST", "/api/replies", reply);
    expect((await texts()).filter((t: string) => t.startsWith("Agent replied"))).toEqual(["Agent replied to 1 note (1 done) | agent"]);
  });

  it("the current set the scanner brings in is one line by Rushes, and never also Before the log (R5, R9)", async () => {
    const { root, store } = await tmpProject("adopt");
    await store.update("project", (p) => addVersion(p, { video: "hero", file: "renders/hero v3.mov", duration: 60, fps: 25 }));
    for (const f of ["renders/hero v3.mov", "bed/hero v3 theme.wav", "vo_jules/hero v3 read.wav"]) {
      await mkdir(dirname(join(root, f)), { recursive: true });
      await writeFile(join(root, f), "bytes");
    }
    const lengths: Record<string, number> = { "hero v3 theme.wav": 60, "hero v3 read.wav": 60.4 };
    const s = await startServer(root, { port: 0, found: { probe: async (abs) => lengths[abs.split("/").pop()!] ?? null } });
    let view: { entries: { text: string; by: string }[]; undated: unknown[] } = { entries: [], undated: [] };
    await expect
      .poll(async () => {
        view = await (await fetch(`${s.url}/api/log`)).json();
        return view.entries.map((e) => `${e.text} | ${e.by}`);
      }, { timeout: 10_000 })
      .toEqual(["Brought in 2 files with v1 | rushes", "v1 added: hero v3 | rushes"]);
    expect(view.undated).toEqual([]);
    await s.close();
  });
});

describe("projects that already exist (§22.6)", () => {
  it("backfills a 0.2.2 project once, from its dated cuts, batches and files, by Rushes; its audio is listed undated", async () => {
    const { root, store } = await tmpProject("old");
    const t = Date.now();
    await store.update("project", (p) => {
      addVersion(p, { video: "Hero", file: "renders/hero_v1.mp4", note: "v1: first pass; rough" }, new Date(t - 3 * DAY));
      addVersion(p, { video: "Hero", file: "renders/hero_v2.mp4", note: "v2 (batch b_1): tighter cut" }, new Date(t - DAY));
      addFile(p, { kind: "doc", file: "brief.md", name: "Creative brief" }, new Date(t - 4 * DAY));
      for (const name of ["Night drive", "Held back", "Quiet bed"]) addVariant(p, { stage: "music", lane: "night-drive", name, file: `audio/${name}.wav` });
      p.videos[0].versions.push({ ...p.videos[0].versions[0], id: "v3", addedAt: "" });
    });
    await store.update("batches", (b) => {
      b.batches.push({ id: "b_1", stage: "picture", noteIds: ["n_1", "n_2"], sectionIds: [], sentAt: new Date(t - 2 * DAY).toISOString(), prompt: "" });
    });
    await expect(access(store.path("log"))).rejects.toThrow();
    const app = createApp(store);
    const view = await (await app.request("/api/log?limit=50")).json();
    expect(view.entries.map((e: { text: string; by: string }) => `${e.text} | ${e.by}`)).toEqual([
      "v2 added: tighter cut | rushes",
      "2 notes sent from Picture | rushes",
      "v1 added: first pass | rushes",
      "File added: Creative brief (Scripts & docs) | rushes",
    ]);
    expect(view.undated).toEqual([{ area: "music", text: "Music: night-drive (3 variants)" }]);
    expect(JSON.parse(await readFile(store.path("log"), "utf8")).backfilled).toBe(true);
    // Never again: a second server on the same folder adds nothing old.
    const again = createApp(new Store(root));
    expect((await (await again.request("/api/log?limit=50")).json()).entries).toHaveLength(4);
  });

  it("two first reads at once backfill once (Review Focus 1)", async () => {
    const { store } = await tmpProject("race");
    await store.update("project", (p) => {
      for (const n of [1, 2, 3]) addVersion(p, { video: "Hero", file: `renders/hero_v${n}.mp4`, note: `cut ${n}` }, new Date(Date.now() - n * DAY));
    });
    const a = new LogBook(store);
    const b = new LogBook(store);
    const ctx = { project: await store.read("project"), script: await store.read("script") };
    await Promise.all([a.view({ limit: 50 }, ctx), b.view({ limit: 50 }, ctx), a.add(lineEvent("Picked the slower cut", "project"), "agent"), b.ready()]);
    const file = await store.read("log");
    expect(file.entries.filter((e) => e.by === "rushes")).toHaveLength(3);
    expect(file.entries).toHaveLength(4);
  });

  it("a cut registered on a new project is logged once, never also read in as history (R6)", async () => {
    const { root, call, texts } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4`, note: "v1: first; more" });
    expect(await texts()).toEqual(["v1 added: first | agent"]);
  });
});

describe("a log that is missing, corrupt or huge (§22.9)", () => {
  it("moves a corrupt log aside as log.json.bad, reads as empty, and never breaks the state (R7)", async () => {
    const { store, call } = await setup();
    await call("POST", "/api/log", { text: "First decision" });
    await writeFile(store.path("log"), "{ nope", "utf8");
    const state = await call("GET", "/api/state");
    expect(state.status).toBe(200);
    expect(state.json.log).toBeNull();
    const view = (await call("GET", "/api/log")).json;
    expect(view).toMatchObject({ entries: [], undated: [], dropped: 0 });
    expect(await readFile(`${store.path("log")}.bad`, "utf8")).toBe("{ nope");
    expect(JSON.parse(await readFile(store.path("log"), "utf8"))).toMatchObject({ backfilled: true, entries: [] });
    await call("POST", "/api/log", { text: "Second decision" });
    expect((await call("GET", "/api/log")).json.entries.map((e: { text: string }) => e.text)).toEqual(["Second decision"]);
  });

  it("keeps the newest 5000, counts what it dropped, and still answers quickly (Review Focus 5)", async () => {
    const { store, call } = await setup();
    const start = Date.now() - 6000 * 60_000;
    const entries = Array.from({ length: 5000 }, (_, i) => ({
      id: `l_${String(i).padStart(6, "0")}`, at: new Date(start + i * 60_000).toISOString(), area: "project", kind: "entry", text: `Line ${i}`, video: null, version: null, ref: null, by: "agent",
    }));
    await writeFile(store.path("log"), JSON.stringify({ schema: 1, rev: 1, backfilled: true, undated: [], dropped: 0, entries }));
    const t0 = performance.now();
    expect((await call("POST", "/api/log", { text: "One more" })).status).toBe(201);
    expect(performance.now() - t0).toBeLessThan(1500);
    const file = await store.read("log");
    expect(file.entries).toHaveLength(5000);
    expect(file.dropped).toBe(1);
    expect(file.entries[0].text).toBe("Line 1");
    const view = (await call("GET", "/api/log?limit=10")).json;
    expect(view).toMatchObject({ dropped: 1, total: 5000, earlier: 4990 });
    expect(view.entries[0].text).toBe("One more");
  });

  it("GET /api/state carries a read-only head for the dot: it never backfills or writes (R6, R19)", async () => {
    const { store, call } = await setup();
    expect((await call("GET", "/api/state")).json.log).toEqual({ rev: 0, mark: null, total: 0 });
    await expect(access(store.path("log"))).rejects.toThrow();
    const { entry } = (await call("POST", "/api/log", { text: "Kept the wide" })).json;
    const head = (await call("GET", "/api/state")).json.log;
    expect(head).toMatchObject({ mark: `${entry.id}@${entry.at}`, total: 1 });
    expect(head.rev).toBeGreaterThan(0);
  });
});

describe("the log's routes (§22.7)", () => {
  it("POST /api/log: one clean line of 160 at most, by whoever sent it; blank and unknown places are refused (R21, Review Focus 2)", async () => {
    const { root, call, asUser } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4` });
    const a = (await call("POST", "/api/log", { text: "  Slowed the zooms\n\tbecause the first cut\u0007 felt rushed  " })).json.entry;
    expect(a).toMatchObject({ text: "Slowed the zooms because the first cut felt rushed", by: "agent", area: "project", kind: "entry", video: null });
    const long = (await call("POST", "/api/log", { text: `${"a".repeat(158)}🎬🎬🎬`, area: "picture" }, asUser)).json.entry;
    expect(long).toMatchObject({ text: `${"a".repeat(158)}🎬…`, by: "user", area: "picture" });
    const linked = (await call("POST", "/api/log", { text: "Look at the end card", video: "Hero", version: "v1" })).json.entry;
    expect(linked).toMatchObject({ video: "hero", version: "v1" });
    expect((await call("POST", "/api/log", { text: "   " })).status).toBe(400);
    expect((await call("POST", "/api/log", { text: "x".repeat(2001) })).status).toBe(400);
    expect((await call("POST", "/api/log", { text: "x", video: "Nope" })).status).toBe(404);
    expect((await call("POST", "/api/log", { text: "x", video: "hero", version: "v9" })).status).toBe(404);
    expect((await call("POST", "/api/log", { text: "x", version: "v1" })).status).toBe(400);
    expect((await call("POST", "/api/log", { text: "x", area: "elsewhere" })).status).toBe(400);
  });

  it("GET /api/log: newest first, with limit, area and since, and how many it left out", async () => {
    const { call } = await setup();
    for (const [text, area] of [["One", "picture"], ["Two", "music"], ["Three", "picture"]] as const) await call("POST", "/api/log", { text, area });
    const all = (await call("GET", "/api/log")).json;
    expect(all.entries.map((e: { text: string }) => e.text)).toEqual(["Three", "Two", "One"]);
    expect(all.earlier).toBe(0);
    expect((await call("GET", "/api/log?limit=1")).json).toMatchObject({ earlier: 2, entries: [{ text: "Three" }] });
    expect((await call("GET", "/api/log?area=picture")).json.entries.map((e: { text: string }) => e.text)).toEqual(["Three", "One"]);
    expect((await call("GET", "/api/log?since=2000-01-01T00:00:00Z")).json.entries).toHaveLength(3);
    expect((await call("GET", "/api/log?since=2999-01-01T00:00:00Z")).json.entries).toHaveLength(0);
    for (const bad of ["limit=0", "limit=5001", "area=elsewhere", "since=yesterday"]) expect((await call("GET", `/api/log?${bad}`)).status, bad).toBe(400);
  });

  it("Send to agent's prompt ends with the last five lines, newest first; an empty log adds nothing (R11)", async () => {
    const { root, call, asUser } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4`, note: "v1: first pass; rough" });
    await call("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Too dark" }, asUser);
    for (let i = 1; i <= 6; i++) await call("POST", "/api/log", { text: `Decision ${i}` });
    const { batch } = (await call("POST", "/api/batches", { stage: "picture" }, asUser)).json;
    const [head, block] = batch.prompt.split("\n\nRecent changes (newest first):\n");
    expect(head).toContain("Work through picture batch b_1");
    expect(block.split("\n").map((l: string) => l.replace(/^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} /, ""))).toEqual(["Decision 6", "Decision 5", "Decision 4", "Decision 3", "Decision 2"]);
    expect((await call("GET", "/api/log?limit=1")).json.entries[0].text).toBe("1 note sent from Picture");
    const fresh = await setup();
    await fresh.call("POST", "/api/notes", { stage: "music", scope: "whole", text: "Warmer" }, fresh.asUser);
    expect((await fresh.call("POST", "/api/batches", { stage: "music" }, fresh.asUser)).json.batch.prompt).not.toContain("Recent changes");
  });

  it("Export notes also writes exports/change-log-<date>.md, and the drawer's export writes it alone (R17)", async () => {
    const { root, call } = await setup("Lumen launch film");
    await call("POST", "/api/versions", { video: "Lumen launch film", file: `${root}/renders/lumen.mp4`, note: "v1: first pass; rough" });
    const r = (await call("POST", "/api/exports/notes", {})).json;
    expect(r.changeLog).toMatch(/^exports\/change-log-\d{4}-\d{2}-\d{2}\.md$/);
    const md = await readFile(join(root, r.changeLog), "utf8");
    expect(md).toMatch(/^# Lumen launch film — change log\nExported \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n\n## \w+day \d+ \w+ \d{4}\n- \d{2}:\d{2} · Picture · v1 added: first pass \(agent\)\n$/);
    expect((await call("POST", "/api/exports/change-log", {})).json).toEqual({ path: r.changeLog });
  });

  it("announces each write as a change to log, so open dashboards refetch (§22.8)", async () => {
    const { root } = await tmpProject("live");
    const s = await startServer(root, { port: 0 });
    const events = await sse(s.url);
    await events.until("event: hello");
    await fetch(`${s.url}/api/log`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Kept the wide" }) });
    expect(await events.until('"file":"log"')).toContain('"file":"log"');
    events.stop();
    await s.close();
  });
});
```

Append to `test/cli/doctor.test.ts`, inside `describe("runDoctor", …)`:

```ts
  it("a corrupt log.json isn't required and says how to start the log again; log.json.bad is reported, not failed (R7)", async () => {
    const { root, store } = await tmpProject();
    await writeFile(store.path("log"), "{ nope", "utf8");
    await writeFile(`${store.path("log")}.bad`, "{ older", "utf8");
    const checks = await runDoctor(fakeEnv(root, await tmpHome()));
    expect(find(checks, "file:log")).toMatchObject({ ok: false, required: false });
    expect(find(checks, "file:log")!.fix).toContain("Delete .rushes/log.json");
    expect(find(checks, "file:log-bad")).toMatchObject({ ok: false, required: false, label: "log.json.bad" });
    expect(find(checks, "file:log-bad")!.detail).toMatch(/set it aside/);
  });
```

- [ ] **Step 2: Run them and see them fail.** Run: `npx vitest run test/server/log.test.ts test/cli/doctor.test.ts`. Expected: FAIL. `/api/log` is a 404, `logbook.ts` is missing, and doctor treats `log.json` as required.

- [ ] **Step 3: Write `src/server/logbook.ts`:**

```ts
// §22: the Change Log's keeper on the server. One per store, so every route, the found scanner and
// the state share its backfill and its cache. Every write goes through store.update, so writes
// serialise with each other (§22.9).
import { rename, stat } from "node:fs/promises";
import { CorruptFileError } from "../core/errors.js";
import { appendEvent, backfillLog, logView, type LogEvent, type LogQuery, type LogView, type UndatedContext } from "../core/log.js";
import { LOG_MAX, logMarkdown, type LogBy } from "../core/logText.js";
import type { LogEntry, LogFile, Project } from "../core/schema.js";
import type { Store } from "../core/store.js";

/** What the header's button needs (§22.8, R19): the file's rev, its newest line as id@at, and its size. */
export interface LogHead {
  rev: number;
  mark: string | null;
  total: number;
}

/** R8: the dashboard sends its project id with every request (web/src/api.ts); MCP, the CLI and curl don't. */
export function byOf(projectHeader: string | undefined): "user" | "agent" {
  return projectHeader ? "user" : "agent";
}

const books = new WeakMap<Store, LogBook>();

/** The one LogBook for `store`, shared by the app's routes and the found scanner. */
export function logBookFor(store: Store): LogBook {
  let book = books.get(store);
  if (!book) {
    book = new LogBook(store);
    books.set(store, book);
  }
  return book;
}

export class LogBook {
  /** When this log began, for this server: the backfill reads in only what's older (R6). */
  private readonly since = Date.now();
  private readying: Promise<void> | null = null;
  private cache: { key: string; file: LogFile } | null = null;

  constructor(private readonly store: Store) {}

  /** Backfills once (§22.6) and sets a corrupt file aside (R7). Never throws. Concurrent callers share one run. */
  ready(): Promise<void> {
    this.readying ??= this.prepare()
      .catch((e: unknown) => console.error(`Rushes: the Change Log isn't ready: ${(e as Error).message}`))
      .finally(() => {
        this.readying = null;
      });
    return this.readying;
  }

  private async prepare(): Promise<void> {
    const file = await this.read(true);
    if (file.backfilled) return;
    const [project, batches, script] = await Promise.all([this.store.read("project"), this.store.read("batches"), this.store.read("script")]);
    // backfillLog is a no-op once `backfilled` is set, and update runs one at a time per file, so a
    // second LogBook racing this one can never read the history in twice (Review Focus 1).
    await this.store.update("log", (f) => backfillLog(f, { project, batches, script }, this.since));
  }

  /** The file, parsed once per change on disk. With `fix`, a corrupt one is set aside as log.json.bad and the log starts again (R7). */
  private async read(fix: boolean): Promise<LogFile> {
    const path = this.store.path("log");
    const st = await stat(path).catch(() => null);
    const key = st ? `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}` : "missing";
    if (this.cache?.key === key) return this.cache.file;
    try {
      const file = await this.store.read("log");
      this.cache = { key, file };
      return file;
    } catch (e) {
      if (!fix || !(e instanceof CorruptFileError)) throw e;
      await rename(path, `${path}.bad`);
      this.store.forget("log");
      const { data } = await this.store.update("log", (f) => {
        f.backfilled = true;
      });
      console.error(`Rushes: ${path} couldn't be read, so it was set aside as log.json.bad and the Change Log started again.`);
      return data;
    }
  }

  /** §22.5: writes one event. A failure is reported on the console and returns null: the change it describes has already been made. */
  async add(event: LogEvent, by: LogBy, at: Date = new Date()): Promise<LogEntry | null> {
    try {
      await this.ready();
      const { result } = await this.store.update("log", (f) => appendEvent(f, event, by, at));
      return result;
    } catch (e) {
      console.error(`Rushes: couldn't write to the Change Log: ${(e as Error).message}`);
      return null;
    }
  }

  /** §22.7: a page of the log, newest first. The first read backfills (R6). */
  async view(q: LogQuery, ctx: UndatedContext): Promise<LogView> {
    await this.ready();
    return logView(await this.read(true), q, ctx);
  }

  /** The head for the header's dot. Read-only: it never backfills or fixes, and null means it couldn't be read. */
  async head(): Promise<LogHead | null> {
    try {
      const f = await this.read(false);
      const last = f.entries[f.entries.length - 1];
      return { rev: f.rev, mark: last ? `${last.id}@${last.at}` : null, total: f.entries.length };
    } catch {
      return null;
    }
  }

  /** §22.7: the whole log as Markdown, what Export writes. */
  async markdown(ctx: UndatedContext & { project: Pick<Project, "name"> }, now: Date): Promise<string> {
    const v = await this.view({ limit: LOG_MAX }, ctx);
    return logMarkdown({ project: ctx.project.name, entries: v.entries, undated: v.undated, dropped: v.dropped, now });
  }
}
```

- [ ] **Step 4: Wire up `src/server/app.ts`.**
  1. **Imports.** After line 27, add:

```ts
import { byOf, logBookFor } from "./logbook.js";
import {
  broughtInEvent, cutEvent, fileEvent, lineEvent, lockEvent, notesSentEvent, picksEvent, repliesEvent, scriptEvent, takeEvent, variantEvent,
} from "../core/logEvents.js";
import { LOG_AREAS, LOG_MAX, changeLogFileName, recentChanges } from "../core/logText.js";
```

  2. **Bodies.** After `FoundBringInBody` (line 174), add:

```ts
// §22.7: the Change Log's routes. A line is made one line and cut to 160 characters by the server (R21).
const LogQuery = z.object({
  limit: z.string().min(1).pipe(z.coerce.number<string>().int().min(1).max(LOG_MAX)).optional(),
  area: z.enum(LOG_AREAS).optional(),
  since: z.string().refine((s) => Number.isFinite(Date.parse(s)), "since must be a date and time, e.g. 2026-10-07T09:00:00Z").optional(),
});
const LogLineBody = z.object({
  text: z.string().max(2000),
  area: z.enum(LOG_AREAS).optional(),
  video: z.string().min(1).max(200).nullish(),
  version: z.string().min(1).max(64).nullish(),
  ref: z.string().min(1).max(300).nullish(),
});
```

  3. **Inside `createApp`**, after the `const found = …` line (240), add:

```ts
  // §22: the Change Log, shared with the found scanner (logBookFor keeps one per store).
  const log = logBookFor(store);
  const by = (c: Context) => byOf(c.req.header("x-rushes-project"));
  /** R17: writes exports/change-log-YYYY-MM-DD.md (a same-day export replaces it) and returns its path. */
  async function exportChangeLog(now: Date): Promise<string> {
    const [project, script] = await Promise.all([store.read("project"), store.read("script")]);
    const md = await log.markdown({ project, script }, now);
    const name = changeLogFileName(now);
    const dir = join(store.root, "exports");
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${name}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tmp, md, "utf8");
    await rename(tmp, join(dir, name));
    return `exports/${name}`;
  }
```

  4. **`POST /api/files`:** after the `store.update` line, add `await log.add(fileEvent(result), by(c));`.
  5. **`POST /api/exports/notes`:** in its body, replace the last line, `return c.json({ path: \`exports/${name}\` }, 201);`, with:

```ts
    // §22.7: Export notes also writes the change log, newest first, one heading per day.
    const changeLog = await exportChangeLog(now);
    return c.json({ path: `exports/${name}`, changeLog }, 201);
```

  Then, straight after that route's closing `});`, add the drawer's export:

```ts
  // §22.8: the drawer's Export as Markdown.
  app.post("/api/exports/change-log", async (c) => c.json({ path: await exportChangeLog(new Date()) }, 201));
```

  6. **`GET /api/state`:** replace its first statement and its `return` with:

```ts
    // §22.8: the log's head is read-only, so a state request never writes (R6).
    const [project, script, notes, picks, batches, ffmpeg, foundSummary, logHead] = await Promise.all([
      store.read("project"), store.read("script"), store.read("notes"), store.read("picks"), store.read("batches"), jobs.available(), found.summary(), log.head(),
    ]);
```

```ts
    return c.json({ project: { ...project, videos }, script, notes, picks, batches, tabs, proxies: { ffmpeg, jobs: jobs.list() }, found: foundSummary, log: logHead });
```
  7. **`POST /api/found/scan`, the `include` branch:** after `const included = await found.bringIn(b.include, { film: b.film, origin: "include" });` add `if (included.added.length) await log.add(broughtInEvent(included.added, null), by(c));`.
  8. **`POST /api/found/bring-in`:** replace its body with:

```ts
    const b = await body(c, FoundBringInBody);
    const r = await found.bringIn(b.files, { film: b.film });
    if (r.added.length) await log.add(broughtInEvent(r.added, null), by(c));
    return c.json(r);
```

  9. **`POST /api/replies`:** after its `store.update`, add `await log.add(repliesEvent(result), by(c));`.
  10. **`POST /api/versions`:**
      - before `const { result } = await store.update("project", …`, add `let films = 1;`;
      - inside the update, after `autoProxy = p.autoProxy;`, add `films = p.videos.length;`;
      - after the update block's `});`, add `await log.add(cutEvent(films, result.video, result.version), by(c));`.
  11. **`PUT /api/videos/:video/lock`:** replace the body with:

```ts
    const b = await body(c, LockBody);
    let before: string | null = null;
    let films = 1;
    const { result } = await store.update("project", (p) => {
      before = resolveVideo(p, c.req.param("video")).lockedVersion;
      films = p.videos.length;
      return lockPicture(p, c.req.param("video"), b.version);
    });
    // R10: a lock that changes nothing isn't logged.
    if (result.lockedVersion !== before) await log.add(lockEvent(films, result), by(c));
    return c.json({ video: result });
```

  12. **`POST /api/variants`:** after the update, add `await log.add(variantEvent(result.lane, result.variant), by(c));`.
  13. **`PUT /api/script`:** after the update, add `await log.add(scriptEvent(result.length), by(c));`.
  14. **`POST /api/script/:id/takes`:** change `const { result } =` to `const { data, result } =` and, after it, add:

```ts
    const section = data.sections.find((s) => s.id === c.req.param("id"))!;
    await log.add(takeEvent(section, result, section.takes.findIndex((t) => t.id === result.id) + 1), by(c));
```

  15. **`PUT /api/picks`:** before the update, add `let before: Record<string, string> = {};`. As the update's first line, add `before = { ...p.lanes };`. After the update, add:

```ts
    // §22.5: a change of what's picked is logged; levels alone aren't (R10).
    const changed = Object.keys({ ...before, ...data.lanes }).some((k) => before[k] !== data.lanes[k]);
    if (changed) await log.add(picksEvent(await store.read("project"), data.lanes), by(c));
```

  16. **`POST /api/batches`:** replace the `run` body with:

```ts
    const run = batchQueue.catch(() => undefined).then(async (): Promise<Batch> => {
      const [project, script, batches] = await Promise.all([store.read("project"), store.read("script"), store.read("batches")]);
      const { result } = await store.update("notes", (notes) => createBatch({ project, script, notes, batches }, stage));
      // R11: the prompt ends with the last five lines of the log, from before this send.
      const [projectNow, scriptNow] = await Promise.all([store.read("project"), store.read("script")]);
      const recent = recentChanges((await log.view({ limit: 5 }, { project: projectNow, script: scriptNow })).entries);
      if (recent) result.prompt = `${result.prompt}\n\n${recent}`;
      await store.update("batches", (f) => { f.batches.push(result); });
      await log.add(notesSentEvent(result), by(c));
      return result;
    });
```

  17. **The log routes**, before `// ---- live updates ----`:

```ts
  // ---- the Change Log (§22.7) ----
  app.get("/api/log", async (c) => {
    const q = LogQuery.safeParse(c.req.query());
    if (!q.success) throw new InvalidError("Query is invalid", q.error.issues);
    const [project, script] = await Promise.all([store.read("project"), store.read("script")]);
    return c.json(await log.view(q.data, { project, script }));
  });

  app.post("/api/log", async (c) => {
    const b = await body(c, LogLineBody);
    const text = b.text.trim();
    if (!text) throw new InvalidError("text is empty: say what happened in one line");
    let video: string | null = null;
    let version: string | null = null;
    if (b.video) {
      const v = resolveVideo(await store.read("project"), b.video);
      video = v.id;
      if (b.version) {
        if (!v.versions.some((x) => x.id === b.version)) throw new NotFoundError("version", b.version);
        version = b.version;
      }
    } else if (b.version) {
      throw new InvalidError("version needs video");
    }
    const entry = await log.add(lineEvent(text, b.area ?? "project", { video, version, ref: b.ref ?? null }), by(c));
    if (!entry) throw new RushesError("The Change Log couldn't be written. Run `rushes doctor`.", 500, "log_unwritable");
    return c.json({ entry }, 201);
  });
```

- [ ] **Step 5: Log the current set in `src/server/found.ts`.**
  - Add to the imports: `import { logBookFor } from "./logbook.js";` and `import { broughtInEvent, cutName } from "../core/logEvents.js";`.
  - In `adopt`, after `let byPath: Map<string, Scored>;`, add `let withCut: string | null = null;`.
  - Inside the `try`, after `byPath = s.byPath;`, add:

```ts
        const cut = anchorCut(ctx.project, this.film);
        withCut = cut ? cutName(ctx.project.videos.length, cut.video, cut.version.id) : null;
```

  - Replace `return this.bringInNow(picked.map((f) => ({ path: f.path, kind: f.kind as BringInKind })), { reasons, film, origin: "auto" });` with:

```ts
      const result = await this.bringInNow(picked.map((f) => ({ path: f.path, kind: f.kind as BringInKind })), { reasons, film, origin: "auto" });
      // §22.5: what the current set brought in is one line, by Rushes (R8, R9); its variants are dated (R5).
      if (result.added.length) await logBookFor(this.store).add(broughtInEvent(result.added, withCut), "rushes");
      return result;
```

- [ ] **Step 6: Doctor.** In `src/cli/doctor.ts`, in the `FILES` loop's `catch`, change `required: true` to `required: key !== "log"`, and change the fix's ternary to:

```ts
fix: key === "found"
  ? `Delete ${RUSHES_DIR}/${name}. Rushes recreates it; files you hid come back in Found and the current set may be chosen again. Nothing else is lost.`
  : key === "log"
    ? `Delete ${RUSHES_DIR}/${name}. Rushes starts the Change Log again, reading in the cuts, notes sent and files it has dates for. Nothing else is lost.`
    : `Fix or restore ${name}, or delete the ${RUSHES_DIR} folder and run rushes init to start over.`,
```

  After the loop, add:

```ts
  // R7: a Change Log that couldn't be read was set aside, and the log started again.
  if (await exists(join(env.cwd, RUSHES_DIR, "log.json.bad"))) {
    checks.push({
      id: "file:log-bad", label: "log.json.bad", ok: false, required: false,
      detail: "An earlier Change Log couldn't be read, so Rushes set it aside as log.json.bad and started the log again. Nothing else was affected.",
      fix: `Nothing to do. Delete ${RUSHES_DIR}/log.json.bad once you don't need it.`,
    });
  }
```

- [ ] **Step 7: Run the tests.** Run: `npx vitest run test/server/log.test.ts test/cli/doctor.test.ts`. Expected: PASS.

- [ ] **Step 8: Run the gates.** Run: `npm run build && npm run typecheck && npx vitest run`, then the existing e2e suite once in both projects: `npx playwright test --retries=0`. Expected: all green. In particular, the change-counting tests in `test/server/app.test.ts:1212` and `test/server/proxy.test.ts:302` stay green, because the state's head never writes.

- [ ] **Step 9: Commit.**

```bash
git add src/server/logbook.ts src/server/app.ts src/server/found.ts src/cli/doctor.ts test/server/log.test.ts test/cli/doctor.test.ts
git -c user.name=iamredmh -c user.email=17407420+iamredmh@users.noreply.github.com commit -m "feat(server): the Change Log is written at every change, read and added to over /api/log, exported and sent with the prompt" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

**Mutation check:** dropping `clears` from `broughtInEvent` must fail "the current set the scanner brings in is one line by Rushes, and never also Before the log".

---

### Task 5: The agent surface (§22.7)

**Files:**
- Modify: `src/mcp/tools.ts` (imports; `rushes_export_notes`' description at 370–379; two new tools after it)
- Modify: `src/cli/main.ts`:
  - imports;
  - HELP: after line 63, add the two `log` lines;
  - `OPTIONS`: add `limit`, `area` and `md`;
  - a new `case "log"` before `default:`.
- Modify: `AGENTS.md`, `skills/rushes/SKILL.md`
- Modify: `test/mcp/tools.test.ts:46-56`, `test/package.test.ts:82-87` (tool count)
- Test: `test/mcp/changelog.test.ts`, `test/cli/log.test.ts`, `test/docs-changelog.test.ts` (append)

**Interfaces:**
- Consumes (Task 4): `GET`/`POST /api/log` and `POST /api/exports/notes`. From `logText.ts`: `LOG_AREAS`, `LOG_MAX`, `AREA_LABELS`, `BY_WORDS`, `localStamp`, `logMarkdown`, `LogLine` and `UndatedLine`.
- Produces:
  - **MCP `rushes_log`:** `{ project?, text: string (1–2000), area?: LogArea, video?, version?, ref? }`. Returns `{ entry }`.
  - **MCP `rushes_get_log`:** `{ project?, limit?: 1–200 (default 30), area?, since? }`. Returns `LogView`.
  - **The CLI:**
    - `rushes log [--limit N] [--area A] [--md]`: the `--md` default limit is everything (5000), otherwise 30;
    - `rushes log add <text…> [--area A]` prints `Added to the Change Log: <text>`.
  - **Older servers.** Against one, both tools and both commands surface `RushesClient`'s "older than this command … Run `rushes stop`" (`src/mcp/client.ts:32`).

- [ ] **Step 1: Write the failing MCP tests.** Append to `test/mcp/changelog.test.ts`, adding `import { createServer, type Server } from "node:http";`:

```ts
describe("the Change Log for agents (§22.7)", () => {
  it("rushes_log adds a line as the agent; rushes_get_log reads back newest first, with what it left out", async () => {
    const { root } = await tmpProject("Lumen launch film");
    const s = await startServer(root, { port: 0 });
    const t = await mcpOn(s.url);
    await t.call("rushes_add_version", { video: "Lumen launch film", file: "renders/lumen_v1.mp4", note: "v1: first pass; rough", label: "First pass" });
    const added = await t.call("rushes_log", { text: "Decided to slow the zooms\nthe first cut felt rushed", area: "picture" });
    expect(added.isError).toBe(false);
    expect(JSON.parse(added.text).entry).toMatchObject({ text: "Decided to slow the zooms the first cut felt rushed", by: "agent", area: "picture" });
    const one = JSON.parse((await t.call("rushes_get_log", { limit: 1 })).text);
    expect(one.entries.map((e: { text: string }) => e.text)).toEqual(["Decided to slow the zooms the first cut felt rushed"]);
    expect(one.earlier).toBe(1);
    const picture = JSON.parse((await t.call("rushes_get_log", { area: "picture" })).text);
    expect(picture.entries.map((e: { text: string }) => e.text)).toEqual(["Decided to slow the zooms the first cut felt rushed", "v1 added: First pass"]);
    expect((await t.call("rushes_get_log", { limit: 201 })).isError).toBe(true);
    expect((await t.call("rushes_log", { text: "" })).isError).toBe(true);
    const { tools } = await t.client.listTools();
    expect(tools.find((x) => x.name === "rushes_log")!.description).toMatch(/already logs cuts/);
    expect(tools.find((x) => x.name === "rushes_get_log")!.description).toMatch(/start of a session/);
    expect(tools.find((x) => x.name === "rushes_export_notes")!.description).toMatch(/change-log-<date>\.md/);
    await t.client.close();
    await s.close();
  });

  it("against an older Rushes, both tools say to restart it, in words (§22.9)", async () => {
    const server: Server = createServer((req, res) => {
      if (req.url === "/api/health") {
        res.setHeader("content-type", "application/json");
        return void res.end(JSON.stringify({ ok: true }));
      }
      res.statusCode = 404;
      res.end("404 Not Found");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const t = await mcpOn(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    for (const [name, args] of [["rushes_log", { text: "x" }], ["rushes_get_log", {}]] as const) {
      const r = await t.call(name, args);
      expect(r.isError, name).toBe(true);
      expect(r.text, name).toMatch(/older than/);
      expect(r.text, name).toMatch(/rushes stop/);
    }
    await t.client.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
});
```

  In `test/mcp/tools.test.ts`, rename "lists the nineteen tools" to "lists the twenty-one tools", and add `"rushes_get_log"` and `"rushes_log"` to its sorted list. `"rushes_get_log"` goes after `"rushes_get_batch"`, and `"rushes_log"` after `"rushes_lock_picture"` ("lock" sorts before "log").

- [ ] **Step 2: Write the failing CLI and docs tests.** Append to `test/cli/log.test.ts`, adding `import { readFile } from "node:fs/promises";` and `import { join } from "node:path";`:

```ts
describe("rushes log (§22.7)", () => {
  it("prints the log newest first, adds a line, and prints the same Markdown the export writes", async () => {
    const { root } = await tmpProject("Lumen launch film");
    const s = await startServer(root, { port: 0 });
    const a = io(root);
    expect(await main(["add", "version", "renders/lumen v1.mp4", "--video", "Lumen launch film", "--label", "First pass"], a.x)).toBe(0);
    expect(await main(["log", "add", "Kept", "the", "wide", "shot", "--area", "picture"], a.x)).toBe(0);
    expect(a.out.pop()).toBe("Added to the Change Log: Kept the wide shot");
    expect(await main(["log"], a.x)).toBe(0);
    expect(a.out.slice(-2).map((l) => l.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}  /, ""))).toEqual([
      "Picture       Kept the wide shot  (agent)",
      "Picture       v1 added: First pass  (agent)",
    ]);
    expect(await main(["log", "--md"], a.x)).toBe(0);
    const md = a.out.pop()!;
    const { changeLog } = await (await fetch(`${s.url}/api/exports/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    const file = await readFile(join(root, changeLog), "utf8");
    const exported = (t: string) => t.replace(/^Exported .*$/m, "Exported");
    expect(exported(`${md}\n`)).toBe(exported(file));
    const b = io(root);
    expect(await main(["log", "--area", "elsewhere"], b.x)).toBe(2);
    expect(await main(["log", "--limit", "0"], b.x)).toBe(2);
    expect(await main(["log", "add"], b.x)).toBe(2);
    expect(await main(["log", "frobnicate"], b.x)).toBe(2);
    await s.close();
  });

  it("help lists both commands, in the description column", async () => {
    const a = io("/tmp");
    await main([], a.x);
    const lines = a.out.join("\n").split("\n");
    // Where the description starts: after the line's last run of two or more spaces (as test/cli/main.test.ts measures it).
    const col = (line: string) => {
      let last = -1;
      for (const m of line.matchAll(/ {2,}\S/g)) last = m.index + m[0].length - 1;
      return last;
    };
    const status = lines.find((l) => l.startsWith("  rushes status"))!;
    for (const start of ["  rushes log [--limit N] [--area A] [--md]", "  rushes log add <text> [--area A]"]) {
      const line = lines.find((l) => l.startsWith(start))!;
      expect(line, start).toBeTruthy();
      expect(col(line), start).toBe(col(status));
    }
  });
});
```

  Append to `test/docs-changelog.test.ts`:

```ts
describe("shipped docs: the Change Log (§22.7)", () => {
  it.each(["AGENTS.md", "skills/rushes/SKILL.md"])("%s says to read the log at the start of a session and add a line when changing direction", (file) => {
    const text = read(file);
    expect(text).toMatch(/at the start of a session, (call|read) `rushes_get_log`/i);
    expect(text).toMatch(/(change direction|a decision)[^.]*`rushes_log`|`rushes_log`[^.]*(change direction|a decision)/i);
    expect(text).toContain("twenty-one tools");
    for (const tool of ["rushes_log", "rushes_get_log"]) expect(text).toContain(`\`${tool}\``);
    expect(text).toMatch(/rushes log/);
    expect(text).not.toMatch(/\/Users\//);
  });
});
```

  In `test/package.test.ts`, change the "%s counts nineteen tools" test to "%s counts twenty-one tools", with `expect(text).toMatch(/twenty-one tools/)`. Add `"rushes_log", "rushes_get_log"` to its tool list.

- [ ] **Step 3: Run them and see them fail.** Run: `npx vitest run test/mcp/changelog.test.ts test/mcp/tools.test.ts test/cli/log.test.ts test/docs-changelog.test.ts test/package.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement the MCP tools.** In `src/mcp/tools.ts`:
  - Import `LOG_AREAS` from `../core/logText.js`.
  - Change `rushes_export_notes`' description to `"Write every note to exports/<project-slug>-notes-<date>.md, grouped by stage and, for Picture, by film and version, and the Change Log to exports/change-log-<date>.md, newest first. Exporting again the same day overwrites them. Returns both paths (path, changeLog)."`
  - After `rushes_export_notes`, register:

```ts
  const area = z.enum(LOG_AREAS);

  server.registerTool(
    "rushes_log",
    {
      title: "Add a line to the Change Log",
      description:
        'Adds one line to the project\'s Change Log, as the agent: a decision or a change of direction, e.g. "Slowed the zooms: the first cut felt rushed". One line, 160 characters at most (longer is cut). Rushes already logs cuts, voice reads, music, sound effects, takes, the script, picks, notes sent and replies by itself, so don\'t repeat those. `area` defaults to project; `video`, `version` and `ref` ("<lane>/<variant>") let the line open that place in the dashboard. Returns the line.',
      inputSchema: {
        project,
        text: z.string().min(1).max(2000).describe("What happened, in one line."),
        area: area.optional().describe("script, picture, voice, music, sfx, mix, notes, assets or project (the default)."),
        video: z.string().optional().describe("Video id or name, to open its cut from the line."),
        version: z.string().optional().describe("With video: the version to open."),
        ref: z.string().optional().describe('"<lane>/<variant>" to open a voice read, bed or pass from the line.'),
      },
    },
    safe(async ({ project, ...b }) => (await ctx.client(project)).post("/api/log", b)),
  );

  server.registerTool(
    "rushes_get_log",
    {
      title: "Read the Change Log",
      description:
        "Call this at the start of a session to catch up: what happened in the project, newest first. Cuts, reads, beds, passes and takes as they were added, the script, picks, notes sent, replies and lines people or agents wrote. Returns `entries` (each with `at`, `area`, `text`, `by`: user, agent or rushes), `earlier` (how many matching lines were left out), `undated` (audio from before the log) and `dropped` (lines removed past 5000).",
      inputSchema: {
        project,
        limit: z.number().int().min(1).max(200).default(30).describe("How many lines, newest first. Default 30, at most 200."),
        area: area.optional().describe("Only this area."),
        since: z.string().optional().describe("Only lines after this date and time, e.g. 2026-10-07T09:00:00Z."),
      },
    },
    safe(async ({ project, limit, area: a, since }) => {
      const q = new URLSearchParams({ limit: String(limit ?? 30) });
      if (a) q.set("area", a);
      if (since) q.set("since", since);
      return (await ctx.client(project)).get(`/api/log?${q}`);
    }),
  );
```

- [ ] **Step 5: Implement the CLI.** In `src/cli/main.ts`:
  - Import `{ AREA_LABELS, BY_WORDS, LOG_AREAS, LOG_MAX, localStamp, logMarkdown, type LogLine, type UndatedLine }` from `../core/logText.js`.
  - Add `limit: { type: "string" },`, `area: { type: "string" },` and `md: { type: "boolean" },` to `OPTIONS` (after `film`).
  - In `HELP`, after the `rushes export notes` line, add these two lines. The descriptions start at column 52, like every other line:

```
  rushes log [--limit N] [--area A] [--md]          the Change Log, newest first (--md: as Markdown)
  rushes log add <text> [--area A]                  add a line to the Change Log
```

  - Before `default:`, add:

```ts
      case "log": {
        const logUsage = "rushes log [--limit N] [--area A] [--md] | rushes log add <text> [--area A]";
        const [what, ...words] = rest;
        const area = o.area;
        if (area !== undefined && !(LOG_AREAS as readonly string[]).includes(area)) {
          io.err(`--area must be one of ${LOG_AREAS.join(", ")} (got "${area}")`);
          return usage(io, logUsage);
        }
        if (what === "add") {
          const text = words.join(" ").trim();
          if (!text) return usage(io, 'rushes log add "text" [--area A]');
          const r = await (await client()).post("/api/log", { text, ...(area ? { area } : {}) });
          io.out(`Added to the Change Log: ${stripControl(r.entry.text)}`);
          return 0;
        }
        if (what !== undefined) return usage(io, logUsage);
        const limit = o.limit === undefined ? (o.md ? LOG_MAX : 30) : Number(o.limit);
        if (!(Number.isInteger(limit) && limit >= 1 && limit <= LOG_MAX)) {
          io.err(`--limit must be a whole number from 1 to ${LOG_MAX} (got "${o.limit}")`);
          return usage(io, logUsage);
        }
        const c = await client();
        const q = new URLSearchParams({ limit: String(limit) });
        if (area) q.set("area", area);
        const view = await c.get<{ entries: LogLine[]; earlier: number; undated: UndatedLine[]; dropped: number }>(`/api/log?${q}`);
        if (o.md) {
          const { name } = await c.get<{ name: string }>("/api/health");
          io.out(logMarkdown({ project: name, entries: view.entries, undated: view.undated, dropped: view.dropped, earlier: view.earlier, now: new Date() }).trimEnd());
          return 0;
        }
        if (!view.entries.length && !view.undated.length) return io.out("Nothing in the Change Log yet."), 0;
        for (const e of view.entries) io.out(`${localStamp(new Date(e.at))}  ${AREA_LABELS[e.area].padEnd(13)} ${stripControl(e.text)}  (${BY_WORDS[e.by]})`);
        if (view.earlier) io.out(`${view.earlier} earlier (rushes log --limit ${Math.min(LOG_MAX, limit + view.earlier)} shows them)`);
        if (view.undated.length) {
          io.out("Before the log:");
          for (const u of view.undated) io.out(`  ${stripControl(u.text)}`);
        }
        if (view.dropped) io.out("Earlier entries were removed.");
        return 0;
      }
```

- [ ] **Step 6: Write the docs.**
  - **`AGENTS.md`:** add a section after "Opening a project, and the files that go with the cut":

    > ## The Change Log
    >
    > Rushes keeps a log of what happened in the project, newest first, written as it happens (`.rushes/log.json`): cuts, voice reads, music beds, sound-effects passes, takes, the script, picks, notes sent and your replies. A burst of registrations is one line. The user opens it from the **Change Log** button.
    >
    > - **At the start of a session, call `rushes_get_log`** to catch up on what changed since you last worked on the project. It takes `limit` (default 30, at most 200), `area` and `since` (a date and time). It returns `entries` newest first, `earlier` (how many it left out) and `undated` (audio from before the log).
    > - **When you change direction or make a decision**, add one line with `rushes_log` (`text`, optional `area`, `video`, `version`, `ref`), e.g. "Slowed the zooms: the first cut felt rushed". One line, 160 characters at most. Don't log what Rushes logs itself.
    > - **Give every cut a short `label`** (step 1 of the loop).
    > - CLI: `rushes log [--limit N] [--area A] [--md]` and `rushes log add "text" [--area A]`. `rushes_export_notes` also writes `exports/change-log-<date>.md`.
    > - Send to agent's prompt ends with the last five lines, under "Recent changes".

  - **`AGENTS.md`, "Tools":** "twenty-one tools", with `rushes_log` and `rushes_get_log` added after `rushes_export_notes`.
  - **`AGENTS.md`, "Without MCP":** add `npx -y rushes log --limit 20` and `npx -y rushes log add "Slowed the zooms" --area picture`.
  - **`skills/rushes/SKILL.md`:** after step 7, add the paragraph: "At the start of a session, call `rushes_get_log` to catch up (newest first; `limit`, `area`, `since`). When you change direction or make a decision, add one line with `rushes_log`; Rushes logs cuts, reads, beds, passes, the script, picks, notes sent and replies itself. CLI: `rushes log`, `rushes log add`." Change the tool count to "twenty-one tools", with `rushes_log` and `rushes_get_log` in the list.
  - **`README.md`'s tool line** (line 43): "twenty-one tools", with the two new names. Task 7 writes the README section.
  - Check every tool, field and flag against `src/mcp/tools.ts` and `src/cli/main.ts`.

- [ ] **Step 7: Run the tests.** Run: `npx vitest run test/mcp/changelog.test.ts test/mcp/tools.test.ts test/cli/log.test.ts test/docs-changelog.test.ts test/package.test.ts`. Expected: PASS.

- [ ] **Step 8: Run the gates.** Run: `npm run build && npm run typecheck && npx vitest run`. Expected: all green.

- [ ] **Step 9: Commit.**

```bash
git add src/mcp/tools.ts src/cli/main.ts AGENTS.md skills/rushes/SKILL.md README.md test/mcp/changelog.test.ts test/mcp/tools.test.ts test/cli/log.test.ts test/docs-changelog.test.ts test/package.test.ts
git -c user.name=iamredmh -c user.email=17407420+iamredmh@users.noreply.github.com commit -m "feat(agent): rushes_log and rushes_get_log, rushes log and rushes log add, and the guidance to read the log first" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

**Mutation check:** changing `rushes_get_log`'s `.max(200)` to `.max(5000)` must fail "rushes_log adds a line as the agent …" (the `limit: 201` call is no longer refused).

---

### Task 6: The Change Log button and drawer (§22.8)

**Files:**
- Create: `web/src/changelog.ts`, `web/src/ui/ChangeLog.tsx`
- Modify: `web/src/ui/App.tsx`:
  - line 2: add `projectId` to the `api` import;
  - imports;
  - the hook after line 112;
  - `jump` after `toggleLock` (199);
  - the button after line 403;
  - the drawer after line 413.
- Modify: `web/src/types.ts` (type exports; `State.log`), `web/src/changes.css` (append)
- Test: new `test/web/changelog.test.ts`, `test/web/changes-css.test.ts` (append), new `e2e/changelog.spec.ts`

**Interfaces:**
- Consumes:
  - Task 3: `AREA_LABELS`, `clock`, `dayHeading`, `localDate` and `LogLine` (`logText.ts`); `LogView` (`log.ts`).
  - Task 4: `LogHead`; `GET`/`POST /api/log`; `POST /api/exports/change-log`; `state.log`.
  - Task 2: `moveActive`.
- Produces (`web/src/changelog.ts`):

```ts
export type Filter = "all" | "picture" | "voice" | "music" | "sfx" | "mix" | "notes" | "assets";
export const FILTERS: readonly (readonly [Filter, string])[];
export function isFilter(s: string | null): s is Filter;
export const BY_UI: Record<LogBy, string>;   // "added by you", "agent", "Rushes"
export interface DayGroup { key: string; heading: string; entries: LogLine[] }
export function groupByDay(entries: readonly LogLine[], now: Date): DayGroup[];
export type JumpTarget = { tab: Stage | "assets"; video?: string; version?: string; row?: string };
export function jumpOf(e: LogLine, project: { videos: { id: string; versions: { id: string }[] }[]; lanes: { id: string; stage: LaneStage }[] }): JumpTarget | null;
export function newCount(shown: readonly LogLine[], next: readonly LogLine[]): number;
export function footText(v: { entries: readonly unknown[]; earlier: number; dropped: number }): string;
export interface KeyStore { getItem(k: string): string | null; setItem(k: string, v: string): void }
export function storageKey(projectId: string, what: "log-open" | "log-seen" | "log-filter"): string;
export function recall(store: KeyStore | undefined, key: string): string | null;     // never throws
export function remember(store: KeyStore | undefined, key: string, value: string): void;
```

- Produces (`web/src/ui/ChangeLog.tsx`):

```ts
export interface ChangeLogState { open: boolean; focusOnOpen: boolean; dot: boolean; setOpen(open: boolean): void }
export function useChangeLog(projectId: string, head: LogHead | null | undefined): ChangeLogState;
export function ChangeLogButton(props: { log: ChangeLogState; buttonRef: { current: HTMLButtonElement | null } }): JSX.Element;
export interface ChangeLogDrawerProps { log: ChangeLogState; projectId: string; head: LogHead | null | undefined; project: Pick<Project, "videos" | "lanes">;
  stage: Stage | "assets"; header: { current: HTMLElement | null }; buttonRef: { current: HTMLButtonElement | null }; toast(m: string): void; onJump(to: JumpTarget): void }
export function ChangeLogDrawer(props: ChangeLogDrawerProps): JSX.Element | null;
export function focusRow(row: string): void;   // R18
```

- [ ] **Step 1: Write the failing unit tests** at `test/web/changelog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BY_UI, FILTERS, footText, groupByDay, isFilter, jumpOf, newCount, recall, remember, storageKey } from "../../web/src/changelog.js";
import type { LogLine } from "../../src/core/logText.js";

const line = (over: Partial<LogLine>): LogLine => ({ id: "l_1", at: new Date(2026, 9, 7, 14, 32).toISOString(), area: "picture", kind: "cut", text: "x", video: null, version: null, ref: null, by: "agent", tab: null, ...over });
const project = {
  videos: [{ id: "hero", versions: [{ id: "v1" }, { id: "v2" }] }],
  lanes: [{ id: "night-drive", stage: "music" as const }],
};

describe("the drawer's helpers (§22.8)", () => {
  it("filters are the mockup's chips, in order", () => {
    expect(FILTERS.map(([, l]) => l)).toEqual(["All", "Picture", "Voice", "Music", "Sound effects", "Mix", "Notes", "Files"]);
    expect(isFilter("music")).toBe(true);
    expect(isFilter("project")).toBe(false);
    expect(isFilter(null)).toBe(false);
    expect(BY_UI).toEqual({ user: "added by you", agent: "agent", rushes: "Rushes" });
  });

  it("groups by local day under Today, Yesterday and the date", () => {
    const now = new Date(2026, 9, 7, 15, 0);
    const g = groupByDay([
      line({ id: "a", at: new Date(2026, 9, 7, 14, 0).toISOString() }),
      line({ id: "b", at: new Date(2026, 9, 7, 9, 0).toISOString() }),
      line({ id: "c", at: new Date(2026, 9, 6, 17, 0).toISOString() }),
      line({ id: "d", at: new Date(2026, 9, 5, 18, 0).toISOString() }),
    ], now);
    expect(g.map((x) => [x.heading, x.entries.map((e) => e.id)])).toEqual([["Today", ["a", "b"]], ["Yesterday", ["c"]], ["Mon 5 Oct", ["d"]]]);
  });

  it("jumpOf: a cut opens its film and version, a variant its tab and row, a Notes line its tab (R18)", () => {
    expect(jumpOf(line({ video: "hero", version: "v1" }), project)).toEqual({ tab: "picture", video: "hero", version: "v1" });
    expect(jumpOf(line({ area: "music", kind: "variant", ref: "night-drive/bed" }), project)).toEqual({ tab: "music", row: "night-drive/bed" });
    expect(jumpOf(line({ area: "notes", kind: "notes-sent", tab: "voice" }), project)).toEqual({ tab: "voice" });
    expect(jumpOf(line({ area: "assets", kind: "files" }), project)).toEqual({ tab: "assets" });
    expect(jumpOf(line({ area: "script", kind: "script" }), project)).toEqual({ tab: "script" });
  });

  it("jumpOf goes as far as it can when things have gone, and nowhere for a plain line (Review Focus 4, R14)", () => {
    expect(jumpOf(line({ video: "hero", version: "v9" }), project)).toEqual({ tab: "picture", video: "hero" });
    expect(jumpOf(line({ video: "gone", version: "v1" }), project)).toEqual({ tab: "picture" });
    expect(jumpOf(line({ area: "music", kind: "variant", ref: "gone/bed" }), project)).toEqual({ tab: "music" });
    expect(jumpOf(line({ area: "notes", kind: "replies", tab: null }), project)).toBeNull();
    expect(jumpOf(line({ area: "project", kind: "entry" }), project)).toBeNull();
    expect(jumpOf(line({ area: "picture", kind: "entry" }), project)).toBeNull();
    expect(jumpOf(line({ area: "picture", kind: "entry", video: "hero", version: "v2" }), project)).toEqual({ tab: "picture", video: "hero", version: "v2" });
  });

  it("newCount counts new and updated lines; footText says how many and when there are more (Review Focus 5)", () => {
    const shown = [line({ id: "a", at: "2026-10-07T10:00:00.000Z" }), line({ id: "b", at: "2026-10-07T09:00:00.000Z" })];
    expect(newCount(shown, [line({ id: "c" }), line({ id: "a", at: "2026-10-07T10:01:00.000Z" }), ...shown.slice(1)])).toBe(2);
    expect(newCount(shown, shown)).toBe(0);
    expect(footText({ entries: [1, 2, 3], earlier: 0, dropped: 0 })).toBe("3 entries");
    expect(footText({ entries: [1], earlier: 0, dropped: 0 })).toBe("1 entry");
    expect(footText({ entries: new Array(1000), earlier: 4000, dropped: 7 })).toBe("Showing the newest 1000 of 5000 · Earlier entries were removed");
  });

  it("storage never throws: blocked, missing or full storage reads as nothing", () => {
    const boom = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } };
    expect(recall(boom, "k")).toBeNull();
    expect(() => remember(boom, "k", "v")).not.toThrow();
    expect(recall(undefined, "k")).toBeNull();
    const map = new Map<string, string>();
    const ok = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    remember(ok, storageKey("k7m2q9ab", "log-filter"), "music");
    expect(recall(ok, "rushes:k7m2q9ab:log-filter")).toBe("music");
  });
});
```

Append to `test/web/changes-css.test.ts`:

```ts
describe("changes.css: the drawer (§22.8)", () => {
  it("is 440 px wide, full width under 560 px, and drops its slide under reduced motion", () => {
    expect(css).toMatch(/\.drawer \{[^}]*width: 440px/);
    expect(css).toMatch(/@media \(max-width: 559px\) \{ \.drawer \{ width: 100%; \} \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\.drawer \{ animation: none; \}/);
  });
  it("tags every area with its stage's colour", () => {
    for (const area of ["picture", "voice", "music", "sfx", "mix", "notes", "assets", "script", "project"]) expect(css, area).toContain(`.ltag.${area}`);
  });
});
```

- [ ] **Step 2: Run them and see them fail.** Run: `npx vitest run test/web/changelog.test.ts test/web/changes-css.test.ts`. Expected: FAIL.

- [ ] **Step 3: Write `web/src/changelog.ts`:**

```ts
// §22.8: the Change Log drawer's helpers. Pure, so they're unit-tested in Node. The words and dates
// come from src/core/logText.ts, which imports nothing but labels.ts.
import { AREA_LABELS, dayHeading, localDate, type LogArea, type LogBy, type LogLine } from "../../src/core/logText.js";
import type { LaneStage, Stage } from "./types.js";
export { AREA_LABELS, clock } from "../../src/core/logText.js";

export type Filter = "all" | Exclude<LogArea, "script" | "project">;

/** The mockup's chips, in order. */
export const FILTERS: readonly (readonly [Filter, string])[] = [
  ["all", "All"], ["picture", AREA_LABELS.picture], ["voice", AREA_LABELS.voice], ["music", AREA_LABELS.music],
  ["sfx", AREA_LABELS.sfx], ["mix", AREA_LABELS.mix], ["notes", AREA_LABELS.notes], ["assets", AREA_LABELS.assets],
];

export function isFilter(s: string | null): s is Filter {
  return FILTERS.some(([f]) => f === s);
}

/** Who wrote a row, under its text (the mockup's words). */
export const BY_UI: Record<LogBy, string> = { user: "added by you", agent: "agent", rushes: "Rushes" };

export interface DayGroup {
  key: string;
  heading: string;
  entries: LogLine[];
}

/** Newest-first lines under their local day's heading (§22.8). */
export function groupByDay(entries: readonly LogLine[], now: Date): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const e of entries) {
    const d = new Date(e.at);
    const key = localDate(d);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.entries.push(e);
    else groups.push({ key, heading: dayHeading(d, now, true), entries: [e] });
  }
  return groups;
}

export type JumpTarget = { tab: Stage | "assets"; video?: string; version?: string; row?: string };

const TABS: readonly string[] = ["script", "picture", "voice", "music", "sfx", "mix"];

/** R18: where a row goes, as far as what still exists allows. Null when it has nowhere to go (R14). */
export function jumpOf(
  e: LogLine,
  project: { videos: { id: string; versions: { id: string }[] }[]; lanes: { id: string; stage: LaneStage }[] },
): JumpTarget | null {
  const film = e.video ? project.videos.find((v) => v.id === e.video) : undefined;
  if (film) return e.version && film.versions.some((v) => v.id === e.version) ? { tab: "picture", video: film.id, version: e.version } : { tab: "picture", video: film.id };
  const slash = e.ref ? e.ref.indexOf("/") : -1;
  const lane = slash > 0 ? project.lanes.find((l) => l.id === e.ref!.slice(0, slash)) : undefined;
  if (lane) return { tab: lane.stage, row: e.ref! };
  if (e.kind === "entry") return e.video || e.version || e.ref ? fallback(e) : null;
  return fallback(e);
}

function fallback(e: LogLine): JumpTarget | null {
  if (e.tab && TABS.includes(e.tab)) return { tab: e.tab as Stage };
  if (e.area === "assets") return { tab: "assets" };
  if (TABS.includes(e.area)) return { tab: e.area as Stage };
  return null;
}

/** How many lines in `next` are new or updated since `shown` (the "N new" pill). */
export function newCount(shown: readonly LogLine[], next: readonly LogLine[]): number {
  const seen = new Set(shown.map((e) => `${e.id}@${e.at}`));
  return next.filter((e) => !seen.has(`${e.id}@${e.at}`)).length;
}

/** The footer's words (R16, §22.9). */
export function footText(v: { entries: readonly unknown[]; earlier: number; dropped: number }): string {
  const matching = v.entries.length + v.earlier;
  const count = v.earlier > 0 ? `Showing the newest ${v.entries.length} of ${matching}` : `${matching} entr${matching === 1 ? "y" : "ies"}`;
  return v.dropped > 0 ? `${count} · Earlier entries were removed` : count;
}

export interface KeyStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function storageKey(projectId: string, what: "log-open" | "log-seen" | "log-filter"): string {
  return `rushes:${projectId}:${what}`;
}

/** Storage that's blocked, missing or full (a private window, say) reads as nothing and never breaks the drawer. */
export function recall(store: KeyStore | undefined, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function remember(store: KeyStore | undefined, key: string, value: string): void {
  try {
    store?.setItem(key, value);
  } catch {
    // Nothing to do: the choice just isn't remembered.
  }
}
```

- [ ] **Step 4: Add the web types.** In `web/src/types.ts`:
  - after line 7, add `export type { LogLine, UndatedLine } from "../../src/core/logText.js";`, `export type { LogView } from "../../src/core/log.js";` and `export type { LogHead } from "../../src/server/logbook.js";`;
  - after line 13, add `import type { LogHead } from "../../src/server/logbook.js";`;
  - inside `State`, after `found: FoundSummary;`, add:

```ts
  /** §22.8: the Change Log's newest line and size, for the header button's dot (null if it couldn't be read). */
  log?: LogHead | null;
```

- [ ] **Step 5: Run the unit tests.** Run: `npx vitest run test/web/changelog.test.ts && npm run typecheck`. Expected: PASS (the CSS test still fails until Step 7).

- [ ] **Step 6: Write `web/src/ui/ChangeLog.tsx`:**

```tsx
// §22.8: the header's Change Log button and the drawer it opens, newest first by day and live. Not
// modal: the dashboard stays usable. Its open state and filter last the session; the last line seen
// is kept in the browser, for the dot.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api } from "../api.js";
import {
  AREA_LABELS, BY_UI, FILTERS, clock, footText, groupByDay, isFilter, jumpOf, newCount, recall, remember, storageKey, type Filter, type JumpTarget, type KeyStore,
} from "../changelog.js";
import { moveActive } from "../versions.js";
import type { LogHead, LogLine, LogView, Project, Stage } from "../types.js";

/** How many lines the drawer loads (R16). */
const LIMIT = 1000;
/** Scrolled further than this counts as reading: new lines wait behind the pill (§22.8). */
const READING_PX = 40;

const session = (): KeyStore | undefined => {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
};
const local = (): KeyStore | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

export interface ChangeLogState {
  open: boolean;
  /** True when the person opened it just now (the input takes focus); false when it reopens with the session. */
  focusOnOpen: boolean;
  /** Lines arrived since it was last open (R19). */
  dot: boolean;
  setOpen(open: boolean): void;
}

export function useChangeLog(projectId: string, head: LogHead | null | undefined): ChangeLogState {
  const [open, setOpenState] = useState(() => recall(session(), storageKey(projectId, "log-open")) === "1");
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const [seen, setSeen] = useState(() => recall(local(), storageKey(projectId, "log-seen")));
  const mark = head?.mark ?? null;
  // Whatever arrives while it's open has been seen.
  useEffect(() => {
    if (!open || !mark || mark === seen) return;
    setSeen(mark);
    remember(local(), storageKey(projectId, "log-seen"), mark);
  }, [open, mark]);
  const setOpen = (o: boolean) => {
    setOpenState(o);
    setFocusOnOpen(o);
    remember(session(), storageKey(projectId, "log-open"), o ? "1" : "0");
  };
  return { open, focusOnOpen, dot: !open && !!mark && mark !== seen, setOpen };
}

/** The mockup's clock-arrow. */
function HistoryIcon() {
  return (
    <svg class="ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function ChangeLogButton({ log, buttonRef }: { log: ChangeLogState; buttonRef: { current: HTMLButtonElement | null } }) {
  return (
    <button ref={buttonRef} type="button" class="btn clog" aria-expanded={log.open} aria-controls="changelog" onClick={() => log.setOpen(!log.open)}>
      <HistoryIcon />
      Change Log
      {log.dot && (
        <>
          <span class="cdot" aria-hidden="true" />
          <span class="vh"> (new entries)</span>
        </>
      )}
    </button>
  );
}

/** R18: after a jump, a variant's lane row takes focus once its tab has drawn it (for up to about a second). */
export function focusRow(row: string): void {
  let tries = 0;
  const attempt = () => {
    const el = document.querySelector<HTMLElement>(`.lane[data-row="${CSS.escape(row)}"] .nm`);
    if (el) {
      el.scrollIntoView({ block: "nearest" });
      el.focus({ preventScroll: true });
      return;
    }
    if (++tries < 60) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

export interface ChangeLogDrawerProps {
  log: ChangeLogState;
  projectId: string;
  head: LogHead | null | undefined;
  project: Pick<Project, "videos" | "lanes">;
  /** The tab on screen: a line added here is about it (R15). */
  stage: Stage | "assets";
  /** The page header: the drawer sits under it. */
  header: { current: HTMLElement | null };
  buttonRef: { current: HTMLButtonElement | null };
  toast(message: string): void;
  onJump(to: JumpTarget): void;
}

export function ChangeLogDrawer(props: ChangeLogDrawerProps) {
  return props.log.open ? <Drawer {...props} /> : null;
}

function Row({ entry: e, to, onGo }: { entry: LogLine; to: JumpTarget | null; onGo(to: JumpTarget): void }) {
  const inner = (
    <>
      <span class="ltime">{clock(new Date(e.at))}</span>
      <span class={`ltag ${e.area}`}>{AREA_LABELS[e.area]}</span>
      <span class="ltext">
        {e.text}
        <span class="lby">{BY_UI[e.by]}</span>
      </span>
      <span class="lgo" aria-hidden="true">{to ? "›" : ""}</span>
    </>
  );
  // R14: a row with somewhere to go is a button; the rest are text, so Tab doesn't stop on every line.
  return to ? (
    <button type="button" class="lrow" data-entry={e.id} data-go="" onClick={() => onGo(to)}>{inner}</button>
  ) : (
    <div class="lrow" data-entry={e.id}>{inner}</div>
  );
}

function Drawer({ log, projectId, head, project, stage, header, buttonRef, toast, onJump }: ChangeLogDrawerProps) {
  const [view, setView] = useState<LogView | null>(null);
  const [waiting, setWaiting] = useState<LogView | null>(null);
  const [filter, setFilter] = useState<Filter>(() => {
    const saved = recall(session(), storageKey(projectId, "log-filter"));
    return isFilter(saved) ? saved : "all";
  });
  const [text, setText] = useState("");
  const [top, setTop] = useState(0);
  const root = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const chips = useRef<Record<string, HTMLButtonElement | null>>({});
  const shown = useRef<LogView | null>(null);
  shown.current = view;
  const seq = useRef(0);

  const reading = () => (list.current?.scrollTop ?? 0) > READING_PX;
  /** Fetches the newest lines. While someone reads further down, they wait behind the pill instead (§22.8). */
  const load = async (force = false) => {
    const n = ++seq.current;
    const q = new URLSearchParams({ limit: String(LIMIT) });
    if (filter !== "all") q.set("area", filter);
    try {
      const next = await api.get<LogView>(`/api/log?${q}`);
      if (n !== seq.current) return;
      if (!force && shown.current && reading()) setWaiting(next);
      else {
        setView(next);
        setWaiting(null);
      }
    } catch (e) {
      if (n === seq.current) toast((e as Error).message);
    }
  };
  // A new filter starts at the top. New lines refetch, since every write moves the head's rev.
  useEffect(() => {
    if (list.current) list.current.scrollTop = 0;
    void load(true);
  }, [filter]);
  useEffect(() => {
    if (shown.current) void load();
  }, [head?.rev]);

  // Under the header, whatever its height.
  useLayoutEffect(() => {
    const el = header.current;
    if (!el) return;
    const place = () => setTop(Math.max(0, Math.round(el.getBoundingClientRect().bottom)));
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, { passive: true });
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place);
    };
  }, []);

  useEffect(() => {
    if (log.focusOnOpen) input.current?.focus();
  }, []);

  const close = () => {
    log.setOpen(false);
    buttonRef.current?.focus();
  };
  // R13: Esc closes it when the key comes from inside it, from its button or from the page itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as Node | null;
      const here = !t || t === document.body || t === document.documentElement || t === buttonRef.current || !!root.current?.contains(t);
      if (!here) return;
      e.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const add = async () => {
    const line = text.trim();
    if (!line) return;
    try {
      await api.post("/api/log", { text: line, area: stage });
      setText("");
      if (list.current) list.current.scrollTop = 0;
      await load(true);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const choose = (f: Filter) => {
    setFilter(f);
    remember(session(), storageKey(projectId, "log-filter"), f);
  };
  // A radio group: the arrows move and choose. They stop here, so they never step the picture's frames.
  const onChipKey = (e: KeyboardEvent, i: number) => {
    const to = moveActive(e.key, i, FILTERS.length, true);
    if (to === null) return;
    e.preventDefault();
    e.stopPropagation();
    const f = FILTERS[to][0];
    choose(f);
    chips.current[f]?.focus();
  };
  const showWaiting = () => {
    if (!waiting) return;
    setView(waiting);
    setWaiting(null);
    if (list.current) list.current.scrollTop = 0;
    // The pill goes; focus moves to the newest line rather than being lost.
    requestAnimationFrame(() => (list.current?.querySelector<HTMLElement>(".lrow[data-go]") ?? list.current)?.focus());
  };
  const onScroll = () => {
    if (waiting && !reading()) {
      setView(waiting);
      setWaiting(null);
    }
  };
  const go = (to: JumpTarget) => {
    onJump(to);
    if (window.innerWidth < 560) log.setOpen(false); // R18: full width covers the page
  };
  const exportMd = async () => {
    try {
      const r = await api.post<{ path: string }>("/api/exports/change-log", {});
      toast(`Saved to ${r.path}`);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const now = new Date();
  const groups = view ? groupByDay(view.entries, now) : [];
  const fresh = view && waiting ? newCount(view.entries, waiting.entries) : 0;
  const nothing = view !== null && view.total === 0 && view.undated.length === 0;
  const nothingHere = view !== null && !nothing && view.entries.length === 0 && view.undated.length === 0;
  return (
    <aside id="changelog" class="drawer" ref={root} aria-label="Change Log" style={{ top: `${top}px` }}>
      <div class="dhead">
        <h2>Change Log</h2>
        <span class="dquiet">newest first</span>
        <button type="button" class="btn dclose" aria-label="Close the change log" onClick={close}>Close</button>
      </div>
      <form class="dadd" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input
          ref={input}
          value={text}
          maxLength={160}
          placeholder="Add a line to the log"
          aria-label="Add a line to the log"
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
        />
        <button type="submit" class="btn">Add</button>
      </form>
      <div class="dchips" role="radiogroup" aria-label="Show">
        {FILTERS.map(([f, label], i) => (
          <button
            type="button"
            role="radio"
            aria-checked={filter === f}
            tabIndex={filter === f ? 0 : -1}
            ref={(el) => { chips.current[f] = el; }}
            onClick={() => choose(f)}
            onKeyDown={(e) => onChipKey(e, i)}
          >
            {label}
          </button>
        ))}
      </div>
      {/* The pill sits over the list, outside the scroller, so showing it never moves a line (§22.8). */}
      <div class="dwrap">
        {fresh > 0 && <button type="button" class="dpill" onClick={showWaiting}>{fresh} new</button>}
      <div class="dlist" ref={list} tabIndex={-1} aria-label="Entries" onScroll={onScroll}>
        {view === null && <p class="dempty">Loading…</p>}
        {nothing && <p class="dempty">Nothing yet. Rushes writes a line here whenever a cut, a take or a variant is added.</p>}
        {nothingHere && <p class="dempty">Nothing for this filter.</p>}
        {groups.map((g) => (
          <section key={g.key} aria-label={g.heading}>
            <h3 class="dday">{g.heading}</h3>
            <ul>
              {g.entries.map((e) => (
                <li key={e.id}>
                  <Row entry={e} to={jumpOf(e, project)} onGo={go} />
                </li>
              ))}
            </ul>
          </section>
        ))}
        {view && view.undated.length > 0 && (
          <section class="dbefore" aria-label="Before the log">
            <h3>Before the log</h3>
            <ul>{view.undated.map((u) => <li>{u.text}</li>)}</ul>
          </section>
        )}
      </div>
      </div>
      <div class="dfoot">
        <span>{view ? footText(view) : ""}</span>
        <button type="button" class="btn" onClick={() => void exportMd()}>Export as Markdown</button>
      </div>
    </aside>
  );
}
```

- [ ] **Step 7: Write the styles.** Append to `web/src/changes.css`:

```css
/* §22.8: the Change Log button and drawer (the approved mockup). */
.clog { position: relative; display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
.clog .ic { flex: none; width: 18px; height: 18px; }
.clog[aria-expanded="true"] { background: var(--accent-soft); color: var(--accent-2); box-shadow: inset 0 0 0 1px var(--accent); }
.clog .cdot { position: absolute; top: -3px; right: -3px; width: 10px; height: 10px; border-radius: 50%; background: var(--todo); border: 2px solid var(--app); }
.drawer { position: fixed; right: 0; bottom: 0; z-index: 35; display: grid; width: 440px; max-width: 100%; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto auto minmax(0, 1fr) auto; background: var(--app); border-left: 1px solid var(--line-2); box-shadow: -16px 0 40px rgba(0, 0, 0, 0.35); font-size: 15px; animation: drawer-in 0.16s ease-out; }
@keyframes drawer-in { from { transform: translateX(105%); } to { transform: none; } }
@media (max-width: 559px) { .drawer { width: 100%; } }
.dhead { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.dhead h2 { margin: 0; font-size: 16px; font-weight: 600; }
.dhead .dquiet { color: var(--text-3); }
.dhead .dclose { margin-left: auto; }
.dadd { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--line); }
.dadd input { min-width: 0; padding: 8px 12px; border: 1px solid var(--line-2); border-radius: var(--r); background: var(--bg); color: var(--text); font-size: 15px; }
.dchips { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 16px; border-bottom: 1px solid var(--line); }
.dchips [role="radio"] { padding: 2px 12px; border: 1px solid var(--line-2); border-radius: 999px; background: transparent; color: var(--text-2); font-size: 15px; cursor: pointer; }
.dchips [aria-checked="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-2); }
.dwrap { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); min-height: 0; }
.dlist { overflow: auto; padding: 4px 0 12px; }
.dlist ul { margin: 0; padding: 0; list-style: none; }
.dpill { position: absolute; top: 8px; left: 50%; z-index: 3; transform: translateX(-50%); padding: 4px 14px; border: 0; border-radius: 999px; background: var(--accent); color: var(--on-accent); font-size: 15px; font-weight: 600; cursor: pointer; }
.dday { position: sticky; top: 0; z-index: 1; margin: 0; padding: 12px 16px 4px; background: var(--app); color: var(--text-3); font-size: 15px; font-weight: 600; }
.lrow { display: grid; grid-template-columns: 48px 116px minmax(0, 1fr) 16px; gap: 10px; align-items: start; width: 100%; padding: 8px 16px; border: 0; background: transparent; color: var(--text); text-align: left; font-size: 15px; }
button.lrow { cursor: pointer; }
button.lrow:hover { background: var(--hover); }
.lrow .ltime { color: var(--text-3); font-family: var(--mono); }
.lrow .ltag { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 8px; border: 1px solid; border-radius: 999px; font-size: 15px; line-height: 22px; text-align: center; }
.ltag.picture { color: var(--accent-2); border-color: var(--accent); }
.ltag.voice { color: var(--vo); border-color: var(--vo); }
.ltag.music { color: var(--music); border-color: var(--music); }
.ltag.sfx { color: var(--sfx); border-color: var(--sfx); }
.ltag.mix { color: var(--over); border-color: var(--over); }
.ltag.notes { color: var(--todo); border-color: var(--todo); }
.ltag.script { color: var(--done); border-color: var(--done); }
.ltag.assets, .ltag.project { color: var(--text-2); border-color: var(--line-2); }
.lrow .ltext { overflow-wrap: anywhere; }
.lrow .lby { display: block; color: var(--text-3); font-size: 15px; }
.lrow .lgo { color: var(--text-3); }
.dbefore { margin: 10px 16px 0; padding-top: 10px; border-top: 1px dashed var(--line-2); color: var(--text-2); }
.dbefore h3 { margin: 0 0 6px; color: var(--text-3); font-size: 15px; font-weight: 600; }
.dempty { margin: 0; padding: 28px 20px; color: var(--text-3); }
.dfoot { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 10px 16px; border-top: 1px solid var(--line); color: var(--text-3); }
@media (prefers-reduced-motion: reduce) { .drawer { animation: none; } }
```

- [ ] **Step 8: Wire up App.** In `web/src/ui/App.tsx`:
  - Change line 2 to `import { api, ApiError, projectId } from "../api.js";`. Add `import { ChangeLogButton, ChangeLogDrawer, focusRow, useChangeLog } from "./ChangeLog.js";` and `import type { JumpTarget } from "../changelog.js";`.
  - After `const [foundSeen, setFoundSeen] = useState<string | null>(null);` (line 112):

```ts
  // §22.8: the Change Log drawer, and whether lines arrived since it was last open.
  const changeLog = useChangeLog(projectId() ?? "", state?.log);
  const changeLogButton = useRef<HTMLButtonElement>(null);
```

  - After `toggleLock` (line 199):

```ts
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
```

  - After the shortcuts button (line 403), before the Send to agent button: `<ChangeLogButton log={changeLog} buttonRef={changeLogButton} />`.
  - After `</header>` (line 413):

```tsx
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
```

- [ ] **Step 9: Write the failing e2e tests** at `e2e/changelog.spec.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test, versionButton, videoReady } from "./fixture.js";

const logButton = (page: Page) => page.getByRole("button", { name: /^Change Log/ });
const drawer = (page: Page) => page.getByRole("complementary", { name: "Change Log" });
const rows = (page: Page) => drawer(page).locator(".lrow");

test("Change Log opens a drawer under the header, newest first by day, and Esc gives focus back (§22.8)", async ({ page, rushes }) => {
  await rushes.addCut("v1: first pass; rough timing");
  await rushes.addVariant("music", "Night drive", { seconds: 2, freq: 220, lane: "night-drive" });
  await page.goto(rushes.url);
  await videoReady(page);
  const button = logButton(page);
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const d = drawer(page);
  await expect(d.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(rows(page)).toHaveText([/Music: “Night drive” added to night-drive/, /v1 added: first pass/]);
  await expect(rows(page).nth(0)).toContainText("agent");
  await expect(rows(page).nth(0).locator(".ltag")).toHaveText("Music");
  const head = (await page.locator("header.head").boundingBox())!;
  const box = (await d.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(Math.floor(head.y + head.height) - 1);
  expect(Math.round(box.width)).toBe(440);
  expect(Math.round(box.x + box.width)).toBe(1440);
  await expect(d.getByLabel("Add a line to the log")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("a line added in the drawer is by you, about the tab on screen; the filters are a radio group kept for the session (§22.8)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await rushes.addVariant("music", "Night drive", { seconds: 2, freq: 220 });
  await page.goto(rushes.url);
  await videoReady(page);
  await logButton(page).click();
  const input = drawer(page).getByLabel("Add a line to the log");
  await input.fill("Decided to slow the zooms; the first cut felt rushed");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await expect(rows(page).first()).toContainText("Decided to slow the zooms");
  await expect(rows(page).first()).toContainText("added by you");
  await expect(rows(page).first().locator(".ltag")).toHaveText("Picture");
  expect(await rows(page).first().evaluate((el) => el.tagName)).toBe("DIV"); // nowhere to go (R14)
  const { entries } = await rushes.api("GET", "/api/log");
  expect(entries[0]).toMatchObject({ by: "user", area: "picture", kind: "entry" });

  const chips = drawer(page).getByRole("radiogroup", { name: "Show" });
  await expect(chips.getByRole("radio")).toHaveText(["All", "Picture", "Voice", "Music", "Sound effects", "Mix", "Notes", "Files"]);
  await chips.getByRole("radio", { name: "All" }).focus();
  const t0 = await page.getByLabel("Timecode").textContent();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await expect(chips.getByRole("radio", { name: "Music" })).toHaveAttribute("aria-checked", "true");
  await expect(chips.getByRole("radio", { name: "Music" })).toBeFocused();
  await expect(page.getByLabel("Timecode")).toHaveText(t0!); // the arrows moved the chips, not the playhead
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Music:");
  await page.reload();
  await videoReady(page);
  await expect(drawer(page)).toBeVisible();
  await expect(chips.getByRole("radio", { name: "Music" })).toHaveAttribute("aria-checked", "true");
  await chips.getByRole("radio", { name: "Sound effects" }).click();
  await expect(drawer(page).getByText("Nothing for this filter.")).toBeVisible();
});

test("ten variants registered at once make one line (§22.5, §22.11)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await Promise.all(Array.from({ length: 10 }, (_, i) => rushes.addVariant("music", `Bed ${i + 1}`, { seconds: 1, freq: 200 + i * 20 })));
  await page.goto(rushes.url);
  await logButton(page).click();
  await expect(rows(page)).toHaveText([/Music: 10 variants added/, /v1 added: first cut/]);
});

test("while you read further down, new lines wait behind an 'N new' pill and the list doesn't jump (§22.8, §22.11)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  for (let i = 1; i <= 40; i++) await rushes.api("POST", "/api/log", { text: `Decision ${i}: kept the wide shot` });
  await page.goto(rushes.url);
  await videoReady(page);
  await logButton(page).click();
  await expect(rows(page)).toHaveCount(41);
  const list = drawer(page).locator(".dlist");
  await list.evaluate((el) => { el.scrollTop = 600; });
  const before = await list.evaluate((el) => el.scrollTop);
  const firstVisible = () =>
    list.evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      return [...el.querySelectorAll(".lrow")].find((r) => r.getBoundingClientRect().bottom > top + 40)?.textContent ?? "";
    });
  const reading = await firstVisible();
  await rushes.api("POST", "/api/log", { text: "Swapped the end card for line B" });
  const pill = drawer(page).getByRole("button", { name: "1 new" });
  await expect(pill).toBeVisible();
  expect(await list.evaluate((el) => el.scrollTop)).toBe(before);
  expect(await firstVisible()).toBe(reading);
  await pill.click();
  await expect(rows(page).first()).toContainText("Swapped the end card for line B");
  expect(await list.evaluate((el) => el.scrollTop)).toBe(0);
});

test("a focused row keeps focus as lines arrive at the top (§22.11)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await rushes.api("POST", "/api/log", { text: "Look at the end card", video: "hero", version: "v1" });
  await page.goto(rushes.url);
  await videoReady(page);
  await logButton(page).click();
  const linked = drawer(page).getByRole("button", { name: /Look at the end card/ });
  await linked.focus();
  for (let i = 1; i <= 5; i++) await rushes.api("POST", "/api/log", { text: `Note to self ${i}` });
  await expect(rows(page)).toHaveCount(7);
  await expect(linked).toBeFocused();
});

test("the dot says lines arrived since the drawer was last open; opening it clears the dot (R19)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(logButton(page)).toHaveAccessibleName("Change Log (new entries)");
  await logButton(page).click();
  await logButton(page).click(); // closed again: seen
  await expect(logButton(page)).toHaveAccessibleName("Change Log");
  await rushes.api("POST", "/api/log", { text: "Moved the logo up" });
  await expect(logButton(page).locator(".cdot")).toHaveCount(1);
  await page.reload();
  await expect(logButton(page).locator(".cdot")).toHaveCount(1); // kept in the browser
  await logButton(page).click();
  await logButton(page).click();
  await page.reload();
  await expect(logButton(page)).toHaveAccessibleName("Change Log");
});

test("a row with somewhere to go opens it: a line on v1 opens Picture at v1, a variant opens its tab and row (R18)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await rushes.addCut("second cut");
  await rushes.addVariant("music", "Night drive", { seconds: 2, freq: 220, lane: "night-drive" });
  await rushes.api("POST", "/api/log", { text: "The end card on v1 read better", video: "hero", version: "v1" });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(versionButton(page)).toHaveAttribute("data-version", "v2");
  await logButton(page).click();
  await expect(rows(page)).toHaveText([/The end card on v1/, /Music: “Night drive”/, /2 cuts added, the latest v2: second cut/]);
  await drawer(page).getByRole("button", { name: /The end card on v1 read better/ }).click();
  await expect(versionButton(page)).toHaveAttribute("data-version", "v1");
  await expect(drawer(page)).toBeVisible();
  await drawer(page).getByRole("button", { name: /Music: “Night drive” added/ }).click();
  await expect(page.getByRole("tab", { name: /Music/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('.lane[data-row="night-drive/night-drive"] .nm')).toBeFocused();
});

test("an empty log says so; audio from before the log is listed undated; Export as Markdown writes the file (§22.6–§22.8)", async ({ page, rushes }) => {
  await page.goto(rushes.url);
  await logButton(page).click();
  await expect(drawer(page).getByText("Nothing yet. Rushes writes a line here whenever a cut, a take or a variant is added.")).toBeVisible();
  await rushes.addVariant("music", "Night drive", { seconds: 2, freq: 220, lane: "night-drive" });
  // History made by hand: the variant was already there when the log began.
  await writeFile(join(rushes.root, ".rushes", "log.json"), JSON.stringify({ schema: 1, rev: 99, backfilled: true, undated: ["night-drive/night-drive"], dropped: 0, entries: [] }));
  await expect(drawer(page).getByRole("region", { name: "Before the log" })).toContainText("Music: night-drive (1 variant)");
  await drawer(page).getByRole("button", { name: "Export as Markdown" }).click();
  const status = page.getByRole("status");
  await expect(status).toContainText(/Saved to exports\/change-log-\d{4}-\d{2}-\d{2}\.md/);
  const name = (await status.textContent())!.match(/exports\/(change-log-[\d-]+\.md)/)![1];
  const md = await readFile(join(rushes.root, "exports", name), "utf8");
  expect(md).toContain("# My Film — change log");
  expect(md).toContain("## Before the log\n- Music: night-drive (1 variant)");
});

test("under 560 px the drawer is full width; reduced motion drops the slide (§22.8)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await page.goto(rushes.url);
  await logButton(page).click();
  expect(await drawer(page).evaluate((el) => getComputedStyle(el).animationName)).toBe("drawer-in");
  await logButton(page).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 500, height: 800 });
  await logButton(page).click();
  expect(await drawer(page).evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  expect(Math.round((await drawer(page).boundingBox())!.width)).toBe(500);
});

test("the drawer isn't modal: tabs and keys still work with it open (§22.8)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await page.goto(rushes.url);
  await videoReady(page);
  await logButton(page).click();
  await page.getByRole("tab", { name: /Script/ }).click();
  await expect(page.getByRole("tab", { name: /Script/ })).toHaveAttribute("aria-selected", "true");
  await expect(drawer(page)).toBeVisible();
  await page.keyboard.press("2");
  await expect(page.getByRole("tab", { name: /Picture/ })).toHaveAttribute("aria-selected", "true");
});
```

- [ ] **Step 10: Run e2e and see it fail, then pass.** Run: `npm run build && npx playwright test e2e/changelog.spec.ts --project=chromium --retries=0`. Expected: FAIL before Steps 6–8 are in; PASS after. Then run `npx playwright test e2e/changelog.spec.ts --project=webkit --retries=0`. Expected: PASS.

- [ ] **Step 11: Run the gates.** Run: `npm run build && npm run typecheck && npx vitest run && npx playwright test --retries=0` (both projects). Expected: all green. Save 1440×900 screenshots of the open drawer (with the "N new" pill showing) and of a 500 px window to the scratchpad path given in the dispatch.

- [ ] **Step 12: Commit.**

```bash
git add web/src/changelog.ts web/src/ui/ChangeLog.tsx web/src/ui/App.tsx web/src/types.ts web/src/changes.css test/web/changelog.test.ts test/web/changes-css.test.ts e2e/changelog.spec.ts
git -c user.name=iamredmh -c user.email=17407420+iamredmh@users.noreply.github.com commit -m "feat(web): the Change Log button and drawer: newest first by day, live, filters, a line of your own, jumps and export" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

**Mutation check:** making `load` always apply (`if (false && …)` in place of the `reading()` check) must fail "while you read further down, new lines wait behind an 'N new' pill".

---

### Task 7: The README, the realistic check and CI

**Files:**
- Modify: `README.md` (a new "The Change Log" section after "Locked tabs"; "What gets saved")
- Test: `test/docs-changelog.test.ts` (append)

**Interfaces:**
- Consumes: everything above.
- Produces: docs, plus measured evidence in the task report.

- [ ] **Step 1: Write the failing docs test.** Append to `test/docs-changelog.test.ts`:

```ts
describe("README: the Change Log (§22)", () => {
  it("has a section, the CLI and the file, and no personal paths", () => {
    const text = read("README.md");
    expect(text).toContain("## The Change Log");
    for (const s of ["rushes log --md", 'rushes log add "', "change-log-<date>.md", "Before the log", "log.json"]) expect(text, s).toContain(s);
    expect(text).toMatch(/version list/i);
    expect(text).not.toMatch(/\/Users\//);
  });
});
```

- [ ] **Step 2: Run it and see it fail.** Run: `npx vitest run test/docs-changelog.test.ts`. Expected: FAIL.

- [ ] **Step 3: Write the README.**
  - After "## Locked tabs", add:

    > ## The Change Log
    >
    > The **Change Log** button in the header opens a log of what happened, newest first and grouped by day:
    > - each cut, voice read, music bed, sound-effects pass and take as it arrives;
    > - the script, picks and notes sent;
    > - the agent's replies.
    >
    > Rushes writes it itself, one short line per event, and a burst of registrations is one line. You can:
    > - type a line of your own at the top;
    > - filter by tab;
    > - click a line to open that cut or variant.
    >
    > A dot on the button means new lines since you last looked. **Export as Markdown** (and **Export notes**) writes `exports/change-log-<date>.md`. A project made before the log existed starts it from the dates it already has (cuts, notes sent and files); its older audio is listed undated, under "Before the log".
    >
    > Picture's version list shows each cut's short label (the agent's, or one taken from its note) and how long ago it arrived, with its full note beside the list and under the picture.
    >
    > ```bash
    > rushes log --limit 20          # newest first
    > rushes log --area music
    > rushes log --md                # the same Markdown the export writes
    > rushes log add "Kept the wide shot" --area picture
    > ```

  - In "What gets saved", add the line `  log.json       the Change Log: what happened, newest first` after `batches.json`.

- [ ] **Step 4: Run the docs test.** Run: `npx vitest run test/docs-changelog.test.ts test/package.test.ts`. Expected: PASS.

- [ ] **Step 5: Run the realistic check (generated project only).** Do this on a quiet machine. Never copy real files.

```bash
cd ~/Developer/rushes-changelog && npm run build
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/rushes-log-check.XXXX")
export PROJ="$SCRATCH/Lumen launch film"; mkdir -p "$PROJ"
REPO="$HOME/Developer/rushes-changelog"; CLI="node $REPO/dist/cli/index.js"
```

  Write `$SCRATCH/seed.mjs` (a throwaway, never committed). It builds a 0.2.2-shaped project with no `log.json`:
  - 30 cuts over two films across ten days;
  - 40 variants in six lanes;
  - 60 dated docs;
  - 25 batches;
  - a script with a take.

```js
const REPO = process.env.REPO;
const { Store } = await import(`${REPO}/dist/core/store.js`);
const { addVersion, addVariant, addFile } = await import(`${REPO}/dist/core/project.js`);
const { setSections, addTake } = await import(`${REPO}/dist/core/script.js`);
const store = new Store(process.env.PROJ);
await store.init("Lumen launch film");
const start = Date.now() - 10 * 86_400_000;
await store.update("project", (p) => {
  for (let i = 0; i < 30; i++) addVersion(p, { video: i % 3 ? "Lumen launch film" : "Lumen teaser", file: `renders/lumen_${i + 1}.mp4`, note: `v${i + 1}: pass ${i + 1}; detail that goes on` }, new Date(start + i * 7 * 3_600_000));
  for (let i = 0; i < 40; i++) addVariant(p, { stage: ["voice", "music", "sfx"][i % 3], lane: `lane-${i % 6}`, name: `Take ${i + 1}`, file: `audio/a${i}.wav` });
  for (let i = 0; i < 60; i++) addFile(p, { kind: "doc", file: `docs/d${i}.md` }, new Date(start + i * 3 * 3_600_000));
});
await store.update("batches", (b) => {
  for (let i = 0; i < 25; i++) b.batches.push({ id: `b_${i + 1}`, stage: "picture", noteIds: ["n_1", "n_2"], sectionIds: [], sentAt: new Date(start + i * 9 * 3_600_000).toISOString(), prompt: "" });
});
await store.update("script", (s) => { setSections(s, [{ start: 0, end: 4, current: "One." }, { start: 4, end: 8, current: "Two." }]); addTake(s, "s1", { file: "audio/t1.wav" }); });
```

```bash
REPO="$REPO" PROJ="$PROJ" node "$SCRATCH/seed.mjs"
RUSHES_NO_REVEAL=1 $CLI serve "$PROJ" --port 0 > "$SCRATCH/serve.log" 2>&1 &
SERVE_PID=$!; sleep 2; URL=$(grep -o 'http://127.0.0.1:[0-9]*' "$SCRATCH/serve.log" | head -1); echo "$URL"
time curl -s "$URL/api/log?limit=5" > /dev/null                     # the first read: the backfill
for i in $(seq 1 85); do curl -s -X POST -H 'content-type: application/json' -d "{\"text\":\"Decision $i\"}" "$URL/api/log" > /dev/null; done
for i in $(seq 1 10); do curl -s -X POST -H 'content-type: application/json' -d "{\"stage\":\"music\",\"name\":\"Burst $i\",\"file\":\"audio/burst$i.wav\"}" "$URL/api/variants" > /dev/null & done; wait
$CLI log --dir "$PROJ" --limit 3
( for i in $(seq 1 50); do curl -s -X POST -H 'content-type: application/json' -d "{\"text\":\"Writer A $i\"}" "$URL/api/log" > /dev/null; done ) &
( for i in $(seq 1 50); do curl -s -X POST -H 'content-type: application/json' -d "{\"text\":\"Writer B $i\"}" "$URL/api/log" > /dev/null; done ) &
wait
curl -s "$URL/api/log?limit=5000" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log("total",v.total,"writers",v.entries.filter(e=>/^Writer [AB] /.test(e.text)).length,"undated",JSON.stringify(v.undated))})'
$CLI log --dir "$PROJ" --md | head -20
```

  Then write `$SCRATCH/check.mjs` (a throwaway). It opens `$URL` in Chromium (`import { chromium } from "@playwright/test"`) at 1440×900 and:
  1. opens the version list and screenshots it to `$SCRATCH/versions.png`;
  2. presses Esc, clicks **Change Log**, and times the click until the first `.lrow` is visible;
  3. screenshots `$SCRATCH/drawer.png`;
  4. posts five lines with the list scrolled, and screenshots the pill to `$SCRATCH/pill.png`.

  Run it from the repo: `cd ~/Developer/rushes-changelog && URL="$URL" SCRATCH="$SCRATCH" node --input-type=module -e "$(cat "$SCRATCH/check.mjs")"`.

  Then the cap check:
  1. Stop the server: `kill $SERVE_PID`.
  2. Write a `log.json` with 4995 generated entries.
  3. Start the server again, and time 20 sequential `POST /api/log`. Print the median and the worst.

  Paste every timing, the three CLI outputs and the screenshot paths into the report. Expected:
  - the backfill's first read is under 500 ms;
  - the burst of 10 is one line ("Music: 10 variants added to lane-1");
  - both writers' 100 lines are all present, and `total` is right;
  - "Before the log" lists six lanes and "Voiceover: 1 section with takes";
  - the drawer shows within 1 s;
  - near the cap, the median append is under 150 ms and the worst under 1 s.

- [ ] **Step 6: Run the gates.** Run: `npm run build && npm run typecheck && npx vitest run && npx playwright test --retries=0` (both projects), then `npm pack --dry-run` (the files list is unchanged). Expected: all green.

- [ ] **Step 7: Commit.**

```bash
git add README.md test/docs-changelog.test.ts
git -c user.name=iamredmh -c user.email=17407420+iamredmh@users.noreply.github.com commit -m "docs: the Change Log and the version list in the README" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Push and see CI green.** Run: `git push -u origin changelog`, then `gh run watch --exit-status $(gh run list --branch changelog --limit 1 --json databaseId -q '.[0].databaseId')`. Expected: all four jobs pass (Chromium and WebKit, on Node 20.19 and 22). If a job fails, read its Playwright report artifact, fix it and push again. Never retry a flaky test into green.

**Mutation check:** removing the `## The Change Log` section must fail "README: the Change Log".

The version bump and the release are decided by the controller at release time. This plan doesn't bump the version.

---

## Spec coverage

| Spec | Task |
|---|---|
| §22.1 (1) the dropdown is a wall of text | 1 (`shortLabel`), 2 (the list) |
| §22.1 (2) nothing says what happened, in order | 3, 4, 6 |
| §22.2 (1) `Version.label`, ≤ 48, derived when missing | 1 (R2) |
| §22.2 (2) a list: id, short label, how long ago; the note beside it and under the picture | 2 |
| §22.2 (3) `.rushes/log.json`, written by Rushes, one line each | 3, 4 |
| §22.2 (4) newest first, by day | 3 (`logView`, `logMarkdown`), 6 (`groupByDay`) |
| §22.2 (5) a Change Log button and drawer, not a tab | 6 |
| §22.2 (6) agents write and read it; people add lines | 4 (`POST /api/log`), 5, 6 |
| §22.2 (7) short, never note content; bursts collapse | 3 (R4, R9) |
| §22.3 the data, additive | 1 (`label`), 3 (schemas, R1, R3) |
| §22.4 `shortLabel`'s five rules, the examples, its four uses | 1 (Assets), 2 (list), 3 (cut lines), 4 (prompt via R11) |
| §22.5 the table, row by row | 3 (builders), 4 (hooks: versions, lock, variants, takes, script, picks, batches, replies, files, adoption, a line) |
| §22.5 not logged; collapsing | 3 (R4), 4 (R10 test) |
| §22.5 a format added | later hook (Overlap table; needs `"format"` in `LOG_KINDS`) |
| §22.6 backfill once from dated data; audio undated, computed when read; new work dated by its entry | 3 (`backfillLog`, `undatedLines`), 4 (R5, R6 tests) |
| §22.7 `rushes_log`, `rushes_get_log`, `label`, the CLI, Send to agent, Export, AGENTS/SKILL | 1, 4 (prompt, export), 5 |
| §22.8 the version list (menu button, keys, rows, detail, touch, note under the picture) | 2 |
| §22.8 the button, dot, drawer, add, chips, list, Before the log, export, live pill, empty, a11y, reduced motion | 6 |
| §22.9 every edge case | 1 (no note, punctuation, over 48), 3 (cap, retry), 4 (corrupt, missing, two writers, older server via 5), 5 (older server) |
| §22.10 not in this release | nothing builds editing, search, per-note lines, dating old audio or side-by-side |
| §22.11 review focus 1–6 | 4 (1, 5), 1 (2), 3 and 4 (3), 6 (4), 2 and the CSS tests (6) |
