# Rushes Plan 6: Formats — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cut can carry several renders of the same edit at different aspect ratios. Picture gets a format toggle that switches between them seamlessly, and each note belongs to one format or to all of them.

**Architecture:**
- **Core.** A new, dependency-free `src/core/formats.ts` holds the ratio measurement (`ratioLabel`), the chip order, the per-version view of the formats and the note-visibility rule. The schema gains additive fields: `Version.width`, `Version.height` and `Version.formats`, and `Note.format`. `addFormat` and `resolveCut` live in `project.ts`, and `checkNoteFormat` in `notes.ts`.
- **Server.** `probeVideo` reads a render's *displayed* size, with rotation and pixel shape applied, behind an injectable `VideoProber`. The server adds:
  - `POST /api/formats`;
  - `formats` on `POST /api/versions`;
  - the note checks at write time;
  - `?format=` on the notes and frame routes.
  
  Format files join the registered-media allow-list, so `/media` serves them under the §15.5 rules.
- **Agent.**
  - MCP: `rushes_add_format`; `formats` on `rushes_add_version`; `format` and `onlyThisFormat` on `rushes_list_notes`.
  - CLI: `rushes add format` and a format column on `rushes notes`.
  - The Markdown export, the Send-to-agent prompt and the docs.
- **Dashboard.**
  - A `FormatToggle` radio group in the header. Picture switches the file in place, reusing the Proxy/Original resume path.
  - Notes per format: the composer and card switch, tags, rings and the Other formats row.
  - Assets › Cuts sub-rows and grab names.
  - The dashboard imports `src/core/formats.ts` at runtime. It is the one core module it does, which is allowed because the file has only type imports (a unit test enforces this), so no zod or Node code reaches the bundle. Vite and `tsc` (Bundler and NodeNext) both resolve its `.js` specifier to the `.ts` file.

**Tech Stack:** TypeScript (ESM, NodeNext), Hono, zod 4, Preact 10, Vite 8, ffprobe and ffmpeg (optional), vitest, Playwright (Chromium and WebKit).

**Spec:** `docs/specs/2026-10-07-rushes-formats.md` (§21, binding; this plan builds §21.2–§21.6, and §21.7 is out) and the approved mockup `docs/specs/2026-10-07-rushes-formats-mockup.html`. It also draws on `docs/specs/2026-10-02-rushes-design.md`:
- §5: notes and field ownership.
- §14.2: films and the `[`/`]` keys.
- §15.5: serving symlinked files.
- §19.1: the locked-tab copy-prompt pattern.
- §19.4: Safari.
- §19.5: proxies.
- §19.9: the player's layout cap and the waveform.

## Global Constraints

- **Dependencies:** runtime dependencies stay exactly four: `@hono/node-server`, `@modelcontextprotocol/sdk`, `hono` and `zod`.
- **Language and type:** UK English in all copy, docs and comments. Type is 15px or larger everywhere, including the ratio tags, the chip counts and the hint line.
- **Accessibility:** every control has an accessible name and works from the keyboard.
- **Privacy:** no client names and no personal paths anywhere in the repo or tests. Use invented names only ("Hero", "Teaser", "Lumen launch film"), with media generated into temp folders. Never copy real client files.
- **Tests:** tests use `RUSHES_NO_REVEAL=1` (`vitest.config.ts` and `e2e/fixture.ts` already set it) and never open apps.
- **Schemas are additive only:** every new zod field is optional or has a default, so every 0.2.x file loads unchanged (§21.3).
- **ffmpeg and ffprobe stay optional.** Spawn them with an args array, never a shell. Without ffprobe, registering a format fails with "needs ffprobe to read the ratio", and the primary behaves as today (§21.6).
- **Commits:** use `git -c user.name=iamredmh -c user.email=17407420+iamredmh@users.noreply.github.com commit`. Every message ends with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never change git config.
- **Never run `rushes setup` against the real home without `--dry-run`.**
- **Ports:** never use ports 4410, 4430–4434 or 8765. Tests use port 0.
- **No version bump:** `package.json`, `VERSION` in `src/server/app.ts`, `.claude-plugin/plugin.json` and `package-lock.json` stay at 0.2.2.
- **Rendering (Safari):** grids use explicit tracks (`minmax(0,1fr)`), and there's no per-frame React state.
- **Nothing pending is ever dropped (§14.2).** A drawn box is pending and belongs to the format on screen.
- **e2e:** runs in Chromium and WebKit. Run it locally only when the machine is quiet: load average below `sysctl -n hw.ncpu`, and `pgrep -fl 'playwright|ffmpeg'` prints nothing. One default-parallel run takes about a minute. CI on the pushed branch is the final word.
- **The gate for every task:** `npm run build && npm run typecheck && npx vitest run`, then the e2e suite in both projects, where the task touches the dashboard.

## Rulings (where the real code left the spec open)

- **R1: format keys.** `[` and `]` are taken: they switch films (§14.2, `web/src/ui/App.tsx`'s keydown handler). Following §21.5's own fallback, formats use **Alt+←** and **Alt+→**. These don't wrap, like films. They never fire while typing, and the shortcuts popover and README say so.
- **R2: the primary's size is stored.** The version gains `width` and `height` (nullable, default null). They are filled when a cut is added and backfilled when the cut's first format is registered. For an older one-format cut with no stored size, the dashboard takes the player's measured size for the single chip.
- **R3: "Up to 8 formats" means 8 shapes in total, the primary included.** The schema keeps `formats.max(8)` as §21.3 writes it, so a hand-edited file still loads. Registration refuses the ninth shape.
- **R4: tags and counts appear only when needed.** The ratio tags (list, markers, export, CLI) and the per-chip counts appear only when the note's cut has two or more formats, or when the note names a format. One-format cuts look and export exactly as they do today.
- **R5: the one-format chip.** It is greyed and out of the tab order (§21.5). Its popover's Copy button is always in the tab order, and it reveals the popover when focused. That matches the mockup and is keyboard-operable.
- **R6: the selected note.** This is the note last clicked in the list; its box shows on the frame. It stays selected across a switch when it shows on the new format. Otherwise it's cleared, because a note for one format can't show on another (§21.2 (5)).
- **R7: the box rule.**
  - A box belongs to the format it was drawn on: the note's `format`, or the primary for a note from before formats.
  - Switching formats while a box is pending is refused with a toast. Typed text and In/Out carry over.
  - A boxed note can't be widened, or moved to another format.
  - An older boxed note on a cut that has since gained formats draws its box only on the primary.
- **R8: where the toggle sits.** The toggle shows on the Picture tab only. The audio tabs' picture preview always plays the primary. In the header it sits after the version picker and its lock button.
- **R9: the timeline's length** is the cut's (the primary's), whatever format plays. Nothing is rescaled (§21.3).
- **R10: the `label` hint.** It is used only when the measured ratio isn't a §21.3 standard and the hint is within 2% of it. Otherwise the measured label stands, and the reply carries `labelNote` saying why.
- **R11: `rushes_add_version` with `formats` is all-or-nothing.** Every file is read first, and one refusal refuses the whole call. Without ffprobe, the call is refused with 501 rather than registering the primary alone.
- **R12: frames.** `GET …/frame?format=` is what Grab Frame calls on a format. Frames are numbered at the cut's fps. The shot strip and the note thumbnails have no frame-route thumbnails today, so nothing else calls it.
- **R13: decimal labels** put the long side over the short, to two decimals, with trailing zeros dropped: "2.39:1" and "1:2.39".
- **R14: the `format` filter on listing notes** applies to Picture notes only.
- **R15: the composer's hint line** (from the mockup) shows only with two or more formats. On a one-format cut nothing new appears (§21.2 (2)).
- **R16: `rushes_add_format`'s default film** is the one whose newest version was added last.
- **R17: actions in the Other formats row.**
  - "Show on 9:16" appears when the version on screen has that format.
  - "Restore to all formats" appears only when the note's format no longer exists on its own version and the note has no box.
  - Otherwise the row is read only.

## Review Focus

1. **Files saved by 0.2.x.** These have no `width`, `height`, `formats` or `format`. They load, and are written back, unchanged in meaning: their notes read as all-format and nothing new shows on a one-format cut. A boxed note from then, on a cut that later gains formats, draws its box only on the primary. *(Task 1 unit; Task 5 e2e.)*
2. **Real renders whose stored size isn't their shape on screen.** This covers rotation metadata (a phone held upright), non-square pixels (anamorphic), encoder padding (1920×1088) and near-standard sizes (1080×1349). The label is the displayed ratio, snapped per §21.3. *(Task 1 ratio unit; Task 2 parse unit and a real-ffprobe test.)*
3. **A drawn box or a half-typed note while switching formats**, by click, Alt+arrows, the radio arrows or "Show on 9:16". A box is never carried to another shape: the switch is refused with a toast. Typed text and In/Out survive, and Alt+arrows never fire while typing. *(Task 4 and Task 5 e2e.)*
4. **The same shape registered twice under another spelling.** This covers a relative and an absolute path, the primary's own file, a 1280×720 next to a 1920×1080, and two registrations racing. One lands; the other gets §21.3's sentence, "v1 already has 16:9. Register a re-render as a new version." *(Task 1 unit; Task 2 server.)*
5. **A format file that later goes missing, won't play in a browser (ProRes), or is a link out of the project to a non-media file.**
   - The chip warns, and the frame says "File not found".
   - A format the browser can't play gets the won't-play message, and no proxy is offered for the wrong file.
   - `/media` follows §15.5.
   
   *(Task 2 server; Task 4 e2e.)*

---

## File structure

| Area | Files |
|---|---|
| Core | new `src/core/formats.ts`; `src/core/schema.ts`, `src/core/project.ts`, `src/core/notes.ts`, `src/core/media.ts`, `src/core/exportNotes.ts`, `src/core/batches.ts` |
| Server | `src/server/app.ts`, `src/server/start.ts`, `src/server/files.ts`, `src/server/assets.ts` |
| Agent | `src/mcp/tools.ts`, `src/cli/main.ts`, `AGENTS.md`, `skills/rushes/SKILL.md`, `README.md` |
| Web | `web/src/lib.ts`, `web/src/types.ts`, `web/src/api.ts`, new `web/src/ui/FormatToggle.tsx`, new `web/src/ui/FormatScope.tsx`, new `web/src/ui/OtherFormats.tsx`, `web/src/ui/App.tsx`, `web/src/ui/Picture.tsx`, `web/src/ui/Notes.tsx`, `web/src/ui/AssetViews.tsx`, `web/src/styles.css` |
| Tests | new `test/core/formats.test.ts`, new `test/server/formats.test.ts`, new `test/helpers/probe.ts`, new `e2e/formats.spec.ts`; `test/core/{project,notes,media,exportNotes,tabs-batches}.test.ts`, `test/mcp/tools.test.ts`, `test/cli/main.test.ts`, `test/web/{lib,styles}.test.ts`, `test/package.test.ts`, `test/server/files.test.ts`, `e2e/fixture.ts` |

---

### Task 1: The data model and ratio measurement (§21.2, §21.3)

**Files:**
- Create: `src/core/formats.ts`
- Modify: `src/core/schema.ts`: `FormatSchema`; `VersionSchema` gains `width`, `height` and `formats`, plus a `superRefine`; `NoteSchema` gains `format`.
- Modify: `src/core/project.ts`: `AddVersionInput.width` and `height`; `addVersion`; `resolveCut`; `AddFormatInput`; `addFormat`.
- Modify: `src/core/notes.ts`: `NewNote.format`; `UserEdit.format`; `applyUserEdit`'s `check`; `checkNoteFormat`; `NoteFilter.format` and `onlyThisFormat`.
- Create: `test/core/formats.test.ts`
- Modify: `test/core/project.test.ts`, `test/core/notes.test.ts`
- Modify: the test literals that must carry the new required output fields: `test/web/lib.test.ts:32-36` (`note()`), `:174`, `:182` and `:338`, and `test/server/files.test.ts:353`.

**Interfaces:**
- Consumes: `addVersion`, `latestVersion`, `resolveVideo`, the private `resolveVersion` (`src/core/project.ts`), and `RushesError`, `InvalidError` and `NotFoundError` (`src/core/errors.ts`).
- Produces (`src/core/formats.ts`, type imports only):

```ts
export const STANDARD_RATIOS: readonly (readonly [number, number])[];
export const FORMAT_ID_RE: RegExp;                 // /^\d+(?:\.\d+)?x\d+(?:\.\d+)?$/
export const MAX_FORMATS = 8;                      // shapes per cut, the primary included (R3)
export const CHIP_ORDER: readonly string[];        // ["9x16", "4x5", "1x1", "4x3", "16x9"]
export function ratioLabel(width: number, height: number): string;      // "9:16", "10:7", "2.39:1"
export function ratioId(label: string): string;                         // "9:16" -> "9x16"
export function labelOfId(id: string): string;                          // "9x16" -> "9:16"
export function ratioValue(label: string): number | null;               // "9:16" -> 0.5625
export function settleLabel(width: number, height: number, hint?: string): { label: string; note: string | null };
export function chipOrder<T extends { id: string; width: number; height: number }>(list: readonly T[]): T[];
export interface FormatView { id: string; label: string; file: string; width: number; height: number; duration: number | null; fps: number | null; primary: boolean }
export type FormatSource = Pick<Version, "file" | "width" | "height" | "duration" | "fps" | "formats">;
export function versionFormats(v: FormatSource, fallback?: { width: number; height: number } | null): FormatView[];
export function durationWarning(label: string, formatDuration: number | null, cutDuration: number | null): string | null;
export function noteShowsOn(note: Pick<Note, "format">, current: string | null): boolean;
export function formatTag(note: Pick<Note, "stage" | "video" | "version" | "format">, videos: readonly { id: string; versions: readonly (FormatSource & { id: string })[] }[]): string | null;
```

- Produces (`src/core/schema.ts`): `FormatSchema`, `type Format`. `Version` gains `width: number | null`, `height: number | null` and `formats: Format[]`. `Note` gains `format: string | null`.
- Produces (`src/core/project.ts`):

```ts
export interface AddVersionInput { /* existing */ width?: number | null; height?: number | null }
export function resolveCut(p: Project, videoRef?: string, versionId?: string): { video: Video; version: Version };
export interface AddFormatInput { video?: string; version?: string; file: string; width: number; height: number; duration: number | null; fps: number | null; label?: string; primarySize?: { width: number; height: number } | null }
export interface AddFormatResult { video: Video; version: Version; format: Format; warning: string | null; labelNote: string | null }
export function addFormat(p: Project, input: AddFormatInput, now?: Date): AddFormatResult;
// Refusals (RushesError): 404 "no_cut", 422 "no_primary_size", 409 "same_ratio", 400 "too_many_formats".
```

- Produces (`src/core/notes.ts`):

```ts
export interface NewNote { /* existing */ format?: string | null }
export interface UserEdit { /* existing */ format?: string | null }
export function applyUserEdit(file: NotesFile, e: UserEdit, check?: (next: Note, prev: Note) => void): Note;
export interface NoteFormatCheck { next: Pick<Note, "stage" | "video" | "version" | "format" | "box">; prev?: Pick<Note, "format" | "box">; boxRedrawn?: boolean }
export function checkNoteFormat(c: NoteFormatCheck, project: Pick<Project, "videos">): void;
// Refusals (RushesError, all 400): "format_not_picture", "unknown_format", "box_needs_format", "box_fixes_format".
export interface NoteFilter { /* existing */ format?: string; onlyThisFormat?: boolean }
```

- [ ] **Step 0: Install and take a baseline.** The worktree has no `node_modules`. Run `cd ~/Developer/rushes-formats && npm ci && npx vitest run`. Expected: every test passes.

- [ ] **Step 1: Write the failing tests for `formats.ts`** in `test/core/formats.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHIP_ORDER, FORMAT_ID_RE, MAX_FORMATS, chipOrder, durationWarning, formatTag, labelOfId, noteShowsOn, ratioId, ratioLabel, ratioValue, settleLabel, versionFormats,
  type FormatSource,
} from "../../src/core/formats.js";

describe("ratioLabel (§21.3)", () => {
  it.each([
    [1920, 1080, "16:9"], [1080, 1920, "9:16"], [1080, 1080, "1:1"], [1080, 1350, "4:5"], [1350, 1080, "5:4"],
    [1440, 1080, "4:3"], [1080, 1440, "3:4"], [1620, 1080, "3:2"], [1080, 1620, "2:3"], [2520, 1080, "21:9"], [1080, 2520, "9:21"],
  ])("%i×%i is %s", (w, h, label) => expect(ratioLabel(w, h)).toBe(label));

  // Review Focus 2: what real renders measure.
  it.each([
    [1920, 1088, "16:9"], // padded to a multiple of 16 by the encoder
    [1918, 1080, "16:9"],
    [1080, 1349, "4:5"],
    [1920, 817, "21:9"], // 2.35:1 is within 1% of 21:9
  ])("%i×%i snaps to %s within 1%%", (w, h, label) => expect(ratioLabel(w, h)).toBe(label));

  it.each([[1000, 700, "10:7"], [2000, 1000, "2:1"], [3000, 1000, "3:1"]])(
    "%i×%i, off the standard list, is the reduced fraction %s",
    (w, h, label) => expect(ratioLabel(w, h)).toBe(label),
  );

  it.each([
    [2560, 1080, "2.37:1"], // 1.6% off 21:9, and 64:27 has a term over 32
    [1920, 804, "2.39:1"],
    [804, 1920, "1:2.39"],
    [1998, 1080, "1.85:1"],
  ])("%i×%i is the decimal %s (R13)", (w, h, label) => expect(ratioLabel(w, h)).toBe(label));

  it("refuses a size that isn't one", () => {
    expect(() => ratioLabel(0, 1080)).toThrow(RangeError);
    expect(() => ratioLabel(1920, Number.NaN)).toThrow(RangeError);
  });
});

describe("format ids", () => {
  it("are the label with ':' as 'x', and back", () => {
    expect(ratioId("9:16")).toBe("9x16");
    expect(ratioId("2.39:1")).toBe("2.39x1");
    expect(labelOfId("1x2.39")).toBe("1:2.39");
    for (const id of ["9x16", "2.39x1", "10x7", "1x2.39"]) expect(FORMAT_ID_RE.test(id)).toBe(true);
    for (const id of ["9:16", "landscape", "x16", "9x", "../9x16"]) expect(FORMAT_ID_RE.test(id)).toBe(false);
  });
  it("ratioValue reads a label, and nothing else", () => {
    expect(ratioValue("9:16")).toBeCloseTo(0.5625, 6);
    expect(ratioValue("2.4:1")).toBeCloseTo(2.4, 6);
    expect(ratioValue("wide")).toBeNull();
    expect(ratioValue("0:1")).toBeNull();
  });
});

describe("settleLabel: the label hint (§21.4, R10)", () => {
  it("is used for a non-standard ratio within 2% of it", () => {
    expect(settleLabel(1920, 804, "2.4:1")).toEqual({ label: "2.4:1", note: null });
  });
  it("is ignored, with a note, for a standard ratio, a far one, or one that isn't a ratio", () => {
    expect(settleLabel(1080, 1920, "4:5")).toEqual({ label: "9:16", note: expect.stringContaining("9:16") });
    expect(settleLabel(1920, 804, "21:9").label).toBe("2.39:1");
    expect(settleLabel(1920, 804, "scope").note).toMatch(/isn't a ratio like 2\.39:1/);
  });
  it("with no hint, or the same one, is the measured label", () => {
    expect(settleLabel(1080, 1920)).toEqual({ label: "9:16", note: null });
    expect(settleLabel(1080, 1920, "9:16")).toEqual({ label: "9:16", note: null });
  });
});

describe("chipOrder (§21.5)", () => {
  const f = (id: string, width: number, height: number) => ({ id, width, height });
  it("puts 9:16, 4:5, 1:1, 4:3 and 16:9 first, then the rest from narrow to wide", () => {
    const order = chipOrder([f("16x9", 1920, 1080), f("2.39x1", 1920, 804), f("1x1", 1080, 1080), f("9x16", 1080, 1920), f("2x3", 1080, 1620), f("4x5", 1080, 1350)]);
    expect(order.map((x) => x.id)).toEqual(["9x16", "4x5", "1x1", "16x9", "2x3", "2.39x1"]);
    expect(CHIP_ORDER).toEqual(["9x16", "4x5", "1x1", "4x3", "16x9"]);
  });
});

const source = (over: Partial<FormatSource> = {}): FormatSource => ({ file: "renders/hero_v1.mp4", width: 1920, height: 1080, duration: 8, fps: 30, formats: [], ...over });
const tall = { id: "9x16", label: "9:16", file: "renders/hero_v1_9x16.mp4", width: 1080, height: 1920, duration: 8, fps: 30, addedAt: "" };

describe("versionFormats", () => {
  it("is the primary first, measured from its own size, then the formats as stored", () => {
    expect(versionFormats(source({ formats: [tall] }))).toEqual([
      { id: "16x9", label: "16:9", file: "renders/hero_v1.mp4", width: 1920, height: 1080, duration: 8, fps: 30, primary: true },
      { id: "9x16", label: "9:16", file: "renders/hero_v1_9x16.mp4", width: 1080, height: 1920, duration: 8, fps: 30, primary: false },
    ]);
  });
  it("is empty while the primary's size is unknown, unless the player measured it (R2)", () => {
    expect(versionFormats(source({ width: null, height: null }))).toEqual([]);
    expect(versionFormats(source({ width: null, height: null }), { width: 1080, height: 1080 })[0]).toMatchObject({ id: "1x1", primary: true });
  });
});

describe("durationWarning (§21.3)", () => {
  it("speaks only past 0.1 s, in §21.3's words", () => {
    expect(durationWarning("9:16", 8.4, 8)).toBe("9:16 is 8.4 s; the cut is 8.0 s");
    expect(durationWarning("9:16", 8.1, 8)).toBeNull();
    expect(durationWarning("9:16", 7.95, 8)).toBeNull();
    expect(durationWarning("9:16", null, 8)).toBeNull();
    expect(durationWarning("9:16", 8.4, null)).toBeNull();
  });
});

describe("which notes show where (§21.2)", () => {
  it("an all-format note shows on every format, a format note on its own only, and every note on a one-format cut", () => {
    expect(noteShowsOn({ format: null }, "16x9")).toBe(true);
    expect(noteShowsOn({ format: "9x16" }, "9x16")).toBe(true);
    expect(noteShowsOn({ format: "9x16" }, "16x9")).toBe(false);
    expect(noteShowsOn({ format: "9x16" }, null)).toBe(true);
  });
  it("formatTag names the format, says All on a cut with formats, and says nothing on a one-format cut (R4)", () => {
    const videos = [
      { id: "hero", versions: [{ id: "v1", ...source({ formats: [tall] }) }] },
      { id: "solo", versions: [{ id: "v1", ...source() }] },
    ];
    const n = (video: string, format: string | null, stage: "picture" | "music" = "picture") => ({ stage, video, version: "v1", format });
    expect(formatTag(n("hero", "9x16"), videos)).toBe("9:16");
    expect(formatTag(n("hero", null), videos)).toBe("All");
    expect(formatTag(n("solo", null), videos)).toBeNull();
    expect(formatTag(n("hero", null, "music"), videos)).toBeNull();
  });
});

it("MAX_FORMATS is eight shapes, the primary included (R3)", () => expect(MAX_FORMATS).toBe(8));

it("formats.ts has only type imports, so the dashboard can import it without zod or Node", () => {
  const text = readFileSync(new URL("../../src/core/formats.ts", import.meta.url), "utf8");
  const imports = text.split("\n").filter((l) => /^\s*import\s/.test(l));
  expect(imports.length).toBeGreaterThan(0);
  for (const line of imports) expect(line).toMatch(/^\s*import type\s/);
});
```

- [ ] **Step 2: Run them and see them fail.** Run: `npx vitest run test/core/formats.test.ts`. Expected: FAIL, because `src/core/formats.ts` is missing.

- [ ] **Step 3: Write `src/core/formats.ts`.**

```ts
// §21: a cut's formats -- the same edit rendered at other aspect ratios. Pure, and with type
// imports only, because the dashboard imports this file too: nothing here may pull zod or Node
// into the web bundle (test/core/formats.test.ts checks it).
import type { Note, Version } from "./schema.js";

/** §21.3's standard ratios, as [width, height]. */
export const STANDARD_RATIOS: readonly (readonly [number, number])[] = [
  [1, 1], [4, 5], [5, 4], [4, 3], [3, 4], [3, 2], [2, 3], [16, 9], [9, 16], [21, 9], [9, 21],
];

/** A format id: the label with ":" as "x", e.g. "9x16", "2.39x1", "10x7". */
export const FORMAT_ID_RE = /^\d+(?:\.\d+)?x\d+(?:\.\d+)?$/;

/** The most shapes one cut can have, the primary included (ruling R3). */
export const MAX_FORMATS = 8;

/** The order the chips always take (§21.5), so a chip never moves between projects. */
export const CHIP_ORDER: readonly string[] = ["9x16", "4x5", "1x1", "4x3", "16x9"];

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** 2.388 -> "2.39", 2.4 -> "2.4", 2 -> "2". */
const decimal = (n: number): string => String(Number(n.toFixed(2)));

/**
 * §21.3: the label for a picture `width` × `height` (its shape on screen). The nearest standard
 * ratio within 1%, otherwise the reduced fraction when both terms are 32 or less, otherwise a
 * decimal with the long side over the short (R13): "2.39:1", "1:2.39".
 */
export function ratioLabel(width: number, height: number): string {
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) {
    throw new RangeError(`Not a picture size: ${width}×${height}`);
  }
  const r = width / height;
  let best: readonly [number, number] | null = null;
  let bestErr = Infinity;
  for (const s of STANDARD_RATIOS) {
    const err = Math.abs(r - s[0] / s[1]) / (s[0] / s[1]);
    if (err < bestErr) {
      bestErr = err;
      best = s;
    }
  }
  if (best && bestErr <= 0.01 + 1e-12) return `${best[0]}:${best[1]}`;
  const w = Math.round(width);
  const h = Math.round(height);
  const g = gcd(w, h);
  if (w / g <= 32 && h / g <= 32) return `${w / g}:${h / g}`;
  return r >= 1 ? `${decimal(r)}:1` : `1:${decimal(1 / r)}`;
}

export const ratioId = (label: string): string => label.replace(":", "x");
export const labelOfId = (id: string): string => id.replace("x", ":");

/** "9:16" -> 0.5625; null for anything that isn't "a:b" with both terms above 0. */
export function ratioValue(label: string): number | null {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(label.trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a > 0 && b > 0 ? a / b : null;
}

const isStandard = (label: string): boolean => STANDARD_RATIOS.some(([a, b]) => `${a}:${b}` === label);

/**
 * §21.4's `label`, which is only a hint (R10): used when the measured ratio isn't a standard one and
 * the hint is within 2% of it. Otherwise the measured label stands, with a note saying why.
 */
export function settleLabel(width: number, height: number, hint?: string): { label: string; note: string | null } {
  const measured = ratioLabel(width, height);
  const given = hint?.trim() ?? "";
  if (given === "" || given === measured) return { label: measured, note: null };
  const v = ratioValue(given);
  if (v === null) return { label: measured, note: `"${given}" isn't a ratio like 2.39:1, so Rushes used the measured ${measured}.` };
  if (isStandard(measured)) return { label: measured, note: `The file measures ${measured}, a standard ratio, so the label "${given}" wasn't needed.` };
  const r = width / height;
  if (Math.abs(v - r) / r <= 0.02) return { label: given, note: null };
  return { label: measured, note: `The file measures ${measured}, too far from "${given}" to use it.` };
}

/** §21.5: 9:16, 4:5, 1:1, 4:3, 16:9, then anything else from narrow to wide (width over height). */
export function chipOrder<T extends { id: string; width: number; height: number }>(list: readonly T[]): T[] {
  const rank = (f: T): number => {
    const i = CHIP_ORDER.indexOf(f.id);
    return i === -1 ? CHIP_ORDER.length : i;
  };
  return [...list].sort((a, b) => rank(a) - rank(b) || a.width / a.height - b.width / b.height || a.id.localeCompare(b.id));
}

/** One shape of a cut, the primary included. */
export interface FormatView {
  id: string;
  label: string;
  file: string;
  width: number;
  height: number;
  duration: number | null;
  fps: number | null;
  primary: boolean;
}

export type FormatSource = Pick<Version, "file" | "width" | "height" | "duration" | "fps" | "formats">;

/**
 * A version's shapes: the primary first (§21.2 (2): its ratio is read from its own size), then
 * the formats as stored. Empty while the primary's size is unknown, unless `fallback` (the
 * player's measured size, R2) gives it.
 */
export function versionFormats(v: FormatSource, fallback?: { width: number; height: number } | null): FormatView[] {
  const width = v.width ?? fallback?.width ?? null;
  const height = v.height ?? fallback?.height ?? null;
  if (width === null || height === null) return [];
  const label = ratioLabel(width, height);
  const primary: FormatView = { id: ratioId(label), label, file: v.file, width, height, duration: v.duration, fps: v.fps, primary: true };
  return [
    primary,
    ...v.formats.map((f) => ({ id: f.id, label: f.label, file: f.file, width: f.width, height: f.height, duration: f.duration, fps: f.fps, primary: false })),
  ];
}

/** §21.3: "9:16 is 8.4 s; the cut is 8.0 s" when a format's length is more than 0.1 s off the cut's. */
export function durationWarning(label: string, formatDuration: number | null, cutDuration: number | null): string | null {
  if (formatDuration === null || cutDuration === null) return null;
  if (Math.abs(formatDuration - cutDuration) <= 0.1 + 1e-9) return null;
  return `${label} is ${formatDuration.toFixed(1)} s; the cut is ${cutDuration.toFixed(1)} s`;
}

/** §21.2 (5): does `note` show while `current` is on screen? `current` is null on a one-format cut. */
export function noteShowsOn(note: Pick<Note, "format">, current: string | null): boolean {
  return current === null || note.format === null || note.format === current;
}

/**
 * The tag a Picture note carries in export, the CLI and the list (R4): its format's label, "All"
 * on a cut with two or more formats, otherwise null (a one-format cut reads as it always did).
 */
export function formatTag(
  note: Pick<Note, "stage" | "video" | "version" | "format">,
  videos: readonly { id: string; versions: readonly (FormatSource & { id: string })[] }[],
): string | null {
  if (note.stage !== "picture") return null;
  if (note.format !== null) return labelOfId(note.format);
  const version = videos.find((v) => v.id === note.video)?.versions.find((v) => v.id === note.version);
  return version && versionFormats(version).length >= 2 ? "All" : null;
}
```

- [ ] **Step 4: Run them again.** Run: `npx vitest run test/core/formats.test.ts`. Expected: PASS. vitest doesn't type-check, and `FormatSource` names `Version` fields that Step 7 adds, so `npm run typecheck` stays red until then.

- [ ] **Step 5: Write the failing tests for the schema and `addFormat`.** Append to `test/core/project.test.ts`, and extend its imports:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { addFile, addFormat, addVariant, addVersion, ensureProjectId, ensureProjectIdOnce, latestVersion, lockPicture, resolveCut, resolveVideo, setShots, shotAt } from "../../src/core/project.js";
import { NoteSchema, ProjectSchema, type Project, type Shot } from "../../src/core/schema.js";
import { InvalidError, NotFoundError, RushesError } from "../../src/core/errors.js";

describe("formats in the data (§21.3)", () => {
  const T0 = new Date("2026-10-07T00:00:00Z");
  const withCut = (size: { width: number | null; height: number | null } = { width: 1920, height: 1080 }) => {
    const p = empty();
    addVersion(p, { video: "Hero", file: "renders/hero_v1.mp4", duration: 8, fps: 30, ...size }, T0);
    return p;
  };
  const shape = (file: string, width: number, height: number, duration: number | null = 8) => ({ file, width, height, duration, fps: 30 });

  // Review Focus 1.
  it("a project and notes from 0.2.x load unchanged: no size, no formats, notes for every format", () => {
    const old = ProjectSchema.parse({
      schema: 1, rev: 3, name: "demo", fps: 30, lanes: [], files: [], autoProxy: false,
      videos: [{ id: "hero", name: "Hero", lockedVersion: null, versions: [{ id: "v1", file: "renders/hero_v1.mp4", duration: 8, fps: 30, addedAt: "2026-10-01T00:00:00Z", note: "", shots: [], proxy: null }] }],
    });
    expect(old.videos[0].versions[0]).toMatchObject({ width: null, height: null, formats: [] });
    const note = NoteSchema.parse({ id: "n_1", stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "x", createdAt: "2026-10-01T00:00:00Z", box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } });
    expect(note.format).toBeNull();
  });

  it("addVersion records the primary's size and starts with no formats", () => {
    expect(withCut().videos[0].versions[0]).toMatchObject({ width: 1920, height: 1080, formats: [] });
  });

  it("addFormat registers a shape on the newest cut, measured and labelled", () => {
    const p = withCut();
    const r = addFormat(p, shape("renders/hero_v1_9x16.mp4", 1080, 1920), new Date("2026-10-07T10:00:00Z"));
    expect(r.format).toEqual({ id: "9x16", label: "9:16", file: "renders/hero_v1_9x16.mp4", width: 1080, height: 1920, duration: 8, fps: 30, addedAt: "2026-10-07T10:00:00.000Z" });
    expect(r.warning).toBeNull();
    expect(ProjectSchema.safeParse(p).success).toBe(true);
  });

  // Review Focus 4.
  it("refuses a second render of a ratio the cut already has, the primary's own included", () => {
    const p = withCut();
    addFormat(p, shape("renders/a.mp4", 1080, 1920));
    const again = () => addFormat(p, shape("renders/b.mp4", 720, 1280));
    expect(again).toThrow(RushesError);
    expect(again).toThrow("v1 already has 9:16. Register a re-render as a new version.");
    expect(() => addFormat(p, shape("renders/hero_v1.mp4", 1920, 1080))).toThrow("v1 already has 16:9. Register a re-render as a new version.");
  });

  it("refuses a ninth shape: eight in all, the primary included (R3)", () => {
    const p = withCut();
    const sizes: [number, number][] = [[1080, 1920], [1080, 1080], [1080, 1350], [1440, 1080], [1620, 1080], [1080, 1620], [2520, 1080]];
    sizes.forEach(([w, h], i) => addFormat(p, shape(`renders/f${i}.mp4`, w, h)));
    expect(() => addFormat(p, shape("renders/f8.mp4", 1080, 2520))).toThrow("v1 already has 8 formats, the most one cut can have.");
  });

  it("warns when a format's length is more than 0.1 s off the cut's, and registers it anyway", () => {
    const p = withCut();
    expect(addFormat(p, shape("renders/t.mp4", 1080, 1920, 8.4)).warning).toBe("9:16 is 8.4 s; the cut is 8.0 s");
    expect(p.videos[0].versions[0].formats).toHaveLength(1);
  });

  it("takes a label hint only for an unusual ratio close to it (R10)", () => {
    const r = addFormat(withCut(), { ...shape("renders/scope.mp4", 1920, 804), label: "2.4:1" });
    expect(r.format).toMatchObject({ id: "2.4x1", label: "2.4:1" });
    expect(addFormat(withCut(), { ...shape("renders/t.mp4", 1080, 1920), label: "4:5" }).labelNote).toMatch(/standard ratio/);
  });

  it("uses the primary's size given for a cut from before formats, and refuses without one", () => {
    const p = withCut({ width: null, height: null });
    expect(() => addFormat(p, shape("renders/t.mp4", 1080, 1920))).toThrow(/can't read v1's own picture size/);
    addFormat(p, { ...shape("renders/t.mp4", 1080, 1920), primarySize: { width: 1920, height: 1080 } });
    expect(p.videos[0].versions[0]).toMatchObject({ width: 1920, height: 1080 });
  });

  it("adds to a locked cut too (§21.6)", () => {
    const p = withCut();
    lockPicture(p, "hero", "v1");
    expect(addFormat(p, shape("renders/t.mp4", 1080, 1920)).format.id).toBe("9x16");
  });

  it("defaults to the newest cut of the newest film, and takes a film and version by name (R16)", () => {
    const p = withCut();
    addVersion(p, { video: "Teaser", file: "renders/teaser_v1.mp4", width: 1920, height: 1080 }, new Date("2026-10-08T00:00:00Z"));
    expect(resolveCut(p).video.id).toBe("teaser");
    addVersion(p, { video: "Hero", file: "renders/hero_v2.mp4", width: 1920, height: 1080 }, new Date("2026-10-09T00:00:00Z"));
    expect(resolveCut(p)).toMatchObject({ video: { id: "hero" }, version: { id: "v2" } });
    expect(resolveCut(p, "Hero", "v1").version.id).toBe("v1");
    expect(() => resolveCut(empty())).toThrow("There's no cut to add a format to yet. Register one with rushes_add_version first.");
  });

  it("project.json with a ratio twice, a format equal to the primary, a label off its id, or nine formats fails validation", () => {
    const p = withCut();
    addFormat(p, shape("renders/t.mp4", 1080, 1920));
    const f0 = p.videos[0].versions[0].formats[0];
    const variants: Project[] = [structuredClone(p), structuredClone(p), structuredClone(p), structuredClone(p)];
    variants[0].videos[0].versions[0].formats.push({ ...f0, file: "renders/u.mp4" });
    variants[1].videos[0].versions[0].formats[0] = { ...f0, id: "16x9", label: "16:9" };
    variants[2].videos[0].versions[0].formats[0] = { ...f0, label: "4:5" };
    variants[3].videos[0].versions[0].formats = Array.from({ length: 9 }, (_, i) => ({ ...f0, id: `${i + 1}x40`, label: `${i + 1}:40` }));
    for (const v of variants) expect(ProjectSchema.safeParse(v).success).toBe(false);
  });

  it("the store refuses to write a duplicated format, and reports a hand edit that has one", async () => {
    const { store } = await tmpProject();
    await store.update("project", (d) => {
      addVersion(d, { video: "Hero", file: "renders/hero_v1.mp4", width: 1920, height: 1080 });
      addFormat(d, shape("renders/t.mp4", 1080, 1920));
    });
    await expect(store.update("project", (d) => { d.videos[0].versions[0].formats.push({ ...d.videos[0].versions[0].formats[0] }); })).rejects.toThrow(/project\.json is invalid/);
    const raw = JSON.parse(await readFile(store.path("project"), "utf8"));
    raw.videos[0].versions[0].formats.push(raw.videos[0].versions[0].formats[0]);
    await writeFile(store.path("project"), JSON.stringify(raw));
    await expect(store.read("project")).rejects.toThrow(/project\.json can't be read/);
  });
});
```

- [ ] **Step 6: Run them and see them fail.** Run: `npx vitest run test/core/project.test.ts`. Expected: FAIL (`addFormat` and `resolveCut` aren't exported; no `width`).

- [ ] **Step 7: Change the schema.** In `src/core/schema.ts`, add the import under `import { z } from "zod";`:

```ts
import { FORMAT_ID_RE, labelOfId, ratioId, ratioLabel } from "./formats.js";
```

Add above `VersionSchema`:

```ts
// §21.3: another render of the same cut at another aspect ratio. Its id is its label with ":" as "x".
export const FormatSchema = z.object({
  id: z.string().max(16).regex(FORMAT_ID_RE),
  label: z.string().min(3).max(16),
  file: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  duration: seconds.nullable().default(null),
  fps: z.number().positive().nullable().default(null),
  addedAt: z.string(),
});
export type Format = z.infer<typeof FormatSchema>;
```

Replace the `VersionSchema` definition with:

```ts
export const VersionSchema = z
  .object({
    id,
    file: z.string().min(1),
    duration: seconds.nullable().default(null),
    fps: z.number().positive().nullable().default(null),
    addedAt: z.string(),
    note: z.string().default(""),
    shots: z.array(ShotSchema).max(200).default([]),
    // §19.5: a lightweight H.264 copy for smooth preview. Set only once a render has completed.
    proxy: ProxySchema.nullable().default(null),
    // §21.3 (R2): the primary render's picture size as shown, read when the cut is added. Null for a
    // cut from before formats until its first format is registered.
    width: z.number().int().positive().nullable().default(null),
    height: z.number().int().positive().nullable().default(null),
    // §21.3: the other renders of this cut, one per aspect ratio. The primary (`file`) is a format too.
    formats: z.array(FormatSchema).max(8).default([]),
  })
  .superRefine((v, ctx) => {
    // One shape per ratio: no two formats share an id, and none repeats the primary's.
    const primary = v.width !== null && v.height !== null ? ratioId(ratioLabel(v.width, v.height)) : null;
    const seen = new Set<string>(primary ? [primary] : []);
    v.formats.forEach((f, i) => {
      if (f.label !== labelOfId(f.id)) ctx.addIssue({ code: "custom", path: ["formats", i, "label"], message: `label "${f.label}" doesn't match id "${f.id}"` });
      if (seen.has(f.id)) ctx.addIssue({ code: "custom", path: ["formats", i, "id"], message: `${v.id} already has ${f.label}` });
      seen.add(f.id);
    });
  });
