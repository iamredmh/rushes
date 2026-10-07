# Rushes Plan 8: Sound-Effects Cue Layers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Sound effects, every cue's label and tick opens a card with its full name, time, place and (optional) source sample, and a chevron on each pass opens its layers by sound: one layer per cue name, with a count, a tick everywhere it comes in, its own playhead and a play button for its sample.

**Architecture:**
- **Data and server (Task 1).** One additive field, `Cue.file?`. A new, dependency-light `src/core/cues.ts` checks a cue file (an audio file of at most 1024 characters) and lists the project's cue files.
  - `addVariant` stores the file.
  - `POST /api/variants` turns it into a manifest path.
  - `registeredMedia` adds cue files to the `/media` allow-list, so §15.5's symlink rules apply unchanged.
  - The found scanner counts cue files as registered.
  - `rushes_add_variant` takes `cues[].file`.
- **Dashboard (Task 2).** New files hold the new logic:
  - `web/src/cues.ts`: pure helpers (time order, layers by sound, roving keys, card position);
  - `web/src/audio/sample.ts`: one sample player on the existing one-player bus;
  - `web/src/ui/CueCard.tsx`: the hover card;
  - `web/src/ui/CueLayers.tsx`: the layers;
  - `web/src/cues.css`: the styles.

  `Lanes.tsx` turns cue labels into buttons, adds the chevron and renders the layers and the card. `VariantTab.tsx` remembers which passes are open for the session. `AudioStage.tsx` aims the note at a clicked cue. The layers' playheads are ordinary `.playhead` elements, which AudioStage's existing layout effect collects and `paint()` moves.
- **Docs, the realistic check and CI (Task 3).**

**Tech Stack:** TypeScript (ESM, NodeNext; the dashboard on Bundler), Hono, zod 4, Preact 10, Vite 8, vitest, Playwright (Chromium and WebKit).