```

Inside `NoteSchema`'s object, after `marks`:

```ts
    // §21.3: the format this note belongs to (a Format id such as "9x16"), or null for every format:
    // the default, and every note from before formats. The server checks it against the note's version.
    format: z.string().max(16).regex(FORMAT_ID_RE).nullable().default(null),
```

- [ ] **Step 8: Change `project.ts`.** Change the imports:

```ts
import type { Cue, FileEntry, FileKind, Format, Lane, LaneStage, Project, Shot, Variant, Version, Video } from "./schema.js";
import { InvalidError, NotFoundError, RushesError } from "./errors.js";
import { MAX_FORMATS, durationWarning, ratioId, settleLabel, versionFormats } from "./formats.js";
```

Add to `AddVersionInput`:

```ts
  /** §21.3: the primary render's picture size as shown, when known. */
  width?: number | null;
  height?: number | null;
```

In `addVersion`'s `version` literal, after `proxy: null,`, add: `width: input.width ?? null, height: input.height ?? null, formats: [],`. Then add after `lockPicture`:

```ts
/** The cut `videoRef`/`versionId` names, defaulting to the newest cut of the only or newest film (§21.4, R16). */
export function resolveCut(p: Project, videoRef?: string, versionId?: string): { video: Video; version: Version } {
  let video: Video | undefined;
  if (videoRef !== undefined) video = resolveVideo(p, videoRef);
  else {
    let newest: string | null = null;
    for (const v of p.videos) {
      const last = latestVersion(v);
      if (last && (newest === null || last.addedAt >= newest)) {
        newest = last.addedAt;
        video = v;
      }
    }
  }
  if (!video) throw new RushesError("There's no cut to add a format to yet. Register one with rushes_add_version first.", 404, "no_cut");
  return { video, version: resolveVersion(video, versionId) };
}

export interface AddFormatInput {
  /** Video id or name. Defaults to the newest cut's film (R16). */
  video?: string;
  /** Defaults to that film's newest version. */
  version?: string;
  /** Manifest path (already passed through toManifestPath). */
  file: string;
  /** The render's picture size as shown (probeVideo applies rotation and pixel shape). */
  width: number;
  height: number;
  duration: number | null;
  fps: number | null;
  /** §21.4: only a hint, for a ratio that isn't a standard one (R10). */
  label?: string;
  /** The primary's own size, read by the caller when the version has none yet (a cut from before formats). */
  primarySize?: { width: number; height: number } | null;
}

export interface AddFormatResult { video: Video; version: Version; format: Format; warning: string | null; labelNote: string | null }

/** §21.3: registers another shape of a cut. Refuses a ratio the cut already has, and a ninth shape. */
export function addFormat(p: Project, input: AddFormatInput, now = new Date()): AddFormatResult {
  const { video, version } = resolveCut(p, input.video, input.version);
  if (version.width === null || version.height === null) {
    if (!input.primarySize) {
      throw new RushesError(
        `Rushes can't read ${version.id}'s own picture size, so it can't tell a new shape from it. Check that the cut's file is there and that ffprobe is installed.`,
        422, "no_primary_size", { version: version.id },
      );
    }
    version.width = input.primarySize.width;
    version.height = input.primarySize.height;
  }
  const { label, note } = settleLabel(input.width, input.height, input.label);
  const id = ratioId(label);
  const shapes = versionFormats(version);
  if (shapes.some((f) => f.id === id)) {
    throw new RushesError(`${version.id} already has ${label}. Register a re-render as a new version.`, 409, "same_ratio", { version: version.id, id });
  }
  if (shapes.length >= MAX_FORMATS) {
    throw new RushesError(`${version.id} already has ${MAX_FORMATS} formats, the most one cut can have.`, 400, "too_many_formats", { version: version.id });
  }
  const format: Format = { id, label, file: input.file, width: input.width, height: input.height, duration: input.duration, fps: input.fps, addedAt: now.toISOString() };
  version.formats.push(format);
  return { video, version, format, warning: durationWarning(label, input.duration, version.duration), labelNote: note };
}
```

- [ ] **Step 9: Run the core tests.** Run: `npx vitest run test/core/formats.test.ts test/core/project.test.ts`. Expected: PASS.

- [ ] **Step 10: Write the failing tests for notes.** Append to `test/core/notes.test.ts`, and extend its imports:

```ts
import { addNote, applyReply, applyUserEdit, checkNoteFormat, filterNotes, onLabel, type OnContext } from "../../src/core/notes.js";
import { markLabel, NoteSchema, type Note, type NotesFile, type Project } from "../../src/core/schema.js";
import { addFormat, addVersion } from "../../src/core/project.js";
import type { RushesError } from "../../src/core/errors.js";

describe("notes and formats (§21.2, §21.3)", () => {
  const project = (): Project => {
    const p: Project = { schema: 1, rev: 0, name: "demo", fps: 30, videos: [], lanes: [], files: [], autoProxy: false };
    addVersion(p, { video: "Hero", file: "renders/hero_v1.mp4", duration: 8, width: 1920, height: 1080 });
    addFormat(p, { video: "hero", file: "renders/hero_v1_9x16.mp4", width: 1080, height: 1920, duration: 8, fps: 30 });
    addVersion(p, { video: "Solo", file: "renders/solo_v1.mp4", duration: 8, width: 1920, height: 1080 });
    return p;
  };
  const next = (over: Partial<Pick<Note, "stage" | "video" | "version" | "format" | "box">> = {}) =>
    ({ stage: "picture" as const, video: "hero", version: "v1", format: null, box: null, ...over });
  const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
  const code = (fn: () => void): string | null => {
    try {
      fn();
      return null;
    } catch (e) {
      return (e as RushesError).code;
    }
  };

  it("a format must be one of the note's own cut's, and only Picture notes have one", () => {
    expect(code(() => checkNoteFormat({ next: next({ format: "9x16" }) }, project()))).toBeNull();
    expect(code(() => checkNoteFormat({ next: next({ format: "16x9" }) }, project()))).toBeNull();
    expect(() => checkNoteFormat({ next: next({ format: "4x5" }) }, project())).toThrow("v1 has no 4:5 format.");
    expect(code(() => checkNoteFormat({ next: next({ format: "9x16", stage: "music" }) }, project()))).toBe("format_not_picture");
  });

  it("a box needs a format on a cut with formats, and keeps the one it was drawn on (R7)", () => {
    expect(code(() => checkNoteFormat({ next: next({ box }) }, project()))).toBe("box_needs_format");
    expect(code(() => checkNoteFormat({ next: next({ box, format: "9x16" }) }, project()))).toBeNull();
    expect(code(() => checkNoteFormat({ next: next({ box, video: "solo" }) }, project()))).toBeNull();
    expect(code(() => checkNoteFormat({ next: next({ box, format: "16x9" }), prev: { box, format: "9x16" } }, project()))).toBe("box_fixes_format");
    // Review Focus 1: a note from before formats drew its box on the primary, so it narrows to the primary only.
    expect(code(() => checkNoteFormat({ next: next({ box, format: "16x9" }), prev: { box, format: null } }, project()))).toBeNull();
    expect(code(() => checkNoteFormat({ next: next({ box, format: "9x16" }), prev: { box, format: null } }, project()))).toBe("box_fixes_format");
    // A box drawn again in the same edit belongs to the format it's drawn on now.
    expect(code(() => checkNoteFormat({ next: next({ box, format: "16x9" }), prev: { box, format: "9x16" }, boxRedrawn: true }, project()))).toBeNull();
  });

  it("applyUserEdit carries format, and runs the check before changing anything", () => {
    const f = empty();
    const p = project();
    const check = (nx: Note, pv: Note) => checkNoteFormat({ next: nx, prev: pv }, p);
    const boxed = addNote(f, { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "x", format: "9x16", box });
    expect(() => applyUserEdit(f, { id: boxed.id, format: null }, check)).toThrow(/box/);
    expect(f.notes[0].format).toBe("9x16");
    const plain = addNote(f, { stage: "picture", video: "hero", version: "v1", scope: "point", t: 2, text: "y", format: "9x16" });
    applyUserEdit(f, { id: plain.id, format: null }, check);
    expect(f.notes[1].format).toBeNull();
  });

  it("filterNotes takes a format: its notes and the all-format ones, or only its own (R14)", () => {
    const f = empty();
    addNote(f, { stage: "picture", scope: "point", t: 1, text: "all" });
    addNote(f, { stage: "picture", scope: "point", t: 2, text: "tall", format: "9x16" });
    addNote(f, { stage: "picture", scope: "point", t: 3, text: "wide", format: "16x9" });
    addNote(f, { stage: "music", scope: "whole", text: "bed" });
    expect(filterNotes(f.notes, { format: "9x16" }).map((n) => n.text)).toEqual(["all", "tall"]);
    expect(filterNotes(f.notes, { format: "9x16", onlyThisFormat: true }).map((n) => n.text)).toEqual(["tall"]);
  });

  it("a format that isn't an id is refused by the schema", () => {
    expect(() => addNote(empty(), { stage: "picture", scope: "point", t: 1, text: "x", format: "portrait" })).toThrow(/invalid/i);
  });
});
```

- [ ] **Step 11: Run them and see them fail.** Run: `npx vitest run test/core/notes.test.ts`. Expected: FAIL (`checkNoteFormat` isn't exported).

- [ ] **Step 12: Change `notes.ts`.** Make these edits:

  1. Change the imports:

     ```ts
     import { InvalidError, NotFoundError, RushesError } from "./errors.js";
     import { labelOfId, versionFormats } from "./formats.js";
     ```

  2. Add `format?: string | null;` to `NewNote` and `UserEdit`, each with the comment `/** §21.3: a Format id, or null for every format. User-owned, like text. */`.
  3. In `applyUserEdit`, add `"format"` to the key list `["text", "box", "grab", "scope", "t", "tOut", "marks", "status", "format"]`.
  4. Give `applyUserEdit` its new signature, `applyUserEdit(file: NotesFile, e: UserEdit, check?: (next: Note, prev: Note) => void): Note`.
  5. Call `check?.(parsed.data, n);` right after the `parsed.success` check, before `reopen`.
  6. Add after `applyUserEdit`:

```ts
export interface NoteFormatCheck {
  next: Pick<Note, "stage" | "video" | "version" | "format" | "box">;
  /** The note as it was, for an edit. */
  prev?: Pick<Note, "format" | "box">;
  /** The edit draws the box again (so it belongs to the format it's drawn on now). */
  boxRedrawn?: boolean;
}

/**
 * §21.3 and R7, checked when a note is written: a format must be one of the note's version's;
 * only Picture notes have one; on a cut with two or more formats a box needs a format, and a box
 * kept from before stays on the format it was drawn on (the primary, for a note from before formats).
 */
export function checkNoteFormat({ next, prev, boxRedrawn = false }: NoteFormatCheck, project: Pick<Project, "videos">): void {
  if (next.format !== null && next.stage !== "picture") throw new RushesError("Only Picture notes belong to a format.", 400, "format_not_picture");
  if (next.stage !== "picture") return;
  const version = project.videos.find((v) => v.id === next.video)?.versions.find((v) => v.id === next.version);
  const shapes = version ? versionFormats(version) : [];
  if (next.format !== null && !shapes.some((f) => f.id === next.format)) {
    throw new RushesError(`${next.version ?? "That cut"} has no ${labelOfId(next.format)} format.`, 400, "unknown_format", { format: next.format });
  }
  if (!next.box || shapes.length < 2) return;
  if (next.format === null) throw new RushesError("A drawn box belongs to one frame, so this note stays on one format.", 400, "box_needs_format");
  if (prev?.box && !boxRedrawn) {
    const drawnOn = prev.format ?? shapes[0].id;
    if (next.format !== drawnOn) {
      throw new RushesError(`A drawn box belongs to the frame it was drawn on (${labelOfId(drawnOn)}), so this note stays there.`, 400, "box_fixes_format", { format: drawnOn });
    }
  }
}
```

  7. Add `format?: string;` and `onlyThisFormat?: boolean;` to `NoteFilter`.
  8. Add one condition to `filterNotes`:

     ```ts
     (f.format === undefined || (n.stage === "picture" && (n.format === f.format || (!f.onlyThisFormat && n.format === null)))) &&
     ```

- [ ] **Step 13: Update the test literals.** `Version` now has `width`, `height` and `formats`, and `Note` has `format`.
  - In `test/web/lib.test.ts`, add `format: null,` to the `note()` helper (lines 32–36).
  - In the same file, add `width: null, height: null, formats: [],` to the version literals at lines 174, 182 and 338.
  - Make the same version change in `test/server/files.test.ts:353`.
  - Then run `npm run typecheck`. If it names any other literal, add the same fields there and run it again.

- [ ] **Step 14: Run the gates.** Run: `npm run build && npm run typecheck && npx vitest run`. Expected: all green.

- [ ] **Step 15: Commit.**

```bash
git add src/core/formats.ts src/core/schema.ts src/core/project.ts src/core/notes.ts test/core/formats.test.ts test/core/project.test.ts test/core/notes.test.ts test/web/lib.test.ts test/server/files.test.ts
git -c user.name=iamredmh -c user.email=17407420+iamredmh@users.noreply.github.com commit -m "feat(core): formats -- measure a render's ratio, register shapes of a cut, notes for one format or all" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

**Mutation check:** changing the 1% tolerance in `ratioLabel` to 2% must fail "2560×1080 is the decimal 2.37:1".

---

### Task 2: Reading a render, registering formats, serving them (§21.3, §21.4 server side, §21.5 frames, §21.6)

**Files:**
- Modify: `src/core/media.ts`: `VIDEO_EXT`, `VideoProbe`, `VideoProber`, `parseVideoProbe` and `probeVideo`.
- Modify: `src/server/app.ts`, which gains:
  - `AppOptions.formatProbe` and the `readRender` helper;
  - `POST /api/formats`;
  - `VersionBody.formats`, with `POST /api/versions` storing the size and formats;
  - `format` on the note bodies, with the checks in `POST /api/notes` and `PATCH /api/notes/:id`;
  - the `format` and `onlyThisFormat` query on `GET /api/notes`;
  - `format` on `FrameQuery`.
- Modify: `src/server/start.ts` (`StartOptions.formats`) and `src/server/files.ts` (`registeredMedia` adds format files).
- Modify: `src/server/assets.ts`: `Asset.format?` and `formatLabel?`, and `listAssets` lists each cut's formats right after it. Task 4's missing-file chip reads `missing` from these rows; reveal, open and download accept them through `candidatePaths`.
- Create: `test/helpers/probe.ts`, `test/server/formats.test.ts`
- Modify: `test/core/media.test.ts`, `test/server/files.test.ts`

**Interfaces:**
- Consumes (Task 1): `addFormat`, `resolveCut`, `checkNoteFormat`, `applyUserEdit(…, check)`, `filterNotes` with `format` and `onlyThisFormat`, `versionFormats`, `FORMAT_ID_RE`, `MAX_FORMATS`.
- Produces (`src/core/media.ts`):

```ts
export const VIDEO_EXT: ReadonlySet<string>;   // mp4 mov m4v webm mkv
export type VideoProbe =
  | { ok: true; width: number; height: number; duration: number | null; fps: number | null }
  | { ok: false; code: "no_ffprobe" | "not_video" | "unreadable"; reason: string };
export type VideoProber = (abs: string) => Promise<VideoProbe>;
export function parseVideoProbe(json: unknown): VideoProbe;
export function probeVideo(file: string, opts?: { timeout?: number }): Promise<VideoProbe>;
```

- Produces (HTTP):
  - **`POST /api/formats`** takes `{ video?, version?, file, label? }` and returns 201 with `{ video: { id, name }, version: Version, format: Format, warning?: string, labelNote?: string }`. Its refusals:
    - 400 `not_video`;
    - 404 `missing_file`;
    - 501 `no_ffprobe`;
    - 422 `unreadable`;
    - 422 `no_primary_size`;
    - 409 `same_ratio`;
    - 400 `too_many_formats`;
    - 404 `no_cut`.
  - **`POST /api/versions`** accepts `formats?: { file }[]` (up to 7) and adds `formatWarnings?: string[]`. One refusal refuses the whole call (R11).
  - **`POST /api/notes` and `PATCH /api/notes/:id`** accept `format` and answer the Task 1 refusals with 400.
  - **`GET /api/notes`** takes `?format=9x16&onlyThisFormat=true`.
  - **`GET /api/videos/:video/versions/:version/frame?t=&format=`** returns 404 `not_found` for a format the cut doesn't have.
  - **`/media`** serves format files under the §15.5 rules.
- Produces (options): `AppOptions.formatProbe?: VideoProber` and `StartOptions.formats?: { probe?: VideoProber }`.
- Produces (`src/server/assets.ts`): `interface Asset { /* existing */ format?: string; formatLabel?: string }`.
  - A cut's own row carries `formatLabel` once it has formats.
  - Each format row is `kind: "cut"` with `format`, `formatLabel`, `width` and `height`, straight after its cut, in chip order.
- Produces (tests): `test/helpers/probe.ts` exports `sizedProbe: VideoProber`.

- [ ] **Step 1: Write the probe helper** at `test/helpers/probe.ts`:

```ts
import { basename } from "node:path";
import type { VideoProbe } from "../../src/core/media.js";

/**
 * A stand-in for ffprobe that answers from the file's name: "…1080x1920…" is that size, and
 * "@8.4" is that length (8 s by default). A name with no size can't be read.
 */
export async function sizedProbe(abs: string): Promise<VideoProbe> {
  const m = /(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?/.exec(basename(abs));
  if (!m) return { ok: false, code: "unreadable", reason: "Invalid data found when processing input" };
  return { ok: true, width: Number(m[1]), height: Number(m[2]), duration: m[3] ? Number(m[3]) : 8, fps: 30 };
}
```

- [ ] **Step 2: Write the failing parse tests** (Review Focus 2). Append to `test/core/media.test.ts`, and extend the imports with `parseVideoProbe`, `probeVideo` (from `../../src/core/media.js`), `spawnSync` (`node:child_process`), `mkdtemp`, `rm` and `writeFile` (`node:fs/promises`), `tmpdir` (`node:os`) and `join` (`node:path`):

```ts
describe("parseVideoProbe (§21.3)", () => {
  const stream = (over: Record<string, unknown> = {}) => ({ codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "30/1", ...over });
  const json = (streams: unknown[], format: Record<string, unknown> = { duration: "8.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }) => ({ streams, format });

  it("reads the size, length and rate", () => {
    expect(parseVideoProbe(json([stream()]))).toEqual({ ok: true, width: 1920, height: 1080, duration: 8, fps: 30 });
  });
  it("stands a quarter-turned phone video upright, from side data or the older rotate tag", () => {
    expect(parseVideoProbe(json([stream({ side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] })]))).toMatchObject({ width: 1080, height: 1920 });
    expect(parseVideoProbe(json([stream({ tags: { rotate: "270" } })]))).toMatchObject({ width: 1080, height: 1920 });
    expect(parseVideoProbe(json([stream({ side_data_list: [{ rotation: 180 }] })]))).toMatchObject({ width: 1920, height: 1080 });
  });
  it("widens non-square pixels to the shape on screen", () => {
    expect(parseVideoProbe(json([stream({ width: 1440, height: 1080, sample_aspect_ratio: "4:3" })]))).toMatchObject({ width: 1920, height: 1080 });
    expect(parseVideoProbe(json([stream({ sample_aspect_ratio: "0:1" })]))).toMatchObject({ width: 1920 });
  });
  it("skips cover art, and refuses audio, stills and a stream with no size", () => {
    expect(parseVideoProbe(json([{ codec_type: "audio" }]))).toEqual({ ok: false, code: "not_video", reason: "it has no video stream" });
    expect(parseVideoProbe(json([{ codec_type: "audio" }, stream({ disposition: { attached_pic: 1 } })]))).toMatchObject({ ok: false, code: "not_video" });
    expect(parseVideoProbe(json([stream()], { format_name: "png_pipe" }))).toEqual({ ok: false, code: "not_video", reason: "it's a still image" });
    expect(parseVideoProbe(json([stream({ width: 0 })]))).toMatchObject({ ok: false, code: "unreadable" });
  });
});

const hasFf = ["ffmpeg", "ffprobe"].every((b) => spawnSync(b, ["-version"], { stdio: "ignore" }).status === 0);

describe.skipIf(!hasFf)("probeVideo with the real ffprobe", () => {
  const make = (dir: string, name: string, args: string[]) => {
    const out = join(dir, name);
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args, out]);
    if (r.status !== 0) throw new Error(String(r.stderr));
    return out;
  };
  it("reads a 9:16 render and an anamorphic one, and refuses a still and a file that isn't video", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rushes probe "));
    try {
      const tall = make(dir, "tall.mp4", ["-f", "lavfi", "-i", "testsrc=size=180x320:rate=30:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
      expect(await probeVideo(tall)).toMatchObject({ ok: true, width: 180, height: 320, fps: 30 });
      const ana = make(dir, "ana.mp4", ["-f", "lavfi", "-i", "testsrc=size=240x240:rate=30:duration=1", "-vf", "setsar=4/3", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
      expect(await probeVideo(ana)).toMatchObject({ ok: true, width: 320, height: 240 });
      const still = make(dir, "still.png", ["-f", "lavfi", "-i", "color=c=red:s=16x16", "-frames:v", "1"]);
      expect(await probeVideo(still)).toMatchObject({ ok: false, code: "not_video" });
      const junk = join(dir, "junk.mp4");
      await writeFile(junk, "not a video at all");
      const r = await probeVideo(junk);
      expect(r).toMatchObject({ ok: false, code: "unreadable" });
      expect(r.ok ? "" : r.reason).not.toContain(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run them and see them fail.** Run: `npx vitest run test/core/media.test.ts`. Expected: FAIL (`parseVideoProbe` isn't exported).

- [ ] **Step 4: Write the probe in `src/core/media.ts`** (below `positiveInt`):

```ts
/** §21.6: the extensions a cut or a format may have. Anything else isn't video. */
export const VIDEO_EXT: ReadonlySet<string> = new Set(["mp4", "mov", "m4v", "webm", "mkv"]);

/** §21.3: a render's shape on screen, its length and rate, or why it can't be a format. */
export type VideoProbe =
  | { ok: true; width: number; height: number; duration: number | null; fps: number | null }
  | { ok: false; code: "no_ffprobe" | "not_video" | "unreadable"; reason: string };
export type VideoProber = (abs: string) => Promise<VideoProbe>;

interface FfStream {
  codec_type?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
  disposition?: { attached_pic?: number };
}

/**
 * ffprobe's `-show_format -show_streams` JSON as a VideoProbe. The size is the one on screen (Review
 * Focus 2): non-square pixels widen it, and a quarter turn of rotation metadata swaps its sides.
 */
export function parseVideoProbe(json: unknown): VideoProbe {
  const j = (json ?? {}) as { format?: { duration?: string; format_name?: string }; streams?: FfStream[] };
  if (/(^|,)image2(,|$)|_pipe(,|$)/.test(j.format?.format_name ?? "")) return { ok: false, code: "not_video", reason: "it's a still image" };
  const s = j.streams?.find((x) => x.codec_type === "video" && x.disposition?.attached_pic !== 1);
  if (!s) return { ok: false, code: "not_video", reason: "it has no video stream" };
  const w = positiveInt(s.width);
  const h = positiveInt(s.height);
  if (w === null || h === null) return { ok: false, code: "unreadable", reason: "it has no picture size" };
  const sar = /^(\d+):(\d+)$/.exec(s.sample_aspect_ratio ?? "");
  const pixel = sar && Number(sar[1]) > 0 && Number(sar[2]) > 0 ? Number(sar[1]) / Number(sar[2]) : 1;
  let width = Math.round(w * pixel);
  let height = h;
  const rotation = s.side_data_list?.find((d) => typeof d.rotation === "number")?.rotation ?? Number(s.tags?.rotate ?? 0);
  if (Math.abs(Math.round(rotation)) % 180 === 90) [width, height] = [height, width];
  const d = j.format?.duration ? Number(j.format.duration) : Number.NaN;
  return { ok: true, width, height, duration: Number.isFinite(d) ? d : null, fps: parseRate(s.avg_frame_rate) ?? parseRate(s.r_frame_rate) };
}

/** §21.3: reads a render with ffprobe, local files only. The reason never repeats the file's path. */
export async function probeVideo(file: string, opts: { timeout?: number } = {}): Promise<VideoProbe> {
  if (!(await hasFfprobe())) return { ok: false, code: "no_ffprobe", reason: "needs ffprobe to read the ratio" };
  try {
    const { stdout } = await run(
      "ffprobe",
      ["-v", "error", "-protocol_whitelist", "file", "-show_format", "-show_streams", "-of", "json", file],
      { timeout: opts.timeout ?? PROBE_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 },
    );
    return parseVideoProbe(JSON.parse(stdout));
  } catch (e) {
    const last = String((e as { stderr?: unknown }).stderr ?? "").trim().split("\n").pop() ?? "";
    const reason = last.startsWith(`${file}: `) ? last.slice(file.length + 2) : last;
    return { ok: false, code: "unreadable", reason: reason.slice(0, 200) || "ffprobe couldn't read it" };
  }
}
```

- [ ] **Step 5: Run the media tests.** Run: `npx vitest run test/core/media.test.ts`. Expected: PASS. The real-ffprobe block is skipped without ffmpeg.

- [ ] **Step 6: Write the failing server tests** at `test/server/formats.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { sizedProbe } from "../helpers/probe.js";
import { createApp, type AppOptions } from "../../src/server/app.js";
import { addVersion } from "../../src/core/project.js";
import { ProxyJobs } from "../../src/server/proxy.js";
import type { Store } from "../../src/core/store.js";

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const WIDE = "renders/hero_1920x1080.mp4";
const TALL = "renders/hero_1080x1920.mp4";
const SQUARE = "renders/hero_1080x1080.mp4";

async function setup(files: string[] = [], opts: AppOptions | ((store: Store) => AppOptions) = {}) {
  const { root, store } = await tmpProject("formats");
  for (const f of files) {
    const abs = join(root, f);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, "bytes");
  }
  const app = createApp(store, { formatProbe: sizedProbe, ...(typeof opts === "function" ? opts(store) : opts) });
  const call = async (method: string, path: string, json?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: json === undefined ? undefined : { "content-type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, json: parsed, text };
  };
  return { root, store, app, call };
}

describe("POST /api/formats (§21.4)", () => {
  it("registers a 9:16 render on the newest cut and says the id and label it settled on", async () => {
    const { call } = await setup([WIDE, TALL]);
    expect((await call("POST", "/api/versions", { video: "Hero", file: WIDE })).json.version).toMatchObject({ width: 1920, height: 1080, formats: [] });
    const r = await call("POST", "/api/formats", { file: TALL });
    expect(r.status).toBe(201);
    expect(r.json.video).toEqual({ id: "hero", name: "Hero" });
    expect(r.json.format).toMatchObject({ id: "9x16", label: "9:16", file: TALL, width: 1080, height: 1920, duration: 8 });
    expect(r.json.warning).toBeUndefined();
  });

  // Review Focus 4.
  it("refuses a second render of a ratio the cut has, however it is spelled", async () => {
    const { root, call } = await setup([WIDE, TALL, "renders/hero_720x1280.mp4"]);
    await call("POST", "/api/versions", { video: "Hero", file: WIDE });
    await call("POST", "/api/formats", { file: TALL });
    for (const file of ["renders/hero_720x1280.mp4", join(root, TALL)]) {
      const r = await call("POST", "/api/formats", { file });
      expect(r.status).toBe(409);
      expect(r.json).toMatchObject({ error: "same_ratio", message: "v1 already has 9:16. Register a re-render as a new version." });
    }
    expect((await call("POST", "/api/formats", { file: join(root, WIDE) })).json.message).toBe("v1 already has 16:9. Register a re-render as a new version.");
  });

  it("two registrations of one ratio at once: one lands, the other is refused", async () => {
    const { call, store } = await setup([WIDE, SQUARE, "renders/alt_1080x1080.mp4"]);
    await call("POST", "/api/versions", { video: "Hero", file: WIDE });
    const both = await Promise.all([call("POST", "/api/formats", { file: SQUARE }), call("POST", "/api/formats", { file: "renders/alt_1080x1080.mp4" })]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await store.read("project")).videos[0].versions[0].formats).toHaveLength(1);
  });

  it("refuses a non-video, a missing file, an unreadable one and one with no video stream, each with its reason (§21.6)", async () => {
    const audioOnly = async (abs: string) => (abs.endsWith("voice.mp4") ? { ok: false as const, code: "not_video" as const, reason: "it has no video stream" } : sizedProbe(abs));
    const { call } = await setup([WIDE, "brief.pdf", "renders/broken.mp4", "renders/voice.mp4"], { formatProbe: audioOnly });
    await call("POST", "/api/versions", { video: "Hero", file: WIDE });
    expect((await call("POST", "/api/formats", { file: "brief.pdf" })).json).toMatchObject({ error: "not_video", message: "brief.pdf isn't a video file." });
    const gone = await call("POST", "/api/formats", { file: "renders/gone_1080x1920.mp4" });
    expect(gone.status).toBe(404);
    expect(gone.json).toMatchObject({ error: "missing_file", message: "File not found: renders/gone_1080x1920.mp4" });
    const broken = await call("POST", "/api/formats", { file: "renders/broken.mp4" });
    expect(broken.status).toBe(422);
    expect(broken.json.message).toBe("ffprobe couldn't read renders/broken.mp4: Invalid data found when processing input");
    expect((await call("POST", "/api/formats", { file: "renders/voice.mp4" })).json).toMatchObject({ error: "not_video", message: "renders/voice.mp4 isn't a video: it has no video stream." });
  });

  it("without ffprobe a format says why it can't be registered, and a cut still goes in (§21.6)", async () => {
    const none = async () => ({ ok: false as const, code: "no_ffprobe" as const, reason: "needs ffprobe to read the ratio" });
    const { call } = await setup([WIDE, TALL], { formatProbe: none });
    const cut = await call("POST", "/api/versions", { video: "Hero", file: WIDE });
    expect(cut.status).toBe(201);
    expect(cut.json.version).toMatchObject({ width: null, height: null });
    const r = await call("POST", "/api/formats", { file: TALL });
    expect(r.status).toBe(501);
    expect(r.json).toMatchObject({ error: "no_ffprobe", message: expect.stringContaining("needs ffprobe to read the ratio") });
  });

  it("registers a format more than 0.1 s off the cut's length, with a warning", async () => {
    const { call } = await setup([WIDE, "renders/hero_1080x1920@8.4.mp4", "renders/hero_1080x1080@8.05.mp4"]);
    await call("POST", "/api/versions", { video: "Hero", file: WIDE });
    expect((await call("POST", "/api/formats", { file: "renders/hero_1080x1920@8.4.mp4" })).json.warning).toBe("9:16 is 8.4 s; the cut is 8.0 s");
    expect((await call("POST", "/api/formats", { file: "renders/hero_1080x1080@8.05.mp4" })).json.warning).toBeUndefined();
  });

  it("reads a cut's own size when it has none (a cut from before formats); refuses when that can't be read", async () => {
    const { call, store } = await setup(["renders/old_1920x1080.mp4", "renders/older.mp4", TALL]);
    await store.update("project", (p) => {
      addVersion(p, { video: "Hero", file: "renders/old_1920x1080.mp4", duration: 8 });
      addVersion(p, { video: "Teaser", file: "renders/older.mp4", duration: 8 });
    });
    expect((await call("POST", "/api/formats", { video: "Hero", file: TALL })).status).toBe(201);
    expect((await store.read("project")).videos[0].versions[0]).toMatchObject({ width: 1920, height: 1080 });
    const r = await call("POST", "/api/formats", { video: "Teaser", file: TALL });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe("no_primary_size");
  });

  it("adds a format to a locked cut (§21.6), and refuses a ninth shape", async () => {
    const sizes = ["1080x1920", "1080x1080", "1080x1350", "1440x1080", "1620x1080", "1080x1620", "2520x1080", "1080x2520"];
    const { call } = await setup([WIDE, ...sizes.map((s) => `renders/f_${s}.mp4`)]);
    await call("POST", "/api/versions", { video: "Hero", file: WIDE });
    await call("PUT", "/api/videos/hero/lock", { version: "v1" });
    for (const s of sizes.slice(0, 7)) expect((await call("POST", "/api/formats", { file: `renders/f_${s}.mp4` })).status).toBe(201);
    expect((await call("POST", "/api/formats", { file: "renders/f_1080x2520.mp4" })).json.error).toBe("too_many_formats");
  });

  it("uses a label hint only for an unusual ratio, and says when it didn't (R10)", async () => {
    const { call } = await setup([WIDE, "renders/scope_1920x804.mp4", TALL]);
    await call("POST", "/api/versions", { video: "Hero", file: WIDE });
    expect((await call("POST", "/api/formats", { file: "renders/scope_1920x804.mp4", label: "2.4:1" })).json.format).toMatchObject({ id: "2.4x1", label: "2.4:1" });
    expect((await call("POST", "/api/formats", { file: TALL, label: "4:5" })).json).toMatchObject({ format: { id: "9x16" }, labelNote: expect.stringContaining("standard ratio") });
  });
});

describe("POST /api/versions with formats (§21.4)", () => {
  it("registers a re-render in all its shapes in one call", async () => {
    const { call } = await setup([WIDE, TALL, SQUARE]);
    const r = await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }, { file: SQUARE }] });
    expect(r.status).toBe(201);
    expect(r.json.version.formats.map((f: any) => f.id)).toEqual(["9x16", "1x1"]);
  });
  it("refuses the whole call when one file is refused, and registers nothing (R11)", async () => {
    const { call, store } = await setup([WIDE, TALL]);
    const r = await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }, { file: "renders/gone_1080x1080.mp4" }] });
    expect(r.status).toBe(404);
    expect((await store.read("project")).videos).toEqual([]);
  });
});