**Spec:** `docs/specs/2026-10-07-rushes-sfx-layers.md` (§23, binding) and the approved mockup `docs/specs/2026-10-07-rushes-sfx-layers-mockup.html` (the mockup's Option 2 only; the UI must match it). It draws on `docs/specs/2026-10-02-rushes-design.md`:
- §15.5: serving registered files that are symlinks.
- §17.1: the audio tabs' layout.
- §17.4: Sound effects and cue notes.
- §17.8: note `on` values.
- §19.4: Safari.
- §19.8: Space on buttons.
- §20: found files.

## Global Constraints

- **Dependencies:** runtime dependencies stay exactly four: `@hono/node-server`, `@modelcontextprotocol/sdk`, `hono` and `zod`.
- **Language and type:** UK English in all copy, docs and comments. Type is 15 px or larger everywhere, including the card, the counts and the file buttons.
- **Accessibility:** every control has an accessible name and works from the keyboard.
  - Ticks and cue labels are buttons. ←/→ move between the ticks in a layer (and the labels in a lane). Enter moves the playhead.
  - The card shows on focus, and Esc hides it.
  - The chevron has `aria-expanded` and an accessible name.
- **Rendering:**
  - Grids use explicit tracks (`minmax(0,1fr)`), for Safari.
  - There's no per-frame component state. The playhead in the layers moves by the same mechanism as the lane's playhead.
  - The layers scroll after about 8 visible rows.
  - Each pass's open state is remembered for the session.
- **Privacy:** no client names and no personal paths anywhere in the repo or tests. Use invented names only ("Effects for Lumen", "Night drive"), with media generated into temp folders.
- **Tests:** tests use `RUSHES_NO_REVEAL=1` (`vitest.config.ts` and `e2e/fixture.ts` already set it) and never open apps.
- **Schemas are additive only:** a 0.2.2 project loads unchanged.
- **Commits:** use `git -c user.name=iamredmh -c user.email=17407420+iamredmh@users.noreply.github.com commit`. Every message ends with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never change git config.
- **`rushes setup`:** never run it against the real home without `--dry-run`.
- **Ports:** never use 4410, 4430–4434 or 8765. Tests use port 0.
- **No version bump:** `package.json`, `VERSION` in `src/server/app.ts`, `.claude-plugin/plugin.json` and `package-lock.json` stay at 0.2.2.
- **e2e:** runs in Chromium and WebKit. Run it locally only when the machine is quiet:
  - the load average is below `sysctl -n hw.ncpu`;
  - `pgrep -fl 'playwright|ffmpeg'` is empty apart from long-lived playwright-mcp servers;
  - no other e2e run is going.
  
  CI on the pushed branch is the final word.
- **Setup:** the worktree (`~/Developer/rushes-sfx`, branch `sfx-layers`, based on main 94cfcd9 = 0.2.2) needs `npm ci` first.
- **Parallel work:** Plan 6 (formats, `~/Developer/rushes-formats`) and Plan 7 (changelog, `~/Developer/rushes-changelog`) are mid-build.
  - New logic goes in new files.
  - Edits to shared files stay small and additive, at the regions listed under "Overlap with Plans 6 and 7".
  - No new tool: tool counts change by zero.
- **The gate for every task:** `npm run build && npm run typecheck && npx vitest run`, then the e2e suite in both projects where the task touches the dashboard.

## Rulings (where the real code left the spec open)

- **R1: where the chevron goes.** The name cell is one `<button class="nm">` (`web/src/ui/Lanes.tsx:255-280`), and a button can't hold another.
  - A row with `layers` gets a wrapper `.nmc`: the chevron, then the unchanged name button.
  - Music, Voiceover and Mix rows keep today's markup.
  - The Voiceover fold row's pattern is reused: `aria-expanded`, the `chev` icon turned −90° while shut, the 0.15 s turn and the `.tip-start` tooltip. The fold itself (`Lanes.tsx:218-237`, a whole-row button) isn't, because a pass row already has a name button, a track and Use.
- **R2: a pass with no cues** shows the chevron disabled (the mockup's second row), with the tooltip "No cues in this pass".
- **R3: grouping.** Layers group by the cue's name trimmed, exactly as sent, case included: "Thud" and "thud" are two layers. A name that is blank once trimmed shows as "Untitled cue" (the schema allows `"  "`).
- **R4: time order.**
  - "cue n of N", the order of the labels on the waveform and the ←/→ order all follow time. Cues at the same time keep the order they were sent in.
  - The stored order and the cue ids (`addVariant`'s `uniqueId`) don't change.
  - On Mix, N counts the cues of every picked pass together, because that is what its lane draws.
- **R5: the file on the layer.**
  - It sits in the layer's control column, which is empty in the mockup, under Use: a play button with the file's base name in mono, in the lane colour. That keeps every layer one 30 px row.
  - The card shows the stored path (the manifest path).
  - When one name's cues name different files, the layer shows the first, in time order, and "+N". Each tick's card names its own file.
- **R6: the card is a tooltip.**
  - It has `role="tooltip"`, `pointer-events: none` and one card per `Lanes`. Auditioning is from the layer's file button only.
  - It follows its cue when the page or the layers scroll, because focusing a tick can scroll the layers.
  - It closes on pointer leave, blur or Esc, and when its cue leaves the page (the layers close).
- **R7: keyboard.**
  - The labels of a lane, and the ticks of each layer, are roving groups: one Tab stop each, the last focused, otherwise the first.
  - ←/→ step in time order, and Home and End jump to the ends. Movement never wraps.
  - Those four keys are stopped at the cue (`stopPropagation`), so AudioStage's window handler (`AudioStage.tsx:304-325`) doesn't step frames while a cue has focus.
  - Enter presses the cue. Space presses a keyboard-focused cue, as §19.8 says for any button. The cues aren't `data-player`.
  - ↑/↓ are left alone (they scroll the layers).
  - The e2e tests focus with `locator.focus()` rather than Tab, because WebKit doesn't Tab to buttons by default.
- **R8: clicking a cue.** A click on a label, a lane tick or a layer tick does three things, and doesn't start playback:
  - it selects the pass;
  - it moves the playhead to the cue;
  - it points the note's On menu at that cue (`c:<lane>/<pass>:<cue>`, when the menu has it), so the next note lands on the cue at its time (§17.4).
- **R9: the sample player.** Assets' one `<audio>` belongs to the Assets page and isn't mounted on Sound effects. So a new module, `web/src/audio/sample.ts`, holds one `Audio` element for the page, made on first use. It claims the existing bus (`web/src/audio/bus.ts`), exactly as the Assets player and the engine do:
  - auditioning pauses the tab;
  - Play stops the sample;
  - a second press on the same file stops it;
  - closing the layers or leaving the tab stops a sample they started.
- **R10: a cue file must be audio** (`wav mp3 m4a aac aif aiff flac ogg opus`, the audio half of §15.5's list). That is narrower than a variant's own `file`, because cue files join the allow-list in bulk.
  - It is refused at registration (400, naming the cue).
  - `registeredMedia` adds only stored cue files with those extensions, so a hand edit naming `.rushes/notes.json` is never served.
  - Existence isn't checked at registration (as for variants).
- **R11: the field is `file: optional`**, not `nullable().default(null)`. So 0.2.2 cues load and write back byte for byte, and only cues with a file carry the key. The schema states 1024 as a literal, so `schema.ts` gains no import.
- **R12: Found** (`registeredPaths`, `src/server/found.ts:356-363`) counts cue files as registered, so samples aren't offered as passes to bring in. Cue files don't appear in Assets' Sound effects folder (§23.7).
- **R13: Mix.**
  - The card and the keyboard come with the shared `Lanes`, so Mix's Sound effects lane has them without any change to `Mix.tsx`.
  - The layers aren't on Mix: its lane merges every picked pass and has no per-pass row to remember. `Mix.tsx` passes no `layers`.
- **R14: the open state** is a module-level `Set` in `VariantTab.tsx`, keyed by `<lane>/<variant>`. This is the pattern of Voiceover's `openRounds` (`web/src/ui/Voice.tsx:30-31`).
  - It survives a trip to another tab and is gone on reload.
  - The toggle re-renders VariantTab, so AudioStage re-renders, and its layout effect (`AudioStage.tsx:241-244`) collects the layers' `.playhead` elements with the lane's.
- **R15: the CLI** is unchanged. `rushes add variant` (`src/cli/main.ts:328-331`) has never taken cues.
- **R16: a layer tick for a cue after the pass's end** sits at the end of the track. The main track is unchanged.
- **R17: CSS** goes in a new `web/src/cues.css`, imported after `styles.css` in `web/src/main.tsx`. Its `.track .cue` and `.track .cue-tick` rules outrank `styles.css:442-443`'s `.cue` and `.cue-tick` (which set `pointer-events: none`), so `styles.css` is untouched.
- **R18: an older Rushes server** strips `file` silently (zod drops unknown keys). The reply's cues show no `file`, and nothing breaks.
- **R19: the label's text sits in a `<span>`** inside the button, which does the ellipsis, because WebKit's ellipsis on a button's own text isn't dependable.
- **R20: only ticks seek in a layer.** The layer's track itself isn't clickable, as in the mockup.

## Review Focus

1. **A cue `file` that points out of the project, or at something that isn't a sample**, such as `../`, an absolute path, a symlink to a key file, or a hand edit naming `.rushes/notes.json`. Only a registered audio file is served, and §15.5 still holds. *(Task 1: `test/server/cue-files.test.ts`, "a cue's sample linked in from outside…", "refuses a cue file that isn't audio…", "a hand-edited cue file that isn't audio is never served".)*
2. **A busy pass:** 200 cues over 12 sounds, repeats, and cues at the same moment.
   - The layers open within 1.5 s and scroll after eight.
   - Every tick is reachable.
   - The playheads stay together.
   - Nothing re-renders per frame.
   
   *(Task 2: the `cueLayers` and `cuesInTime` units; Task 3: "a busy pass…" e2e.)*
3. **Keys on a focused cue.** ←/→/Home/End never step frames. Esc hides only the card. Enter presses the cue, and the roving stop follows focus. *(Task 2 e2e: "the cue labels are one Tab stop…" and "in a layer, ←/→ move…".)*
4. **The card at the window's edges and in a scrolled layer list.** It stays 16 px inside the window, follows its cue and closes with the layers. *(Task 2: the `cardPosition` unit; Task 3: the busy-pass e2e hovers the last tick of the last layer after scrolling.)*
5. **Auditioning while the tab plays, a sample that isn't there, and closing the layers mid-sample.** One sound at a time, "Couldn't play gone.wav", and nothing left marked as playing. *(Task 2: the `SamplePlayer` units; e2e: "a layer's file button plays its sample…" and "a sample that isn't there says so…".)*

---

## File structure

| Area | Files |
|---|---|
| Core | new `src/core/cues.ts`; `src/core/schema.ts` (`CueSchema.file`), `src/core/project.ts` (`AddVariantInput.cues[].file`, `addVariant`) |
| Server | `src/server/app.ts` (`VariantBody`, the variants route), `src/server/files.ts` (`registeredMedia`), `src/server/found.ts` (`registeredPaths`) |
| Agent | `src/mcp/tools.ts` (`rushes_add_variant`'s `cues`), `AGENTS.md`, `skills/rushes/SKILL.md` |
| Web | new `web/src/cues.ts`, new `web/src/audio/sample.ts`, new `web/src/ui/CueCard.tsx`, new `web/src/ui/CueLayers.tsx`, new `web/src/cues.css`; `web/src/ui/Lanes.tsx`, `web/src/ui/AudioStage.tsx`, `web/src/ui/VariantTab.tsx`, `web/src/main.tsx` (one import) |
| Docs | `README.md`, `AGENTS.md`, `skills/rushes/SKILL.md` |
| Tests | new `test/core/cues.test.ts`, `test/server/cue-files.test.ts`, `test/mcp/cue-files.test.ts`, `test/web/cues.test.ts`, `test/web/sample.test.ts`, `test/web/cues-css.test.ts`, `test/docs-cues.test.ts`, `e2e/cues.spec.ts`; `e2e/fixture.ts` (one type) |

## Overlap with Plans 6 and 7

Line numbers are main at 94cfcd9. Whichever plan lands second rebases on these regions.

| File | What this plan touches | What Plan 6 / Plan 7 touch nearby | Rebase note |
|---|---|---|---|
| `src/core/schema.ts` | `CueSchema`, line 54, only | Plan 6: `VersionSchema` (33–43), `NoteSchema`. Plan 7: line 1 import, `VersionSchema` 39, a block after 283, `FILES` | Separate regions |
| `src/core/project.ts` | One import after line 4. `AddVariantInput.cues` (line 106). `addVariant` lines 111–123 (the cue loop moves above the lane lookup) | Plan 6: `AddVersionInput`, `addVersion`, new `resolveCut`/`addFormat`. Plan 7: `AddVersionInput.label`, `addVersion` line 67 | Keep every import. Separate functions |
| `src/server/app.ts` | `VariantBody.cues` (line 94). The variants route (812–816): one `cues` line before `store.update`, and `cues` added to its `addVariant({...})` | Plan 7: `log.add(variantEvent(...))` straight after the same `store.update` (814–815). Plan 6: versions, formats, notes and frame routes | Keep our `const cues = …` line and the `cues` property; put Plan 7's log line after the `store.update` as it says |
| `src/server/files.ts` | One import after line 5. One line after line 85 in `registeredMedia` | Plan 6: one line inside the versions loop (after 82) | Different lines: keep both |
| `src/server/found.ts` | One import after line 26. One line after line 359 in `registeredPaths` | Plan 7: imports 20–26, `adopt` 662–682 | Keep both imports |
| `src/mcp/tools.ts` | `rushes_add_variant`'s `cues` (line 234) | Plan 6: `rushes_add_version`, `rushes_add_format`, `rushes_list_notes`. Plan 7: `rushes_add_version`'s `label`, `rushes_export_notes`, two new tools | Separate tools |
| `web/src/main.tsx` | `import "./cues.css";` after line 8 | Plan 7: `import "./changes.css";` at the same spot | Keep both, both after `styles.css` |
| `e2e/fixture.ts` | `VariantOptions.cues` type (line 60) | Plans 6 and 7: new helpers elsewhere in the file | Separate lines |
| `AGENTS.md` | Line 66 (SFX cues) | Both: the "nineteen tools" line (94) and new sections | Separate paragraphs |
| `skills/rushes/SKILL.md` | Line 15 (the `rushes_add_variant` bullet) | Both: line 32 (tool count) | Separate lines |
| `README.md` | Shortcuts, after line 113. Audio review, after line 204 | Both: the tool-count line (43) and new sections | Separate paragraphs |
| Tool counts | No change: no new tool | Plan 6 +1, Plan 7 +2 | Nothing to reconcile from this plan |

This plan does **not** touch:
- `src/cli/main.ts`, `web/src/ui/App.tsx`, `web/src/ui/Picture.tsx`, `web/src/ui/Notes.tsx`, `web/src/ui/Mix.tsx`, `web/src/styles.css`, `web/src/lib.ts` or `web/src/types.ts`;
- `test/mcp/tools.test.ts`, `test/package.test.ts`, `test/server/files.test.ts` or `test/web/lib.test.ts`.

---

### Task 1: Cue files: the field, the checks, the route, the allow-list and the agent surface (§23.3, §23.4)

**Files:**
- Create: `src/core/cues.ts`
- Modify: `src/core/schema.ts:54` (`CueSchema`)
- Modify: `src/core/project.ts:4` (import), `:106` (`AddVariantInput.cues`), `:111-123` (`addVariant`)
- Modify: `src/server/app.ts:94` (`VariantBody.cues`), `:812-816` (the variants route)
- Modify: `src/server/files.ts:5` (import), `:85` (`registeredMedia`)
- Modify: `src/server/found.ts:26` (import), `:359` (`registeredPaths`)
- Modify: `src/mcp/tools.ts:234` (`rushes_add_variant`'s `cues`)
- Create: `test/core/cues.test.ts`, `test/server/cue-files.test.ts`, `test/mcp/cue-files.test.ts`

**Interfaces:**
- Consumes:
  - `addVariant(p: Project, input: AddVariantInput): { lane: Lane; variant: Variant }` (`src/core/project.ts:111`);
  - `InvalidError(message: string)` (`src/core/errors.ts:19`);
  - `toManifestPath(root: string, file: string): string` (`src/core/paths.ts:8`);
  - `registeredMedia(project, script): Set<string>` (`src/server/files.ts:75`);
  - `registeredPaths(project, script): string[]` (`src/server/found.ts:356`);
  - `OUTSIDE_MEDIA_EXT` and `contentType` (`src/server/files.ts`).
- Produces (`src/core/cues.ts`):

```ts
export const CUE_FILE_MAX = 1024;
export const CUE_FILE_EXT: ReadonlySet<string>;                 // "wav" "mp3" "m4a" "aac" "aif" "aiff" "flac" "ogg" "opus"
export function isCueFile(file: string): boolean;                // non-empty, ≤ 1024, no NUL, one of CUE_FILE_EXT
export function checkCueFile(cueName: string, file: string): string; // `file`, or InvalidError (400) naming the cue
export function cueFiles(project: Pick<Project, "lanes">): string[]; // every stored cue file that isCueFile, once each, in manifest order
```

- Produces (`src/core/schema.ts`): `Cue` gains `file?: string`.
- Produces (`src/core/project.ts`): `AddVariantInput.cues?: { name: string; t: number; file?: string }[]`. `addVariant` refuses a bad cue file before it touches the project.
- Produces (server): `POST /api/variants` takes `cues[].file` (string, 1–1024 characters) and stores it as a manifest path. `/media` serves cue files (registered only, §15.5).
- Produces (MCP): `rushes_add_variant`'s `cues` items take `file?: string` (≤ 1024 characters). The reply's `variant.cues` carry it back.

- [ ] **Step 0: Install and take a baseline.** Run `cd ~/Developer/rushes-sfx && npm ci && npx vitest run`. Expected: every test passes.

- [ ] **Step 1: Write the failing core tests** in `test/core/cues.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CUE_FILE_EXT, CUE_FILE_MAX, checkCueFile, cueFiles, isCueFile } from "../../src/core/cues.js";
import { InvalidError } from "../../src/core/errors.js";
import { addVariant } from "../../src/core/project.js";
import { CueSchema, ProjectSchema, type Project } from "../../src/core/schema.js";
import { OUTSIDE_MEDIA_EXT, contentType } from "../../src/server/files.js";

const empty = (): Project => ({ schema: 1, rev: 0, name: "demo", fps: 30, videos: [], lanes: [], files: [], autoProxy: false });

describe("cue files (§23.3)", () => {
  it("are audio files of at most 1024 characters", () => {
    for (const ok of ["sfx/thud_low_03.wav", "SFX/Whoosh.WAV", "/Volumes/Library Drive/sfx/pop.aiff", "a.mp3", "b.m4a", "c.aac", "d.aif", "e.flac", "f.ogg", "g.opus", `${"a".repeat(1020)}.wav`]) {
      expect(isCueFile(ok), ok).toBe(true);
    }
    for (const bad of ["", "notes.json", ".rushes/notes.json", "id_ed25519", "sfx/thud", ".wav", "render.mp4", "sheet.pdf", "a.wav\0.json", `${"a".repeat(1021)}.wav`]) {
      expect(isCueFile(bad), bad).toBe(false);
    }
    expect(CUE_FILE_MAX).toBe(1024);
  });

  it("are the audio half of §15.5's outside-the-project list, served as audio", () => {
    for (const ext of CUE_FILE_EXT) {
      expect(OUTSIDE_MEDIA_EXT.has(ext), ext).toBe(true);
      expect(contentType(`x.${ext}`), ext).toMatch(/^audio\//);
    }
  });

  it("checkCueFile returns the file, or says which cue and why", () => {
    expect(checkCueFile("thud", "sfx/thud.wav")).toBe("sfx/thud.wav");
    expect(() => checkCueFile("thud", "notes.json")).toThrow(InvalidError);
    expect(() => checkCueFile("thud", "notes.json")).toThrow('Cue "thud": "notes.json" isn\'t an audio file. Send a .wav, .mp3, .m4a, .aac, .aif, .aiff, .flac, .ogg or .opus.');
    expect(() => checkCueFile("thud", `${"a".repeat(1021)}.wav`)).toThrow('Cue "thud": its file path is over 1024 characters');
  });
});

describe("addVariant with cue files", () => {
  it("keeps a cue's file only when one is sent", () => {
    const p = empty();
    const { variant } = addVariant(p, { stage: "sfx", name: "Pass A", file: "pass.wav", cues: [{ name: "thud", t: 1, file: "sfx/thud.wav" }, { name: "click", t: 2 }] });
    expect(variant.cues).toEqual([{ id: "thud", name: "thud", t: 1, file: "sfx/thud.wav" }, { id: "click", name: "click", t: 2 }]);
    expect("file" in variant.cues[1]).toBe(false);
  });

  it("refuses a cue file that isn't audio before it touches the project, even a new lane", () => {
    const p = empty();
    expect(() => addVariant(p, { stage: "sfx", lane: "fx", name: "Pass B", file: "b.wav", cues: [{ name: "key", t: 1, file: "id_ed25519" }] })).toThrow(/Cue "key"/);
    expect(p.lanes).toEqual([]);
  });
});

describe("the stored field", () => {
  it("a 0.2.2 project's cues load and write back exactly as they were", () => {
    const saved = {
      ...empty(),
      lanes: [{ id: "sfx", stage: "sfx", name: "Sound effects", variants: [{ id: "pass-a", name: "Pass A", file: "audio/sfx/pass-a.wav", meta: {}, cues: [{ id: "swipe", name: "Swipe", t: 1.5 }] }] }],
    };
    const parsed = ProjectSchema.parse(JSON.parse(JSON.stringify(saved)));
    expect(JSON.stringify(parsed.lanes)).toBe(JSON.stringify(saved.lanes));
  });

  it("CueSchema takes an optional file of 1 to 1024 characters", () => {
    expect(CueSchema.parse({ id: "a", name: "a", t: 0, file: "sfx/a.wav" }).file).toBe("sfx/a.wav");
    expect(CueSchema.parse({ id: "a", name: "a", t: 0 })).toEqual({ id: "a", name: "a", t: 0 });
    expect(CueSchema.safeParse({ id: "a", name: "a", t: 0, file: "" }).success).toBe(false);
    expect(CueSchema.safeParse({ id: "a", name: "a", t: 0, file: `${"a".repeat(1021)}.wav` }).success).toBe(false);
  });
});

describe("cueFiles", () => {
  it("lists each audio cue file once, in manifest order, and leaves out a hand-edited one that isn't audio", () => {
    const p = empty();
    addVariant(p, { stage: "sfx", name: "A", file: "a.wav", cues: [{ name: "thud", t: 1, file: "sfx/thud.wav" }, { name: "thud", t: 2, file: "sfx/thud.wav" }, { name: "pop", t: 3, file: "sfx/pop.wav" }] });
    addVariant(p, { stage: "sfx", name: "B", file: "b.wav", cues: [{ name: "tick", t: 1 }] });
    p.lanes[0].variants[1].cues[0].file = ".rushes/notes.json"; // a hand edit
    expect(cueFiles(p)).toEqual(["sfx/thud.wav", "sfx/pop.wav"]);
  });
});
```

- [ ] **Step 2: Run them and see them fail.** Run: `npx vitest run test/core/cues.test.ts`. Expected: FAIL, because `src/core/cues.js` is missing.

- [ ] **Step 3: Write `src/core/cues.ts`, the schema field and `addVariant`.**

`src/core/cues.ts`:

```ts
// §23: a cue's optional source file -- the sample an agent placed at that cue. Checked where it
// comes in (an audio file, at most 1024 characters, so it can never open the allow-list to
// anything else) and served by /media only because it is registered (§15.5 applies unchanged).
import { InvalidError } from "./errors.js";
import type { Project } from "./schema.js";

export const CUE_FILE_MAX = 1024;

/** The sample types a cue may name: the audio half of §15.5's outside-the-project list. */
export const CUE_FILE_EXT: ReadonlySet<string> = new Set(["wav", "mp3", "m4a", "aac", "aif", "aiff", "flac", "ogg", "opus"]);

function extOf(file: string): string {
  const base = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Whether `file` may be a cue's source: not empty, at most 1024 characters, no NUL, an audio extension. */
export function isCueFile(file: string): boolean {
  return file.length > 0 && file.length <= CUE_FILE_MAX && !file.includes("\0") && CUE_FILE_EXT.has(extOf(file));
}

/** `file` when it may be a cue's source; otherwise an InvalidError (400) naming the cue. */
export function checkCueFile(cueName: string, file: string): string {
  if (file.length > CUE_FILE_MAX) throw new InvalidError(`Cue "${cueName}": its file path is over ${CUE_FILE_MAX} characters`);
  if (!isCueFile(file)) {
    throw new InvalidError(`Cue "${cueName}": "${file}" isn't an audio file. Send a .wav, .mp3, .m4a, .aac, .aif, .aiff, .flac, .ogg or .opus.`);
  }
  return file;
}

/**
 * Every cue file the project names, once each, in manifest order. A stored one that isn't an
 * audio file (a hand edit) is left out, so it is never served.
 */
export function cueFiles(project: Pick<Project, "lanes">): string[] {
  const out = new Set<string>();
  for (const l of project.lanes) {
    for (const v of l.variants) for (const c of v.cues) if (c.file !== undefined && isCueFile(c.file)) out.add(c.file);
  }
  return [...out];
}
```

In `src/core/schema.ts`, replace line 54:

```ts
export const CueSchema = z.object({
  id,
  name: z.string().min(1),
  t: seconds,
  // §23: the sample placed at this cue, as a manifest path (CUE_FILE_MAX in cues.ts). Optional and
  // absent on every older cue, so a 0.2.x project loads and writes back unchanged.
  file: z.string().min(1).max(1024).optional(),
});
```

In `src/core/project.ts`:
- After line 4, add `import { checkCueFile } from "./cues.js";`.
- Change line 106 to `cues?: { name: string; t: number; file?: string }[];`.
- In `addVariant`, move the cue loop to the top and keep the file. Replace lines 111–123 with:

```ts
export function addVariant(p: Project, input: AddVariantInput): { lane: Lane; variant: Variant } {
  // §23: the cues first, so a cue refused for its file leaves the project untouched.
  const cues: Cue[] = [];
  for (const c of input.cues ?? []) {
    const cue: Cue = { id: uniqueId(slugify(c.name), cues.map((x) => x.id)), name: c.name, t: c.t };
    if (c.file !== undefined) cue.file = checkCueFile(c.name, c.file);
    cues.push(cue);
  }
  // Lane ids are capped at 64 by the schema; a slug can outgrow its source (NFKD splits ligatures).
  const laneId = slugify(input.lane ?? input.round ?? input.stage).slice(0, 64).replace(/-+$/, "");
  let lane = p.lanes.find((l) => l.id === laneId);
  if (lane && lane.stage !== input.stage) throw new InvalidError(`Lane "${laneId}" belongs to ${lane.stage}, not ${input.stage}`);
  if (!lane) {
    lane = { id: laneId, stage: input.stage, name: input.round ?? input.lane ?? LANE_NAMES[input.stage], variants: [] };
    p.lanes.push(lane);
  }
```

(Lines 124–133, the `variant` literal and the push, stay as they are.)

- [ ] **Step 4: Run them and see them pass.** Run: `npx vitest run test/core/cues.test.ts test/core/project.test.ts`. Expected: PASS, including the existing "stores cues with ids".

- [ ] **Step 5: Write the failing server tests** in `test/server/cue-files.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { createApp } from "../../src/server/app.js";
import { FoundScanner } from "../../src/server/found.js";

/** A project with an app on it, a scanner that's never run on its own, and a folder beside it ("outside drive"). */
async function setup() {
  const { root, store } = await tmpProject("cue-files");
  const found = new FoundScanner({ store, probe: async () => null, announce: () => undefined });
  const app = createApp(store, { found });
  const call = (path: string) => app.request(path);
  const post = (path: string, json: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) });
  const put = async (rel: string, text = "sample") => {
    const abs = join(root, ...rel.split("/"));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text);
    return abs;
  };
  const media = (path: string) => call(`/media?path=${encodeURIComponent(path)}`);
  const outside = join(dirname(root), "outside drive");
  await mkdir(outside, { recursive: true });
  // The project's id is ensured (and written) on the first request: do it now, so later reads compare like with like.
  await call("/api/health");
  return { root, store, found, post, put, media, outside };
}

const pass = (cues: { name: string; t: number; file?: string }[]) => ({ stage: "sfx", name: "Effects for Lumen", file: "audio/sfx/pass.wav", cues });

describe("a cue's file (§23.3)", () => {
  it("POST /api/variants stores it as a manifest path and returns it; a cue without one has no key", async () => {
    const s = await setup();
    const r = await s.post("/api/variants", pass([{ name: "thud", t: 1, file: join(s.root, "audio", "sfx", "samples", "thud_low_03.wav") }, { name: "click", t: 2 }]));
    expect(r.status).toBe(201);
    const { variant } = (await r.json()) as { variant: { cues: unknown[] } };
    expect(variant.cues).toEqual([{ id: "thud", name: "thud", t: 1, file: "audio/sfx/samples/thud_low_03.wav" }, { id: "click", name: "click", t: 2 }]);
    const saved = JSON.parse(await readFile(join(s.root, ".rushes", "project.json"), "utf8"));
    expect(saved.lanes[0].variants[0].cues[1]).toEqual({ id: "click", name: "click", t: 2 });
  });

  it("refuses a cue file that isn't audio, or is over 1024 characters, and writes nothing", async () => {
    const s = await setup();
    const before = await readFile(join(s.root, ".rushes", "project.json"), "utf8");
    for (const file of ["notes.json", "../outside drive/id_ed25519", ".rushes/notes.json"]) {
      const r = await s.post("/api/variants", pass([{ name: "key", t: 1, file }]));
      expect(r.status, file).toBe(400);
      expect(((await r.json()) as { message: string }).message, file).toMatch(/^Cue "key": ".*" isn't an audio file/);
    }
    expect((await s.post("/api/variants", pass([{ name: "thud", t: 1, file: `${"a".repeat(1021)}.wav` }]))).status).toBe(400);
    expect(await readFile(join(s.root, ".rushes", "project.json"), "utf8")).toBe(before);
  });

  it("/media serves a registered cue's sample with the usual headers, and never the unregistered one beside it", async () => {
    const s = await setup();
    await s.put("audio/sfx/samples/thud_low_03.wav", "thud");
    await s.put("audio/sfx/samples/unused.wav", "unused");
    await s.post("/api/variants", pass([{ name: "thud", t: 1, file: "audio/sfx/samples/thud_low_03.wav" }]));
    const res = await s.media("audio/sfx/samples/thud_low_03.wav");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(await res.text()).toBe("thud");
    expect((await s.media("audio/sfx/samples/unused.wav")).status).toBe(404);
  });

  it("a cue's sample linked in from outside is served only when the real file is media (§15.5)", async () => {
    const s = await setup();
    await writeFile(join(s.outside, "boom.wav"), "boom");
    await writeFile(join(s.outside, "id_ed25519"), "secret");
    await mkdir(join(s.root, "audio", "sfx"), { recursive: true });
    await symlink(join(s.outside, "boom.wav"), join(s.root, "audio", "sfx", "boom.wav"));
    await symlink(join(s.outside, "id_ed25519"), join(s.root, "audio", "sfx", "key.wav"));
    const r = await s.post("/api/variants", pass([
      { name: "boom", t: 1, file: "audio/sfx/boom.wav" },
      { name: "key", t: 2, file: "audio/sfx/key.wav" },
      { name: "far", t: 3, file: join(s.outside, "boom.wav") },
    ]));
    expect(r.status).toBe(201);
    expect(await (await s.media("audio/sfx/boom.wav")).text()).toBe("boom");
    const key = await s.media("audio/sfx/key.wav");
    expect(key.status).toBe(404);
    expect(await key.text()).not.toContain("secret");
    expect((await s.media(join(s.outside, "boom.wav"))).status).toBe(200);
    expect((await s.media(join(s.outside, "id_ed25519"))).status).toBe(404);
  });

  it("a hand-edited cue file that isn't audio is never served", async () => {
    const s = await setup();
    await s.post("/api/variants", pass([{ name: "thud", t: 1 }]));
    await s.store.update("project", (p) => {
      p.lanes[0].variants[0].cues[0].file = ".rushes/notes.json";
    });
    expect((await s.media(".rushes/notes.json")).status).toBe(404);
  });

  it("Found leaves a registered cue's sample out (§20)", async () => {
    const s = await setup();
    await s.put("sfx/thud_low_03.wav");
    await s.put("sfx/whoosh_long_01.wav");
    await s.post("/api/variants", pass([{ name: "thud", t: 1, file: "sfx/thud_low_03.wav" }]));
    await s.found.scan();
    const paths = (await s.found.list()).map((f) => f.path);
    expect(paths).toContain("sfx/whoosh_long_01.wav");
    expect(paths).not.toContain("sfx/thud_low_03.wav");
  });
});
```

- [ ] **Step 6: Run them and see them fail.** Run: `npx vitest run test/server/cue-files.test.ts`. Expected: FAIL. The route drops `file` (zod strips it), so the first and third tests fail, and the Found test lists the sample.

- [ ] **Step 7: Implement the route, the allow-list and Found.**

`src/server/app.ts` line 94 becomes:

```ts
  cues: z.array(z.object({ name: z.string().min(1), t, file: z.string().min(1).max(1024).optional() })).optional(),
```

The variants route (lines 812–816) becomes:

```ts
  app.post("/api/variants", async (c) => {
    const b = await body(c, VariantBody);
    // §23: a cue's file is stored as a manifest path, like the variant's own.
    const cues = b.cues?.map((q) => (q.file === undefined ? q : { ...q, file: toManifestPath(store.root, q.file) }));
    const { result } = await store.update("project", (p) => addVariant(p, { ...b, cues, file: toManifestPath(store.root, b.file) }));
    return c.json(result, 201);
  });
```

`src/server/files.ts`: after line 5 add `import { cueFiles } from "../core/cues.js";`. After line 85, inside `registeredMedia`, add:

```ts
  // §23: each cue's sample, when it is an audio file; served only because it is registered.
  for (const f of cueFiles(project)) files.add(f);
```

`src/server/found.ts`: after line 26 add `import { cueFiles } from "../core/cues.js";`. After line 359, inside `registeredPaths`, add:

```ts
  // §23: a cue's sample is part of its pass, not a pass of its own to bring in.
  for (const f of cueFiles(project)) out.push(f);
```

Update the doc comment on line 355 to read `/** Every manifest path the project has registered: cuts, variants, cue samples, library files and script takes. */`.

- [ ] **Step 8: Run them and see them pass.** Run: `npx vitest run test/server/cue-files.test.ts test/server/files.test.ts test/server/found.test.ts`. Expected: PASS.

- [ ] **Step 9: Write the failing MCP test** in `test/mcp/cue-files.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { tmpProject } from "../helpers/tmp.js";
import { startServer } from "../../src/server/start.js";
import { createMcpServer } from "../../src/mcp/tools.js";
import { RushesClient } from "../../src/mcp/client.js";

async function connect() {
  const { root } = await tmpProject("cue-files");
  const running = await startServer(root, { port: 0 });
  const server = createMcpServer({ client: async () => new RushesClient(running.url), openBrowser: () => undefined, doctor: async () => [] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: !!r.isError, text: r.content[0].text, json: r.isError ? null : JSON.parse(r.content[0].text) };
  };
  return { client, call, close: async () => { await client.close(); await running.close(); } };
}

type Prop = { description?: string; items?: { properties: Record<string, Prop>; required?: string[] } };

describe("rushes_add_variant: a cue's file (§23.4)", () => {
  it("describes `file` on each cue, keeps name and t required, and passes it through", async () => {
    const t = await connect();
    const { tools } = await t.client.listTools();
    const cues = (tools.find((x) => x.name === "rushes_add_variant")!.inputSchema.properties as Record<string, Prop>).cues;
    expect(cues.description).toMatch(/`file`/);
    expect(cues.items!.properties.file.description).toMatch(/the sample you placed at this cue/);
    expect(cues.items!.required).toEqual(["name", "t"]);
    const r = await t.call("rushes_add_variant", {
      stage: "sfx", name: "Effects for Lumen", file: "pass.wav",
      cues: [{ name: "thud", t: 1, file: "sfx/thud_low_03.wav" }, { name: "click", t: 2 }],
    });
    expect(r.isError).toBe(false);
    expect(r.json.variant.cues).toEqual([{ id: "thud", name: "thud", t: 1, file: "sfx/thud_low_03.wav" }, { id: "click", name: "click", t: 2 }]);
    await t.close();
  });

  it("reports a cue file that isn't audio, and refuses one over 1024 characters", async () => {
    const t = await connect();
    const bad = await t.call("rushes_add_variant", { stage: "sfx", name: "Pass", file: "pass.wav", cues: [{ name: "key", t: 1, file: "notes.json" }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Cue "key": "notes\.json" isn't an audio file/);
    const long = await t
      .call("rushes_add_variant", { stage: "sfx", name: "Pass", file: "pass.wav", cues: [{ name: "thud", t: 1, file: `${"a".repeat(1021)}.wav` }] })
      .catch((e: Error) => ({ isError: true, text: e.message, json: null }));
    expect(long.isError).toBe(true);
    await t.close();
  });
});
```

- [ ] **Step 10: Run it and see it fail.** Run: `npx vitest run test/mcp/cue-files.test.ts`. Expected: FAIL, because the tool's cue schema has no `file`.

- [ ] **Step 11: Implement the tool's schema.** In `src/mcp/tools.ts`, replace line 234 with:

```ts
        cues: z
          .array(
            z.object({
              name: z.string(),
              t: z.number().nonnegative(),
              file: z
                .string()
                .min(1)
                .max(1024)
                .optional()
                .describe("Optional: the sample you placed at this cue (an audio file), so the user can see which it is and hear it on its own."),
            }),
          )
          .optional()
          .describe("SFX cues with times in seconds, each optionally with the `file` of its sample. Give a sound the same name every time it comes back: the tab groups cues by name."),
```

- [ ] **Step 12: Run the gates.** Run: `npm run build && npm run typecheck && npx vitest run`. Expected: all green. The dashboard is unchanged so far, so e2e isn't needed for this task.

- [ ] **Step 13: Commit.**

```bash
git add src/core/cues.ts src/core/schema.ts src/core/project.ts src/server/app.ts src/server/files.ts src/server/found.ts src/mcp/tools.ts test/core/cues.test.ts test/server/cue-files.test.ts test/mcp/cue-files.test.ts
git -c user.name=iamredmh -c user.email=17407420+iamredmh@users.noreply.github.com commit -m "feat: a cue can name its sample; /media serves it only when registered (§23)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

**Mutation check:** each of these changes must make a test fail:
- Removing the `cueFiles` line from `registeredMedia` must fail "/media serves a registered cue's sample…" with a 404.
- Making `isCueFile` skip the extension check must fail "a hand-edited cue file that isn't audio is never served" and "refuses a cue file that isn't audio…".
- Moving the cue loop back below the lane lookup must fail "refuses a cue file that isn't audio before it touches the project, even a new lane".

---

### Task 2: The card, the keyboard and layers by sound (§23.2, §23.5)

**Files:**
- Create: `web/src/cues.ts`, `web/src/audio/sample.ts`, `web/src/ui/CueCard.tsx`, `web/src/ui/CueLayers.tsx`, `web/src/cues.css`
- Modify: `web/src/ui/Lanes.tsx:8-14` (imports), `:29-55` (`StageRow`), `:143-153` (`LanesProps`), `:182-340` (`Lanes`)
- Modify: `web/src/ui/AudioStage.tsx:10` (import), `:27-39` and `:45-63` (the test hook), `:409-421` (`<Lanes>`)
- Modify: `web/src/ui/VariantTab.tsx:13-18` (session state), `:32-73` (`layers` on each pass)
- Modify: `web/src/main.tsx:8` (one import after it)
- Modify: `e2e/fixture.ts:60` (`VariantOptions.cues`)
- Create tests: `test/web/cues.test.ts`, `test/web/sample.test.ts`, `test/web/cues-css.test.ts`, `e2e/cues.spec.ts`

**Interfaces:**
- Consumes:
  - `Cue` with `file?: string` (Task 1, through `web/src/types.ts`'s re-export);
  - `fmt(t: number): string` and `cueRoom(cues: { t: number }[], length: number): number[]` (`web/src/lib.ts:6`, `:526`);
  - `claim(owner, stop): () => void` and `release(owner): void` (`web/src/audio/bus.ts`);
  - `mediaUrl(path: string): string` (`web/src/api.ts:69`);
  - `Icon` (names `chev`, `play`, `pause`).
- Produces (`web/src/cues.ts`, pure):

```ts
export interface CueLike { id: string; name: string; t: number; file?: string }
export function cuesInTime<C extends CueLike>(cues: readonly C[]): C[];
export function cueName(c: Pick<CueLike, "name">): string;            // trimmed, or "Untitled cue"
export function cueLabel(c: Pick<CueLike, "name" | "t">): string;     // "thud at 0:04.20"
export function cueCount(n: number, of: number): string;              // "cue 5 of 80"
export interface CueLayer<C extends CueLike = CueLike> { name: string; cues: C[]; file: string | null; moreFiles: number }
export function cueLayers<C extends CueLike>(cues: readonly C[]): CueLayer<C>[];
export function rovingIndex(key: string, i: number, n: number): number | null;
export function baseName(path: string): string;
export function tickLeft(t: number, length: number): string;          // "25.000%", clamped to 0–100
export interface Box { left: number; top: number; width: number; height: number }
export function cardPosition(anchor: Box, card: { width: number; height: number }, view: { width: number; height: number }): { left: number; top: number };
```

- Produces (`web/src/audio/sample.ts`):

```ts
export interface SampleElement { src: string; currentTime: number; play(): Promise<void>; pause(): void; addEventListener(type: "ended", listener: () => void): void }
export interface SampleState { path: string | null; playing: boolean }
export class SamplePlayer {
  constructor(make: () => SampleElement, url: (path: string) => string);
  state(): SampleState;
  subscribe(fn: (s: SampleState) => void): () => void;
  toggle(path: string): Promise<void>;   // play from the top, or stop the one playing; rejects when it won't play
  stop(): void;
}
export const samples: SamplePlayer;
```

- Produces (`web/src/ui/CueCard.tsx`): `CUE_CARD_ID = "cue-card"`, `interface CardCue { key; name; t; n; of; file: string | null; color }`, `interface CardApi { shown: string | null; show(anchor: HTMLElement, cue: CardCue): void; hide(): void }`, `useCueCard(): { shown: Shown | null; api: CardApi }`, `cardHover(api, cue)`, `CueCard({ shown, onHide })`.
- Produces (`web/src/ui/CueLayers.tsx`): `interface KeyLike`, `rovingKeyDown(e: KeyLike, selector: string, card: CardApi): void`, `interface CueLayersProps { id; name; cues: Cue[]; length; color; card: CardApi; onSeek(t: number, cueId: string): void; toast(message: string): void }`, `CueLayers(props)`.
- Produces (`web/src/ui/Lanes.tsx`):
  - `StageRow.cues?: { id: string; name: string; t: number; file?: string }[]`;
  - `StageRow.layers?: { open: boolean; onToggle(): void }`;
  - `LanesProps.onSeek(t: number, row: StageRow, cue?: string): void`;
  - `LanesProps.toast?(message: string): void`.
- Produces (`web/src/ui/AudioStage.tsx`): `AudioTestHook.sample(): SampleState` (only with `?test=1`).
- Produces (`e2e/fixture.ts`): `VariantOptions.cues?: { name: string; t: number; file?: string }[]`.
- DOM the tests rely on:
  - each cue label is `.lane .track > button.cue[data-cue]` with a `<span>` inside;
  - the chevron is `button.chev[aria-label="Layers for <name>"]`;
  - the layers are `.clayers#cl-<lane>/<variant>`, holding `.clayer[data-layer="<name>"]`, each with `.clname span` and `.clname em`, `.cltrack .ltick` and `.cltrack .playhead`, and `.clfile button`;
  - the card is `#cue-card[role=tooltip]`, with `b`, `.m` and `.f`.

- [ ] **Step 1: Write the failing unit tests for the helpers** in `test/web/cues.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { baseName, cardPosition, cueCount, cueLabel, cueLayers, cueName, cuesInTime, rovingIndex, tickLeft } from "../../web/src/cues.js";

const cue = (id: string, name: string, t: number, file?: string) => (file === undefined ? { id, name, t } : { id, name, t, file });

describe("cues in time (§23)", () => {
  it("sorts by time and keeps the sent order for cues at the same moment, without sorting in place", () => {
    const cues = [cue("b", "thud", 2), cue("a", "whoosh", 0.5), cue("c", "click", 2), cue("d", "pop", 1)];
    expect(cuesInTime(cues).map((c) => c.id)).toEqual(["a", "d", "b", "c"]);
    expect(cues.map((c) => c.id)).toEqual(["b", "a", "c", "d"]);
  });
});

describe("cueLayers: layers by sound (§23.2)", () => {
  const cues = [
    cue("thud-2", "thud", 3, "sfx/thud_low_03.wav"),
    cue("whoosh", "whoosh", 0.5, "sfx/whoosh_long_01.wav"),
    cue("thud", "thud", 1, "sfx/thud_low_03.wav"),
    cue("click", "click", 1.1),
    cue("thud-3", " thud ", 4.5, "sfx/thud_low_04.wav"),
    cue("thud-4", "Thud", 5),
    cue("blank", "   ", 6),
  ];
  const layers = cueLayers(cues);

  it("gives one layer per name, in order of first appearance in time, and repeats share it", () => {
    expect(layers.map((l) => l.name)).toEqual(["whoosh", "thud", "click", "Thud", "Untitled cue"]);
    expect(layers[1].cues.map((c) => c.id)).toEqual(["thud", "thud-2", "thud-3"]);
    expect(layers.map((l) => l.cues.length)).toEqual([1, 3, 1, 1, 1]);
  });

  it("names the first file a layer's cues send, and counts any others", () => {
    expect(layers[0]).toMatchObject({ file: "sfx/whoosh_long_01.wav", moreFiles: 0 });
    expect(layers[1]).toMatchObject({ file: "sfx/thud_low_03.wav", moreFiles: 1 });
    expect(layers[2]).toMatchObject({ file: null, moreFiles: 0 });
  });

  it("is empty for a pass with no cues", () => expect(cueLayers([])).toEqual([]));
});

describe("a cue's words", () => {
  it("names it by its trimmed name, says its time and place, and shortens a path to its file", () => {
    expect(cueName({ name: "  swoosh · end line " })).toBe("swoosh · end line");
    expect(cueName({ name: " " })).toBe("Untitled cue");
    expect(cueLabel({ name: "thud", t: 4.2 })).toBe("thud at 0:04.20");
    expect(cueCount(5, 80)).toBe("cue 5 of 80");
    expect(baseName("audio/sfx/samples/thud_low_03.wav")).toBe("thud_low_03.wav");
    expect(baseName("C:\\Library\\pop.wav")).toBe("pop.wav");
  });
});

describe("rovingIndex (§23.5 keyboard)", () => {
  it("steps left and right, jumps with Home and End, and never wraps", () => {
    expect(rovingIndex("ArrowRight", 0, 3)).toBe(1);
    expect(rovingIndex("ArrowRight", 2, 3)).toBe(2);
    expect(rovingIndex("ArrowLeft", 0, 3)).toBe(0);
    expect(rovingIndex("ArrowLeft", 2, 3)).toBe(1);
    expect(rovingIndex("Home", 2, 3)).toBe(0);
    expect(rovingIndex("End", 0, 3)).toBe(2);
  });
  it("leaves every other key alone, and does nothing with no cues", () => {
    for (const key of ["ArrowUp", "ArrowDown", "Enter", " ", "Escape", "Tab", "n"]) expect(rovingIndex(key, 1, 3)).toBeNull();
    expect(rovingIndex("ArrowRight", 0, 0)).toBeNull();
  });
});

describe("tickLeft", () => {
  it("is the time's share of the timeline, kept on the track", () => {
    expect(tickLeft(10, 40)).toBe("25.000%");
    expect(tickLeft(45, 40)).toBe("100.000%");
    expect(tickLeft(-1, 40)).toBe("0.000%");
    expect(tickLeft(3, 0)).toBe("0.000%");
  });
});

describe("cardPosition (§23.5, Review Focus 4)", () => {
  const view = { width: 1440, height: 900 };
  const card = { width: 240, height: 80 };
  it("sits under its cue, centred on it, 8 px away", () => {
    expect(cardPosition({ left: 600, top: 300, width: 6, height: 20 }, card, view)).toEqual({ left: 483, top: 328 });
  });
  it("goes above when there's no room below", () => {
    expect(cardPosition({ left: 600, top: 820, width: 6, height: 20 }, card, view)).toEqual({ left: 483, top: 732 });
  });
  it("stays 16 px inside the window at every edge", () => {
    expect(cardPosition({ left: 2, top: 300, width: 6, height: 20 }, card, view).left).toBe(16);
    expect(cardPosition({ left: 1436, top: 300, width: 6, height: 20 }, card, view).left).toBe(1440 - 16 - 240);
    expect(cardPosition({ left: 600, top: 4, width: 6, height: 20 }, { width: 240, height: 2000 }, view).top).toBe(16);
  });
});
```

- [ ] **Step 2: Run them and see them fail.** Run: `npx vitest run test/web/cues.test.ts`. Expected: FAIL, because `web/src/cues.js` is missing.

- [ ] **Step 3: Write `web/src/cues.ts`.**

```ts
// §23: pure helpers for a pass's cues on Sound effects -- time order, layers by sound, the card's
// words and where it goes, and the keys that walk a row of cues. No DOM, so they're unit-tested in Node.
import { fmt } from "./lib.js";

/** A cue as the lanes draw it: the stored cue, with its optional source file (§23.3). */
export interface CueLike {
  id: string;
  name: string;
  t: number;
  file?: string;
}

/** The cues in time order; cues at the same time keep the order they were sent in. */
export function cuesInTime<C extends CueLike>(cues: readonly C[]): C[] {
  return cues
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.t - b.c.t || a.i - b.i)
    .map((x) => x.c);
}

/** The name a cue is shown and grouped by: as sent, trimmed; "Untitled cue" when that leaves nothing. */
export function cueName(c: Pick<CueLike, "name">): string {
  return c.name.trim() || "Untitled cue";
}

/** A cue's accessible name, on its label and its ticks: "thud at 0:04.20". */
export function cueLabel(c: Pick<CueLike, "name" | "t">): string {
  return `${cueName(c)} at ${fmt(c.t)}`;
}

/** "cue 5 of 80". */
export function cueCount(n: number, of: number): string {
  return `cue ${n} of ${of}`;
}

/** One layer by sound (§23.2): every cue with one name, in time order, and the sample they name. */
export interface CueLayer<C extends CueLike = CueLike> {
  name: string;
  cues: C[];
  /** The first file its cues name, in time order, or null. */
  file: string | null;
  /** How many other files its cues name. */
  moreFiles: number;
}

/** The layers by sound: one per distinct name (cueName), in order of first appearance in time. */
export function cueLayers<C extends CueLike>(cues: readonly C[]): CueLayer<C>[] {
  const layers = new Map<string, CueLayer<C>>();
  for (const c of cuesInTime(cues)) {
    const name = cueName(c);
    let layer = layers.get(name);
    if (!layer) {
      layer = { name, cues: [], file: null, moreFiles: 0 };
      layers.set(name, layer);
    }
    layer.cues.push(c);
  }
  for (const layer of layers.values()) {
    const files = [...new Set(layer.cues.flatMap((c) => (c.file ? [c.file] : [])))];
    layer.file = files[0] ?? null;
    layer.moreFiles = Math.max(0, files.length - 1);
  }
  return [...layers.values()];
}

/** Where ←, →, Home and End move from cue `i` of `n`; null for any other key. Never wraps. */
export function rovingIndex(key: string, i: number, n: number): number | null {
  if (n <= 0) return null;
  if (key === "ArrowLeft") return Math.max(0, i - 1);
  if (key === "ArrowRight") return Math.min(n - 1, i + 1);
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return null;
}

/** The last part of a path, for the layer's file button. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** A layer tick's left edge: its time as a share of the timeline, kept on the track (ruling R16). */
export function tickLeft(t: number, length: number): string {
  const share = length > 0 ? Math.min(1, Math.max(0, t / length)) : 0;
  return `${(share * 100).toFixed(3)}%`;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where the hover card goes (§23.5): under its cue, centred on it, 8 px away; above it when
 * there's no room below; always at least 16 px inside the window.
 */
export function cardPosition(anchor: Box, card: { width: number; height: number }, view: { width: number; height: number }): { left: number; top: number } {
  const GAP = 8;
  const EDGE = 16;
  const centred = anchor.left + anchor.width / 2 - card.width / 2;
  const left = Math.max(EDGE, Math.min(centred, view.width - EDGE - card.width));
  const below = anchor.top + anchor.height + GAP;
  const top = below + card.height <= view.height - EDGE ? below : Math.max(EDGE, anchor.top - GAP - card.height);
  return { left: Math.round(left), top: Math.round(top) };
}
```

- [ ] **Step 4: Run them and see them pass.** Run: `npx vitest run test/web/cues.test.ts`. Expected: PASS.

- [ ] **Step 5: Write the failing sample-player tests** in `test/web/sample.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { claim, owner, release } from "../../web/src/audio/bus.js";
import { SamplePlayer, type SampleElement, type SampleState } from "../../web/src/audio/sample.js";

class FakeAudio implements SampleElement {
  src = "";
  currentTime = 0;
  paused = true;
  fail = false;
  private readonly onEnded: (() => void)[] = [];
  async play(): Promise<void> {
    if (this.fail) throw new Error("NotSupportedError");
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
  addEventListener(_type: "ended", fn: () => void): void {
    this.onEnded.push(fn);
  }
  end(): void {
    this.paused = true;
    for (const fn of this.onEnded) fn();
  }
}

const THUD = "audio/sfx/samples/thud_low_03.wav";
const POP = "audio/sfx/samples/pop_bubble_05.wav";
let made: SamplePlayer[] = [];

function setup() {
  const el = new FakeAudio();
  let elements = 0;
  const player = new SamplePlayer(() => (elements++, el), (p) => `/media?path=${encodeURIComponent(p)}`);
  made.push(player);
  return { el, player, elements: () => elements };
}

afterEach(() => {
  for (const p of made) p.stop();
  made = [];
  const o = owner();
  if (o !== null) release(o);
});

describe("SamplePlayer: a cue's sample on the one-player bus (§23, ruling R9)", () => {
  it("makes its one element only when first asked to play", async () => {
    const { player, elements } = setup();
    expect(elements()).toBe(0);
    await player.toggle(THUD);
    await player.toggle(POP);
    expect(elements()).toBe(1);
  });

  it("plays from the top and stops whoever held the bus", async () => {
    const { el, player } = setup();
    let engineStops = 0;
    claim("engine", () => engineStops++);
    el.currentTime = 2.5;
    await player.toggle(THUD);
    expect(engineStops).toBe(1);
    expect(owner()).toBe(player);
    expect(el.src).toBe("/media?path=audio%2Fsfx%2Fsamples%2Fthud_low_03.wav");
    expect(el.currentTime).toBe(0);
    expect(el.paused).toBe(false);
    expect(player.state()).toEqual({ path: THUD, playing: true });
  });

  it("a second press on the playing sample stops it and lets the bus go; another sample swaps in", async () => {
    const { el, player } = setup();
    await player.toggle(THUD);
    await player.toggle(THUD);
    expect(player.state()).toEqual({ path: THUD, playing: false });
    expect(el.paused).toBe(true);
    expect(owner()).toBeNull();
    await player.toggle(POP);
    expect(player.state()).toEqual({ path: POP, playing: true });
    expect(el.src).toContain("pop_bubble_05.wav");
  });

  it("stops when anything else claims the bus (Play on the tab)", async () => {
    const { el, player } = setup();
    await player.toggle(THUD);
    claim("engine", () => undefined);
    expect(el.paused).toBe(true);
    expect(player.state().playing).toBe(false);
    expect(owner()).toBe("engine");
  });

  it("lets the bus go when the sample ends", async () => {
    const { el, player } = setup();
    await player.toggle(THUD);
    el.end();
    expect(player.state()).toEqual({ path: THUD, playing: false });
    expect(owner()).toBeNull();
  });

  it("a sample that won't play rejects, and isn't left marked as playing (Review Focus 5)", async () => {
    const { el, player } = setup();
    el.fail = true;
    await expect(player.toggle(THUD)).rejects.toThrow(/NotSupportedError/);
    expect(player.state()).toEqual({ path: THUD, playing: false });
    expect(owner()).toBeNull();
  });

  it("tells its subscribers about each change, until they unsubscribe", async () => {
    const { el, player } = setup();
    const seen: SampleState[] = [];
    const off = player.subscribe((s) => seen.push(s));
    await player.toggle(THUD);
    el.end();
    off();
    await player.toggle(POP);
    expect(seen).toEqual([{ path: THUD, playing: true }, { path: THUD, playing: false }]);
  });
});
```

- [ ] **Step 6: Run them and see them fail.** Run: `npx vitest run test/web/sample.test.ts`. Expected: FAIL, because `web/src/audio/sample.js` is missing.

- [ ] **Step 7: Write `web/src/audio/sample.ts`.**

```ts
// §23: the one player for a cue's source sample. It shares the one-player bus (bus.ts) with the
// audio engine and the Assets player: playing a sample stops whatever was playing, and anything
// that starts later stops the sample. One element for the whole page, made on first use.
import { mediaUrl } from "../api.js";
import { claim, release } from "./bus.js";

/** What the player needs from an <audio> element (a fake in unit tests). */
export interface SampleElement {
  src: string;
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: "ended", listener: () => void): void;
}

export interface SampleState {
  /** The sample last played (null: none yet). */
  path: string | null;
  playing: boolean;
}

export class SamplePlayer {
  private el: SampleElement | null = null;
  private current: SampleState = { path: null, playing: false };
  private readonly listeners = new Set<(s: SampleState) => void>();
  private readonly make: () => SampleElement;
  private readonly url: (path: string) => string;

  constructor(make: () => SampleElement, url: (path: string) => string) {
    this.make = make;
    this.url = url;
  }

  state(): SampleState {
    return this.current;
  }

  subscribe(fn: (s: SampleState) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Plays `path` from the top, or stops it when it's the one playing. Rejects when it won't play. */
  async toggle(path: string): Promise<void> {
    if (this.current.playing && this.current.path === path) return this.stop();
    const el = this.element();
    el.pause();
    if (this.current.path !== path) el.src = this.url(path);
    el.currentTime = 0;
    claim(this, () => this.stop());
    this.set({ path, playing: true });
    try {
      await el.play();
    } catch (err) {
      // A later claim pausing this one interrupts play(): only a real failure is reported.
      if (this.current.path === path && this.current.playing) {
        release(this);
        this.set({ path, playing: false });
        throw err;
      }
    }
  }

  stop(): void {
    this.el?.pause();
    release(this);
    if (this.current.playing) this.set({ ...this.current, playing: false });
  }

  private element(): SampleElement {
    if (!this.el) {
      const el = this.make();
      el.addEventListener("ended", () => {
        release(this);
        this.set({ ...this.current, playing: false });
      });
      this.el = el;
    }
    return this.el;
  }

  private set(next: SampleState): void {
    this.current = next;
    for (const fn of this.listeners) fn(next);
  }
}

/** The page's one sample player. */
export const samples = new SamplePlayer(() => new Audio(), mediaUrl);
```

- [ ] **Step 8: Run them and see them pass.** Run: `npx vitest run test/web/sample.test.ts test/web/bus.test.ts`. Expected: PASS.

- [ ] **Step 9: Write the failing stylesheet test** in `test/web/cues-css.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../web/src/cues.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const main = readFileSync(new URL("../../web/src/main.tsx", import.meta.url), "utf8");

describe("cues.css (§23)", () => {
  it("is loaded after styles.css, so its overrides win", () => {
    expect(main.indexOf('import "./cues.css";')).toBeGreaterThan(main.indexOf('import "./styles.css";'));
    expect(main.indexOf('import "./styles.css";')).toBeGreaterThan(-1);
  });

  it("sets no type under 15 px", () => {
    const sizes = [...css.matchAll(/font(?:-size)?:[^;]*?(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    for (const s of sizes) expect(s).toBeGreaterThanOrEqual(15);
  });

  it("uses explicit grid tracks: every fraction is minmax(0, 1fr) (Safari)", () => {
    const grids = [...css.matchAll(/grid-template-columns:([^;]+);/g)];
    expect(grids.length).toBeGreaterThan(0);
    for (const m of grids) expect(m[1].replace(/minmax\(0, 1fr\)/g, "")).not.toMatch(/\dfr/);
  });

  it("scrolls the layers after about eight rows (8 × 30 px + 7 × 3 px)", () => {
    expect(css).toMatch(/\.clayers \{[^}]*max-height: 261px;[^}]*overflow-y: auto;/);
  });

  it("turns the chevron without motion when motion is reduced", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.chev svg\.ic \{ transition: none; \}/);
  });
});
```

- [ ] **Step 10: Run it and see it fail.** Run: `npx vitest run test/web/cues-css.test.ts`. Expected: FAIL, because `web/src/cues.css` is missing.

- [ ] **Step 11: Write `web/src/cues.css` and import it.** Create `web/src/cues.css`:

```css
/* §23: sound-effects cue layers -- the chevron, the cue buttons on a pass's waveform, the layers by
   sound and the hover card. Loaded after styles.css. Explicit grid tracks throughout (Safari). */

/* A pass's name cell: the chevron, then the name button (a button can't hold another, ruling R1). */
.lane .nmc { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 8px; align-items: center; min-width: 0; }
.lane .nmc > .nm { margin-left: 0; }
.chev { width: 26px; height: 26px; display: grid; place-items: center; padding: 0; border: 1px solid var(--line-2); border-radius: 8px; background: transparent; color: var(--text-2); cursor: pointer; }
.chev:hover:not(:disabled) { background: var(--hover); color: var(--text); }
.chev:disabled { opacity: 0.4; cursor: default; }
.chev svg.ic { width: 14px; height: 14px; transform: rotate(-90deg); transition: transform 0.16s; }
.chev[aria-expanded="true"] svg.ic { transform: none; }

/* The cue labels are buttons (§23.5): reachable, and hoverable for the card. These outrank
   styles.css's .cue and .cue-tick, which take no pointer. */
.track .cue { pointer-events: auto; cursor: pointer; padding: 0; border: 0; background: none; border-radius: 4px; text-align: center; }
.track .cue > span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.track .cue.hot > span { text-decoration: underline; text-underline-offset: 3px; }
.track .cue:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.track .cue-tick { pointer-events: auto; cursor: pointer; }
.track .cue-tick::before { content: ""; position: absolute; top: 0; bottom: 0; left: -4px; right: -4px; }
.track .cue-tick.hot { opacity: 1; width: 2px; }

/* The layers by sound: the lanes' own three tracks, so each layer's track lines up with the pass's. */
.clayers { display: grid; grid-template-columns: minmax(0, 1fr); gap: 3px; max-height: 261px; overflow-y: auto; overscroll-behavior: contain; }
.clayer { display: grid; grid-template-columns: 180px minmax(0, 1fr) 136px; gap: 16px; align-items: center; height: 30px; }
.clname { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; color: var(--text-2); font-size: 15px; }
.clname span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.clname em { flex: none; font: 15px var(--mono); font-style: normal; color: var(--text-3); }
.cltrack { position: relative; height: 30px; background: var(--raised); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.ltick { position: absolute; top: 4px; width: 6px; height: 20px; padding: 0; border: 0; border-radius: 3px; background: var(--lane); transform: translateX(-50%); cursor: pointer; z-index: 2; }
.ltick:hover, .ltick.hot { background: var(--text); box-shadow: 0 0 0 2px var(--lane); }
.ltick:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.cltrack .playhead { top: 0; bottom: 0; }
.cltrack .playhead::before { display: none; }
.clfile { display: flex; align-items: center; gap: 6px; min-width: 0; }
.clfile button { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; height: 28px; padding: 0 6px; border: 0; border-radius: 6px; background: transparent; color: var(--lane); font: 15px var(--mono); cursor: pointer; }
.clfile button:hover, .clfile button[aria-pressed="true"] { background: var(--raised); }
.clfile button span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.clfile button svg.ic { width: 14px; height: 14px; flex: none; }
.clfile small { flex: none; font: 15px var(--mono); color: var(--text-3); }

/* The hover card: a tooltip, so it never takes the pointer (ruling R6). */
.cuecard { position: fixed; z-index: 50; pointer-events: none; display: grid; gap: 2px; min-width: 200px; max-width: min(420px, calc(100vw - 32px)); padding: 8px 12px; background: #000; border: 1px solid var(--line-2); border-radius: 10px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5); color: var(--text); font-size: 15px; line-height: 1.4; }
.cuecard b { font-weight: 600; overflow-wrap: anywhere; }
.cuecard .m { font: 15px var(--mono); color: var(--text-2); }
.cuecard .f { font: 15px var(--mono); overflow-wrap: anywhere; }

@media (prefers-reduced-motion: reduce) {
  .chev svg.ic { transition: none; }
}
```

In `web/src/main.tsx`, after line 8 (`import "./styles.css";`), add `import "./cues.css";`.

- [ ] **Step 12: Run it and see it pass.** Run: `npx vitest run test/web/cues-css.test.ts test/web/styles.test.ts`. Expected: PASS.

- [ ] **Step 13: Add the fixture type and write the failing e2e tests.** In `e2e/fixture.ts`, change line 60 to `cues?: { name: string; t: number; file?: string }[];`. Then create `e2e/cues.spec.ts`:

```ts
// §23: sound-effects cue layers -- the hover card, the chevron's layers by sound, the keyboard and
// a cue's own sample. Every page goes to `rushes.testUrl()` (`?test=1`), which exposes the engine.
import type { Page } from "@playwright/test";
import { expect, type Rushes, test } from "./fixture.js";

type Hook = {
  inspect(): { playing: boolean; time: number; media: string[] } | null;
  renders: number;
  sample(): { path: string | null; playing: boolean };
};

/** The engine's state, the stage's render count and the sample player's state, read in one go. */
const hook = (page: Page) =>
  page.evaluate(() => {
    const h = (window as unknown as { __rushesAudio: Hook }).__rushesAudio;
    const s = h.inspect();
    return { playing: s?.playing ?? false, time: s?.time ?? 0, media: s?.media.length ?? 0, renders: h.renders, sample: h.sample() };
  });

/** Open Sound effects once it has unlocked, and wait until its engine holds `files` files. */
async function openSfx(page: Page, rushes: Rushes, files: number) {
  await page.goto(rushes.testUrl());
  const tab = page.getByRole("tab", { name: /Sound effects/ });
  await expect(tab).not.toHaveAttribute("data-locked");
  await page.keyboard.press("5");
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect.poll(async () => (await hook(page)).media, { timeout: 10_000 }).toBe(files);
}

const PASS = "sfx/effects-for-lumen";
const THUD = "audio/sfx/samples/thud_low_03.wav";
const WHOOSH = "audio/sfx/samples/whoosh_long_01.wav";
const lane = (page: Page) => page.locator(`.lane[data-row="${PASS}"]`);
const layers = (page: Page) => page.locator(`.clayers[id="cl-${PASS}"]`);
const card = (page: Page) => page.getByRole("tooltip");
const chevron = (page: Page, name = "Effects for Lumen") => page.getByRole("button", { name: `Layers for ${name}`, exact: true });

/**
 * A 6 s pass with five cues, sent out of time order: thud ×3 and whoosh with their samples (thud's
 * is 4 s, long enough to watch), and one long name with no file; plus a pass with no cues.
 * In time: whoosh 0.5 (1), thud 1.5 (2), power-down · offline 2.1 (3), thud 3.0 (4), thud 4.5 (5).
 */
async function lumen(page: Page, rushes: Rushes, opts: { music?: boolean } = {}) {
  await rushes.writeFiles([{ path: THUD, seconds: 4, freq: 110 }, { path: WHOOSH, seconds: 0.6, freq: 660 }]);
  await rushes.addVariant("sfx", "Effects for Lumen", {
    seconds: 6,
    freq: 880,
    cues: [
      { name: "thud", t: 3, file: THUD },
      { name: "whoosh", t: 0.5, file: WHOOSH },
      { name: "thud", t: 1.5, file: THUD },
      { name: "power-down · offline", t: 2.1 },
      { name: "thud", t: 4.5, file: THUD },
    ],
  });
  await rushes.addVariant("sfx", "Effects, levelled", { seconds: 6, freq: 660 });
  if (opts.music) await rushes.addVariant("music", "Night drive", { seconds: 2, freq: 220 });
  await openSfx(page, rushes, 2);
}

test("hovering a cut-short cue label or its tick shows the full name, the time, its place and its sample", async ({ page, rushes }) => {
  await lumen(page, rushes);
  await expect(lane(page).locator(".cue")).toHaveText(["whoosh", "thud", "power-down · offline", "thud", "thud"]);
  const long = lane(page).locator('.cue[data-cue="power-down-offline"]');
  expect(await long.locator("span").evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  await long.hover();
  await expect(card(page).locator("b")).toHaveText("power-down · offline");
  await expect(card(page).locator(".m")).toHaveText("0:02.10 · cue 3 of 5");
  // No file was sent: the card says nothing about one.
  await expect(card(page).locator(".f")).toHaveCount(0);
  await expect(card(page)).not.toContainText("file");
  await expect(long).toHaveAttribute("aria-describedby", "cue-card");
  // The tick of the cue at 3 s (sent first, fourth in time) has its own card, with its sample.
  await lane(page).locator(".cue-tick").nth(3).hover();
  await expect(card(page).locator("b")).toHaveText("thud");
  await expect(card(page).locator(".m")).toHaveText("0:03.00 · cue 4 of 5");
  await expect(card(page).locator(".f")).toHaveText(THUD);
  const box = (await card(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(16);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width - 16);
  await page.mouse.move(5, 5);
  await expect(card(page)).toHaveCount(0);
});

test("the cue labels are one Tab stop; ←/→ walk them in time without stepping frames; Enter moves the playhead and aims the note; Esc hides the card", async ({ page, rushes }) => {
  await lumen(page, rushes);
  const cue = (name: string) => lane(page).getByRole("button", { name, exact: true });
  await expect(lane(page).locator('.cue[tabindex="0"]')).toHaveCount(1);
  await expect(cue("whoosh at 0:00.50")).toHaveAttribute("tabindex", "0");
  await cue("whoosh at 0:00.50").focus();
  await expect(card(page).locator("b")).toHaveText("whoosh");
  await page.keyboard.press("ArrowRight");
  await expect(cue("thud at 0:01.50")).toBeFocused();
  await expect(card(page).locator(".m")).toHaveText("0:01.50 · cue 2 of 5");
  await page.keyboard.press("End");
  await expect(cue("thud at 0:04.50")).toBeFocused();
  // The last cue: nowhere further to go, and no frame step either.
  await page.keyboard.press("ArrowRight");
  await expect(cue("thud at 0:04.50")).toBeFocused();
  expect((await hook(page)).time).toBe(0);
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);
  await expect(cue("thud at 0:04.50")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await hook(page)).time).toBeCloseTo(4.5, 3);
  expect((await hook(page)).playing).toBe(false);
  await expect(page.getByRole("combobox", { name: "Note on" })).toHaveValue(`c:${PASS}:thud-3`);
  await expect(lane(page)).toHaveAttribute("aria-current", "true");
  await expect(cue("thud at 0:04.50")).toHaveAttribute("tabindex", "0");
  await expect(lane(page).locator('.cue[tabindex="0"]')).toHaveCount(1);
});

test("the chevron opens one layer per sound, in order of first appearance, with counts; repeats share a layer; a tick moves the playhead", async ({ page, rushes }) => {
  await lumen(page, rushes);
  const chev = chevron(page);
  await expect(chev).toHaveAttribute("aria-expanded", "false");
  await expect(layers(page)).toHaveCount(0);
  await chev.click();
  await expect(chev).toHaveAttribute("aria-expanded", "true");
  await expect(chev).toHaveAttribute("aria-controls", `cl-${PASS}`);
  await expect(layers(page)).toHaveAttribute("aria-label", "Layers for Effects for Lumen");
  await expect(layers(page).locator(".clname span")).toHaveText(["whoosh", "thud", "power-down · offline"]);
  await expect(layers(page).locator(".clname em")).toHaveText(["×1", "×3", "×1"]);
  await expect(layers(page).locator('.clayer[data-layer="thud"] .ltick')).toHaveCount(3);
  // A pass with no cues has nothing to open.
  await expect(chevron(page, "Effects, levelled")).toBeDisabled();
  // Each layer's track lines up with the pass's own.
  const lt = (await layers(page).locator(".cltrack").first().boundingBox())!;
  const tr = (await lane(page).locator(".track").boundingBox())!;
  expect(Math.abs(lt.x - tr.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(lt.width - tr.width)).toBeLessThanOrEqual(1);
  // Hover a tick for its card; click it to move the playhead there, without playing.
  const tick = layers(page).getByRole("button", { name: "thud at 0:03.00", exact: true });
  await tick.hover();
  await expect(card(page).locator(".m")).toHaveText("0:03.00 · cue 4 of 5");
  await tick.click();
  await expect.poll(async () => (await hook(page)).time).toBeCloseTo(3, 3);
  expect((await hook(page)).playing).toBe(false);
  await expect(lane(page)).toHaveAttribute("aria-current", "true");
  await chev.click();
  await expect(layers(page)).toHaveCount(0);
  await expect(card(page)).toHaveCount(0);
});

test("in a layer, ←/→ move between its ticks without stepping frames, Enter moves the playhead, the card shows on focus and Esc hides it", async ({ page, rushes }) => {
  await lumen(page, rushes);
  await chevron(page).click();
  for (const name of ["whoosh", "thud", "power-down · offline"]) {
    await expect(layers(page).locator(`.clayer[data-layer="${name}"] .ltick[tabindex="0"]`)).toHaveCount(1);
  }
  const tick = (name: string) => layers(page).getByRole("button", { name, exact: true });
  await tick("thud at 0:01.50").focus();
  await expect(card(page).locator(".m")).toHaveText("0:01.50 · cue 2 of 5");
  await expect(tick("thud at 0:01.50")).toHaveAttribute("aria-describedby", "cue-card");
  await page.keyboard.press("ArrowRight");
  await expect(tick("thud at 0:03.00")).toBeFocused();
  await expect(card(page).locator(".m")).toHaveText("0:03.00 · cue 4 of 5");
  await page.keyboard.press("End");
  await expect(tick("thud at 0:04.50")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tick("thud at 0:01.50")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(tick("thud at 0:01.50")).toBeFocused();
  expect((await hook(page)).time).toBe(0);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);
  await expect(tick("thud at 0:03.00")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await hook(page)).time).toBeCloseTo(3, 3);
  await expect(page.getByRole("combobox", { name: "Note on" })).toHaveValue(`c:${PASS}:thud`);
  await expect(layers(page).locator('.clayer[data-layer="thud"] .ltick[tabindex="0"]')).toHaveAccessibleName("thud at 0:03.00");
});

test("layers opened mid-play have playheads that move with the lane's, and nothing re-renders per frame", async ({ page, rushes }) => {
  await lumen(page, rushes);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await hook(page)).time).toBeGreaterThan(0.3);
  // Opened while playing, so only the toggle's own re-render can hand these playheads to paint().
  await chevron(page).click();
  await expect(layers(page).locator(".playhead")).toHaveCount(3);
  const before = (await hook(page)).renders;
  await page.waitForTimeout(600);
  const lefts = await page.locator(".astage .playhead").evaluateAll((els) => els.map((e) => (e as HTMLElement).style.left));
  expect(lefts).toHaveLength(5); // two passes, three layers
  expect(new Set(lefts).size).toBe(1);
  expect(lefts[0]).not.toBe("0%");
  expect((await hook(page)).renders - before).toBeLessThan(10);
});

test("a pass's layers stay open for the session, across tabs, and start shut after a reload", async ({ page, rushes }) => {
  await lumen(page, rushes, { music: true });
  await chevron(page).click();
  await page.keyboard.press("4");
  await expect(page.getByRole("tab", { name: /Music/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("5");
  await expect(chevron(page)).toHaveAttribute("aria-expanded", "true");
  await expect(layers(page).locator(".clayer")).toHaveCount(3);
  await expect(chevron(page, "Effects, levelled")).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(page.getByRole("tab", { name: /Sound effects/ })).toBeVisible();
  await page.keyboard.press("5");
  await expect(chevron(page)).toHaveAttribute("aria-expanded", "false");
  await expect(layers(page)).toHaveCount(0);
});

test("a layer's file button plays its sample on the one-player bus: it stops the tab, Play stops it, and closing the layers stops it", async ({ page, rushes }) => {
  await lumen(page, rushes);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await hook(page)).playing).toBe(true);
  await chevron(page).click();
  const thud = layers(page).getByRole("button", { name: `Play ${THUD}`, exact: true });
  await expect(thud).toHaveText("thud_low_03.wav");
  await expect(layers(page).locator('.clayer[data-layer="power-down · offline"] .clfile button')).toHaveCount(0);
  await thud.click();
  await expect(thud).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await hook(page)).sample).toEqual({ path: THUD, playing: true });
  expect((await hook(page)).playing).toBe(false);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await hook(page)).sample.playing).toBe(false);
  await expect(thud).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await hook(page)).playing).toBe(true);
  // Played again, then the layers close under it: the sample stops too.
  await thud.click();
  await expect.poll(async () => (await hook(page)).sample.playing).toBe(true);
  await chevron(page).click();
  await expect.poll(async () => (await hook(page)).sample.playing).toBe(false);
});

test("a sample that isn't there says so, and nothing is left playing", async ({ page, rushes }) => {
  await rushes.addVariant("sfx", "Effects for Lumen", { seconds: 4, freq: 880, cues: [{ name: "boom", t: 1, file: "audio/sfx/samples/gone.wav" }] });
  await openSfx(page, rushes, 1);
  await chevron(page).click();
  const boom = layers(page).getByRole("button", { name: "Play audio/sfx/samples/gone.wav", exact: true });
  await boom.click();
  await expect(page.getByRole("status")).toContainText("Couldn't play gone.wav");
  await expect(boom).toHaveAttribute("aria-pressed", "false");
  expect((await hook(page)).sample.playing).toBe(false);
});

test("Mix's Sound effects lane shows the card and walks its cues; it has no layers", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles([{ path: THUD, seconds: 0.4, freq: 110 }]);
  const pass = await rushes.addVariant("sfx", "Effects for Lumen", { seconds: 4, freq: 880, cues: [{ name: "whoosh", t: 0.5 }, { name: "thud", t: 2, file: THUD }] });
  await rushes.api("PUT", "/api/picks", { lanes: { [pass.lane.id]: pass.variant.id } });
  await page.goto(rushes.testUrl());
  const tab = page.getByRole("tab", { name: /Mix/ });
  await expect(tab).not.toHaveAttribute("data-locked");
  await page.keyboard.press("6");
  await expect(page.locator(".lane")).toHaveCount(3);
  const sfx = page.locator('.lane[data-row="sfx"]');
  await expect(sfx.locator(".cue")).toHaveCount(2);
  await expect(sfx.locator(".chev")).toHaveCount(0);
  await sfx.locator('.cue[data-cue="thud"]').hover();
  await expect(card(page).locator("b")).toHaveText("thud");
  await expect(card(page).locator(".m")).toHaveText("0:02.00 · cue 2 of 2");
  await expect(card(page).locator(".f")).toHaveText(THUD);
  await sfx.getByRole("button", { name: "whoosh at 0:00.50", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(sfx.getByRole("button", { name: "thud at 0:02.00", exact: true })).toBeFocused();
});
```

- [ ] **Step 14: Run them and see them fail.** First check the machine is quiet: `uptime; sysctl -n hw.ncpu; pgrep -fl 'playwright|ffmpeg'`. The load average must be under the CPU count, and nothing may be listed but long-lived playwright-mcp servers. Then run: `npm run build && npx playwright test e2e/cues.spec.ts --project=chromium --retries=0`. Expected: FAIL. There's no tooltip, no chevron, and `sample` isn't on the hook.

- [ ] **Step 15: Write `web/src/ui/CueCard.tsx`.**

```tsx
// §23: the hover card for a cue -- its full name, its time, where it falls in the pass and, when
// the agent sent one, its source file in the lane colour. One per audio tab: Lanes owns it. It shows
// on hover or focus, never takes the pointer, follows its cue when anything scrolls (focusing a tick
// can scroll the layers), and goes on leave, blur or Esc, or when its cue leaves the page.
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { cardPosition, cueCount } from "../cues.js";
import { fmt } from "../lib.js";

/** The card's id: the cue it's showing is described by it. */
export const CUE_CARD_ID = "cue-card";

/** What the card says about one cue. `key` tells cues apart across a lane and its layers. */
export interface CardCue {
  key: string;
  name: string;
  t: number;
  /** Its place in time order, from 1. */
  n: number;
  of: number;
  file: string | null;
  color: string;
}

interface Shown {
  cue: CardCue;
  anchor: HTMLElement;
}

export interface CardApi {
  /** The key of the cue on show, or null. */
  shown: string | null;
  show(anchor: HTMLElement, cue: CardCue): void;
  hide(): void;
}

/** The card's state, for a Lanes: what it shows, and the calls that change it. Never per frame. */
export function useCueCard(): { shown: Shown | null; api: CardApi } {
  const [shown, setShown] = useState<Shown | null>(null);
  return {
    shown,
    api: {
      shown: shown?.cue.key ?? null,
      show: (anchor, cue) => setShown((s) => (s && s.anchor === anchor && s.cue.key === cue.key ? s : { anchor, cue })),
      hide: () => setShown(null),
    },
  };
}

/** The pointer half of the card's triggers, for a cue's label or tick. Each button wires focus itself. */
export function cardHover(api: CardApi, cue: CardCue) {
  return {
    onPointerEnter: (e: { currentTarget: EventTarget | null }) => api.show(e.currentTarget as HTMLElement, cue),
    onPointerLeave: () => api.hide(),
  };
}

export function CueCard({ shown, onHide }: { shown: Shown | null; onHide(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    setAt(null);
    if (!shown) return;
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const r = shown.anchor.getBoundingClientRect();
      const next = cardPosition(
        { left: r.left, top: r.top, width: r.width, height: r.height },
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setAt((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [shown]);
  // Its cue gone from the page (the layers closed under it): the card goes too.
  useLayoutEffect(() => {
    if (shown && !shown.anchor.isConnected) onHide();
  });
  if (!shown) return null;
  const c = shown.cue;
  return (
    <div
      ref={ref}
      id={CUE_CARD_ID}
      class="cuecard"
      role="tooltip"
      style={at ? { left: `${at.left}px`, top: `${at.top}px` } : { left: "0px", top: "0px", visibility: "hidden" }}
    >
      <b>{c.name}</b>
      <span class="m">
        {fmt(c.t)} · {cueCount(c.n, c.of)}
      </span>
      {c.file !== null && (
        <span class="f" style={{ color: c.color }}>
          {c.file}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 16: Write `web/src/ui/CueLayers.tsx`.**

```tsx
// §23: a pass's layers by sound, under its row. Each cue name gets one layer, in order of first
// appearance. A layer has its count, a tick everywhere that sound comes in, its own playhead line
// (moved by AudioStage with the lane's, never by state here) and, when the agent sent one, the
// sample's file as a play button on the one-player bus.
import { useEffect, useRef, useState } from "preact/hooks";
import { type SampleState, samples } from "../audio/sample.js";
import { baseName, cueLabel, cueLayers, cuesInTime, rovingIndex, tickLeft } from "../cues.js";
import type { Cue } from "../types.js";
import { type CardApi, type CardCue, CUE_CARD_ID, cardHover } from "./CueCard.js";
import { Icon } from "./Icon.js";

/** What rovingKeyDown reads off a key event. */
export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  currentTarget: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * ←/→/Home/End move focus among the `selector` buttons beside this one (DOM order is time order);
 * Esc hides the card. Those keys stop here, so the transport's ←/→ frame steps (AudioStage's
 * window handler) don't fire while a cue has focus (ruling R7).
 */
export function rovingKeyDown(e: KeyLike, selector: string, card: CardApi): void {
  if (e.key === "Escape") {
    if (card.shown !== null) {
      e.preventDefault();
      e.stopPropagation();
      card.hide();
    }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const self = e.currentTarget as HTMLElement;
  const all = [...(self.parentElement?.querySelectorAll<HTMLElement>(`:scope > ${selector}`) ?? [])];
  const next = rovingIndex(e.key, all.indexOf(self), all.length);
  if (next === null) return;
  e.preventDefault();
  e.stopPropagation();
  all[next].focus();
}

export interface CueLayersProps {
  /** The element id, which the chevron's aria-controls names. */
  id: string;
  /** The pass's name, for the group's accessible name. */
  name: string;
  cues: Cue[];
  /** The timeline's length in seconds, as the lanes use. */
  length: number;
  color: string;
  card: CardApi;
  /** A tick was pressed: move the playhead to `t` and aim the note at the cue. */
  onSeek(t: number, cueId: string): void;
  toast(message: string): void;
}

function useSample(): SampleState {
  const [state, setState] = useState(samples.state());
  useEffect(() => samples.subscribe(setState), []);
  return state;
}

export function CueLayers({ id, name, cues, length, color, card, onSeek, toast }: CueLayersProps) {
  const order = cuesInTime(cues);
  const place = new Map(order.map((c, i) => [c, i + 1] as const));
  const layers = cueLayers(cues);
  // Each layer's Tab stop: the tick last focused, else its first.
  const [active, setActive] = useState<Record<string, number>>({});
  const sample = useSample();
  const ownFiles = useRef(new Set<string>());
  ownFiles.current = new Set(cues.flatMap((c) => (c.file ? [c.file] : [])));
  // Closing the layers (or leaving the tab) stops a sample they started.
  useEffect(
    () => () => {
      const s = samples.state();
      if (s.playing && s.path !== null && ownFiles.current.has(s.path)) samples.stop();
    },
    [],
  );
  const audition = async (file: string) => {
    try {
      await samples.toggle(file);
    } catch {
      toast(`Couldn't play ${baseName(file)}`);
    }
  };

  return (
    <div class="clayers" id={id} role="group" aria-label={`Layers for ${name}`} style={`--lane: ${color}`}>
      {layers.map((l) => {
        const at = Math.min(active[l.name] ?? 0, l.cues.length - 1);
        const file = l.file;
        const playing = file !== null && sample.playing && sample.path === file;
        return (
          <div class="clayer" key={l.name} data-layer={l.name}>
            <div class="clname">
              <span>{l.name}</span>
              <em>×{l.cues.length}</em>
            </div>
            <div class="cltrack">
              {l.cues.map((c, j) => {
                const cc: CardCue = { key: `l:${id}:${c.id}`, name: l.name, t: c.t, n: place.get(c) ?? j + 1, of: order.length, file: c.file ?? null, color };
                const shown = card.shown === cc.key;
                return (
                  <button
                    type="button"
                    class={`ltick${shown ? " hot" : ""}`}
                    key={c.id}
                    tabIndex={j === at ? 0 : -1}
                    style={{ left: tickLeft(c.t, length) }}
                    aria-label={cueLabel(c)}
                    aria-describedby={shown ? CUE_CARD_ID : undefined}
                    {...cardHover(card, cc)}
                    onFocus={(e) => {
                      setActive((a) => (a[l.name] === j ? a : { ...a, [l.name]: j }));
                      card.show(e.currentTarget, cc);
                    }}
                    onBlur={() => card.hide()}
                    onKeyDown={(e) => rovingKeyDown(e, "button.ltick", card)}
                    onClick={() => onSeek(c.t, c.id)}
                  />
                );
              })}
              <div class="playhead" />
            </div>
            <div class="clfile">
              {file !== null && (
                <button type="button" aria-pressed={playing} aria-label={`Play ${file}`} onClick={() => void audition(file)}>
                  <Icon name={playing ? "pause" : "play"} />
                  <span>{baseName(file)}</span>
                </button>
              )}
              {l.moreFiles > 0 && <small>+{l.moreFiles}</small>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 17: Change `web/src/ui/Lanes.tsx`.**
  - **Imports.** After line 13 (`import { Missing } from "./AssetViews.js";`), add:

```ts
import { cueLabel, cueName, cuesInTime } from "../cues.js";
import { type CardCue, CUE_CARD_ID, CueCard, cardHover, useCueCard } from "./CueCard.js";
import { CueLayers, rovingKeyDown } from "./CueLayers.js";
```

  - **`StageRow`.** Replace lines 36–37 (the `cues` field) with:

```ts
  /** SFX cues, labelled on the waveform at their times. `file` is the cue's sample, when the agent sent one (§23). */
  cues?: { id: string; name: string; t: number; file?: string }[];
  /** §23: the chevron that opens this pass's layers by sound. Only Sound effects passes have one. */
  layers?: { open: boolean; onToggle(): void };
```

  - **`LanesProps`.** Replace line 152 (`onSeek(t: number, row: StageRow): void;`) with:

```ts
  /** A seek on a lane; `cue` when a cue's label or tick was pressed (§23). */
  onSeek(t: number, row: StageRow, cue?: string): void;
  /** For a cue's sample that won't play (§23). */
  toast?(message: string): void;
```

  - **The `Lanes` function.** Replace lines 182–340 with:

```tsx
/** A cue as a lane draws it. */
type LaneCue = NonNullable<StageRow["cues"]>[number];

export function Lanes({ rows, length, media, selected, marks, range, onSelect, onSeek, toast }: LanesProps) {
  const pct = (s: number) => `${length > 0 ? (s / length) * 100 : 0}%`;

  // A name or meta line cut off by its column shows in full as a tooltip. Measured when the rows'
  // text changes or the window resizes, never per frame.
  const root = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState<Cut>({});
  const measure = () => {
    if (root.current) {
      const next = measureCut(root.current);
      setCut((prev) => (sameCut(prev, next) ? prev : next));
    }
  };
  // The long-file and won't-play marks join a meta line once its media loads, and can cut it off.
  const mediaMarks = rows.map((r) => {
    const results = r.clips.map((c) => media[mediaKey(c)]);
    return (results.some((x) => x !== undefined && x !== "error" && x.streamed) ? "s" : "") + (results.some((x) => x === "error") ? "b" : "");
  });
  // §23: a chevron narrows the name column, so it's part of the shape too.
  const shape = JSON.stringify(rows.map((r, i) => [r.key, r.name, r.meta ?? "", r.heading ?? "", r.fold ? r.fold.text : null, r.missing ?? false, mediaMarks[i], r.layers ? 1 : 0]));
  useLayoutEffect(measure, [shape]);
  useEffect(() => {
    window.addEventListener("resize", measure);
    // Text measured before the web font lands is the fallback font's width.
    void document.fonts?.ready.then(measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // §23: the one hover card, and which cue label is each lane's Tab stop. Neither changes per frame.
  const { shown: shownCard, api: card } = useCueCard();
  const [focusCue, setFocusCue] = useState<Record<string, number>>({});

  return (
    <div class="lanes" ref={root}>
      {rows.map((row) => {
        const heading = row.heading !== undefined && (
          <div class="rhead" data-heading={row.key} data-tip={cut[`h:${row.key}`] ? row.heading : undefined}>
            <span class="rname">{row.heading}</span>
            {row.tag && <span class="rtag">{row.tag}</span>}
          </div>
        );
        if (row.fold) {
          const f = row.fold;
          return (
            <Fragment key={row.key}>
              {heading}
              <button
                type="button"
                class="fold"
                data-row={row.key}
                data-tip={cut[`f:${row.key}`] ? f.text : undefined}
                aria-expanded={f.open}
                aria-description={f.dot ? "Open notes" : undefined}
                onClick={f.onToggle}
              >
                <Icon name="chev" />
                <span class="flabel">{f.label}</span>
                {f.dot && <span class="fdot" data-dot data-tip="Open notes" />}
              </button>
            </Fragment>
          );
        }
        const current = row.key === selected;
        const flags = cut[row.key] ?? "";
        // §23: cues in time order, so the labels, ←/→ and "cue n of N" all follow time.
        const timed = cuesInTime(row.cues ?? []);
        const rooms = cueRoom(timed, length);
        const tabCue = Math.min(focusCue[row.key] ?? 0, Math.max(0, timed.length - 1));
        const cardCue = (c: LaneCue, i: number): CardCue => ({
          key: `m:${row.key}:${i}`, name: cueName(c), t: c.t, n: i + 1, of: timed.length, file: c.file ?? null, color: row.color,
        });
        const results = row.clips.map((c) => media[mediaKey(c)]);
        const streamed = results.some((r) => r !== undefined && r !== "error" && r.streamed);
        const broken = results.some((r) => r === "error");
        const segments: WaveSegment[] = row.clips.map((c, i) => {
          const r = results[i];
          const loaded = r !== undefined && r !== "error" ? r : null;
          return { offset: c.offset, duration: c.duration > 0 ? c.duration : (loaded?.duration ?? 0), peaks: loaded ? loaded.peaks : null };
        });
        const laneMarks = marks[row.key] ?? [];
        const nameButton = (
          <button
            type="button"
            class="nm"
            // Part of the player: Space still plays with a lane focused (§19.8).
            data-player
            aria-current={current ? "true" : "false"}
            aria-label={row.name}
            aria-description={row.missing ? (typeof row.missing === "string" ? row.missing : "Missing") : undefined}
            onClick={() => onSelect(row)}
          >
            {/* The tooltip sits on the unclipped line, not on the ellipsised text, which would clip it. */}
            <b data-tip={flags.includes("n") ? row.name : undefined}>
              <i style={{ background: row.color }} />
              <span data-name>{row.name}</span>
              {/* Beside the name, not in the meta line, which clips its tooltip. */}
              {row.missing && <Missing tip={typeof row.missing === "string" ? row.missing : undefined} />}
            </b>
            <small data-meta data-tip={flags.includes("m") && row.meta ? row.meta : undefined}>
              {broken ? (
                <span class="smk bad" data-tip="This file won't play in a browser"><Icon name="alert" /></span>
              ) : streamed ? (
                <span class="smk" data-tip="Long file: switching isn't sample-exact"><Icon name="stream" /></span>
              ) : null}
              <span data-meta-text>{row.meta ?? ""}</span>
            </small>
          </button>
        );
        return (
          <Fragment key={row.key}>
          {heading}
          <div class="lane" data-row={row.key} aria-current={current ? "true" : undefined}>
            {row.layers ? (
              // §23: the chevron sits beside the name button, which can't hold another button (ruling R1).
              <div class="nmc">
                <button
                  type="button"
                  class="chev tip-start"
                  aria-expanded={row.layers.open}
                  aria-controls={row.layers.open && timed.length > 0 ? `cl-${row.key}` : undefined}
                  aria-label={`Layers for ${row.name}`}
                  data-tip={timed.length === 0 ? "No cues in this pass" : row.layers.open ? "Hide the layers" : "Show the layers"}
                  disabled={timed.length === 0}
                  onClick={row.layers.onToggle}
                >
                  <Icon name="chev" />
                </button>
                {nameButton}
              </div>
            ) : (
              nameButton
            )}
            <div
              class="track"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                onSeek(((e.clientX - r.left) / r.width) * length, row);
              }}
            >
              <Wave segments={segments} length={length} color={row.color} />
              {timed.map((c, i) => (
                <i
                  class={`cue-tick${card.shown === `m:${row.key}:${i}` ? " hot" : ""}`}
                  aria-hidden="true"
                  key={`t${i}`}
                  style={{ left: pct(c.t), color: row.color }}
                  {...cardHover(card, cardCue(c, i))}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSeek(c.t, row, c.id);
                  }}
                />
              ))}
              {timed.map((c, i) => {
                const cc = cardCue(c, i);
                const shown = card.shown === cc.key;
                return (
                  // Each label gets the gap to its nearest cue, so close cues are cut short rather than overlap.
                  <button
                    type="button"
                    class={`cue${shown ? " hot" : ""}`}
                    data-cue={c.id}
                    key={`c${i}`}
                    tabIndex={i === tabCue ? 0 : -1}
                    aria-label={cueLabel(c)}
                    aria-describedby={shown ? CUE_CARD_ID : undefined}
                    style={{ left: pct(c.t), color: row.color, maxWidth: `calc(${(rooms[i] * 100).toFixed(3)}% - 8px)` }}
                    {...cardHover(card, cc)}
                    onFocus={(e) => {
                      setFocusCue((f) => (f[row.key] === i ? f : { ...f, [row.key]: i }));
                      card.show(e.currentTarget, cc);
                    }}
                    onBlur={() => card.hide()}
                    onKeyDown={(e) => rovingKeyDown(e, "button.cue", card)}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSeek(c.t, row, c.id);
                    }}
                  >
                    <span>{c.name}</span>
                  </button>
                );
              })}
              {laneMarks.map((m) => m.tOut !== null && <div class={`span ${m.status}`} data-note={m.id} style={{ left: pct(m.t), width: pct(m.tOut - m.t) }} />)}
              {laneMarks.map((m) => <div class={`mk ${m.status}`} data-note={m.id} style={{ left: pct(m.t) }} title={m.text} />)}
              {range.in !== null && (
                <div class="span live" style={{ left: pct(range.in), width: pct((range.out ?? range.in + Math.max(0.2, length / 200)) - range.in) }} />
              )}
              <div class="playhead" />
            </div>
            <div class="ctl">
              {row.use && (
                <button
                  type="button"
                  class="use"
                  aria-pressed={row.use.inUse}
                  aria-label={`Use ${row.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    row.use!.onUse();
                  }}
                >
                  {row.use.inUse ? <><Icon name="check" />In use</> : "Use"}
                </button>
              )}
              {row.use?.inUse && row.use.onUnpick && (
                <button
                  type="button"
                  class="btn ghost ib sm unpick"
                  data-tip="Unpick"
                  aria-label={`Unpick ${row.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    row.use!.onUnpick!();
                  }}
                >
                  <Icon name="x" />
                </button>
              )}
              {row.controls}
            </div>
          </div>
          {row.layers?.open && timed.length > 0 && (
            <CueLayers
              id={`cl-${row.key}`}
              name={row.name}
              cues={timed}
              length={length}
              color={row.color}
              card={card}
              onSeek={(t, cue) => onSeek(t, row, cue)}
              toast={toast ?? (() => undefined)}
            />
          )}
          </Fragment>
        );
      })}
      <CueCard shown={shownCard} onHide={card.hide} />
    </div>
  );
}
```

  - Update the file's header comment (lines 1–7) by adding one sentence at the end of the first paragraph: `A Sound effects pass also carries a chevron that opens its layers by sound (§23, CueLayers), and every cue opens the hover card (CueCard).`

- [ ] **Step 18: Change `web/src/ui/AudioStage.tsx`.**
  - After line 10, add `import { type SampleState, samples } from "../audio/sample.js";`.
  - In `AudioTestHook` (lines 27–39), add before the closing brace:

```ts
  /** §23: the cue-sample player's state. */
  sample(): SampleState;
```

  - In the `hook` object (lines 45–63), add after `liveContexts,` (line 53): `sample: () => samples.state(),`.
  - Replace the `<Lanes … />` element (lines 409–421) with:

```tsx
        <Lanes
          rows={rows}
          length={length}
          media={media}
          selected={selected}
          marks={drawn}
          range={range}
          onSelect={select}
          onSeek={(t, row, cue) => {
            select(row);
            // §23: a cue's label or tick also aims the note at that cue, so the next note lands on it at its time.
            const aim = cue === undefined ? undefined : onOptions.find((o) => o.value === `c:${row.key}:${cue}`);
            if (aim) {
              selectedOn.current = aim.value;
              setOnValue(aim.value);
            }
            engine.seek(t);
          }}
          toast={toast}
        />
```

- [ ] **Step 19: Change `web/src/ui/VariantTab.tsx`.**
  - After line 18 (`let blindSession = false;`), add:

```ts
// §23: which passes have their layers open, by row key, for the session (like Voiceover's open
// rounds). Toggling re-renders this tab, so AudioStage re-renders and its layout effect hands the
// layers' playheads to paint() with the lane's own.
const openLayers = new Set<string>();
```

  - After line 37 (the end of `setBlind`), add:

```ts
  const [, rerender] = useState(0);
  const toggleLayers = (key: string) => {
    if (openLayers.has(key)) openLayers.delete(key);
    else openLayers.add(key);
    rerender((n) => n + 1);
  };
```

  - In the row literal, after line 65 (`cues: stage === "sfx" ? r.cues : undefined,`), add:

```ts
      layers: stage === "sfx" ? { open: openLayers.has(r.key), onToggle: () => toggleLayers(r.key) } : undefined,
```

- [ ] **Step 20: Run the new e2e tests and see them pass.** Check the machine is quiet as in Step 14. Then run: `npm run build && npx playwright test e2e/cues.spec.ts --project=chromium --retries=0`, then the same with `--project=webkit`. Expected: PASS in both.

- [ ] **Step 21: Run the gates.** On a quiet machine, run: `npm run build && npm run typecheck && npx vitest run && npx playwright test --retries=0` (both projects). Expected: all green. That includes `e2e/audio.spec.ts`'s existing cue tests: "cue labels close together never overlap", "Sound effects labels cues…" and the Mix tests that read `.lane[data-row="sfx"] .cue`. They pass unchanged, because the labels keep their text, their `data-cue` and their gap-sized width.

- [ ] **Step 22: Commit.**

```bash
git add web/src/cues.ts web/src/audio/sample.ts web/src/ui/CueCard.tsx web/src/ui/CueLayers.tsx web/src/cues.css web/src/ui/Lanes.tsx web/src/ui/AudioStage.tsx web/src/ui/VariantTab.tsx web/src/main.tsx e2e/fixture.ts e2e/cues.spec.ts test/web/cues.test.ts test/web/sample.test.ts test/web/cues-css.test.ts
git -c user.name=iamredmh -c user.email=17407420+iamredmh@users.noreply.github.com commit -m "feat(web): hover cards for cues, and layers by sound on Sound effects (§23)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

**Mutation check:** each of these changes must make a test fail:
- Keying `cueLayers` on the cue's id instead of its name must fail "gives one layer per name… repeats share it" and the e2e "×3".
- Deleting `e.stopPropagation()` after the roving move in `rovingKeyDown` must fail both keyboard e2e tests on `time` being 0, because a frame step moves it to 0.033.
- Keeping the open state in `CueLayers`' or `Lanes`' own `useState`, so AudioStage doesn't re-render on the toggle, must fail "layers opened mid-play have playheads that move with the lane's": the new playheads keep an empty `left`.

---

### Task 3: Docs, the busy-pass check and CI (§23.4 docs, Review Focus 2 and 4)

**Files:**
- Modify: `AGENTS.md:66`, `skills/rushes/SKILL.md:15`, `README.md` (after line 113, and after line 204)
- Create: `test/docs-cues.test.ts`
- Modify: `e2e/cues.spec.ts` (append the busy-pass test)

**Interfaces:**
- Consumes:
  - `e2e/cues.spec.ts`'s helpers (Task 2): `hook(page)`, `openSfx(page, rushes, files)`, `lane(page)`, `layers(page)`, `card(page)`, `chevron(page, name?)`;
  - `rushes_add_variant`'s `cues[].file` (Task 1).
- Produces: the docs, and a measured check whose numbers go in the report. No code interfaces.

- [ ] **Step 1: Write the failing docs test** in `test/docs-cues.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("shipped docs on cue samples and layers by sound (§23)", () => {
  it.each(["AGENTS.md", "skills/rushes/SKILL.md"])("%s tells agents a cue can carry its sample's file, and to keep a sound's name", (file) => {
    const text = read(file);
    expect(text).toContain("`{name, t, file?}`");
    expect(text).toMatch(/same name/);
    expect(text).toMatch(/an audio file/);
  });

  it("README explains the card, the layers by sound and their keys", () => {
    const text = read("README.md");
    for (const words of ["layers by sound", "`thud ×19`", "source file", "**Esc** hides the card", "Mix's Sound effects lane has the card too"]) {
      expect(text).toContain(words);
    }
  });

  it.each(["README.md", "AGENTS.md", "skills/rushes/SKILL.md"])("%s has no personal path", (file) => {
    const text = read(file);
    expect(text).not.toContain("/Users/");
    expect(text).not.toMatch(/\/home\/[a-z]/i);
  });
});
```

- [ ] **Step 2: Run it and see it fail.** Run: `npx vitest run test/docs-cues.test.ts`. Expected: FAIL. The "no personal path" cases pass already.

- [ ] **Step 3: Update `AGENTS.md`.** Replace line 66 with:

```markdown
   - Music beds or SFX passes: `rushes_add_variant` with `stage` `music` or `sfx`. Give it `meta: {description: "..."}`, shown on its lane card in place of `bpm`/`key`; SFX passes also take `cues` (`{name, t, file?}`: `t` in seconds, and `file` the sample you placed there, an audio file, optional), labelled on the waveform. Give a sound the same name every time it comes back (`thud`, not `thud 2`): the Sound effects tab groups cues by name into layers, one per sound, and shows a cue's `file` on its card, where the user can play that sample on its own.
```

- [ ] **Step 4: Update `skills/rushes/SKILL.md`.** Replace line 15 with:

```markdown
   - `rushes_add_variant` for each voice read, music bed or SFX pass. Voice reads carry `stage: "voice"` and a `round` (its name — reads in one round are compared side by side; a new direction gets a new round); say what the read is, or what changed, in `description`. Music and SFX carry `meta.description` for their lane card, and SFX passes carry `cues` as `{name, t, file?}`: the same name each time a sound comes back, and `file` (an audio file) when you know which sample you placed;
```

- [ ] **Step 5: Update `README.md`.**
  - After line 113 (`- **N** new note`, under "In the Voiceover, Music, Sound effects and Mix tabs"), add:

```markdown
- **←/→** with a cue or a layer's tick focused: the previous or next cue (**Home**/**End**: the first or last); **Enter** moves the playhead there; **Esc** hides the card
```

  - After line 204 (the Mix level slider bullet), add:

```markdown
- On **Sound effects**, rest the pointer on a cue's label or tick (or Tab to it) for a card with its full name, its time, where it falls in the pass (`cue 5 of 80`) and, when your agent sent one, its source file. The arrow beside a pass's name opens its **layers by sound**: one row per sound, in the order it first comes in, with a count (`thud ×19`) and a tick everywhere it plays. Click a tick to move the playhead there; click a layer's file name to hear that sample on its own (it stops the tab, and Play stops it). The layers stay open while you work, until you reload. Mix's Sound effects lane has the card too.
```

- [ ] **Step 6: Run the docs tests and see them pass.** Run: `npx vitest run test/docs-cues.test.ts test/package.test.ts`. Expected: PASS. The existing tool-count test still reads "nineteen tools", because this plan adds no tool.

- [ ] **Step 7: Append the busy-pass check** to the end of `e2e/cues.spec.ts`:

```ts
// ---- §23: a busy pass (Review Focus 2 and 4) ----
// Twelve invented sounds, 200 cues, each sound's own generated sample. Never real project files.
const SOUNDS = ["click", "whoosh", "thud", "shimmer", "tick", "chime", "pop", "sweep", "impact", "static", "swoosh · end line", "power-down · offline"];
const sampleOf = (s: string) => `audio/sfx/samples/${s.replace(/[^a-z]+/g, "_")}.wav`;

test("a busy pass: 200 cues over 12 sounds open as 12 layers quickly, scroll after eight, line up, and stay inside the window", async ({ page, rushes }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await rushes.writeFiles(SOUNDS.map((s, i) => ({ path: sampleOf(s), seconds: 0.3, freq: 200 + i * 40 })));
  const cues = Array.from({ length: 200 }, (_, i) => {
    const s = SOUNDS[(i * 7) % SOUNDS.length];
    return { name: s, t: Math.round((0.1 + i * 0.19) * 100) / 100, file: sampleOf(s) };
  });
  await rushes.addVariant("sfx", "Effects for Lumen", { seconds: 40, freq: 880, cues });
  await openSfx(page, rushes, 1);
  await expect(lane(page).locator(".cue")).toHaveCount(200);
  await expect(lane(page).locator('.cue[tabindex="0"]')).toHaveCount(1);

  const started = Date.now();
  await chevron(page).click();
  await expect(layers(page).locator(".clayer")).toHaveCount(12);
  const openMs = Date.now() - started;
  test.info().annotations.push({ type: "layers open (ms)", description: String(openMs) });
  console.log(`layers open: ${openMs} ms (${test.info().project.name})`);
  expect(openMs).toBeLessThan(1500);

  // First appearance in time: i·7 mod 12 for i = 0…11. Every cue is on exactly one layer.
  await expect(layers(page).locator(".clname span")).toHaveText([0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5].map((k) => SOUNDS[k]));
  const counts = await layers(page).locator(".clname em").allTextContents();
  expect(counts.reduce((sum, c) => sum + Number(c.replace("×", "")), 0)).toBe(200);
  expect(counts[0]).toBe("×17");
  await expect(layers(page).locator(".ltick")).toHaveCount(200);

  // About eight layers show; the rest scroll inside the box, and the page never scrolls sideways.
  const box = await layers(page).evaluate((e) => ({ client: e.clientHeight, scroll: e.scrollHeight }));
  expect(box.client).toBeLessThanOrEqual(261);
  expect(box.scroll).toBeGreaterThan(box.client);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // The last layer's last tick, scrolled to, still opens its card inside the window.
  const last = layers(page).locator(".clayer").last().locator(".ltick").last();
  await last.scrollIntoViewIfNeeded();
  await last.hover();
  const c = (await card(page).boundingBox())!;
  expect(c.x).toBeGreaterThanOrEqual(16);
  expect(c.x + c.width).toBeLessThanOrEqual(1440 - 16);
  expect(c.y).toBeGreaterThanOrEqual(16);
  expect(c.y + c.height).toBeLessThanOrEqual(900 - 16);

  // Playing with every layer open: the playheads keep together and nothing re-renders per frame.
  const before = (await hook(page)).renders;
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await hook(page)).time).toBeGreaterThan(0.5);
  await page.waitForTimeout(600);
  expect((await hook(page)).renders - before).toBeLessThan(10);
  const lefts = await page.locator(".astage .playhead").evaluateAll((els) => els.map((e) => (e as HTMLElement).style.left));
  expect(lefts).toHaveLength(13);
  expect(new Set(lefts).size).toBe(1);

  await page.screenshot({ path: process.env.RUSHES_SHOT ?? test.info().outputPath("sfx-layers-1440.png") });
});
```

- [ ] **Step 8: Run the busy-pass check in both browsers and record it.** On a quiet machine (as in Task 2 Step 14), run: `RUSHES_SHOT="$TMPDIR/rushes-sfx-layers-chromium.png" npx playwright test e2e/cues.spec.ts -g "a busy pass" --project=chromium --retries=0 --reporter=list`, then `RUSHES_SHOT="$TMPDIR/rushes-sfx-layers-webkit.png" npx playwright test e2e/cues.spec.ts -g "a busy pass" --project=webkit --retries=0 --reporter=list`. Expected: PASS in both.
  - The list reporter prints each run's `layers open: N ms` line. Paste both numbers into the report, with the two screenshot paths.
  - Look at the screenshots against the mockup: chevron in the name cell, layers under the row, names on the left with the counts in mono, ticks as small rounded bars, the playhead running through the layers.

- [ ] **Step 9: Run the gates.** On a quiet machine, run: `npm run build && npm run typecheck && npx vitest run && npx playwright test --retries=0` (both projects), then `npm pack --dry-run`. Expected: all green, and the packed file list is unchanged: the new web files ship inside `web-dist`, and the new core file inside `dist`.

- [ ] **Step 10: Commit.**

```bash
git add AGENTS.md skills/rushes/SKILL.md README.md test/docs-cues.test.ts e2e/cues.spec.ts
git -c user.name=iamredmh -c user.email=17407420+iamredmh@users.noreply.github.com commit -m "docs: cue samples and layers by sound, and a busy-pass check (§23)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 11: Push and see CI green.** Run: `git push -u origin sfx-layers`, then `gh run watch --exit-status $(gh run list --branch sfx-layers --limit 1 --json databaseId -q '.[0].databaseId')`. Expected: all four jobs pass (Chromium and WebKit, on Node 20.19 and 22). If a job fails, read its Playwright report artifact, fix the cause and push again. Never retry a flaky test into green.

**Mutation check:** each of these changes must make a test fail:
- Removing `max-height: 261px` from `.clayers` must fail the busy-pass check's "scroll after eight" (and `test/web/cues-css.test.ts`).
- Deleting `file?` from AGENTS.md's cue line must fail "AGENTS.md tells agents a cue can carry its sample's file…".

The version bump and the release are decided by the controller at release time. This plan doesn't bump the version.

---

## Spec coverage

| Spec | Where |
|---|---|
| §23.2 (1) the card: name, time, cue n of N, file only when known | Task 2: `CueCard`, `cueCount`, e2e "hovering a cut-short cue label…" |
| §23.2 (2) chevron, one layer per name, first appearance, `×N`, ticks | Task 2: `cueLayers`, `CueLayers`, e2e "the chevron opens one layer per sound…" |
| §23.2 (3) ticks move the playhead; the playhead runs through the layers | Task 2: `onSeek`, e2e "…a tick moves the playhead" and "layers opened mid-play…" |
| §23.2 (4) optional `file`, shown on the card and the layer, auditioned on the bus | Task 1 (data and server); Task 2: `SamplePlayer`, e2e "a layer's file button…" |
| §23.2 (5) keyboard: buttons, ←/→, Enter, card on focus, Esc, the chevron's name and `aria-expanded` | Task 2: `rovingKeyDown`, both keyboard e2e tests, the chevron assertions |
| §23.2 (6) open state for the session | Task 2: `openLayers`, e2e "…stay open for the session…" |
| §23.3 the field, audio only, ≤ 1024, manifest path, allow-list, §15.5, Found | Task 1: every test in `test/core/cues.test.ts` and `test/server/cue-files.test.ts` |
| §23.4 `rushes_add_variant` `file`, no new tool, CLI unchanged, docs | Task 1: `test/mcp/cue-files.test.ts`; Task 3: the docs and their test |
| §23.5 the card's placement, the pass row, the layers' grid, scrolling after eight, Mix | Task 2: `cardPosition`, `cues.css` and its test, the alignment e2e, the Mix e2e; Task 3: the busy-pass check |
| §23.6 edge cases | Non-audio and over-long files: Task 1. Missing sample: Task 2. Symlinks and absolute paths: Task 1. Hand edit: Task 1. Mixed files, case and blank names: the Task 2 units. Same-time cues: the `cuesInTime` unit. A cue after the end: the `tickLeft` unit. Up to 200: Task 3. A 0.2.2 project: Task 1. An older server and a sample already a pass: rulings R18 and R12, nothing to build |
| §23.7 not in this release | Not built. Mix has no `layers` (ruling R13) |
| §23.8 review focus | The plan's Review Focus, with each line's test |