describe("serving format files (§21.6, §15.5)", () => {
  // Review Focus 5.
  it("/media serves a format file, including one outside the project, and refuses a link out to a non-media file", async () => {
    const { root, app, call } = await setup([WIDE, TALL]);
    const outside = join(root, "..", "hf", "renders", "hero_1080x1080.mp4");
    await mkdir(dirname(outside), { recursive: true });
    await writeFile(outside, "square bytes");
    await writeFile(join(root, "..", "secret.key"), "key");
    await symlink(join(root, "..", "secret.key"), join(root, "renders", "link_1350x1080.mp4"));
    await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }, { file: outside }, { file: "renders/link_1350x1080.mp4" }] });
    expect((await app.request(`/media?path=${encodeURIComponent(TALL)}`)).status).toBe(200);
    const out = await app.request(`/media?path=${encodeURIComponent(outside)}`);
    expect(out.status).toBe(200);
    expect(await out.text()).toBe("square bytes");
    expect((await app.request(`/media?path=${encodeURIComponent("renders/link_1350x1080.mp4")}`)).status).toBe(404);
  });

  it("the frame route reads a format's own file with ?format= (R12)", async () => {
    let jobs!: ProxyJobs;
    const { call } = await setup([WIDE, TALL], (store) => {
      jobs = new ProxyJobs(store, { available: async () => true });
      return { proxyJobs: jobs };
    });
    const seen: string[] = [];
    vi.spyOn(jobs, "frame").mockImplementation(async (orig: string) => {
      seen.push(orig);
      return Buffer.from(PNG_1PX, "base64");
    });
    await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }] });
    expect((await call("GET", "/api/videos/hero/versions/v1/frame?t=0&format=9x16")).status).toBe(200);
    expect(seen.pop()).toMatch(/hero_1080x1920\.mp4$/);
    expect((await call("GET", "/api/videos/hero/versions/v1/frame?t=0&format=16x9")).status).toBe(200);
    expect(seen.pop()).toMatch(/hero_1920x1080\.mp4$/);
    expect((await call("GET", "/api/videos/hero/versions/v1/frame?t=0&format=4x5")).status).toBe(404);
    expect((await call("GET", "/api/videos/hero/versions/v1/frame?t=0&format=tall")).status).toBe(400);
  });

  it("GET /api/assets lists a cut's formats right after it, in chip order, with their ratio; reveal accepts them", async () => {
    const { call } = await setup([WIDE, TALL, SQUARE]);
    await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: SQUARE }, { file: TALL }] });
    const cuts = (await call("GET", "/api/assets?kind=cut")).json.assets;
    expect(cuts.map((a: any) => [a.path, a.format ?? null, a.formatLabel ?? null])).toEqual([[WIDE, null, "16:9"], [TALL, "9x16", "9:16"], [SQUARE, "1x1", "1:1"]]);
    expect((await call("POST", "/api/reveal", { path: TALL })).status).toBe(200);
  });

  it("GET /api/state carries each version's size and formats", async () => {
    const { call } = await setup([WIDE, TALL]);
    await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }] });
    const v = (await call("GET", "/api/state")).json.project.videos[0].versions[0];
    expect(v).toMatchObject({ width: 1920, height: 1080, formats: [{ id: "9x16", label: "9:16" }] });
  });
});

describe("notes and formats on the server (§21.3, R7)", () => {
  const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
  async function withNotes() {
    const s = await setup([WIDE, TALL, "renders/solo_1920x1080.mp4"]);
    await s.call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }] });
    await s.call("POST", "/api/versions", { video: "Solo", file: "renders/solo_1920x1080.mp4" });
    const note = (over: Record<string, unknown>) => s.call("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "x", ...over });
    return { ...s, note };
  }

  it("a format must be the note's own cut's; a box needs one; a boxed note keeps its format", async () => {
    const { call, note } = await withNotes();
    expect((await note({ format: "4x5" })).json).toMatchObject({ error: "unknown_format", message: "v1 has no 4:5 format." });
    expect((await note({ box })).json.error).toBe("box_needs_format");
    const boxed = await note({ box, format: "9x16" });
    expect(boxed.status).toBe(201);
    const id = boxed.json.note.id;
    expect((await call("PATCH", `/api/notes/${id}`, { format: null })).json.error).toBe("box_needs_format");
    expect((await call("PATCH", `/api/notes/${id}`, { format: "16x9" })).json.error).toBe("box_fixes_format");
    const plain = (await note({ format: "9x16", t: 2 })).json.note.id;
    expect((await call("PATCH", `/api/notes/${plain}`, { format: null })).json.note.format).toBeNull();
    expect((await call("PATCH", `/api/notes/${plain}`, { format: "9x16" })).json.note.format).toBe("9x16");
    expect((await call("POST", "/api/notes", { stage: "music", scope: "whole", text: "x", format: "9x16" })).json.error).toBe("format_not_picture");
    // A one-format cut keeps today's rule: a box with no format is fine.
    expect((await call("POST", "/api/notes", { stage: "picture", video: "solo", version: "v1", scope: "point", t: 1, text: "x", box })).status).toBe(201);
  });

  it("GET /api/notes filters by format, with the all-format notes unless onlyThisFormat", async () => {
    const { call, note } = await withNotes();
    await note({ text: "all" });
    await note({ text: "tall", format: "9x16", t: 2 });
    await note({ text: "wide", format: "16x9", t: 3 });
    expect((await call("GET", "/api/notes?format=9x16")).json.notes.map((n: any) => n.text)).toEqual(["all", "tall"]);
    expect((await call("GET", "/api/notes?format=9x16&onlyThisFormat=true")).json.notes.map((n: any) => n.text)).toEqual(["tall"]);
    expect((await call("GET", "/api/notes?format=portrait")).status).toBe(400);
  });
});
```

Add to `test/server/files.test.ts`. Use that file's existing imports, and add `registeredMedia` from `../../src/server/files.js` and `addFormat` and `addVersion` from `../../src/core/project.js`:

```ts
it("registeredMedia includes every format file of every cut (§21.6)", () => {
  const p = { schema: 1 as const, rev: 0, name: "demo", fps: 30, videos: [], lanes: [], files: [], autoProxy: false };
  addVersion(p, { video: "Hero", file: "renders/hero_v1.mp4", width: 1920, height: 1080 });
  addFormat(p, { file: "/elsewhere/hf/hero_v1_9x16.mp4", width: 1080, height: 1920, duration: 8, fps: 30 });
  expect(registeredMedia(p, { schema: 1, rev: 0, wordsPerSecond: 2.6, sections: [] }).has("/elsewhere/hf/hero_v1_9x16.mp4")).toBe(true);
});
```

- [ ] **Step 7: Run them and see them fail.** Run: `npx vitest run test/server/formats.test.ts test/server/files.test.ts`. Expected: FAIL (404 on `/api/formats`; there is no `formatProbe` option).

- [ ] **Step 8: Implement the server.** First, in `src/server/files.ts` `registeredMedia`, inside the versions loop after the proxy line:

```ts
      // §21: a cut's other formats play in Picture like the cut itself, under the same §15.5 rules.
      for (const f of ver.formats) files.add(f.file);
```

In `src/server/assets.ts`:
- Import `chipOrder`, `labelOfId` and `versionFormats` from `../core/formats.js`.
- Add to `Asset`:

  ```ts
  /** §21: a cut's format row (its id), and the ratio label on a cut with formats. */
  format?: string;
  formatLabel?: string;
  ```

- Extend `fileAsset`'s `extra` `Pick` with `"format" | "formatLabel"`.
- Replace `cutEntries` in `listAssets` with:

```ts
  // §21.5: each cut, then its formats as sub-rows in chip order, each with the ratio it is.
  type CutEntry = { video: string; version: string; file: string; formatLabel?: string; format?: string; width?: number; height?: number };
  const cutEntries: CutEntry[] = project.videos.flatMap((video) =>
    [...video.versions].reverse().flatMap((version): CutEntry[] => {
      const views = versionFormats(version);
      const own: CutEntry = { video: video.id, version: version.id, file: version.file, ...(version.formats.length > 0 && views[0] ? { formatLabel: views[0].label } : {}) };
      const subs = chipOrder(version.formats).map((f) => ({ video: video.id, version: version.id, file: f.file, format: f.id, formatLabel: labelOfId(f.id), width: f.width, height: f.height }));
      return [own, ...subs];
    }),
  );
```

  Then change the cuts line to:

  ```ts
  Promise.all(cutEntries.map((e) => fileAsset(store, "cut", e.file, { video: e.video, version: e.version, format: e.format, formatLabel: e.formatLabel, width: e.width, height: e.height }))),
  ```

  `fileAsset` spreads `extra`, so keys left `undefined` disappear from the JSON.

In `src/server/start.ts`, add to `StartOptions`:

```ts
  /** How §21's formats are read. Defaults to ffprobe; tests inject a fake. */
  formats?: { probe?: VideoProber };
```

Import `type VideoProber` from `../core/media.js`, and add `formatProbe: opts.formats?.probe` to the `appOpts` literal.

In `src/server/app.ts`, extend these imports:
- `resolveCut, addFormat` from `../core/project.js`;
- `checkNoteFormat` from `../core/notes.js`;
- `VIDEO_EXT, probeVideo, type VideoProber` from `../core/media.js`;
- `FORMAT_ID_RE, MAX_FORMATS, versionFormats` from `../core/formats.js`.

Then add:

```ts
// to AppOptions:
  /** §21: reads a render's shape on screen for formats. Defaults to ffprobe (probeVideo); tests inject a fake. */
  formatProbe?: VideoProber;

// schemas:
const formatId = z.string().regex(FORMAT_ID_RE);
// NewNoteBody gains:      format: formatId.nullish(),
// UserEditBody gains:     format: formatId.nullable().optional(),
// NoteQuery gains:        format: formatId.optional(), onlyThisFormat: z.enum(["true", "false"]).optional(),
// FrameQuery gains:       format: formatId.optional(),
const VersionBody = z.object({
  video: z.string().min(1),
  file: z.string().min(1),
  note: z.string().optional(),
  // §21.4: the other shapes of this same cut, registered in the same call. `file` is the main one.
  formats: z.array(z.object({ file: z.string().min(1) })).max(MAX_FORMATS - 1).optional(),
});
const FormatBody = z.object({
  video: z.string().min(1).max(200).optional(),
  version: z.string().min(1).max(64).optional(),
  file: z.string().min(1),
  label: z.string().trim().min(1).max(16).optional(),
});
```

Inside `createApp`, after `const found = …`:

```ts
  const readVideo = opts.formatProbe ?? probeVideo;
  /** §21.3/§21.6: a render's shape on screen, length and rate, or the refusal in the user's words. */
  async function readRender(given: string): Promise<{ file: string; width: number; height: number; duration: number | null; fps: number | null }> {
    const file = toManifestPath(store.root, given);
    const abs = fromManifestPath(store.root, file);
    if (!VIDEO_EXT.has(extname(file).toLowerCase().replace(/^\./, ""))) throw new RushesError(`${file} isn't a video file.`, 400, "not_video", { path: file });
    const isFile = await stat(abs).then((s) => s.isFile(), () => false);
    if (!isFile) throw new RushesError(`File not found: ${file}`, 404, "missing_file", { path: file });
    const r = await readVideo(abs);
    if (!r.ok) {
      if (r.code === "no_ffprobe") throw new RushesError("Registering a format needs ffprobe to read the ratio. Run `rushes doctor` for how to add it.", 501, "no_ffprobe");
      if (r.code === "not_video") throw new RushesError(`${file} isn't a video: ${r.reason}.`, 400, "not_video", { path: file });
      throw new RushesError(`ffprobe couldn't read ${file}: ${r.reason}`, 422, "unreadable", { path: file });
    }
    return { file, width: r.width, height: r.height, duration: r.duration, fps: r.fps };
  }
```

Replace the body of `app.post("/api/versions", …)` up to the `store.update` call with:

```ts
    const b = await body(c, VersionBody);
    // §21.4 (R11): with formats, every file is read first and one refusal refuses the whole call.
    const shapes = b.formats?.length ? await Promise.all([b.file, ...b.formats.map((f) => f.file)].map(readRender)) : null;
    const file = shapes ? shapes[0].file : toManifestPath(store.root, b.file);
    const abs = fromManifestPath(store.root, file);
    // The proxy jobs' probe is ffprobe (tests inject a fake), so the cut's need is read from the same
    // answer. §21.3 (R2): the primary's shape on screen is stored too, when it can be read.
    const [info, size] = await Promise.all([jobs.probe(abs), shapes ? Promise.resolve(shapes[0]) : readVideo(abs).then((r) => (r.ok ? r : null))]);
    const formatWarnings: string[] = [];
    let lockedVersion: string | null = null;
    let autoProxy = false;
    const { result } = await store.update("project", (p) => {
      const out = addVersion(p, {
        video: b.video, file, note: b.note, duration: info.duration ?? size?.duration ?? null, fps: info.fps ?? size?.fps ?? null,
        width: size?.width ?? null, height: size?.height ?? null,
      });
      for (const s of shapes?.slice(1) ?? []) {
        const added = addFormat(p, { video: out.video.id, version: out.version.id, ...s });
        if (added.warning) formatWarnings.push(added.warning);
      }
      lockedVersion = out.video.lockedVersion;
      autoProxy = p.autoProxy;
      if (info.fps && p.videos.length === 1 && p.videos[0].versions.length === 1) p.fps = info.fps;
      return out;
    });
```

In that route's two `return c.json({ ...result, ...proxy …}, 201)` lines, spread `...(formatWarnings.length ? { formatWarnings } : {})` alongside `...proxy`. Then add the formats route after it:

```ts
  // ---- formats (§21.4) ----
  app.post("/api/formats", async (c) => {
    const b = await body(c, FormatBody);
    const render = await readRender(b.file);
    // The cut it joins, pinned now, and its own shape when it has none yet (a cut from before formats).
    const cut = resolveCut(await store.read("project"), b.video, b.version);
    let primarySize: { width: number; height: number } | null = null;
    if (cut.version.width === null || cut.version.height === null) {
      const r = await readVideo(fromManifestPath(store.root, cut.version.file));
      if (r.ok) primarySize = { width: r.width, height: r.height };
    }
    const { result } = await store.update("project", (p) =>
      addFormat(p, { ...render, video: cut.video.id, version: cut.version.id, label: b.label, primarySize }),
    );
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
```

Replace the notes routes' bodies:

```ts
  app.get("/api/notes", async (c) => {
    const q = NoteQuery.safeParse(c.req.query());
    if (!q.success) throw new InvalidError("Query is invalid", q.error.issues);
    const { notes } = await store.read("notes");
    return c.json({ notes: filterNotes(notes, { ...q.data, onlyThisFormat: q.data.onlyThisFormat === "true" }) });
  });

  app.post("/api/notes", async (c) => {
    const b = await body(c, NewNoteBody);
    // The client never sends shot; the server stamps it from the version's shots.
    let shot: Note["shot"] = null;
    if (b.stage === "picture" || b.format != null) {
      const project = await store.read("project");
      // §21.3: a format must be one of this cut's, and on a cut with formats a box belongs to one.
      checkNoteFormat({ next: { stage: b.stage, video: b.video ?? null, version: b.version ?? null, format: b.format ?? null, box: b.box ?? null } }, project);
      if (b.stage === "picture" && b.video && b.version && b.t != null) {
        const version = project.videos.find((v) => v.id === b.video)?.versions.find((v) => v.id === b.version);
        if (version) shot = shotAt(version.shots, b.t);
      }
    }
    const { result } = await store.update("notes", (f) => addNote(f, { ...b, shot, by: "user" }));
    return c.json({ note: result }, 201);
  });

  app.patch("/api/notes/:id", async (c) => {
    const b = await body(c, UserEditBody);
    const project = b.format !== undefined || b.box !== undefined ? await store.read("project") : null;
    const check = project ? (next: Note, prev: Note) => checkNoteFormat({ next, prev, boxRedrawn: b.box !== undefined }, project) : undefined;
    const { result } = await store.update("notes", (f) => applyUserEdit(f, { id: c.req.param("id"), ...b }, check));
    return c.json({ note: result });
  });
```

In the frame route, after `const { project, version } = await cutOf(…);`:

```ts
    // R12: Grab Frame on a format reads that format's own file. Frames are counted at the cut's fps.
    const view = q.data.format ? versionFormats(version).find((f) => f.id === q.data.format) : undefined;
    if (q.data.format && !view) throw new NotFoundError("format", q.data.format);
    const orig = fromManifestPath(store.root, view && !view.primary ? view.file : version.file);
```

Delete the old `const orig = …` line. Change the clamp to use `const length = view?.duration ?? version.duration;` in place of `version.duration`, and keep the rest.

- [ ] **Step 9: Run the server tests.** Run: `npx vitest run test/server/formats.test.ts test/server/files.test.ts test/server/app.test.ts test/server/assets.test.ts`. Expected: PASS. A cut with no formats lists exactly as before.

- [ ] **Step 10: Run the gates.** Run: `npm run build && npm run typecheck && npx vitest run`. The dashboard is unchanged so far, so check that the existing e2e suite still passes once, in both projects: `npx playwright test --retries=0`. Expected: all green.

- [ ] **Step 11: Commit.**

```bash
git add src/core/media.ts src/server/app.ts src/server/start.ts src/server/files.ts src/server/assets.ts test/helpers/probe.ts test/server/formats.test.ts test/server/files.test.ts test/core/media.test.ts
git -c user.name=iamredmh -c user.email=17407420+iamredmh@users.noreply.github.com commit -m "feat(server): register formats with ffprobe, serve them, check notes' formats, frames by format" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

**Mutation check:** removing the `for (const f of ver.formats)` line from `registeredMedia` must fail "/media serves a format file…" with a 404.

---

### Task 3: The agent surface (§21.4, §21.5 Send to agent)

**Files:**
- Modify: `src/mcp/tools.ts`: `rushes_add_format`; `formats` on `rushes_add_version`; `format` and `onlyThisFormat` on `rushes_list_notes`.
- Modify: `src/cli/main.ts`: `add format`; the `--label` option; the format column on `notes`; the help lines.
- Modify: `src/core/exportNotes.ts` (the format tag on Picture note lines) and `src/core/batches.ts` (`formatLines` and `buildPrompt`'s `extra`).
- Modify: `AGENTS.md`, `skills/rushes/SKILL.md`, `README.md` (the tool count and list, and the CLI line).
- Test: `test/mcp/tools.test.ts`, `test/cli/main.test.ts`, `test/core/exportNotes.test.ts`, `test/core/tabs-batches.test.ts`, `test/package.test.ts`

**Interfaces:**
- Consumes: Task 1's `formatTag`, `versionFormats`, `chipOrder` and `labelOfId`; Task 2's routes; `StartOptions.formats`; `sizedProbe`.
- Produces:
  - **MCP tool `rushes_add_format`:** `{ project?, video?, version?, file, label? }`. It returns `POST /api/formats`'s JSON.
  - **`rushes_add_version`** gains `formats?: { file: string }[]`.
  - **`rushes_list_notes`** gains `format?: string` and `onlyThisFormat?: boolean`.
  - **The CLI:** `rushes add format <file> [--video NAME] [--version V] [--label RATIO]` prints `Added <label> to <film> <vN>`, plus `Warning: …` and `Label: …` lines when present.
  - **`src/core/batches.ts`:**

    ```ts
    export function formatLines(project: Pick<Project, "videos">, notes: Pick<Note, "video" | "version" | "format">[]): string[]
    export function buildPrompt(project: string, stage: Stage, batchId: string, notes: number, sections: number, extra?: string[]): string
    ```

  - **`src/core/exportNotes.ts`:** the `noteLines(n, ctx, videos)` signature (internal).

- [ ] **Step 1: Write the failing MCP tests.** In `test/mcp/tools.test.ts`:
  - Import `sizedProbe` from `../helpers/probe.js` and `type VideoProber` from `../../src/core/media.js`.
  - Extend `connect` to `connect(opts: { files?: string[]; probe?: Probe; formatProbe?: VideoProber } = {})`, passing `formats: opts.formatProbe ? { probe: opts.formatProbe } : undefined` to `startServer`.
  - Rename "lists the nineteen tools" to "lists the twenty tools", and add `"rushes_add_format"` after `"rushes_add_file"` in its sorted list.
  - Append:

```ts
describe("formats for agents (§21.4)", () => {
  const FILES = ["renders/hero_1920x1080.mp4", "renders/hero_1080x1920.mp4", "renders/hero_1080x1080.mp4", "renders/hero_720x1280.mp4", "renders/hero_1080x1350@8.4.mp4"];

  it("rushes_add_format registers a shape; a second of the same ratio is refused with the reason and its code", async () => {
    const t = await connect({ files: FILES, formatProbe: sizedProbe });
    await t.call("rushes_add_version", { video: "Hero", file: "renders/hero_1920x1080.mp4" });
    expect((await t.call("rushes_add_format", { file: "renders/hero_1080x1920.mp4" })).json.format).toMatchObject({ id: "9x16", label: "9:16" });
    const again = await t.call("rushes_add_format", { file: "renders/hero_720x1280.mp4" });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("v1 already has 9:16. Register a re-render as a new version.");
    expect(again.text).toContain("same_ratio");
    expect((await t.call("rushes_add_format", { file: "renders/hero_1080x1350@8.4.mp4" })).json.warning).toBe("4:5 is 8.4 s; the cut is 8.0 s");
    await t.close();
  });

  it("describes the tools' new inputs", async () => {
    const t = await connect();
    const { tools } = await t.client.listTools();
    const props = (n: string) => Object.keys(tools.find((x) => x.name === n)!.inputSchema.properties as object).sort();
    expect(props("rushes_add_format")).toEqual(["file", "label", "project", "version", "video"]);
    expect(props("rushes_add_version")).toContain("formats");
    expect(props("rushes_list_notes")).toEqual(expect.arrayContaining(["format", "onlyThisFormat"]));
    expect(tools.find((x) => x.name === "rushes_add_format")!.description).toMatch(/Register a re-render as a new version|re-render is a new version/);
    await t.close();
  });

  it("rushes_add_version takes formats and registers every shape in one call", async () => {
    const t = await connect({ files: FILES, formatProbe: sizedProbe });
    const r = await t.call("rushes_add_version", { video: "Hero", file: "renders/hero_1920x1080.mp4", formats: [{ file: "renders/hero_1080x1920.mp4" }, { file: "renders/hero_1080x1080.mp4" }] });
    expect(r.json.version.formats.map((f: any) => f.id)).toEqual(["9x16", "1x1"]);
    await t.close();
  });

  // §21.8 (6): an agent sees format, can filter, and a reply to a format note leaves the others alone.
  it("rushes_list_notes returns format on every note and filters by it", async () => {
    const t = await connect({ files: FILES, formatProbe: sizedProbe });
    await t.call("rushes_add_version", { video: "Hero", file: "renders/hero_1920x1080.mp4", formats: [{ file: "renders/hero_1080x1920.mp4" }] });
    const api = new RushesClient(t.running.url);
    const add = (text: string, format: string | null, at: number) => api.post("/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: at, text, format });
    await add("Drop the first sound.", null, 1);
    await add("Logo too close to the top.", "9x16", 2);
    await add("Rows land late on wide.", "16x9", 3);
    expect((await t.call("rushes_list_notes", { stage: "picture" })).json.notes.every((n: any) => "format" in n)).toBe(true);
    expect((await t.call("rushes_list_notes", { format: "9x16" })).json.notes.map((n: any) => n.text).sort()).toEqual(["Drop the first sound.", "Logo too close to the top."]);
    const only = (await t.call("rushes_list_notes", { format: "9x16", onlyThisFormat: true })).json.notes;
    expect(only.map((n: any) => n.text)).toEqual(["Logo too close to the top."]);
    await t.call("rushes_reply", { replies: [{ id: only[0].id, reply: "Moved the logo down on 9:16.", status: "done" }] });
    const after = (await t.call("rushes_list_notes", { stage: "picture" })).json.notes;
    expect(after.filter((n: any) => n.status === "done").map((n: any) => n.id)).toEqual([only[0].id]);
    await t.close();
  });
});
```

- [ ] **Step 2: Write the failing CLI, export and prompt tests.** In `test/cli/main.test.ts`, import `sizedProbe` from `../helpers/probe.js`, then append:

```ts
describe("formats on the CLI (§21.4)", () => {
  async function server(files: string[]) {
    const { root } = await tmpProject();
    for (const f of files) {
      await mkdir(dirname(join(root, f)), { recursive: true });
      await writeFile(join(root, f), "bytes");
    }
    const s = await startServer(root, { port: 0, formats: { probe: sizedProbe } });
    return { root, s };
  }

  it("add format says what it settled on and any warning; a refusal exits 1 with the reason", async () => {
    const { root, s } = await server(["renders/hero_1920x1080.mp4", "renders/hero_1080x1920@8.4.mp4", "renders/hero_720x1280.mp4"]);
    const a = io(root);
    expect(await main(["add", "version", "renders/hero_1920x1080.mp4", "--video", "Hero"], a.x)).toBe(0);
    expect(await main(["add", "format", "renders/hero_1080x1920@8.4.mp4"], a.x)).toBe(0);
    expect(a.out).toContain("Added 9:16 to Hero v1");
    expect(a.out).toContain("Warning: 9:16 is 8.4 s; the cut is 8.0 s");
    const b = io(root);
    expect(await main(["add", "format", "renders/hero_720x1280.mp4", "--video", "Hero", "--version", "v1"], b.x)).toBe(1);
    expect(b.err.join("\n")).toContain("v1 already has 9:16. Register a re-render as a new version.");
    await s.close();
  });

  it("notes shows a format column for a cut with formats, and none for a one-format cut (R4)", async () => {
    const { root, s } = await server(["renders/hero_1920x1080.mp4", "renders/hero_1080x1920.mp4", "renders/solo_1920x1080.mp4"]);
    const a = io(root);
    await main(["add", "version", "renders/hero_1920x1080.mp4", "--video", "Hero"], a.x);
    await main(["add", "format", "renders/hero_1080x1920.mp4", "--video", "Hero"], a.x);
    await main(["add", "version", "renders/solo_1920x1080.mp4", "--video", "Solo"], a.x);
    const post = (body: object) => fetch(`${s.url}/api/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await post({ stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Logo too close to the top.", format: "9x16" });
    await post({ stage: "picture", video: "hero", version: "v1", scope: "point", t: 2, text: "Drop the first sound." });
    await post({ stage: "picture", video: "solo", version: "v1", scope: "point", t: 3, text: "Hold longer." });
    const b = io(root);
    expect(await main(["notes"], b.x)).toBe(0);
    expect(b.out.find((l) => l.includes("Logo too close"))).toMatch(/ 9:16 {2}Logo too close/);
    expect(b.out.find((l) => l.includes("Drop the first"))).toMatch(/ All {2}Drop the first/);
    expect(b.out.find((l) => l.includes("Hold longer"))).not.toMatch(/ All /);
    await s.close();
  });

  it("help lists add format", async () => {
    const a = io("/tmp");
    await main([], a.x);
    expect(a.out.join("\n")).toContain("rushes add format <file> [--video NAME] [--version V] [--label RATIO]");
  });
});
```

Append to `test/core/exportNotes.test.ts`, with `import { addFormat, addVersion } from "../../src/core/project.js";`:

```ts
it("on a cut with formats every Picture note carries its format; a one-format cut's notes read as before (§21.4, R4)", () => {
  const p = project();
  addVersion(p, { video: "Hero", file: "renders/hero_v1.mp4", duration: 8, width: 1920, height: 1080 });
  addFormat(p, { video: "hero", file: "renders/hero_v1_9x16.mp4", width: 1080, height: 1920, duration: 8, fps: 30 });
  addVersion(p, { video: "Solo", file: "renders/solo_v1.mp4", width: 1920, height: 1080 });
  const notes: NotesFile = { schema: 1, rev: 0, notes: [] };
  addNote(notes, { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Drop the first sound." });
  addNote(notes, { stage: "picture", video: "hero", version: "v1", scope: "point", t: 2, text: "Logo too close to the top.", format: "9x16" });
  addNote(notes, { stage: "picture", video: "solo", version: "v1", scope: "point", t: 1, text: "Hold longer." });
  const md = notesMarkdown(p, notes.notes, new Date(2026, 9, 7, 9, 0));
  expect(md).toContain("- **0:01.00** · All · to do — Drop the first sound.");
  expect(md).toContain("- **0:02.00** · 9:16 · to do — Logo too close to the top.");
  expect(md).toContain("- **0:01.00** · to do — Hold longer.");
});
```

Append to `test/core/tabs-batches.test.ts`'s `describe("createBatch")`, extending the import with `addFormat`:

```ts
  it("a Picture batch on a cut with formats lists them and the notes by format, and how to fix them (§21.5)", () => {
    const c = ctx();
    addVersion(c.project, { video: "Hero", file: "renders/hero_v1.mp4", duration: 8, width: 1920, height: 1080 });
    addFormat(c.project, { video: "hero", file: "renders/hero_v1_9x16.mp4", width: 1080, height: 1920, duration: 8, fps: 30 });
    addFormat(c.project, { video: "hero", file: "renders/hero_v1_1x1.mp4", width: 1080, height: 1080, duration: 8, fps: 30 });
    addNote(c.notes, { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "a" });
    addNote(c.notes, { stage: "picture", video: "hero", version: "v1", scope: "point", t: 2, text: "b", format: "9x16" });
    addNote(c.notes, { stage: "picture", video: "hero", version: "v1", scope: "point", t: 3, text: "c", format: "9x16" });
    const b = createBatch(c, "picture");
    expect(b.prompt).toContain("Hero v1 has 3 formats: 16:9 (main), 9:16, 1:1. Notes: 1 for all formats, 2 for 9:16.");
    expect(b.prompt).toContain(
      "A note with a format is for that format only: fix it there and leave the others. An all-format note is for every format: say in your reply which formats you fixed. Register every shape of the new cut (rushes_add_version with formats, or rushes_add_format).",
    );
  });

  it("a one-format Picture batch's prompt says nothing about formats", () => {
    const c = ctx();
    addVersion(c.project, { video: "Hero", file: "renders/hero_v1.mp4", duration: 8, width: 1920, height: 1080 });
    addNote(c.notes, { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "a" });
    expect(createBatch(c, "picture").prompt).not.toMatch(/format/i);
  });
```

In `test/package.test.ts`:
- Change the test "%s counts nineteen tools, and names every one" so that it expects `/twenty tools/`, `.not.toMatch(/nineteen/)`, and `` `rushes_add_format` `` alongside the existing names.
- Add:

```ts
  it.each(["skills/rushes/SKILL.md", "AGENTS.md"])("%s tells the agent to register every shape, main one first, and fix only a note's own format (§21.4)", (file) => {
    const text = read(file);
    expect(text).toContain("`rushes_add_format`");
    expect(text).toMatch(/register every shape you rendered/i);
    expect(text).toMatch(/main one first/i);
    expect(text).toMatch(/fix only that format/i);
    expect(text).toMatch(/`format`/);
  });
```

- [ ] **Step 3: Run them and see them fail.** Run: `npx vitest run test/mcp/tools.test.ts test/cli/main.test.ts test/core/exportNotes.test.ts test/core/tabs-batches.test.ts test/package.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement the MCP tools.** In `src/mcp/tools.ts`:
  - Add `formats: z.array(z.object({ file: z.string() })).max(7).optional().describe("Other shapes of this same cut (the same edit at other aspect ratios, e.g. a 9:16 and a 1:1 of the 16:9), registered as its formats in one call. `file` is the main one.")` to `rushes_add_version`'s schema. Append to its description: " Pass `formats` to register the other shapes of the same cut in one call."
  - Add `format: z.string().optional().describe('A format id such as "9x16": that format\'s Picture notes plus the all-format ones.')` and `onlyThisFormat: z.boolean().optional().describe("With format: only that format's notes, not the all-format ones.")` to `rushes_list_notes`'s schema.
  - In `rushes_list_notes`'s handler, build the query with `String(v)`: `new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))`.
  - Append to its description: ` On Picture, a note's \`format\` is null when it's for every format, or a format id such as "9x16" when it's for that shape only.`
  - Register after `rushes_add_version`:

```ts
  server.registerTool(
    "rushes_add_format",
    {
      title: "Add a format",
      description:
        "Register another shape of a cut: the same edit rendered at another aspect ratio, e.g. the 9:16 or 1:1 of a 16:9 cut. Rushes measures the ratio with ffprobe. Defaults to the newest cut of the only or newest film. Returns the format's id and label (e.g. \"9x16\", \"9:16\"), and `warning` when its length is more than 0.1 s off the cut's. A second render with a ratio the cut already has is refused: a re-render is a new version.",
      inputSchema: {
        project,
        video: z.string().optional().describe("Video id or name. Defaults to the newest cut's film."),
        version: z.string().optional().describe("Defaults to that film's newest cut."),
        file: z.string().describe("Path to the render, absolute or relative to the project."),
        label: z.string().optional().describe('Only a hint, used when the measured ratio isn\'t a standard one, e.g. "2.39:1".'),
      },
    },
    safe(async ({ project, ...b }) => (await ctx.client(project)).post("/api/formats", b)),
  );
```

- [ ] **Step 5: Implement the CLI.**
  - In `src/cli/main.ts`, add `label: { type: "string" },` to `OPTIONS`.
  - Add the help lines under `rushes add version …`:

    ```
      rushes add format <file> [--video NAME] [--version V] [--label RATIO]
                                                        register another shape (aspect ratio) of a cut
    ```

  - In `case "add"` before `if (what === "variant")`:

```ts
        if (what === "format") {
          if (!a) return usage(io, "rushes add format <file> [--video NAME] [--version V] [--label RATIO]");
          const r = await (await client()).post("/api/formats", { file: resolve(io.cwd, a), video: o.video, version: addVersion, label: o.label });
          io.out(`Added ${r.format.label} to ${r.video.name} ${r.version.id}`);
          if (r.warning) io.out(`Warning: ${r.warning}`);
          if (r.labelNote) io.out(`Label: ${r.labelNote}`);
          return 0;
        }
```

  - Change the final usage to `"rushes add version|format|variant|shots|file ..."`.
  - In `case "notes"`, import `formatTag` from `../core/formats.js`, and replace the `ctx` and line building with:

```ts
        // What an audio note is on (M4), and a Picture note's format (§21.4, R4), from the state.
        const state: (OnContext & { project: Project }) | null = (notes as Note[]).some((n) => n.stage !== "script") ? await c.get("/api/state") : null;
        for (const n of notes) {
          const label = state ? onLabel(n, state) : null;
          const on = label ? `${stripControl(label)}  ` : "";
          const tag = state ? formatTag(n, state.project.videos) : null;
          const fmtCol = tag ? `${tag}  ` : "";
          const shot = n.shot ? `shot ${String(n.shot.n).padStart(2, "0")} ` : "";
          const marks = (n.marks as Mark[] | undefined)?.length ? `${(n.marks as Mark[]).map(markLabel).join(" · ")}  ` : "";
          io.out(`${n.id}  ${n.status === "done" ? "done" : "todo"}  ${n.stage.padEnd(7)} ${when(n).padEnd(17)} ${fmtCol}${on}${marks}${shot}${n.text}`);
        }
```

  Import `type Project` from `../core/schema.js` if it isn't already imported.

- [ ] **Step 6: Implement the export and the prompt.** In `src/core/exportNotes.ts`:
  - Import `formatTag` from `./formats.js`.
  - Change `noteLines(n, ctx)` to `noteLines(n: Note, ctx: OnContext, videos: Project["videos"])`.
  - Add `const tag = formatTag(n, videos); const fmtPart = tag ? \` · ${tag}\` : "";` and put `${fmtPart}` straight after the bold time: `` `- **${noteTime(n.t, n.tOut)}**${fmtPart}${on}${marks}${shot} · ${status} — …` ``.
  - Pass `project.videos` at all three call sites.

In `src/core/batches.ts`, import `chipOrder` and `versionFormats` from `./formats.js` and `type Note` from `./schema.js`, then add:

```ts
const FORMAT_STEPS =
  "A note with a format is for that format only: fix it there and leave the others. An all-format note is for every format: say in your reply which formats you fixed. Register every shape of the new cut (rushes_add_version with formats, or rushes_add_format).";

/** §21.5: for a Picture batch, each cut with formats, its shapes and how many notes each has, then how to fix them. */
export function formatLines(project: Pick<Project, "videos">, notes: Pick<Note, "video" | "version" | "format">[]): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const n of notes) {
    const key = `${n.video}\u0000${n.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const video = project.videos.find((v) => v.id === n.video);
    const version = video?.versions.find((v) => v.id === n.version);
    const shapes = version ? versionFormats(version) : [];
    if (!video || !version || shapes.length < 2) continue;
    const [main, ...rest] = shapes;
    const ordered = chipOrder(rest);
    const here = notes.filter((x) => x.video === n.video && x.version === n.version);
    const counts = [
      { label: "all formats", k: here.filter((x) => x.format === null).length },
      ...[main, ...ordered].map((f) => ({ label: f.label, k: here.filter((x) => x.format === f.id).length })),
    ].filter((c) => c.k > 0);
    lines.push(`${video.name} ${version.id} has ${shapes.length} formats: ${[`${main.label} (main)`, ...ordered.map((f) => f.label)].join(", ")}. Notes: ${counts.map((c) => `${c.k} for ${c.label}`).join(", ")}.`);
  }
  if (lines.length) lines.push(FORMAT_STEPS);
  return lines;
}
```

Change `buildPrompt` to take `extra: string[] = []` and return `` `Work through …${parts.join(" and ")}.\n${[...extra, steps].join("\n")}` ``. In `createBatch`, pass `stage === "picture" ? formatLines(ctx.project, notes) : []`.

- [ ] **Step 7: Write the docs.**
  - **`AGENTS.md`, under "The loop" step 1**, after the "A render" bullet:

    > - **Other shapes of the same cut** (a 9:16, 1:1 or 4:5 of the 16:9: same edit, same length): register every shape you rendered, main one first. `rushes_add_version` with `file` (the main one) and `formats: [{ file }, …]` registers them all in one call; `rushes_add_format` (`file`, optional `video`, `version` and `label`) adds one to a cut already registered. Rushes measures each ratio with ffprobe; `label` is only a hint for an unusual ratio such as 2.39:1. A second render with a ratio the cut already has is refused: a re-render is a new version. A shape more than 0.1 s off the cut's length is registered with a `warning`.

  - **`AGENTS.md`, step 4:** add `` `format` `` to the list of note fields: "(Picture only: `null` when the note is for every format, or a format id such as `"9x16"` when it's for that shape only)". Then add the sentence: "When a note's `format` is not null, fix only that format and leave the others alone; an all-format note is for every shape, so fix each and say in `reply` which formats you fixed. `rushes_list_notes` takes `format` (that format's notes plus the all-format ones) and `onlyThisFormat: true`."
  - **`AGENTS.md`, "Tools":** "twenty tools", with `rushes_add_format` after `rushes_add_version`.
  - **`AGENTS.md`, "Without MCP":** add `npx -y rushes add format renders/hero_v2_9x16.mp4 --video "Hero 60s"`.
  - **`skills/rushes/SKILL.md`, step 1:** add the bullet:

    > - `rushes_add_format` for each other shape of a cut (a 9:16, 1:1 or 4:5 of the same edit): register every shape you rendered, main one first, or pass `formats: [{ file }]` to `rushes_add_version`;

  - **`skills/rushes/SKILL.md`, step 3:** add "A Picture note's `format` is null for every format, or a format id such as `"9x16"`: when it isn't null, fix only that format."
  - **`skills/rushes/SKILL.md`, the tool count:** "twenty tools", with `rushes_add_format` in the list.
  - **`README.md`:** "twenty tools" with `rushes_add_format` in the list.
  - Check every tool name, field and flag against `src/mcp/tools.ts` and `src/cli/main.ts`.

- [ ] **Step 8: Run the tests.** Run: `npx vitest run test/mcp/tools.test.ts test/cli/main.test.ts test/core/exportNotes.test.ts test/core/tabs-batches.test.ts test/package.test.ts`. Expected: PASS.

- [ ] **Step 9: Run the gates.** Run: `npm run build && npm run typecheck && npx vitest run`. Expected: all green.

- [ ] **Step 10: Commit.**

```bash
git add src/mcp/tools.ts src/cli/main.ts src/core/exportNotes.ts src/core/batches.ts AGENTS.md skills/rushes/SKILL.md README.md test/mcp/tools.test.ts test/cli/main.test.ts test/core/exportNotes.test.ts test/core/tabs-batches.test.ts test/package.test.ts
git -c user.name=iamredmh -c user.email=17407420+iamredmh@users.noreply.github.com commit -m "feat(agent): rushes_add_format, formats on add_version, notes by format; CLI, export and prompt say the format" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

**Mutation check:** making `filterNotes` ignore `onlyThisFormat` must fail "rushes_list_notes returns format on every note and filters by it".

---

### Task 4: The toggle and the player (§21.5 toggle and player)

**Files:**
- Create: `web/src/ui/FormatToggle.tsx`
- Modify: `web/src/lib.ts`, which gains:
  - re-exports from `src/core/formats.ts`;
  - `FormatChip`, `previousVersion`, `currentFormat`, `formatChips`, `neighbourFormat`, `chipLabel`, `shapeBox`, `fmtColumns`, `formatPrompt`, `RESHAPE_MS` and `reshapeKeyframes`.
- Modify: `web/src/types.ts` (export `Format`), `web/src/ui/App.tsx`, `web/src/ui/Picture.tsx`, `web/src/ui/Notes.tsx` (`selectedId` only) and `web/src/styles.css`.
- Modify: `e2e/fixture.ts` (`addFormatsCut`, `addFormatFile`)
- Create: `e2e/formats.spec.ts`
- Test: `test/web/lib.test.ts`, `test/web/styles.test.ts`

**Interfaces:**
- Consumes:
  - Task 1's `versionFormats`, `chipOrder`, `durationWarning`, `labelOfId` and `noteShowsOn`.
  - Task 2's routes: the fixture registers formats through `POST /api/versions` and `POST /api/formats`.
  - Task 2's format rows in `GET /api/assets`: `missing` for the "File not found" chip.
- Produces (`web/src/lib.ts`):

```ts
export { CHIP_ORDER, chipOrder, durationWarning, labelOfId, noteShowsOn, ratioLabel, versionFormats, type FormatView } from "../../src/core/formats.js";
export interface FormatChip { id: string; label: string; width: number; height: number; enabled: boolean; selected: boolean; count: number; warn: string | null; reason: "single" | "absent" | null }
export function previousVersion(video: Video, versionId: string): Version | undefined;
export function currentFormat(views: FormatView[], remembered: string | undefined): string | null;
export function formatChips(o: { views: FormatView[]; previous: FormatView[]; current: string | null; versionDuration: number | null; notes: Note[]; missing: ReadonlySet<string> }): FormatChip[];
export function neighbourFormat(chips: FormatChip[], current: string | null, dir: -1 | 1): string | null;
export function chipLabel(chip: FormatChip, versionId: string): string;
export function shapeBox(width: number, height: number, size?: number): { width: number; height: number };
export function fmtColumns(n: number): string;          // "repeat(n, minmax(0, 1fr))"
export function formatPrompt(projectName: string, filmName: string, versionId: string): string;
export const RESHAPE_MS = 160;
export function reshapeKeyframes(from: { width: number; height: number }, to: { width: number; height: number }, reduced: boolean): { width: string; height: string }[] | null;
```

- Produces (`web/src/ui/FormatToggle.tsx`): `export function FormatToggle(p: { chips: FormatChip[]; versionId: string; prompt: string; onSelect(id: string): void; toast(m: string): void })`.
- Produces (new optional `PictureProps`):

```ts
formats?: FormatView[];
format?: string | null;
formatMissing?: boolean;
onPrimarySize?(file: string, width: number, height: number): void;
onBoxPendingChange?(has: boolean): void;
```

- Produces (`NotesProps`): `selectedId?: string | null`. The selected card gets `aria-current="true"`.
- Produces (window hooks, `?test=1` only): `window.__rushesLastReshape: { animated: boolean; ms: number }`.
- Produces (e2e fixture):

```ts
export interface FormatSize { width: number; height: number; seconds?: number }
addFormatsCut(sizes: FormatSize[], opts?: { video?: string; note?: string; audio?: boolean }): Promise<{ version: { id: string; formats: { id: string; label: string; file: string }[] } }>;
addFormatFile(size: FormatSize, opts?: { video?: string; version?: string }): Promise<{ format: { id: string; label: string; file: string } }>;
```

- [ ] **Step 1: Write the failing unit tests.** Append to `test/web/lib.test.ts`, importing the new names from `../../web/src/lib.js`:

```ts
describe("format chips (§21.5)", () => {
  const view = (id: string, w: number, h: number, primary = false, over: Partial<FormatView> = {}): FormatView =>
    ({ id, label: id.replace("x", ":"), file: `renders/hero_${id}.mp4`, width: w, height: h, duration: 8, fps: 30, primary, ...over });
  const FOUR = [view("16x9", 1920, 1080, true), view("9x16", 1080, 1920), view("1x1", 1080, 1080), view("4x5", 1080, 1350)];

  it("are in the fixed order, with the current one selected and a count of the open notes you'd see", () => {
    const notes = [note({ format: null }), note({ id: "n_2", format: "9x16" }), note({ id: "n_3", format: "9x16", status: "done" })];
    const chips = formatChips({ views: FOUR, previous: [], current: "16x9", versionDuration: 8, notes, missing: new Set() });
    expect(chips.map((c) => [c.id, c.selected, c.enabled, c.count])).toEqual([
      ["9x16", false, true, 2], ["4x5", false, true, 1], ["1x1", false, true, 1], ["16x9", true, true, 1],
    ]);
  });
  it("one format: one chip, greyed and selected, with no count", () => {
    const [chip] = formatChips({ views: [FOUR[0]], previous: [], current: null, versionDuration: 8, notes: [note({})], missing: new Set() });
    expect(chip).toMatchObject({ id: "16x9", enabled: false, selected: true, count: 0, reason: "single" });
  });
  it("a format the previous cut had and this one lacks stays, greyed: Not in v2", () => {
    const chips = formatChips({ views: FOUR.filter((v) => v.id !== "4x5"), previous: FOUR, current: "16x9", versionDuration: 8, notes: [], missing: new Set() });
    expect(chips.map((c) => c.id)).toEqual(["9x16", "4x5", "1x1", "16x9"]);
    expect(chips[1]).toMatchObject({ enabled: false, selected: false, reason: "absent" });
    expect(chipLabel(chips[1], "v2")).toBe("4:5, not in v2");
  });
  it("warns about a missing file and a length mismatch, never about the primary", () => {
    const chips = formatChips({
      views: [FOUR[0], view("9x16", 1080, 1920, false, { duration: 8.4 }), FOUR[2]],
      previous: [], current: "16x9", versionDuration: 8, notes: [], missing: new Set(["renders/hero_1x1.mp4", "renders/hero_16x9.mp4"]),
    });
    expect(chips.map((c) => c.warn)).toEqual(["9:16 is 8.4 s; the cut is 8.0 s", "File not found", null]);
  });
  it("chipLabel names the ratio, its open notes and its warning", () => {
    expect(chipLabel({ id: "9x16", label: "9:16", width: 1080, height: 1920, enabled: true, selected: false, count: 2, warn: null, reason: null }, "v1")).toBe("9:16, 2 open notes");
    expect(chipLabel({ id: "1x1", label: "1:1", width: 1, height: 1, enabled: true, selected: false, count: 1, warn: "File not found", reason: null }, "v1")).toBe("1:1, 1 open note, File not found");
  });
  it("currentFormat is the film's choice when this cut has it, else the primary; null for one format", () => {
    expect(currentFormat(FOUR, "9x16")).toBe("9x16");
    expect(currentFormat(FOUR, "21x9")).toBe("16x9");
    expect(currentFormat(FOUR, undefined)).toBe("16x9");
    expect(currentFormat([FOUR[0]], "16x9")).toBeNull();
  });
  it("neighbourFormat steps through the enabled chips and stops at the ends (R1)", () => {
    const chips = formatChips({ views: FOUR, previous: [], current: "1x1", versionDuration: 8, notes: [], missing: new Set() });
    expect(neighbourFormat(chips, "1x1", -1)).toBe("4x5");
    expect(neighbourFormat(chips, "1x1", 1)).toBe("16x9");
    expect(neighbourFormat(chips, "16x9", 1)).toBeNull();
    expect(neighbourFormat(chips, null, 1)).toBeNull();
  });
  it("previousVersion is the version before this one", () => {
    const vid = { id: "hero", name: "Hero", lockedVersion: null, versions: [{ id: "v1" }, { id: "v2" }] } as unknown as Video;
    expect(previousVersion(vid, "v2")?.id).toBe("v1");
    expect(previousVersion(vid, "v1")).toBeUndefined();
  });
  it("the glyph keeps the shape inside 14 px, the grid has explicit tracks, and the prompt names the tool", () => {
    expect(shapeBox(1080, 1920)).toEqual({ width: 8, height: 14 });
    expect(shapeBox(1920, 1080)).toEqual({ width: 14, height: 8 });
    expect(fmtColumns(4)).toBe("repeat(4, minmax(0, 1fr))");
    expect(formatPrompt("Lumen", "Lumen launch film", "v1")).toBe(
      'In Rushes project "Lumen", register the other shapes of "Lumen launch film" v1 (the same cut rendered at other aspect ratios, such as 9:16, 1:1 and 4:5) with rushes_add_format, one call per file.',
    );
  });
  it("the reshape runs 160 ms between two sizes, and not under reduced motion", () => {
    expect(RESHAPE_MS).toBe(160);
    expect(reshapeKeyframes({ width: 800, height: 450 }, { width: 253, height: 450 }, false)).toEqual([{ width: "800px", height: "450px" }, { width: "253px", height: "450px" }]);
    expect(reshapeKeyframes({ width: 800, height: 450 }, { width: 253, height: 450 }, true)).toBeNull();
    expect(reshapeKeyframes({ width: 800, height: 450 }, { width: 800.4, height: 450 }, false)).toBeNull();
  });
});
```

`note()` is the existing helper at line 32. `FormatView` and `Video` come from `../../web/src/lib.js` and `../../web/src/types.js`.

Append to `test/web/styles.test.ts`:

```ts
  it("the format toggle and the note's format switch use explicit grid tracks (§21.8, Safari)", () => {
    expect(css).toMatch(/\.fmts \{[^}]*display: inline-grid/);
    expect(css).toMatch(/\.fscope \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  });
```

- [ ] **Step 2: Run them and see them fail.** Run: `npx vitest run test/web/lib.test.ts test/web/styles.test.ts`. Expected: FAIL (the names aren't exported; the CSS is missing).

- [ ] **Step 3: Write the lib helpers.** Append to `web/src/lib.ts`, and add `Note` and `Version` to its type import if missing:

```ts
// ---- §21 formats ----
export { CHIP_ORDER, chipOrder, durationWarning, labelOfId, noteShowsOn, ratioLabel, versionFormats, type FormatView } from "../../src/core/formats.js";
import { chipOrder as orderChips, durationWarning as lengthWarning, type FormatView as View } from "../../src/core/formats.js";

/** One chip of the format toggle (§21.5). */
export interface FormatChip {
  id: string;
  label: string;
  width: number;
  height: number;
  /** Part of this cut and selectable (false: the one-format chip, or a format only the previous cut had). */
  enabled: boolean;
  selected: boolean;
  /** Open notes you'd see on this format; 0 shows none. */
  count: number;
  /** "File not found", or the length warning; null for none. */
  warn: string | null;
  /** Why it's greyed: the only format, or not in this cut; null when it's selectable. */
  reason: "single" | "absent" | null;
}

/** The version before `versionId`, for §21.5's "Not in v2". */
export function previousVersion(video: Video, versionId: string): Version | undefined {
  const i = video.versions.findIndex((v) => v.id === versionId);
  return i > 0 ? video.versions[i - 1] : undefined;
}

/** The format on screen: the film's remembered choice when this cut has it, else the primary; null for one format. */
export function currentFormat(views: View[], remembered: string | undefined): string | null {
  if (views.length < 2) return null;
  return remembered && views.some((v) => v.id === remembered) ? remembered : views[0].id;
}

export function formatChips(o: { views: View[]; previous: View[]; current: string | null; versionDuration: number | null; notes: Note[]; missing: ReadonlySet<string> }): FormatChip[] {
  if (o.views.length === 0) return [];
  const single = o.views.length === 1;
  const here = new Set(o.views.map((v) => v.id));
  const all = orderChips([...o.views.map((v) => ({ ...v, absent: false })), ...o.previous.filter((p) => !here.has(p.id)).map((v) => ({ ...v, absent: true }))]);
  return all.map((v) => {
    const enabled = !v.absent && !single;
    const count = enabled ? o.notes.filter((n) => n.status === "todo" && (n.format === null || n.format === v.id)).length : 0;
    const warn = v.absent || v.primary ? null : o.missing.has(v.file) ? "File not found" : lengthWarning(v.label, v.duration, o.versionDuration);
    return {
      id: v.id, label: v.label, width: v.width, height: v.height, enabled,
      selected: !v.absent && (single || v.id === o.current), count, warn,
      reason: v.absent ? "absent" : single ? "single" : null,
    };
  });
}

/** R1: the next or previous selectable format, stopping at the ends. */
export function neighbourFormat(chips: FormatChip[], current: string | null, dir: -1 | 1): string | null {
  const list = chips.filter((c) => c.enabled);
  const i = list.findIndex((c) => c.id === current);
  if (i === -1) return null;
  return list[i + dir]?.id ?? null;
}

/** The chip's accessible name: "9:16, 2 open notes", "4:5, not in v2", "1:1, 1 open note, File not found". */
export function chipLabel(c: FormatChip, versionId: string): string {
  const parts = [c.label];
  if (c.reason === "absent") parts.push(`not in ${versionId}`);
  if (c.reason === "single") parts.push("the only format");
  if (c.count > 0) parts.push(`${c.count} open note${c.count === 1 ? "" : "s"}`);
  if (c.warn) parts.push(c.warn);
  return parts.join(", ");
}

/** The shape glyph's size: the ratio inside a `size` px square. */
export function shapeBox(width: number, height: number, size = 14): { width: number; height: number } {
  const k = size / Math.max(width, height);
  return { width: Math.max(4, Math.round(width * k)), height: Math.max(4, Math.round(height * k)) };
}

/** Explicit grid tracks for a segmented control of `n` (§21.8: Safari). */
export const fmtColumns = (n: number): string => `repeat(${n}, minmax(0, 1fr))`;

/** The one-format popover's ready-made request (§21.5), in the locked tabs' manner (§19.1). */
export function formatPrompt(projectName: string, filmName: string, versionId: string): string {
  return `In Rushes project "${projectName}", register the other shapes of "${filmName}" ${versionId} (the same cut rendered at other aspect ratios, such as 9:16, 1:1 and 4:5) with rushes_add_format, one call per file.`;
}

/** §21.5: the frame takes its new shape over 160 ms. */
export const RESHAPE_MS = 160;

/** The frame's reshape keyframes, or null under reduced motion or when the size doesn't change. */
export function reshapeKeyframes(from: { width: number; height: number }, to: { width: number; height: number }, reduced: boolean): { width: string; height: string }[] | null {
  if (reduced) return null;
  if (Math.abs(from.width - to.width) < 1 && Math.abs(from.height - to.height) < 1) return null;
  return [{ width: `${from.width}px`, height: `${from.height}px` }, { width: `${to.width}px`, height: `${to.height}px` }];
}
```

Add `Format` to `web/src/types.ts`'s re-export from `../../src/core/schema.js`.

- [ ] **Step 4: Run the unit tests.** Run: `npx vitest run test/web/lib.test.ts`. Expected: PASS (the styles test still fails until Step 6).

- [ ] **Step 5: Write the toggle** at `web/src/ui/FormatToggle.tsx`:

```tsx
import { useRef } from "preact/hooks";
import { chipLabel, fmtColumns, shapeBox, type FormatChip } from "../lib.js";
import { Icon } from "./Icon.js";

export interface FormatToggleProps {
  chips: FormatChip[];
  versionId: string;
  /** The one-format popover's ready-made request (§21.5). */
  prompt: string;
  onSelect(id: string): void;
  toast(message: string): void;
}

/** §21.5: the format chips in Picture's header: a radio group in a fixed order (mockup). */
export function FormatToggle({ chips, versionId, prompt, onSelect, toast }: FormatToggleProps) {
  const group = useRef<HTMLDivElement>(null);
  if (chips.length === 0) return null;
  const single = chips.some((c) => c.reason === "single");
  const enabled = chips.filter((c) => c.enabled);
  const onKeyDown = (e: KeyboardEvent) => {
    // Alt+arrows belong to the page (R1); everything else here is the radio group's own.
    if (e.altKey || e.metaKey || e.ctrlKey || enabled.length === 0) return;
    const i = Math.max(0, enabled.findIndex((c) => c.selected));
    let to: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") to = (i + 1) % enabled.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") to = (i - 1 + enabled.length) % enabled.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = enabled.length - 1;
    if (to === null) return;
    // Handled here, so Picture's ←/→ frame step never sees it.
    e.preventDefault();
    e.stopPropagation();
    onSelect(enabled[to].id);
    group.current?.querySelector<HTMLButtonElement>(`[data-format="${enabled[to].id}"]`)?.focus();
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      toast("Prompt copied");
    } catch {
      toast("Couldn't reach the clipboard. Ask your agent to register the other shapes with rushes_add_format.");
    }
  };
  return (
    <div class="fmtwrap">
      <div ref={group} class="fmts" role="radiogroup" aria-label="Format" style={{ gridTemplateColumns: fmtColumns(chips.length) }} onKeyDown={(e) => onKeyDown(e)}>
        {chips.map((c) => {
          const box = shapeBox(c.width, c.height);
          const tip = c.reason === "absent" ? `Not in ${versionId}` : c.warn ?? undefined;
          return (
            <button
              type="button"
              role="radio"
              data-format={c.id}
              aria-checked={c.selected}
              aria-disabled={c.enabled ? undefined : "true"}
              tabIndex={c.enabled && c.selected ? 0 : -1}
              aria-label={chipLabel(c, versionId)}
              class={tip ? "tip-below" : undefined}
              data-tip={tip}
              onClick={(e) => {
                if (!c.enabled) return;
                // A mouse click hands the keys back to the player; a key press keeps focus here.
                if (e.detail > 0) (e.currentTarget as HTMLElement).blur();
                onSelect(c.id);
              }}
            >
              <span class="shape" aria-hidden="true" style={{ width: `${box.width}px`, height: `${box.height}px` }} />
              <span>{c.label}</span>
              {c.warn && <span class="warn" aria-hidden="true">!</span>}
              {c.count > 0 && <span class="n" aria-hidden="true">{c.count}</span>}
            </button>
          );
        })}
      </div>
      {single && (
        // R5: the chip itself is out of the tab order; this button is always in it, and focusing it shows the popover.
        <div class="fmtpop">
          <p>One format. Your agent can add more with <code>rushes_add_format</code>.</p>
          <button type="button" class="btn ghost" onClick={() => void copy()}>
            <Icon name="copy" />
            Copy a prompt for your agent
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Write the styles.** Append to `web/src/styles.css` (before the reduced-motion rule):

```css
/* §21.5: the format toggle in Picture's header (mockup). Explicit grid tracks, for Safari (§21.8). */
.fmtwrap { position: relative; display: inline-flex; }
.fmts { display: inline-grid; gap: 2px; padding: 3px; background: var(--bg); border: 1px solid var(--line); border-radius: 999px; }
.fmts [role="radio"] { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 30px; padding: 4px 12px; border: 0; border-radius: 999px; background: transparent; color: var(--text-2); font: 500 15px/1.2 var(--sans); white-space: nowrap; cursor: pointer; }
.fmts [role="radio"]:hover { background: var(--hover); color: var(--text); }
.fmts [role="radio"][aria-checked="true"] { background: var(--accent); color: var(--on-accent); font-weight: 600; }
.fmts [role="radio"][aria-disabled="true"] { background: transparent; color: var(--text-3); cursor: not-allowed; }
.fmts .shape, .fscope .shape { display: inline-block; border: 1.5px solid currentColor; border-radius: 2px; }
.fmts .n { padding: 0 7px; border-radius: 999px; background: var(--todo-soft); color: var(--todo); font-size: 15px; line-height: 20px; font-variant-numeric: tabular-nums; }
.fmts [aria-checked="true"] .n { background: rgba(11, 16, 38, 0.18); color: var(--on-accent); }
.fmts .warn { color: var(--todo); font-weight: 700; }
.fmtpop { position: absolute; top: calc(100% + 8px); left: 0; z-index: 30; width: max-content; max-width: 340px; padding: 8px 12px; border: 1px solid var(--line-2); border-radius: 8px; background: #000; color: var(--text); font-size: 15px; opacity: 0; pointer-events: none; transition: opacity 0.12s; }
.fmtpop::before { content: ""; position: absolute; left: 0; right: 0; top: -9px; height: 9px; }
.fmtpop p { margin: 0 0 6px; }
.fmtpop code { font-family: var(--mono); color: var(--accent-2); }
.fmtwrap:hover .fmtpop, .fmtpop:focus-within { opacity: 1; pointer-events: auto; }
/* §21.5: the composer's and the card's This format | All formats switch (Task 5 uses it). */
.fscope { display: inline-grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px; padding: 3px; background: var(--bg); border: 1px solid var(--line); border-radius: 999px; }
.note[aria-current="true"] { background: var(--hover); box-shadow: inset 2px 0 0 var(--accent); }
```

- [ ] **Step 7: Wire up App.** In `web/src/ui/App.tsx`:
  - Import `currentFormat`, `formatChips`, `formatPrompt`, `labelOfId`, `neighbourFormat`, `previousVersion` and `versionFormats` from `../lib.js`, and `FormatToggle` from `./FormatToggle.js`.
  - Add state next to `sources`:

```ts
  // §21.5: each film's chosen format, in memory only; a fresh load shows the primary.
  const [formatChoice, setFormatChoice] = useState<Record<string, string>>({});
  // R2: the primary's shape as the player measured it, for a cut stored with no size.
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  // R7: a drawn box belongs to the format on screen, so a switch waits for it.
  const [boxPending, setBoxPending] = useState(false);
```

  - After the `cutAsset` line (still before the early return, so the key handler never reads an uninitialised binding):

```ts
  // §21: this cut's formats, the chips and the one on screen.
  const filmNotes = state?.notes.notes.filter((n) => n.stage === "picture" && (!n.video || n.video === video?.id)) ?? [];
  const views = version ? versionFormats(version, measured[version.file]) : [];
  const before = video && version ? previousVersion(video, version.id) : undefined;
  const format = currentFormat(views, video ? formatChoice[video.id] : undefined);
  const missingFiles = new Set(assets.filter((a) => a.kind === "cut" && a.missing).map((a) => a.path));
  const chips = version
    ? formatChips({ views, previous: before ? versionFormats(before) : [], current: format, versionDuration: version.duration, notes: filmNotes, missing: missingFiles })
    : [];
  const switchFormat = (id: string) => {
    if (!video || id === format) return;
    if (boxPending) return toast(`Add or clear your box on ${format ? labelOfId(format) : "this format"} first`);
    setFormatChoice((c) => ({ ...c, [video.id]: id }));
  };
```

  - At the top of the keydown handler, before the modifier check:

```ts
      // §21.5 (R1): Alt+← and Alt+→ step through the formats; [ and ] stay with films (§14.2).
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        if (stage !== "picture" || typing(e.target)) return;
        e.preventDefault();
        const next = neighbourFormat(chips, format, e.key === "ArrowRight" ? 1 : -1);
        if (next) switchFormat(next);
        return;
      }
```

  - In the header, after the `readyVersionId` chip (R8):

```tsx
            {stage === "picture" && version && chips.length > 0 && (
              <FormatToggle chips={chips} versionId={version.id} prompt={formatPrompt(state.project.name, video.name, version.id)} onSelect={switchFormat} toast={toast} />
            )}
```

  - In the shortcuts popover, after the `[ ]` row: `<span><kbd>Alt</kbd> <kbd>←</kbd> <kbd>→</kbd></span><span>Previous or next format</span>`.
  - In `<Picture …>`, add:

```tsx
            formats={views}
            format={format}
            formatMissing={!!format && missingFiles.has(views.find((f) => f.id === format)?.file ?? "")}
            onPrimarySize={(file, width, height) => setMeasured((m) => (m[file] ? m : { ...m, [file]: { width, height } }))}
            onBoxPendingChange={setBoxPending}
```

- [ ] **Step 8: Change Picture** (`web/src/ui/Picture.tsx`):
  1. **Imports.** Import `useLayoutEffect` with the hooks, and `RESHAPE_MS`, `reshapeKeyframes`, `testFlags` and `type FormatView` from `../lib.js`. Add:

     ```ts
     declare global { interface Window { /** Test-only (`?test=1`): the last frame reshape (§21.5). */ __rushesLastReshape?: { animated: boolean; ms: number } } }
     ```

  2. **Props.** Add the five props to `PictureProps`, with comments citing §21.5 and R2/R7. Destructure them with the defaults `formats = [], format = null, formatMissing = false`.
  3. **The file on screen.** After `const playsProxy …`, replace those two lines with:

```ts
  // §21.5: the format on screen. The primary is the version's own file; any other plays its own
  // render. Proxies belong to the primary only (§21.3), so the switch and the offer go with it.
  const view = format ? formats.find((f) => f.id === format) ?? null : null;
  const onPrimary = !view || view.primary;
  const playsProxy = onPrimary && !!version.proxy && source !== "original";
  const src = mediaUrl(playsProxy ? version.proxy!.file : onPrimary ? version.file : view!.file);
```

  4. **Box pending.** After the pending effect:

```ts
  // R7: tell the caller while a drawn box waits, so a format switch can wait for it.
  useEffect(() => {
    onBoxPendingChange?.(box !== null);
    return () => onBoxPendingChange?.(false);
  }, [box]);
```

  5. **The reshape.** Add a `frameRef` (`useRef<HTMLDivElement>(null)`), set as `ref={frameRef}` on the `<div class="frame" …>`, plus:

```ts
  // §21.5: the frame takes the new format's shape straight away (its size is known), animated over
  // 160 ms from the old one -- not under reduced motion. The player's src swap does the rest.
  const reshapeFrom = useRef<{ width: number; height: number } | null>(null);
  const shapeKey = view?.id ?? "primary";
  const firstShape = useRef(true);
  useLayoutEffect(() => {
    if (firstShape.current) {
      firstShape.current = false;
      return;
    }
    const shape = view ?? formats.find((f) => f.primary);
    const el = frameRef.current;
    if (!shape || !el) return;
    const next = shape.width / shape.height;
    if (next === aspect) return;
    const r = el.getBoundingClientRect();
    reshapeFrom.current = { width: r.width, height: r.height };
    setAspect(next);
  }, [shapeKey]);
  useLayoutEffect(() => {
    const from = reshapeFrom.current;
    const el = frameRef.current;
    reshapeFrom.current = null;
    if (!from || !el) return;
    const r = el.getBoundingClientRect();
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frames = reshapeKeyframes(from, { width: r.width, height: r.height }, reduced);
    if (testFlags(location.search).test) window.__rushesLastReshape = { animated: frames !== null, ms: frames ? RESHAPE_MS : 0 };
    if (frames) el.animate(frames, { duration: RESHAPE_MS, easing: "ease-out" });
  }, [aspect]);
```

  6. **Metadata.** In `applyMetadata`, replace the first two lines with:

```ts
    // R9: the timeline is the cut's length, whatever format plays; nothing is rescaled.
    setDuration(onPrimary ? v.duration || version.duration || 0 : version.duration ?? view?.duration ?? (v.duration || 0));
    setDurationOf(version.file);
    // R2: a cut stored without its size learns it from the player, for the single chip.
    if (onPrimary && !playsProxy && version.width === null && v.videoWidth && v.videoHeight) onPrimarySize?.(version.file, v.videoWidth, v.videoHeight);
```

  7. **Messages.** Replace the two `broken` message lines with:

```tsx
            {formatMissing && !onPrimary && <div class="msg">File not found</div>}
            {broken && !onPrimary && !formatMissing && <div class="msg">This file won't play in a browser. Ask your agent for an H.264 MP4 of this format.</div>}
            {broken && onPrimary && !ffmpeg && <div class="msg">This file won't play in a browser. Ask your agent for an H.264 MP4 of this cut.</div>}
            {broken && onPrimary && ffmpeg && version.proxy && !playsProxy && <div class="msg">This file won't play in a browser.</div>}
```

     Set `hidden={broken || (formatMissing && !onPrimary)}` on the `<video>`.
  8. **The primary's controls.** Change `{version.proxy && (` (the source switch) to `{version.proxy && onPrimary && (`, and `{noteProxyJob && (` to `{noteProxyJob && onPrimary && (`.
  9. **Selection (R6).**
     - Replace `const [shown, setShown] = useState<Box | null>(null);` with `const [selectedId, setSelectedId] = useState<string | null>(null);`.
     - In the `[version.file]` effect, replace `setShown(null)` with `setSelectedId(null)`.
     - Derive the box:

       ```ts
       const selected = notes.find((n) => n.id === selectedId) ?? null;
       const shownBox = selected?.box && (!selected.version || selected.version === version.id) ? selected.box : null;
       ```

     - Render `{shownBox && <div class="bx saved" style={style(shownBox)} />}`.
     - In `onSeek`, replace the `setShown(…)` line with `setSelectedId(n.id);`.
     - Pass `selectedId={selectedId}` to `<Notes>`.

- [ ] **Step 9: Change Notes.** In `web/src/ui/Notes.tsx`:
  - Add `/** The note last clicked (R6): its card is marked current. */ selectedId?: string | null;` to `NotesProps`, and destructure it.
  - Add `aria-current={selectedId === n.id ? "true" : undefined}` to the `.note` div.

- [ ] **Step 10: Add the e2e fixture helpers.** In `e2e/fixture.ts`:
  - Add the `FormatSize` interface and the two methods to `Rushes`, using the signatures in Interfaces, each with a doc comment: "Needs ffmpeg. Generated H.264 testsrc renders with invented names."
  - Implement them inside the `rushes` fixture, after `addProResCut`, and add both to the `use({...})` object:

```ts
    const render = async (slug: string, n: number, s: FormatSize, tag: string, audio = false) => {
      const file = `renders/${slug}_v${n}_${s.width}x${s.height}${tag}.mp4`;
      const seconds = s.seconds ?? 4;
      const tone = audio ? ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`, "-c:a", "aac", "-b:a", "64k", "-shortest"] : [];
      await ffmpeg([
        "-f", "lavfi", "-i", `testsrc=size=${s.width}x${s.height}:rate=30:duration=${seconds}`,
        ...tone,
        "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-pix_fmt", "yuv420p", join(root, file),
      ]);
      return file;
    };
    const slugOf = (video: string) => video.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const addFormatsCut = async (sizes: FormatSize[], opts: { video?: string; note?: string; audio?: boolean } = {}) => {
      needsH264(browserName);
      const video = opts.video ?? "Hero";
      const slug = slugOf(video);
      const n = (cutsByVideo.get(slug) ?? 0) + 1;
      cutsByVideo.set(slug, n);
      const files = await Promise.all(sizes.map((s, i) => render(slug, n, s, "", opts.audio && i === 0)));
      return api("POST", "/api/versions", { video, file: files[0], note: opts.note, formats: files.slice(1).map((file) => ({ file })) });
    };
    const addFormatFile = async (size: FormatSize, opts: { video?: string; version?: string } = {}) => {
      needsH264(browserName);
      const video = opts.video ?? "Hero";
      const slug = slugOf(video);
      const file = await render(slug, cutsByVideo.get(slug) ?? 1, size, "_extra");
      return api("POST", "/api/formats", { file, video, ...(opts.version ? { version: opts.version } : {}) });
    };
```

- [ ] **Step 11: Write the failing e2e tests** at `e2e/formats.spec.ts`:

```ts
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, hasFfmpeg, test, videoReady } from "./fixture.js";

test.skip(!hasFfmpeg, "formats are generated with ffmpeg and measured with ffprobe");

const WIDE = { width: 320, height: 180 };
const TALL = { width: 180, height: 320 };
const SQUARE = { width: 240, height: 240 };
const PORTRAIT = { width: 192, height: 240 };
const FOUR = [WIDE, TALL, SQUARE, PORTRAIT];

/** A chip of the format toggle, by its ratio. */
const radio = (page: Page, label: string) => page.getByRole("radiogroup", { name: "Format" }).getByRole("radio", { name: new RegExp(`^${label}(,|$)`) });

async function drawBox(page: Page) {
  await page.keyboard.press("b");
  const o = (await page.locator(".overlay").boundingBox())!;
  await page.mouse.move(o.x + o.width * 0.3, o.y + o.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(o.x + o.width * 0.6, o.y + o.height * 0.6, { steps: 4 });
  await page.mouse.up();
}

test("four formats: the chips keep their fixed order, and switching keeps the time and the play state", async ({ page, rushes }) => {
  await rushes.addFormatsCut(FOUR);
  await page.goto(rushes.url);
  await videoReady(page);
  const chips = page.getByRole("radiogroup", { name: "Format" }).getByRole("radio");
  await expect(chips).toHaveText([/^9:16/, /^4:5/, /^1:1/, /^16:9/]);
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true"); // the primary first
  const xs = async () => Promise.all(["9:16", "4:5", "1:1", "16:9"].map(async (l) => (await radio(page, l).boundingBox())!.x));
  const ascending = (a: number[]) => a.every((x, i) => i === 0 || x > a[i - 1]);
  expect(ascending(await xs())).toBe(true);
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("Timecode")).toContainText("0:01.00");
  await page.keyboard.press(" ");
  const video = page.locator("video");
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime > 1.2)).toBe(true);
  const at = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await radio(page, "9:16").click();
  await expect(video).toHaveAttribute("src", /_180x320\.mp4/);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && !v.paused && v.currentTime >= 1.2)).toBe(true);
  expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThanOrEqual(at - 0.05);
  const frame = (await page.locator(".frame").boundingBox())!;
  expect(frame.width / frame.height).toBeCloseTo(180 / 320, 1);
  expect(ascending(await xs())).toBe(true);
  await page.keyboard.press(" ");
});

test("one format: the chip is greyed and out of the tab order, and the copy prompt is reachable by keyboard (R5)", async ({ page, rushes, context, browserName }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  const chip = page.getByRole("radiogroup", { name: "Format" }).getByRole("radio");
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveText(/^16:9/);
  await expect(chip).toHaveAttribute("aria-disabled", "true");
  await expect(chip).toHaveAttribute("tabindex", "-1");
  await chip.hover();
  await expect(page.locator(".fmtpop")).toHaveCSS("opacity", "1");
  await expect(page.locator(".fmtpop")).toContainText("One format. Your agent can add more with rushes_add_format.");
  await page.mouse.move(2, 2);
  await page.getByRole("button", { name: "Copy a prompt for your agent" }).focus();
  await expect(page.locator(".fmtpop")).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect(page.locator(".toast")).toHaveText(/Prompt copied|Couldn't reach the clipboard/);
});

test("a newer cut without a format keeps its chip, greyed: Not in v2", async ({ page, rushes }) => {
  await rushes.addFormatsCut(FOUR);
  await rushes.addFormatsCut([WIDE, TALL, SQUARE]);
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(page.getByRole("combobox", { name: "Version" })).toHaveValue("v2");
  const chip = radio(page, "4:5");
  await expect(chip).toHaveAttribute("aria-disabled", "true");
  await expect(chip).toHaveAttribute("data-tip", "Not in v2");
  await expect(chip).toHaveAccessibleName("4:5, not in v2");
  await chip.click({ force: true });
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
});

test("Alt+← and Alt+→ step through the formats; the group takes arrows, Home and End; nothing fires while typing (R1)", async ({ page, rushes }) => {
  await rushes.addFormatsCut(FOUR);
  await page.goto(rushes.url);
  await videoReady(page);
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(radio(page, "1:1")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("[");
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  await radio(page, "16:9").focus();
  await page.keyboard.press("Home");
  await expect(radio(page, "9:16")).toHaveAttribute("aria-checked", "true");
  await expect(radio(page, "9:16")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(radio(page, "4:5")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("End");
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByLabel("Timecode")).toContainText("0:00.00");
  await page.keyboard.press("n");
  await page.keyboard.type("Crop is tight");
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("textbox", { name: "New note" })).toHaveValue("Crop is tight");
});

test("each film remembers its format for the session; a fresh load shows the primary", async ({ page, rushes }) => {
  await rushes.addFormatsCut(FOUR);
  await rushes.addFormatsCut([WIDE, TALL], { video: "Teaser" });
  await page.goto(rushes.url);
  await videoReady(page);
  await radio(page, "9:16").click();
  await page.getByRole("navigation", { name: "Films" }).getByRole("button", { name: /Teaser/ }).click();
  await videoReady(page);
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  await page.getByRole("navigation", { name: "Films" }).getByRole("button", { name: /Hero/ }).click();
  await videoReady(page);
  await expect(radio(page, "9:16")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("video")).toHaveAttribute("src", /_180x320\.mp4/);
  await page.reload();
  await videoReady(page);
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
});

test("the frame reshapes over 160 ms, and at once under reduced motion", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  await page.goto(rushes.testUrl());
  await videoReady(page);
  await radio(page, "9:16").click();
  await expect.poll(() => page.evaluate(() => (window as any).__rushesLastReshape)).toEqual({ animated: true, ms: 160 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await radio(page, "16:9").click();
  await expect.poll(() => page.evaluate(() => (window as any).__rushesLastReshape)).toEqual({ animated: false, ms: 0 });
});

// Review Focus 5.
test("a format whose file has gone warns on its chip and says File not found; a length mismatch warns with both lengths", async ({ page, rushes }) => {
  const r = await rushes.addFormatsCut([WIDE, TALL, { ...SQUARE, seconds: 4.5 }]);
  await rm(join(rushes.root, r.version.formats.find((f) => f.id === "9x16")!.file));
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(radio(page, "9:16")).toHaveAccessibleName(/File not found/);
  await expect(radio(page, "1:1")).toHaveAttribute("data-tip", "1:1 is 4.5 s; the cut is 4.0 s");
  await radio(page, "9:16").click();
  await expect(page.locator(".frame .msg")).toHaveText("File not found");
  await expect(page.locator(".proxybar")).toHaveCount(0);
});

test("the Proxy/Original switch belongs to the primary: it hides while another format shows", async ({ page, rushes }) => {
  await rushes.addProResCut({ seconds: 2 });
  await rushes.api("POST", "/api/videos/hero/versions/v1/proxy", {});
  await expect.poll(async () => (await rushes.api("GET", "/api/state")).project.videos[0].versions[0].proxy !== null, { timeout: 20_000 }).toBe(true);
  await rushes.addFormatFile({ width: 360, height: 640, seconds: 2 });
  await page.goto(rushes.url);
  await expect(page.getByRole("button", { name: "Proxy", exact: true })).toBeVisible();
  await radio(page, "9:16").click();
  await expect(page.getByRole("button", { name: "Proxy", exact: true })).toHaveCount(0);
  await radio(page, "16:9").click();
  await expect(page.getByRole("button", { name: "Proxy", exact: true })).toBeVisible();
});

test("at 1440×900 a 9:16 format keeps the timeline and note box on screen; the shot strip, length and waveform stay the cut's", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL], { audio: true });
  await rushes.api("PUT", "/api/videos/hero/shots", { shots: [{ name: "Open", start: 0 }, { name: "Logo", start: 2 }] });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(page.locator(".track canvas")).toBeVisible({ timeout: 15_000 });
  await radio(page, "9:16").click();
  await expect(page.locator(".shots .shot")).toHaveCount(2);
  await expect(page.locator(".ends span").last()).toHaveText("0:04.00");
  await expect(page.locator(".track canvas")).toBeVisible();
  const vp = page.viewportSize()!;
  for (const sel of [".track", ".comp textarea"]) {
    const b = (await page.locator(sel).boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(vp.height);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

// Review Focus 3.
test("with a box drawn, switching format is refused; a half-typed note and an In point carry over", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  await page.goto(rushes.url);
  await videoReady(page);
  await drawBox(page);
  await radio(page, "9:16").click();
  await expect(page.locator(".toast")).toHaveText("Add or clear your box on 16:9 first");
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Remove box" }).click();
  await page.keyboard.press("i");
  await page.keyboard.press("n");
  await page.keyboard.type("Half a thought");
  await radio(page, "9:16").click();
  await expect(radio(page, "9:16")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("textbox", { name: "New note" })).toHaveValue("Half a thought");
  await expect(page.locator(".bar .chipx")).toContainText("0:00.00 →");
});

test("switching keeps the selected note (R6)", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 2, text: "Hold the last row." });
  await page.goto(rushes.url);
  await videoReady(page);
  await page.locator(".note", { hasText: "Hold the last row." }).locator(".t").click();
  await expect(page.locator('.note[aria-current="true"]')).toHaveText(/Hold the last row\./);
  await radio(page, "9:16").click();
  await expect(page.locator('.note[aria-current="true"]')).toHaveText(/Hold the last row\./);
});
```

- [ ] **Step 12: Run e2e and see it fail, then pass.** Run: `npm run build && npx playwright test e2e/formats.spec.ts --project=chromium --retries=0`. Expected: FAIL before Steps 7–10 are complete; PASS after. Then run `npx playwright test e2e/formats.spec.ts --project=webkit --retries=0`. Expected: PASS.

- [ ] **Step 13: Run the gates.** Run: `npm run build && npm run typecheck && npx vitest run && npx playwright test --retries=0`, the whole suite in both projects. Expected: all green, including every existing Picture and proxy test.

- [ ] **Step 14: Commit.**

```bash
git add web/src/lib.ts web/src/types.ts web/src/ui/FormatToggle.tsx web/src/ui/App.tsx web/src/ui/Picture.tsx web/src/ui/Notes.tsx web/src/styles.css e2e/fixture.ts e2e/formats.spec.ts test/web/lib.test.ts test/web/styles.test.ts
git -c user.name=iamredmh -c user.email=17407420+iamredmh@users.noreply.github.com commit -m "feat(web): the format toggle in Picture -- fixed order, keyboard, switches in place keeping your place" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

**Mutation check:** clearing `resume.current` whenever `src` changes, so a format switch starts from the top, must fail "four formats: … switching keeps the time and the play state".

---

### Task 5: Notes per format (§21.2 (4)–(6), §21.5 Notes)

**Files:**
- Create: `web/src/ui/FormatScope.tsx`, `web/src/ui/OtherFormats.tsx`
- Modify: `web/src/lib.ts`, which gains `visibleNotes`, `otherFormatNotes`, `boxShowsOn`, `scopeHint`, `BOX_REASON`, `noteFormatTag`, `OtherFormatAction` and `otherFormatAction`.
- Modify: `web/src/ui/Notes.tsx`, which gains the `formatTag`, `cardExtra`, `formatScope` and `listFooter` props.
- Modify: `web/src/ui/Picture.tsx`, which gains:
  - the visible and other notes;
  - the composer's scope;
  - `format` on `add()`;
  - markers;
  - the card switch;
  - the footer;
  - selection clearing;
  - `boxShowsOn`;
  - the new `onFormatChange` prop.
- Modify: `web/src/ui/App.tsx` (`onFormatChange={switchFormat}`), `web/src/styles.css`
- Test: `test/web/lib.test.ts`, `e2e/formats.spec.ts`

**Interfaces:**
- Consumes: Task 4's `FormatView`, `labelOfId`, `noteShowsOn`, `versionFormats`, `shapeBox` and `switchFormat`; Task 2's `PATCH /api/notes/:id` with `format`.
- Produces (`web/src/lib.ts`):

```ts
export function visibleNotes(notes: Note[], current: string | null): Note[];
export function otherFormatNotes(notes: Note[], current: string | null): Note[];
export function boxShowsOn(note: Pick<Note, "box" | "format">, current: string | null, primaryId: string | null): boolean;
export const BOX_REASON = "A drawn box belongs to one frame, so this note stays on this format.";
export function scopeHint(label: string, scope: "this" | "all", hasBox: boolean): string;
export function noteFormatTag(note: Pick<Note, "format">, many: boolean): string | null;
export type OtherFormatAction = { kind: "show"; id: string; label: string } | { kind: "restore" } | null;
export function otherFormatAction(note: Pick<Note, "format" | "box">, viewsHere: FormatView[], ownViews: FormatView[]): OtherFormatAction;
```

- Produces (components):

```ts
// web/src/ui/FormatScope.tsx
export interface FormatScopeProps { label: string; width: number; height: number; value: "this" | "all"; onChange(v: "this" | "all"): void; lockedReason: string | null; name: string }
export function FormatScope(p: FormatScopeProps): JSX.Element;
// web/src/ui/OtherFormats.tsx
export function OtherFormats(p: { notes: Note[]; version: string; viewsHere: FormatView[]; ownViews(n: Note): FormatView[]; onShow(id: string): void; onRestore(n: Note): void }): JSX.Element | null;
```

- Produces (new optional `NotesProps`): `formatTag?(n: Note): string | null`, `cardExtra?(n: Note): ComponentChildren`, `formatScope?: ComposerFormat`, `listFooter?: ComponentChildren`, with:

```ts
export interface ComposerFormat { label: string; width: number; height: number; value: "this" | "all"; onChange(v: "this" | "all"): void; lockedReason: string | null; hint: string }
```

- Produces (`PictureProps`): `onFormatChange?(id: string): void`.

- [ ] **Step 1: Write the failing unit tests.** Append to `test/web/lib.test.ts`:

```ts
describe("notes per format (§21.2, §21.5)", () => {
  const n = (id: string, format: string | null, box: Note["box"] = null) => note({ id, format, box });
  const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
  const v = (id: string, primary = false): FormatView => ({ id, label: id.replace("x", ":"), file: `${id}.mp4`, width: 1, height: 1, duration: 8, fps: 30, primary });

  it("shows this format's notes and the all-format ones, and keeps the rest one row away", () => {
    const notes = [n("a", null), n("b", "9x16"), n("c", "16x9")];
    expect(visibleNotes(notes, "16x9").map((x) => x.id)).toEqual(["a", "c"]);
    expect(otherFormatNotes(notes, "16x9").map((x) => x.id)).toEqual(["b"]);
    expect(visibleNotes(notes, null)).toHaveLength(3);
    expect(otherFormatNotes(notes, null)).toEqual([]);
  });
  it("a box shows on its own format, and an older boxed note's on the primary only (Review Focus 1)", () => {
    expect(boxShowsOn(n("a", "9x16", box), "9x16", "16x9")).toBe(true);
    expect(boxShowsOn(n("a", null, box), "16x9", "16x9")).toBe(true);
    expect(boxShowsOn(n("a", null, box), "9x16", "16x9")).toBe(false);
    expect(boxShowsOn(n("a", null, box), null, null)).toBe(true);
    expect(boxShowsOn(n("a", null), "16x9", "16x9")).toBe(false);
  });
  it("the composer's hint says where a note will show (mockup)", () => {
    expect(scopeHint("9:16", "this", false)).toBe("Shows only while you're viewing 9:16.");
    expect(scopeHint("9:16", "all", false)).toBe("Shows on every format.");
    expect(scopeHint("9:16", "this", true)).toBe("A drawn box fixes this note to 9:16.");
  });
  it("a note's tag is its format, All on a cut with formats, and nothing on a one-format cut (R4)", () => {
    expect(noteFormatTag({ format: "9x16" }, true)).toBe("9:16");
    expect(noteFormatTag({ format: null }, true)).toBe("All");
    expect(noteFormatTag({ format: null }, false)).toBeNull();
    expect(noteFormatTag({ format: "9x16" }, false)).toBe("9:16");
  });
  it("the Other formats row offers Show on 9:16, or Restore when its format has gone from its own cut, never for a box (R17)", () => {
    const here = [v("16x9", true), v("9x16")];
    expect(otherFormatAction(n("a", "9x16"), here, here)).toEqual({ kind: "show", id: "9x16", label: "9:16" });
    expect(otherFormatAction(n("a", "4x5"), here, [v("16x9", true), v("4x5")])).toBeNull();
    expect(otherFormatAction(n("a", "4x5"), here, here)).toEqual({ kind: "restore" });
    expect(otherFormatAction(n("a", "4x5", box), here, here)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and see them fail.** Run: `npx vitest run test/web/lib.test.ts`. Expected: FAIL.

- [ ] **Step 3: Write the helpers.** Append to `web/src/lib.ts`:

```ts
import { labelOfId as labelFor, noteShowsOn as showsOn } from "../../src/core/formats.js";

/** §21.2 (5): the notes that show on the format on screen (every note on a one-format cut). */
export const visibleNotes = (notes: Note[], current: string | null): Note[] => notes.filter((n) => showsOn(n, current));
/** §21.5: the rest, for the "Other formats (N)" row. */
export const otherFormatNotes = (notes: Note[], current: string | null): Note[] => (current === null ? [] : notes.filter((n) => !showsOn(n, current)));

/** R7: a box belongs to the format it was drawn on; an older note's to the primary. */
export function boxShowsOn(note: Pick<Note, "box" | "format">, current: string | null, primaryId: string | null): boolean {
  if (!note.box) return false;
  if (current === null) return true;
  return note.format !== null ? note.format === current : current === primaryId;
}

export const BOX_REASON = "A drawn box belongs to one frame, so this note stays on this format.";

/** The composer's hint line (mockup; R15: only with two or more formats). */
export function scopeHint(label: string, scope: "this" | "all", hasBox: boolean): string {
  if (hasBox) return `A drawn box fixes this note to ${label}.`;
  return scope === "this" ? `Shows only while you're viewing ${label}.` : "Shows on every format.";
}

/** R4: a listed note's tag. */
export function noteFormatTag(note: Pick<Note, "format">, many: boolean): string | null {
  if (note.format !== null) return labelFor(note.format);
  return many ? "All" : null;
}

export type OtherFormatAction = { kind: "show"; id: string; label: string } | { kind: "restore" } | null;

/** R17: what a read-only note in the Other formats row offers. */
export function otherFormatAction(note: Pick<Note, "format" | "box">, viewsHere: View[], ownViews: View[]): OtherFormatAction {
  if (note.format === null) return null;
  const here = viewsHere.find((f) => f.id === note.format);
  if (here) return { kind: "show", id: here.id, label: here.label };
  if (!note.box && !ownViews.some((f) => f.id === note.format)) return { kind: "restore" };
  return null;
}
```

- [ ] **Step 4: Run the unit tests.** Run: `npx vitest run test/web/lib.test.ts`. Expected: PASS.

- [ ] **Step 5: Write `web/src/ui/FormatScope.tsx`:**

```tsx
import { shapeBox } from "../lib.js";

export interface FormatScopeProps {
  /** The format on screen, e.g. "9:16", and its size for the glyph. */
  label: string;
  width: number;
  height: number;
  value: "this" | "all";
  onChange(value: "this" | "all"): void;
  /** Why All formats can't be chosen (a drawn box), or null. */
  lockedReason: string | null;
  /** The group's accessible name. */
  name: string;
}

/** §21.5: This format | All formats, as a two-way radio group (the composer and the selected card). */
export function FormatScope({ label, width, height, value, onChange, lockedReason, name }: FormatScopeProps) {
  const box = shapeBox(width, height);
  const options = [
    { v: "this" as const, text: "This format", disabled: false },
    { v: "all" as const, text: "All formats", disabled: lockedReason !== null },
  ];
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const to = e.key === "Home" ? "this" : e.key === "End" ? "all" : value === "this" ? "all" : "this";
    if (to === "all" && lockedReason) return;
    onChange(to);
    (e.currentTarget as HTMLElement).querySelector<HTMLButtonElement>(`[data-scope="${to}"]`)?.focus();
  };
  return (
    <div class="fscope" role="radiogroup" aria-label={name} onKeyDown={(e) => onKeyDown(e)}>
      {options.map((o) => (
        <button
          type="button"
          role="radio"
          data-scope={o.v}
          aria-checked={value === o.v}
          aria-disabled={o.disabled ? "true" : undefined}
          tabIndex={value === o.v ? 0 : -1}
          aria-label={o.v === "this" ? `This format, ${label}` : "All formats"}
          class={o.disabled ? "tip-wrap" : undefined}
          data-tip={o.disabled ? lockedReason! : undefined}
          onClick={() => { if (!o.disabled) onChange(o.v); }}
        >
          {o.v === "this" && <span class="shape" aria-hidden="true" style={{ width: `${box.width}px`, height: `${box.height}px` }} />}
          {o.text}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Write `web/src/ui/OtherFormats.tsx`:**

```tsx
import { useState } from "preact/hooks";
import { labelOfId, noteTime, otherFormatAction, placeNote, type FormatView } from "../lib.js";
import type { Note } from "../types.js";

/** §21.5: a quiet "Other formats (N)" row; opened, its notes read only, with a way to their format. */
export function OtherFormats({ notes, version, viewsHere, ownViews, onShow, onRestore }: {
  notes: Note[]; version: string; viewsHere: FormatView[]; ownViews(n: Note): FormatView[]; onShow(id: string): void; onRestore(n: Note): void;
}) {
  const [open, setOpen] = useState(false);
  if (notes.length === 0) return null;
  return (
    <div class="otherfmts">
      <button type="button" class="otherrow" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>Other formats ({notes.length})</span>
        <span class="sp" />
        <span class="act">{open ? "Hide" : "Show"}</span>
      </button>
      {open && notes.map((n) => {
        const at = placeNote(n, version);
        const act = otherFormatAction(n, viewsHere, ownViews(n));
        return (
          <div class="note ro" data-note={n.id}>
            <span aria-hidden="true" />
            <div class="nt">
              <span class="t mono">{noteTime(at.t, at.tOut)}</span>
              <span class="ftag">{n.format ? labelOfId(n.format) : "All"}</span>
            </div>
            <div class="nx">{n.text}</div>
            {act?.kind === "show" && <div class="fact"><button type="button" class="btn ghost" onClick={() => onShow(act.id)}>Show on {act.label}</button></div>}
            {act?.kind === "restore" && <div class="fact"><button type="button" class="btn ghost" onClick={() => onRestore(n)}>Restore to all formats</button></div>}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 7: Change Notes.** In `web/src/ui/Notes.tsx`:
  - Import `FormatScope` from `./FormatScope.js`.
  - Add the four props and the `ComposerFormat` interface to `NotesProps`, each with a §21 comment, and destructure them.
  - Inside `.nt`, after the time button: `{(() => { const tag = formatTag?.(n) ?? null; return tag && <span class={\`ftag${tag === "All" ? " all" : ""}\`}>{tag}</span>; })()}`.
  - At the end of each card: `{selectedId === n.id && cardExtra && <div class="fcard">{cardExtra(n)}</div>}`.
  - At the end of `.list`: `{listFooter}`.
  - In `.comp`, above the attachments row:

```tsx
        {formatScope && (
          <div class="row">
            <FormatScope name="This note applies to" label={formatScope.label} width={formatScope.width} height={formatScope.height} value={formatScope.value} onChange={formatScope.onChange} lockedReason={formatScope.lockedReason} />
          </div>
        )}
```

  - After `.cbox`: `{formatScope && <p class="fhint">{formatScope.hint}</p>}`.

- [ ] **Step 8: Change Picture.**
  1. **Imports and props.** Import `BOX_REASON`, `boxShowsOn`, `labelOfId`, `noteFormatTag`, `otherFormatNotes`, `scopeHint`, `versionFormats` and `visibleNotes` from `../lib.js`, `FormatScope` and `OtherFormats` from their files, and `type Note` (already imported). Add `onFormatChange?(id: string): void;` to `PictureProps`.
  2. **Derived values.** After the `view` and `onPrimary` lines:

```ts
  // §21.2 (5): the notes for the format on screen; the others wait one row away.
  const many = format !== null && formats.length >= 2;
  const primaryId = formats[0]?.id ?? null;
  const visible = visibleNotes(notes, format);
  const others = otherFormatNotes(notes, format);
  // §21.2 (4): a new note starts on This format, every time; a box fixes it there (§21.2 (6)).
  const [noteScope, setNoteScope] = useState<"this" | "all">("this");
  const scopeNow: "this" | "all" = box ? "this" : noteScope;
  const ownViews = (n: Note) => versionFormats(video.versions.find((v) => v.id === n.version) ?? version);
  const setNoteFormat = async (n: Note, to: string | null) => {
    try {
      await api.patch(`/api/notes/${n.id}`, { format: to });
    } catch (e) {
      toast((e as Error).message);
    }
    onChanged();
  };
  // R6: a note that doesn't show on the new format lets go of the selection.
  useEffect(() => {
    if (selectedId && !visible.some((n) => n.id === selectedId)) setSelectedId(null);
  }, [format]);
```

  3. **The selected box.** Change `shownBox` to add `&& boxShowsOn(selected, format, primaryId)`.
  4. **The version effect.** In the `[version.file]` effect, add `setNoteScope("this");`.
  5. **Adding a note.** In `add()`, add `format: many && scopeNow === "this" ? format : null,` to the posted body, and `setNoteScope("this");` after `clearRange();`.
  6. **Markers.** Change the line computing `placed` to use `visible` in place of `notes`. Change the marker line to:

```tsx
          {placed.map(({ n, at }) => {
            const tag = noteFormatTag(n, many);
            return <div class={`mk ${n.status}${many && n.format === null ? " ring" : ""}`} style={{ left: pct(at.t!) }} title={tag ? `${tag} · ${n.text}` : n.text} />;
          })}
```

  7. **The notes column.** Change `<Notes notes={notes}` to `<Notes notes={visible}` and add:

```tsx
        formatTag={(n) => noteFormatTag(n, many)}
        cardExtra={many && view ? (n) => (
          <FormatScope name="Note applies to" label={view.label} width={view.width} height={view.height}
            value={n.format === null ? "all" : "this"} lockedReason={n.box ? BOX_REASON : null}
            onChange={(to) => void setNoteFormat(n, to === "all" ? null : view.id)} />
        ) : undefined}
        formatScope={many && view ? { label: view.label, width: view.width, height: view.height, value: scopeNow, onChange: setNoteScope, lockedReason: box ? BOX_REASON : null, hint: scopeHint(view.label, scopeNow, box !== null) } : undefined}
        listFooter={others.length > 0 ? (
          <OtherFormats notes={others} version={version.id} viewsHere={formats} ownViews={ownViews} onShow={(id) => onFormatChange?.(id)} onRestore={(n) => void setNoteFormat(n, null)} />
        ) : undefined}
```

  8. **App.** In `web/src/ui/App.tsx`, pass `onFormatChange={switchFormat}` to `<Picture>`.

- [ ] **Step 9: Write the styles.** Append to `web/src/styles.css`:

```css
.fscope [role="radio"] { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 4px 14px; border: 0; border-radius: 999px; background: transparent; color: var(--text-2); font: 500 15px/1.4 var(--sans); white-space: nowrap; cursor: pointer; }
.fscope [role="radio"][aria-checked="true"] { background: var(--accent-soft); color: var(--accent-2); box-shadow: inset 0 0 0 1px var(--accent); }
.fscope [role="radio"][aria-disabled="true"] { color: var(--text-3); cursor: not-allowed; }
.fhint { margin: 0; color: var(--text-3); font-size: 15px; }
.ftag { display: inline-block; padding: 0 8px; border: 1px solid var(--line-2); border-radius: 999px; color: var(--text-2); font: 15px/22px var(--mono); }
.ftag.all { border-color: var(--accent); color: var(--accent-2); background: var(--accent-soft); }
.fcard, .fact { grid-column: 2; margin-top: 6px; }
.mk.ring { background: var(--app); border: 2px solid var(--accent-2); }
.mk.ring.done { border-color: var(--done); }
.otherfmts { margin: 8px 0; display: grid; gap: 4px; }
.otherrow { display: flex; width: 100%; align-items: center; gap: 8px; padding: 8px 12px; border: 1px dashed var(--line-2); border-radius: var(--r); background: transparent; color: var(--text-2); font: 500 15px/1.4 var(--sans); cursor: pointer; }
.otherrow .act { color: var(--accent-2); }
.note.ro .t { cursor: default; }
```

- [ ] **Step 10: Write the failing e2e tests.** Append to `e2e/formats.spec.ts`:

```ts
const notesOf = async (rushes: { api: (m: string, p: string) => Promise<any> }) => (await rushes.api("GET", "/api/notes?stage=picture")).notes as any[];

test("a note written on 9:16 stays on 9:16; an all-format note shows on every format; markers and counts follow", async ({ page, rushes }) => {
  await rushes.addFormatsCut(FOUR);
  await page.goto(rushes.url);
  await videoReady(page);
  const scope = page.getByRole("radiogroup", { name: "This note applies to" });
  await expect(scope.getByRole("radio", { name: "This format, 16:9" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".fhint")).toHaveText("Shows only while you're viewing 16:9.");
  await radio(page, "9:16").click();
  await page.keyboard.press("n");
  await page.keyboard.type("Logo sits too close to the top edge.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".list > .note .ftag")).toHaveText(["9:16"]);
  await scope.getByRole("radio", { name: "All formats" }).click();
  await expect(page.locator(".fhint")).toHaveText("Shows on every format.");
  await page.keyboard.press("n");
  await page.keyboard.type("Drop the first sound.");
  await page.keyboard.press("Enter");
  await expect(scope.getByRole("radio", { name: /^This format/ })).toHaveAttribute("aria-checked", "true");
  expect((await notesOf(rushes)).map((n) => [n.text, n.format]).sort()).toEqual([["Drop the first sound.", null], ["Logo sits too close to the top edge.", "9x16"]]);
  await expect(radio(page, "9:16")).toHaveAccessibleName("9:16, 2 open notes");
  await expect(radio(page, "16:9")).toHaveAccessibleName("16:9, 1 open note");
  await radio(page, "16:9").click();
  await expect(page.locator(".list > .note .nx")).toHaveText(["Drop the first sound."]);
  await expect(page.locator(".list > .note .ftag.all")).toHaveText("All");
  await expect(page.locator(".track .mk")).toHaveCount(1);
  await expect(page.locator(".track .mk.ring")).toHaveCount(1);
  await radio(page, "9:16").click();
  await expect(page.locator(".track .mk")).toHaveCount(2);
  await expect(page.locator(".track .mk.ring")).toHaveCount(1);
});

test("one format: no switch in the composer, notes save for the whole cut, and nothing new shows", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(page.getByRole("radiogroup", { name: "This note applies to" })).toHaveCount(0);
  await expect(page.locator(".fhint")).toHaveCount(0);
  await page.keyboard.press("n");
  await page.keyboard.type("Hold longer.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note")).toHaveCount(1);
  await expect(page.locator(".note .ftag")).toHaveCount(0);
  await expect(page.locator(".track .mk.ring")).toHaveCount(0);
  expect((await notesOf(rushes))[0].format).toBeNull();
});

test("a boxed note stays on its format: the composer locks to This format and the card can't widen it; others widen and narrow", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  await page.goto(rushes.url);
  await videoReady(page);
  await drawBox(page);
  const scope = page.getByRole("radiogroup", { name: "This note applies to" });
  await expect(scope.getByRole("radio", { name: "All formats" })).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator(".fhint")).toHaveText("A drawn box fixes this note to 16:9.");
  await page.keyboard.press("n");
  await page.keyboard.type("Title safe.");
  await page.keyboard.press("Enter");
  await scope.getByRole("radio", { name: "All formats" }).click();
  await page.keyboard.press("n");
  await page.keyboard.type("Hold longer.");
  await page.keyboard.press("Enter");
  const byText = async (t: string) => (await notesOf(rushes)).find((n) => n.text === t);
  expect(await byText("Title safe.")).toMatchObject({ format: "16x9", box: expect.any(Object) });
  expect((await byText("Hold longer.")).format).toBeNull();
  const card = page.locator(".list > .note", { hasText: "Hold longer." });
  await card.locator(".t").click();
  await card.getByRole("radiogroup", { name: "Note applies to" }).getByRole("radio", { name: /^This format/ }).click();
  await expect.poll(async () => (await byText("Hold longer.")).format).toBe("16x9");
  await card.getByRole("radiogroup", { name: "Note applies to" }).getByRole("radio", { name: "All formats" }).click();
  await expect.poll(async () => (await byText("Hold longer.")).format).toBeNull();
  const boxed = page.locator(".list > .note", { hasText: "Title safe." });
  await boxed.locator(".t").click();
  const all = boxed.getByRole("radiogroup", { name: "Note applies to" }).getByRole("radio", { name: "All formats" });
  await expect(all).toHaveAttribute("aria-disabled", "true");
  await expect(all).toHaveAttribute("data-tip", "A drawn box belongs to one frame, so this note stays on this format.");
  const res = await fetch(`${rushes.base}/api/notes/${(await byText("Title safe.")).id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ format: null }) });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("box_needs_format");
});

test("notes of other formats wait in a quiet row, read only, with a button that switches to their format", async ({ page, rushes }) => {
  await rushes.addFormatsCut(FOUR);
  const add = (t: number, text: string, format: string) => rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t, text, format });
  await add(1, "Logo sits too close to the top edge.", "9x16");
  await add(2, "Rows land late against the beat.", "9x16");
  await add(3, "End card cropped at the bottom.", "4x5");
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(page.locator(".otherrow")).toContainText("Other formats (3)");
  await page.locator(".otherrow").click();
  const ro = page.locator(".otherfmts .note");
  await expect(ro).toHaveCount(3);
  await expect(ro.locator(".chk")).toHaveCount(0);
  await ro.filter({ hasText: "End card cropped" }).getByRole("button", { name: "Show on 4:5" }).click();
  await expect(radio(page, "4:5")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".list > .note .nx")).toHaveText(["End card cropped at the bottom."]);
  await expect(page.locator(".otherrow")).toContainText("Other formats (2)");
});

test("switching lets go of a selected note that doesn't show on the new format (R6)", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Logo edge.", format: "9x16" });
  await page.goto(rushes.url);
  await videoReady(page);
  await radio(page, "9:16").click();
  await page.locator(".list > .note", { hasText: "Logo edge." }).locator(".t").click();
  await expect(page.locator('.note[aria-current="true"]')).toHaveCount(1);
  await radio(page, "16:9").click();
  await radio(page, "9:16").click();
  await expect(page.locator('.note[aria-current="true"]')).toHaveCount(0);
});

// Review Focus 1.
test("a boxed note from before formats keeps showing everywhere, but draws its box on the primary only", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Old boxed note.", box: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } });
  await rushes.addFormatFile(TALL);
  await page.goto(rushes.url);
  await videoReady(page);
  await page.locator(".list > .note", { hasText: "Old boxed note." }).locator(".t").click();
  await expect(page.locator(".frame .bx.saved")).toHaveCount(1);
  await radio(page, "9:16").click();
  await expect(page.locator(".list > .note", { hasText: "Old boxed note." })).toHaveCount(1);
  await expect(page.locator(".frame .bx.saved")).toHaveCount(0);
});
```

- [ ] **Step 11: Run the e2e tests.** Run: `npm run build && npx playwright test e2e/formats.spec.ts --project=chromium --retries=0`, then the same with `--project=webkit`. Expected: PASS in both.

- [ ] **Step 12: Run the gates.** Run: `npm run build && npm run typecheck && npx vitest run && npx playwright test --retries=0`. Expected: all green.

- [ ] **Step 13: Commit.**

```bash
git add web/src/lib.ts web/src/ui/FormatScope.tsx web/src/ui/OtherFormats.tsx web/src/ui/Notes.tsx web/src/ui/Picture.tsx web/src/ui/App.tsx web/src/styles.css test/web/lib.test.ts e2e/formats.spec.ts
git -c user.name=iamredmh -c user.email=17407420+iamredmh@users.noreply.github.com commit -m "feat(web): notes per format -- This format | All formats, tags and rings, a boxed note stays put, Other formats row" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

**Mutation check:** making `visibleNotes` return every note must fail "a note written on 9:16 stays on 9:16…".

---

### Task 6: Assets, grab names, docs, the realistic check and CI (§21.5 Elsewhere)

**Files:**
- Modify: `src/server/assets.ts`: `screenshotName(…, format?)`, and `NEW_NAME` parsing the ratio. The format rows themselves came in Task 2.
- Modify: `src/server/app.ts` (`GrabBody.format`; the grabs route checks and names it).
- Modify: `web/src/api.ts` (`originalFrame(…, format?)`), `web/src/ui/Picture.tsx` (`grabFrame` sends the format), `web/src/lib.ts` (`withFormatRows`, used by `folderItems`), `web/src/ui/AssetViews.tsx` (`cutLabel` and the `sub` class) and `web/src/styles.css`.
- Modify: `README.md` (a "Formats" section and the shortcuts) and `test/package.test.ts`.
- Test: `test/server/formats.test.ts`, `test/web/lib.test.ts`, `e2e/formats.spec.ts`

**Interfaces:**
- Consumes: everything above. In particular, Task 2's `Asset.format` and `formatLabel` format rows from `GET /api/assets`.
- Produces:

```ts
// src/server/assets.ts
export function screenshotName(video: string, version: string, frame: number, fps: number, format?: string | null): string;
// "hero_v1_9x16_00m01.00s_f30.png" with a format; unchanged without.
// web/src/api.ts
export async function originalFrame(video: string, version: string, t: number, format?: string | null): Promise<{ frame: number | null; png: string }>;
// web/src/lib.ts
export function withFormatRows(items: Asset[]): Asset[];   // each cut's format rows straight after it, in chip order
```

- [ ] **Step 1: Write the failing server tests.** Append to `test/server/formats.test.ts`, and import `screenshotName` from `../../src/server/assets.js`:

```ts
describe("grabs by format (§21.5)", () => {
  it("names a grab with its ratio, and parses the name back", async () => {
    expect(screenshotName("hero", "v1", 30, 30, "9x16")).toBe("hero_v1_9x16_00m01.00s_f30.png");
    expect(screenshotName("hero", "v1", 30, 30)).toBe("hero_v1_00m01.00s_f30.png");
    const { call } = await setup([WIDE, TALL]);
    await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }] });
    const r = await call("POST", "/api/grabs", { video: "hero", version: "v1", frame: 30, format: "9x16", png: PNG_1PX });
    expect(r.json.grab).toBe("screenshots/hero_v1_9x16_00m01.00s_f30.png");
    expect((await call("POST", "/api/grabs", { video: "hero", version: "v1", frame: 30, format: "4x5", png: PNG_1PX })).status).toBe(404);
    const shot = (await call("GET", "/api/assets?kind=screenshot")).json.assets[0];
    expect(shot).toMatchObject({ video: "hero", version: "v1", frame: 30, format: "9x16", formatLabel: "9:16" });
  });
});
```

Append to `test/web/lib.test.ts`:

```ts
describe("withFormatRows (§21.5 Assets › Cuts)", () => {
  const a = (path: string, over: Partial<Asset> = {}): Asset => ({ kind: "cut", path, abs: `/p/${path}`, name: path, size: 1, modified: null, missing: false, video: "hero", version: "v1", ...over });
  it("keeps each cut's formats straight after it, in chip order, whatever the sort", () => {
    const items = [a("sq.mp4", { format: "1x1", width: 1080, height: 1080 }), a("v2.mp4", { version: "v2" }), a("main.mp4"), a("tall.mp4", { format: "9x16", width: 1080, height: 1920 })];
    expect(withFormatRows(items).map((x) => x.path)).toEqual(["v2.mp4", "main.mp4", "tall.mp4", "sq.mp4"]);
  });
  it("a format row whose cut was filtered out still shows", () => {
    expect(withFormatRows([a("tall.mp4", { format: "9x16", width: 1080, height: 1920 })]).map((x) => x.path)).toEqual(["tall.mp4"]);
  });
});
```

Add to `test/package.test.ts`:

```ts
  it("README has a Formats section: the toggle, This format | All formats, Alt+arrows and rushes_add_format", () => {
    const text = read("README.md");
    expect(text).toMatch(/^## Formats$/m);
    for (const word of ["`rushes_add_format`", "This format", "All formats", "Alt+←/→", "Other formats"]) expect(text).toContain(word);
  });
```

- [ ] **Step 2: Run them and see them fail.** Run: `npx vitest run test/server/formats.test.ts test/web/lib.test.ts test/package.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the server side.** In `src/server/assets.ts` (`labelOfId` is already imported from Task 2):
  - Change `screenshotName` to `screenshotName(video, version, frame, fps, format: string | null = null)`, returning `` `${video}_${version}${format ? `_${format}` : ""}_${mm}m${s}s_f${frame}.png` ``.
  - Change `NEW_NAME` to `/^([a-z0-9][a-z0-9-]*)_(v\d+)(?:_(\d+(?:\.\d+)?x\d+(?:\.\d+)?))?_(\d{2})m(\d{2}\.\d{2})s_f(\d+)\.png$/`.
  - In `scanScreenshotDir`, take the frame from group 6, and when group 3 is present set `asset.format = newMatch[3]` and `asset.formatLabel = labelOfId(newMatch[3])`.

In `src/server/app.ts`, add `format: z.string().regex(FORMAT_ID_RE).optional()` to `GrabBody`. In the grabs route, after reading `project`:

```ts
    // §21.5: a grab of a format is named with its ratio; the format must be one of this cut's.
    if (b.format !== undefined) {
      const version = project.videos.find((v) => v.id === b.video)?.versions.find((v) => v.id === b.version);
      if (!version || !versionFormats(version).some((f) => f.id === b.format)) throw new NotFoundError("format", b.format);
    }
    const name = screenshotName(b.video, b.version, b.frame, fps, b.format ?? null);
```

Delete the old `const name = …` line.

- [ ] **Step 4: Implement the web side.**
  - In `web/src/api.ts`, give `originalFrame` a fourth parameter `format: string | null = null`, and append `${format ? `&format=${encodeURIComponent(format)}` : ""}` to its URL.
  - In `web/src/ui/Picture.tsx` `grabFrame`:
    - add `const forFormat = format;` beside `forVersion`;
    - call `originalFrame(forVideo, forVersion, at, forFormat)`;
    - post `{ video: forVideo, version: forVersion, frame, png, ...(forFormat ? { format: forFormat } : {}) }`.
    - Add the comment `// §21.5: on a cut with formats every grab is named with the ratio on screen (the primary's too); a one-format cut's name is unchanged.`
  - In `web/src/lib.ts`, add the function below. It uses `orderChips`, Task 4's local alias for `chipOrder`. Make `folderItems` end with `return folder.kinds.includes("cut") ? withFormatRows(sorted) : sorted;`:

```ts
/** §21.5: each cut's format rows straight after it, in chip order; a row whose cut was filtered out stays where it fell. */
export function withFormatRows(items: Asset[]): Asset[] {
  const isSub = (a: Asset) => a.kind === "cut" && a.format !== undefined;
  const subs = items.filter(isSub);
  const placed = new Set<Asset>();
  const out: Asset[] = [];
  for (const a of items) {
    if (isSub(a)) continue;
    out.push(a);
    if (a.kind !== "cut") continue;
    const mine = subs.filter((s) => s.video === a.video && s.version === a.version);
    for (const s of orderChips(mine.map((s) => ({ id: s.format!, width: s.width ?? 1, height: s.height ?? 1, s }))).map((x) => x.s)) {
      out.push(s);
      placed.add(s);
    }
  }
  return [...out, ...subs.filter((s) => !placed.has(s))];
}
```

  - In `web/src/ui/AssetViews.tsx` `cutLabel`, append the ratio: `` const base = video && asset.version ? `${video.name} · ${asset.version}` : asset.label ?? asset.name; const title = asset.formatLabel ? `${base} · ${asset.formatLabel}` : base; ``
  - In `AssetRow` and `PosterTile`, add ` sub` to the class when `asset.format` is set.
  - In `web/src/styles.css`: `.arow.sub { margin-left: 24px; }`

- [ ] **Step 5: Write the README section.** Add to `README.md`, after "Packs, picture lock and shots":

> ## Formats
>
> A piece often ships in several shapes — 9:16, 4:5, 1:1, 16:9 — the same edit reframed. Your agent registers each shape with `rushes_add_format` (or all of them at once with `rushes_add_version`'s `formats`); Rushes measures each ratio itself. Picture then shows a toggle beside the version, always in the same order (9:16, 4:5, 1:1, 4:3, 16:9), with a count of open notes on each. Switching keeps your place and whether it's playing. **Alt+←/→** steps through them.
>
> A new note belongs to the format on screen: the switch above the note box reads **This format** | **All formats**, and you can change it on the note afterwards. A note for one format shows only there; notes for the other formats wait in a quiet **Other formats** row at the foot of the list. A drawn box always stays on the format it was drawn on. With one format there's no switch, and nothing changes. Assets › Cuts lists each format under its cut, and a frame grab is named with its ratio.

Then add `- **Alt+←/→** previous/next format (Picture)` under "Anywhere" in the Shortcuts list.

- [ ] **Step 6: Write the failing e2e tests.** Append to `e2e/formats.spec.ts`, with `import { readFile } from "node:fs/promises";` added to its imports:

```ts
test("Assets › Cuts lists a cut's formats under it, each with download, reveal and open", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL, SQUARE]);
  await page.goto(rushes.url);
  await page.getByRole("tab", { name: /Assets/ }).click();
  await page.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: /Cuts/ }).click();
  await page.getByRole("button", { name: "List view" }).click();
  const rows = page.locator(".arows .arow");
  await expect(rows.locator(".atitle")).toHaveText(["Hero · v1 · 16:9", "Hero · v1 · 9:16", "Hero · v1 · 1:1"]);
  const tall = rows.nth(1);
  await expect(tall).toHaveClass(/\bsub\b/);
  await expect(tall.getByRole("link", { name: "Download" })).toHaveAttribute("href", /renders%2Fhero_v1_180x320\.mp4.*download=1/);
  const reveal = page.waitForResponse((r) => r.url().endsWith("/api/reveal") && r.status() === 200);
  await tall.getByRole("button", { name: /Show in|Open folder/ }).click();
  await reveal;
  const open = page.waitForResponse((r) => r.url().endsWith("/api/open") && r.status() === 200);
  await tall.getByRole("button", { name: "Open", exact: true }).click();
  await open;
});

test("Grab frame on a format saves that format's frame, named with its ratio", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  await page.goto(rushes.url);
  await videoReady(page);
  await radio(page, "9:16").click();
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("g");
  await expect(page.locator(".toast")).toHaveText("Saved to screenshots/hero_v1_9x16_00m01.00s_f30.png");
  const png = await readFile(join(rushes.root, "screenshots", "hero_v1_9x16_00m01.00s_f30.png"));
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 320]);
  await radio(page, "16:9").click();
  await page.keyboard.press("g");
  await expect(page.locator(".toast")).toHaveText("Saved to screenshots/hero_v1_16x9_00m01.00s_f30.png");
});
```

- [ ] **Step 7: Run all the tests.** Run: `npm run build && npx vitest run && npx playwright test e2e/formats.spec.ts --project=chromium --retries=0`, then the same with `--project=webkit`. The existing grab test (`dashboard.spec.ts`, "In and Out make a range note…", whose name is `hero_v1_00m02.00s_f60.png`) must still pass unchanged. Expected: PASS.

- [ ] **Step 8: Run the realistic end-to-end check (generated renders only).** Run from a quiet machine:

```bash
cd ~/Developer/rushes-formats && npm run build
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/rushes-formats-check.XXXX")
PROJ="$SCRATCH/Lumen launch film"; mkdir -p "$PROJ/renders"; cd "$PROJ"
for s in 1920x1080 1080x1920 1080x1080 1080x1350; do
  ffmpeg -v error -y -f lavfi -i "testsrc2=size=$s:rate=30:duration=12" -f lavfi -i "sine=frequency=220:sample_rate=48000:duration=12" \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 96k -shortest "renders/lumen_v1_$s.mp4"
done
CLI="node $HOME/Developer/rushes-formats/dist/cli/index.js"
RUSHES_NO_REVEAL=1 $CLI serve . --port 0 > "$SCRATCH/serve.log" 2>&1 &
SERVE_PID=$!; sleep 2; grep -o 'http://127.0.0.1:[0-9]*/p/[a-z2-9]*/' "$SCRATCH/serve.log" | tee "$SCRATCH/url"
time $CLI add version renders/lumen_v1_1920x1080.mp4 --video "Lumen launch film" --note "First cut"
for s in 1080x1920 1080x1080 1080x1350; do time $CLI add format "renders/lumen_v1_$s.mp4"; done
$CLI add format renders/lumen_v1_1080x1920.mp4; echo "exit $? (expected 1: same ratio)"
```

Write `$SCRATCH/check.mjs` (a throwaway, never committed). It opens the URL in Chromium at 1440×900 and runs these steps:
1. Screenshot each format after clicking its chip, to `$SCRATCH/<ratio>.png`.
2. Add one note on 9:16 and one for all formats through the composer.
3. Time each chip switch from click to the `<video>` reaching `readyState >= 2`.
4. Print those times.

Run it from the repo so `@playwright/test` resolves:

```bash
cd ~/Developer/rushes-formats && SCRATCH="$SCRATCH" node --input-type=module -e "$(cat "$SCRATCH/check.mjs")"
cd "$PROJ" && $CLI notes && $CLI export notes && cat exports/*-notes-*.md
kill $SERVE_PID
```

Paste the CLI lines, the four screenshot paths, the switch timings and the exported Markdown into the task report. Expected:
- each format registers in under 2 s;
- the second 9:16 is refused with §21.3's sentence;
- every switch is ready in under 1 s;
- `rushes notes` shows `9:16` and `All`;
- the export lines carry `· 9:16` and `· All`.

- [ ] **Step 9: Run the gates.** Run: `npm run build && npm run typecheck && npx vitest run && npx playwright test --retries=0` (both projects), then `npm pack --dry-run` (the files list is unchanged). Expected: all green.

- [ ] **Step 10: Commit.**

```bash
git add src/server/assets.ts src/server/app.ts web/src/api.ts web/src/ui/Picture.tsx web/src/lib.ts web/src/ui/AssetViews.tsx web/src/styles.css README.md test/server/formats.test.ts test/web/lib.test.ts test/package.test.ts e2e/formats.spec.ts
git -c user.name=iamredmh -c user.email=17407420+iamredmh@users.noreply.github.com commit -m "feat: formats in Assets › Cuts, grabs named with their ratio, and the README" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 11: Push and see CI green.** Run: `git push -u origin formats`, then `gh run watch --exit-status $(gh run list --branch formats --limit 1 --json databaseId -q '.[0].databaseId')`. Expected: all four jobs pass: Chromium and WebKit, on Node 20.19 and 22. If a job fails, read its Playwright report artifact, fix it, and push again. Never retry a flaky test into green.

**Mutation check:** dropping `format` from `screenshotName`'s output must fail "Grab frame on a format saves that format's frame, named with its ratio" and "names a grab with its ratio".

The version bump and the release are decided by the controller at release time. This plan doesn't bump the version.

---

## Spec coverage

| Spec | Task |
|---|---|
| §21.2 (1) a format is a render of a version; (2) the primary stays `file` and is a format too | 1 (`versionFormats`, R2) |
| §21.2 (3) and §21.3 the ratio is measured: standard within 1%, then a fraction ≤ 32, then a decimal | 1 (`ratioLabel`), 2 (`probeVideo`: rotation, pixel shape) |
| §21.2 (4) a new note defaults to This format; one format means no switch | 5 |
| §21.2 (5) notes show on their formats; others aren't shown | 5 |
| §21.2 (6) a box fixes a note to its format | 1 (`checkNoteFormat`), 2 (routes), 4 (pending box), 5 (UI) |
| §21.2 (7) done is per note; the reply says which formats | 3 (the prompt and the docs) |
| §21.3 the data, additive and with defaults | 1 |
| §21.3 the id is unique and not the primary's; the refusal sentence | 1, 2 |
| §21.3 proxies are the primary's; the switch hides on a format | 4 |
| §21.3 a duration mismatch is registered and warned | 1, 2, 4 |
| §21.3 up to 8 | 1 (R3) |
| §21.3 `note.format` checked on write; a removed format → Other formats with Restore | 1, 2, 5 (R17) |
| §21.4 `rushes_add_format`, `formats` on `add_version`, `format` and `onlyThisFormat` on `list_notes`, reply unchanged | 2, 3 |
| §21.4 CLI `add format` and the notes column; AGENTS and SKILL; the export | 3 |
| §21.5 the toggle: order, counts, single greyed + copy, "Not in v2", keeps time and play, 160 ms, keys, memory | 4 |
| §21.5 the player: the frame takes the shape; the waveform and strip are unchanged | 4 |
| §21.5 Notes: the composer switch, card switch, tags, ring and dot, Other formats | 5 |
| §21.5 Elsewhere: Assets › Cuts sub-rows, grab naming, frames `?format=`, Send to agent | 6, 6, 2, 3 |
| §21.6 outside the folder, missing, not video, same ratio, unreadable, no ffprobe, locked, removed | 2, 4 (missing in the UI) |
| §21.8 review items 1–9 | 1, 4, 5 (1–5, 9); 3 (6); 2 (7); 4 and the styles test (8) |
