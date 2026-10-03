# Rushes Plan 3b: Voiceover Rounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Voiceover tab's section/take comping UI with rounds of whole reads, judged by Whole or Point notes (spec §18).

**Architecture:**
- **Rounds.** A round is a `voice` lane. The server gains a `round` name on `addVariant`, and the mix's VO comes from the newest round that has a pick.
- **Notes.** The shared `AudioStage` learns per-tab scopes and chips, so Voiceover can offer just Whole/Point.
- **Voiceover tab.** `Voice.tsx` is rebuilt around rounds. The current round is open and older rounds fold into one row. `Lanes` gains fold rows, group headings, and hover tooltips for cut-off text.

**Tech Stack:** TypeScript (ESM, NodeNext), Hono, zod, Preact 10, Vite 8, Web Audio, vitest, Playwright.

**Spec:** `docs/specs/2026-10-02-rushes-design.md` §18. It refers back to §6, §17.1, §17.3, §17.6 and §17.8.

## Global Constraints

- **Language and type.** UK English in all copy and docs. Type is 15px or larger everywhere.
- **Dependencies.** Runtime deps stay exactly `@hono/node-server`, `@modelcontextprotocol/sdk`, `hono`, `zod`.
- **Safari.** Grids use explicit tracks (`minmax(0,1fr)`), never content-sized implicit tracks.
- **Rendering.** No per-frame React state. The playhead and timecode are painted through refs (`engine.subscribe`).
- **Test hook.** `window.__rushesAudio` exists only with `?test=1`.
- **Tests:**
  - Tests never open apps (`RUSHES_NO_REVEAL=1`).
  - E2E must pass 5 consecutive default-parallel runs with `--retries=0`.
  - Never touch ports 4410, 4430, 4431, 4432 or 8765.
- **Privacy.** No client or brand names and no personal paths in tracked files.
- **Git.** Commit with the repo's existing identity and never change git config. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **House style:**
  - icon buttons with `data-tip` tooltips;
  - status shown as marks;
  - no helper text.
- **Nothing pending is ever dropped.** A half-typed note blocks film and tab switches; `notePending` is the single definition.

## Review Focus

1. **A project whose only voice lane is the old default "Voiceover" lane**, with no `round`, should show as one round named "Voiceover". Nothing should be blank, and the tab must not crash. *(Task 3 e2e.)*
2. **Old notes whose `on` is a take, a section or `"vo"`** must still appear in the notes list with a sensible label, are not drawn, and never crash. *(Task 3 unit.)*
3. **A pick in an older round, with no pick in the newest round:**
   - Mix and loudness use the older round's pick, because it is the newest round *with a pick*.
   - With no picks at all, VO is "Nothing picked".

   *(Task 1 server unit, Task 4 e2e.)*
4. **Blind with a folded round** must not reveal the picked read's name in the fold row. *(Task 3 e2e.)*
5. **A round whose reads are all missing on disk** shows the missing marks and plays silence, without crashing. *(Task 3 e2e.)*

---

## File structure

| File | Change |
|---|---|
| `src/core/project.ts` | `addVariant` accepts `round` |
| `src/server/app.ts` | `VariantBody.round` |
| `src/mcp/tools.ts` | `rushes_add_variant` gains `round`; descriptions for rounds |
| `src/cli/main.ts` | `--round NAME` on `add variant` |
| `src/core/tabs.ts` | Voiceover unlocks on a voice read only |
| `src/server/loudness.ts` | VO = the newest round's pick; takes ignored |
| `src/core/batches.ts` | Voice and script batch prompts per §18.5 |
| `src/core/notes.ts` | Voice note labels `Round 2 · Gerald · more sombre` (export, CLI) |
| `web/src/ui/Notes.tsx`, `web/src/ui/AudioStage.tsx` | Per-tab `scopes`, `defaultScope`, `chipsFor`, optional marks; In/Out off when there's no Range |
| `web/src/ui/Lanes.tsx`, `web/src/styles.css` | Group headings, fold rows, tooltips for cut-off name and meta |
| `web/src/lib.ts` | `voiceRounds`, new voice helpers; dead read/take helpers removed |
| `web/src/ui/Voice.tsx` | Rebuilt around rounds |
| `web/src/ui/Mix.tsx` | VO lane = newest round's pick |
| `README.md`, `AGENTS.md`, `skills/rushes/SKILL.md` | Docs |
| `test/core/*`, `test/server/*`, `test/web/lib.test.ts`, `e2e/audio.spec.ts`, `e2e/fixture.ts` | Tests |

---

### Task 1: Server — rounds, VO from the newest round's pick, prompts and labels

**Files:**
- Modify: `src/core/project.ts:102-123` (`addVariant`, `AddVariantInput`)
- Modify: `src/server/app.ts:83-90` (`VariantBody`)
- Modify: `src/mcp/tools.ts` (`rushes_add_variant`)
- Modify: `src/cli/main.ts` (`add variant`, usage line 42, option parsing near line 63)
- Modify: `src/core/tabs.ts:17`
- Modify: `src/server/loudness.ts:104-160, 236-262` (`voiceSource`, `mixInputs`, `voSpan`)
- Modify: `src/core/batches.ts:44-55` (`buildPrompt`)
- Modify: `src/core/notes.ts` (the function that names what an audio note is on, around line 141)
- Test: `test/core/project.test.ts`, `test/core/tabs-batches.test.ts`, `test/core/notes.test.ts`, `test/core/exportNotes.test.ts`, the loudness unit test file under `test/server/` (find it with `grep -l mixInputs test -r`), `test/cli/main.test.ts`, `test/mcp/tools.test.ts`

**Interfaces:**
- **Produces:**
  - `AddVariantInput.round?: string`.
  - Lane id rule: `slugify(input.lane ?? input.round ?? input.stage)`.
  - Lane name on creation: `input.round ?? input.lane ?? LANE_NAMES[stage]`.
  - An existing lane keeps its name.
- **Produces:** `mixInputs` voice behaviour:
  - Walk the `voice` lanes from newest (last in `project.lanes`) to oldest.
  - Use the first lane whose `picks.lanes[lane.id]` names an existing variant.
  - If none has one, add no voice input.
  - Takes are never used.
- **Produces:** the voice note label `"<lane name> · <variant name>"`, e.g. `Round 2 · Gerald · more sombre`. Labels for take, section and `"vo"` notes stay as they are (legacy).

- [ ] **Step 1: Write the failing tests**

In `test/core/project.test.ts`:

```ts
describe("addVariant rounds (§18.4)", () => {
  it("creates a lane named for the round, slugged for its id", () => {
    const p = emptyProject();
    const { lane } = addVariant(p, { stage: "voice", name: "Gerald", file: "media/g.wav", round: "Round 1 · Voices" });
    expect(lane).toMatchObject({ id: "round-1-voices", name: "Round 1 · Voices", stage: "voice" });
    const second = addVariant(p, { stage: "voice", name: "Jane", file: "media/j.wav", round: "Round 1 · Voices" });
    expect(second.lane.id).toBe("round-1-voices");
    expect(p.lanes).toHaveLength(1);
  });
  it("lets an explicit lane win over round", () => {
    const p = emptyProject();
    const { lane } = addVariant(p, { stage: "voice", name: "Gerald", file: "media/g.wav", lane: "vo-a", round: "Round 9" });
    expect(lane.id).toBe("vo-a");
  });
});
```

`emptyProject()` is whatever helper the file already uses to build a fresh `Project`. Reuse it; don't add another.

In the loudness unit test, using the file's existing fixture builders:

```ts
it("VO is the pick of the newest round that has one; takes are never used (§18.4)", () => {
  // Round 1 picked Gerald; Round 2 has reads but no pick; the script has takes.
  const inputs = mixInputs(project, scriptWithTakes, { schema: 1, rev: 0, lanes: { "round-1": "gerald" }, sections: {} }, ["voice"], root);
  expect(inputs.map((i) => i.file)).toEqual([abs("media/gerald.wav")]);
});
it("with no round picked there is no VO input, even when takes exist", () => {
  expect(mixInputs(project, scriptWithTakes, { schema: 1, rev: 0, lanes: {}, sections: {} }, ["voice"], root)).toEqual([]);
});
it("a newer round's pick wins over an older one", () => {
  const inputs = mixInputs(project, scriptWithTakes, { schema: 1, rev: 0, lanes: { "round-1": "gerald", "round-2": "sombre" }, sections: {} }, ["voice"], root);
  expect(inputs.map((i) => i.file)).toEqual([abs("media/sombre.wav")]);
});
```

Also add these tests:
- **Tabs** (`test/core/tabs-batches.test.ts`): Voiceover is locked when the script has takes but no voice lane has a read, and unlocked when a voice lane has a read.
- **Prompt** (`test/core/tabs-batches.test.ts`): `buildPrompt(..., "voice", ...)` contains `new whole read` and `round`.
- **Script prompt:** contains `re-record the picked voice`.
- **Labels** (`test/core/notes.test.ts` / `exportNotes.test.ts`): a voice note with `on: "round-2/sombre"` is labelled `Round 2 · Gerald · more sombre`. A legacy note with `on: "s2:t1"` keeps its old label.
- **CLI** (`test/cli/main.test.ts`): `rushes add variant voice f.wav --name Gerald --round "Round 1 · Voices"` posts `round: "Round 1 · Voices"`.
- **MCP** (`test/mcp/tools.test.ts`): `rushes_add_variant` passes `round` through.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/core test/server test/cli test/mcp`
Expected: the new tests fail (`round` unknown, takes still mixed, old prompt text).

- [ ] **Step 3: Implement**

`src/core/project.ts`:

```ts
export function addVariant(p: Project, input: AddVariantInput): { lane: Lane; variant: Variant } {
  const laneId = slugify(input.lane ?? input.round ?? input.stage);
  let lane = p.lanes.find((l) => l.id === laneId);
  if (lane && lane.stage !== input.stage) throw new InvalidError(`Lane "${laneId}" belongs to ${lane.stage}, not ${input.stage}`);
  if (!lane) {
    lane = { id: laneId, stage: input.stage, name: input.round ?? input.lane ?? LANE_NAMES[input.stage], variants: [] };
    p.lanes.push(lane);
  }
  // …cues and variant exactly as before…
}
```

Add `round?: string` to `AddVariantInput`, `round: z.string().min(1).max(80).optional()` to `VariantBody`, and `round` to the MCP input schema. Its describe text is: `Round name for voice reads, e.g. "Round 2 · Gerald, tone". Reads in one round are compared side by side; a new direction gets a new round.`

In the CLI, add `round: { type: "string" }` to the options, pass `round: o.round`, and update the usage line to `rushes add variant <music|sfx|voice> <file> --name NAME [--lane ID] [--round NAME]`.

`src/core/tabs.ts`: `const voice = laneHasVariants(p, "voice");`

`src/server/loudness.ts`:

```ts
type VoiceSource = { kind: "variant"; variant: Variant } | { kind: "none" };

function voiceSource(project: Project, picks: Picks): VoiceSource {
  // §18.4: the newest round (lane) with a pick; takes are never mixed.
  const voice = project.lanes.filter((l) => l.stage === "voice");
  for (let i = voice.length - 1; i >= 0; i--) {
    const pickedId = picks.lanes[voice[i].id];
    const variant = pickedId ? voice[i].variants.find((v) => v.id === pickedId) : undefined;
    if (variant) return { kind: "variant", variant };
  }
  return { kind: "none" };
}
```

- **`mixInputs`:** `if (voice.kind === "variant") add(voice.variant.file, 0, "voice");`
- **`voSpan`:** return `null` for `none`, so `musicUnderVo` stays unmeasured.
- **The `script` parameter:** drop it from `voiceSource`. If `mixInputs`/`voSpan` no longer use `script`, keep their signatures only where callers still need them.
- **Comments:** update the doc comments above `mixInputs` and `voSpan` to describe §18.4.
- **Unused imports:** remove now-unused `readTake` imports.

`src/core/batches.ts`, in `buildPrompt`:
- **`script`:** append the sentence ` If voiceover already exists, re-record the picked voice with the corrected script and register it with rushes_add_variant as a new read in a new round.`
- **`voice` gets its own branch:** `Use rushes_get_batch and rushes_get_picks. Answer the notes with new whole reads (rushes_add_variant, stage voice): a new round for a new direction, or the current round for a small fix to a marked word. Say in each read's description what changed. Then rushes_reply.`
- **`music`, `sfx`, `mix`:** keep the existing audio sentence.

`src/core/notes.ts`: when a voice note's `on` is `"<lane>/<variant>"` and both resolve, the label is `${lane.name} · ${variant.name}`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npm run build && npx vitest run && npm run typecheck`
Expected: all pass. Fix existing tests that asserted the old prompt text or take mixing. Update their expectations to §18; don't delete them.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(server): voice rounds — round names, VO from the newest round's pick, §18 prompts and labels"
```

---

### Task 2: AudioStage — per-tab scopes, chips and marks

**Files:**
- Modify: `web/src/ui/AudioStage.tsx` (props near line 95; `scope` state at line 147; `setIn`/`setOut`/`changeScope` near lines 234-256; `placeholderFor` near line 189; the `<Notes>` props near line 435; the I/O key handlers and In/Out buttons)
- Modify: `web/src/ui/Notes.tsx:31-53` (`SCOPES` filtered by an allowed list)
- Modify: `web/src/lib.ts:322-330` (`AUDIO_CHIPS` stays for music, sfx and mix)
- Test: `e2e/audio.spec.ts`, `test/web/lib.test.ts`

**Interfaces:**
- **Produces these `AudioStageProps` additions:**
  - `scopes?: Scope[]`, defaulting to `["point", "range", "whole"]`;
  - `defaultScope?: Scope`, defaulting to `"point"`;
  - `chipsFor?(scope: Scope): string[]`, defaulting to `() => AUDIO_CHIPS[stage]`;
  - `marks?: boolean`, defaulting to `true`.
- **Produces:** the `Notes` prop `scope` gains `options?: Scope[]`. The segmented control shows only those, in the order given.
- **Without `"range"` in `scopes`:**
  - the In/Out buttons are not rendered;
  - I and O do nothing;
  - the Range marks row never shows;
  - `placeholderFor` never mentions In/Out.
- **Placeholder:** with `"whole"` selected it reads `Note on the whole read` for `stage === "voice"`, and `Note on the whole track` otherwise.

- [ ] **Step 1: Write the failing test**

Add a temporary fixture-free check through the Music tab, which keeps the defaults, plus a unit test for the scope list helper:

```ts
// test/web/lib.test.ts
import { scopeOptions } from "../../web/src/lib.js";
describe("scopeOptions", () => {
  it("keeps the given order and drops unknown scopes", () => {
    expect(scopeOptions(["whole", "point"])).toEqual([{ value: "whole", label: "Whole" }, { value: "point", label: "Point" }]);
    expect(scopeOptions(undefined).map((s) => s.value)).toEqual(["point", "range", "whole"]);
  });
});
```

E2E (`e2e/audio.spec.ts`): the Music tab still shows Point, Range and Whole, its In/Out buttons, and its Range marks. This regression guard should pass both before and after.

- [ ] **Step 2: Run and see the unit test fail**

Run: `npx vitest run test/web/lib.test.ts`
Expected: FAIL, `scopeOptions` is not exported.

- [ ] **Step 3: Implement**

In `web/src/lib.ts`, move `SCOPES` out of `Notes.tsx` into lib and export it:

```ts
const SCOPE_LABELS: Record<Scope, string> = { point: "Point", range: "Range", whole: "Whole" };
export function scopeOptions(allowed: Scope[] | undefined): { value: Scope; label: string }[] {
  return (allowed ?? ["point", "range", "whole"]).filter((s) => s in SCOPE_LABELS).map((s) => ({ value: s, label: SCOPE_LABELS[s] }));
}
```

`Notes.tsx` renders `scopeOptions(scope.options)`.

In `AudioStage`:
- `useState<Scope>(props.defaultScope ?? "point")`.
- `const hasRange = (props.scopes ?? ALL).includes("range")`.
- Guard `setIn`/`setOut` and the key handler with `hasRange`, and don't render the In/Out buttons without it.
- Pass `scope={{ value: scope, onChange: changeScope, options: props.scopes }}`.
- Pass `chips={(props.chipsFor ?? (() => AUDIO_CHIPS[stage]))(scope)}`.
- Pass `marks={props.marks === false ? undefined : { value: marks, onChange: setMarks }}`.

Music, SFX and Mix pass none of the new props, so their behaviour is unchanged.

- [ ] **Step 4: Run and see it pass**

Run: `npm run build && npx vitest run && npm run typecheck && npx playwright test e2e/audio.spec.ts --retries=0`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add web/src test e2e
git commit -m "feat(web): audio tabs choose their note scopes, chips and marks"
```

---

### Task 3: The Voiceover tab — rounds of whole reads

**Files:**
- Modify: `web/src/ui/Lanes.tsx` (`StageRow` and the render loop), `web/src/styles.css`
- Modify: `web/src/lib.ts` (voice helpers around lines 590-730: `READ_ROW`, `voiceListening`, `voiceNoteRows`, `voiceOnOptions`, `voiceOnLabel`, `VoiceModel`)
- Rewrite: `web/src/ui/Voice.tsx`
- Modify: `e2e/fixture.ts` (`addVariant` passes `round`)
- Test: `test/web/lib.test.ts`, `e2e/audio.spec.ts` (Voiceover section)

**Interfaces:**
- **Consumes (Task 1):**
  - `POST /api/variants` accepts `round`;
  - lanes have `name`;
  - `picks.lanes[laneId]`.
- **Consumes (Task 2):** the `AudioStage` props `scopes`, `defaultScope`, `chipsFor` and `marks`.
- **Produces:**
  - `voiceRounds(lanes: Lane[], picks: Record<string, string>): VoiceRound[]`;
  - `interface VoiceRound { id: string; name: string; reads: VariantRow[]; pick: string | null; current: boolean }`;
  - rounds come in creation order, the last one is `current: true`, and `pick` is the picked variant id or `null`.
- **Produces:**
  - `heardVoice(rounds: VoiceRound[]): VariantRow | null`, which returns the newest round's pick, walking back to older rounds when newer ones have none, or `null`. Mix uses this in Task 4.
  - `voiceDefaultRead(rounds): VariantRow | null`, which returns the current round's pick, else its first read. This is the On default and what plays when no lane is clicked.
- **Produces these `StageRow` additions in `Lanes.tsx`:**
  - `heading?: string`: a group heading line rendered before the row;
  - `tag?: string`: a small pill beside the heading, e.g. `current`;
  - `fold?: { label: ComponentChildren; open: boolean; dot: boolean; onToggle(): void }`: renders a full-width button row instead of a lane, with no clips, track or controls.
- **Produces, for every tab:**
  - a lane name or meta cut off by its column gets `data-tip` with the full text;
  - the overflow is measured in a layout effect when rows change or the window resizes, never per frame.

**Behaviour (spec §18.3), all of it testable:**
1. **Rows.** The current round's heading has the round name and a `current` tag. Under it are its reads as lanes: name, `description` meta, waveform, Use / In use with Unpick.
2. **Older rounds**, newest first under the current round:
   - each is one fold row: `Round 1 · Voices · 3 reads · picked Gerald`, or `nothing picked`;
   - a dot appears if any open (todo) note is on one of its reads;
   - clicking it toggles the round's lanes beneath it;
   - fold state is per round, kept in memory for the session per film.
3. **Blind**, the same control and seed approach as Music (`blindOrder`, `blindSession`):
   - names become `Read 1…n` within each round;
   - meta becomes `·····`;
   - fold rows say `picked a read`;
   - the On labels are `Read n`.
4. **Playback.**
   - `listen(selected)`: the selected read, or with nothing selected `voiceDefaultRead`; only that read's lane is audible.
   - Every read is its own engine lane (`voiceLane(lane) + "/" + variant`, or the existing per-variant clip ids), so switching is a gain ramp.
5. **Notes.**
   - `scopes={["whole", "point"]}` and `defaultScope="whole"`, with `marks={false}`.
   - `chipsFor`: `whole` gives `["Speaker", "Pacing", "Tone", "Overall"]`; `point` gives `["Fix this", "Keep this"]`.
6. **On options**, one per read in every round:
   - the label is the read's name only;
   - `full` (new optional `OnOption` field) is `${round.name} · ${read.name}`;
   - the On `<select>` gets `data-tip` from the selected option's `full` (Notes renders it);
   - the default is `voiceDefaultRead`.
7. **Where notes go.** A point note on a read is drawn on that read's lane. Whole notes are not drawn. Legacy `on` values (`"vo"`, sections, takes) map to no row: they are listed, labelled by `voiceOnLabel`, and never crash.
8. **Removed from Voice.tsx:**
   - the assembled read row and the take rows;
   - the section switch (`.vobar`) and New take;
   - the take clips;
   - every use of `assembleRead`, `readTake`, `takeRowKey`, `takeClipId`, `sectionLane`, `sectionAt` and `sectionLabel` in this file.
   - Delete any lib helpers left unused across `web/src`, but keep anything the Script tab or the server still imports.
   - Delete `.secmk*` and `.vobar` CSS if unused.

- [ ] **Step 1: Write the failing unit tests** (`test/web/lib.test.ts`)

```ts
describe("voiceRounds (§18.2)", () => {
  const lanes = [
    { id: "round-1", stage: "voice", name: "Round 1 · Voices", variants: [v("jane"), v("louise"), v("gerald")] },
    { id: "music", stage: "music", name: "Music", variants: [v("a")] },
    { id: "round-2", stage: "voice", name: "Round 2 · Gerald, tone", variants: [v("excited"), v("sombre")] },
  ] as Lane[];
  it("orders rounds by creation and marks the last current", () => {
    const r = voiceRounds(lanes, { "round-1": "gerald" });
    expect(r.map((x) => [x.id, x.current, x.pick])).toEqual([["round-1", false, "gerald"], ["round-2", true, null]]);
  });
  it("hears the newest round's pick, walking back past rounds with none", () => {
    expect(heardVoice(voiceRounds(lanes, { "round-1": "gerald" }))?.variant).toBe("gerald");
    expect(heardVoice(voiceRounds(lanes, { "round-1": "gerald", "round-2": "sombre" }))?.variant).toBe("sombre");
    expect(heardVoice(voiceRounds(lanes, {}))).toBeNull();
  });
  it("defaults to the current round's pick, else its first read", () => {
    expect(voiceDefaultRead(voiceRounds(lanes, {}))?.variant).toBe("excited");
    expect(voiceDefaultRead(voiceRounds(lanes, { "round-2": "sombre" }))?.variant).toBe("sombre");
  });
  it("labels legacy take and section notes without drawing them", () => {
    const m = { rounds: voiceRounds(lanes, {}) };
    expect(voiceNoteRows(m, { on: "s2:t1" } as Note)).toBeNull();
    expect(voiceOnLabel(m, "vo")).toBe("Assembled read");
  });
});
```

`v(id)` is a local helper returning `{ id, name: id, file: \`media/${id}.wav\`, meta: {}, cues: [] }`. Adapt the `voiceNoteRows`/`voiceOnLabel` signatures to what you build, keeping these outputs.

- [ ] **Step 2: Write the failing e2e tests** (replace the Voiceover section of `e2e/audio.spec.ts`)

Delete the e2e tests that assert the assembled read, takes, sections, New take, stale/missing take marks, and section labels. Replace them with these, using `rushes.addVariant("voice", name, { round, seconds, freq, meta: { description } })`:
1. **Rounds layout.** Two rounds: Round 1 (Jane, Louise, Gerald, with Gerald picked) and Round 2 (more excited, more sombre).
   - The heading reads `Round 2 · Gerald, tone` with a `current` tag.
   - Two lanes sit under it.
   - The fold row reads `Round 1 · Voices · 3 reads · picked Gerald`.
   - No `.vobar`, no `[data-row="vo"]`, no `.secmk`.
   - Clicking the fold row shows three more lanes; clicking it again hides them.
   - **Open-notes dot.** With a todo point note on Jane, the folded Round 1 row shows the dot. Marking the note done removes it.
   - **Fits on one screen.** At a 1440×900 viewport, with Round 2 holding three reads and Round 1 folded, the bottom of the fold row is within the viewport (`getBoundingClientRect().bottom <= 900`).
2. **Playback.** With nothing picked in Round 2, `heard()` is Round 2's first read. Clicking "more sombre" switches what's heard without the playhead moving (use the existing time-stability pattern). Use on "more sombre" sets `picks.lanes["round-2-gerald-tone"] = "more-sombre"`.
3. **Notes.**
   - The scope switch shows exactly `Whole` and `Point`, with Whole selected.
   - There are no In/Out buttons, and pressing `i` adds no range.
   - The chips are `Speaker Pacing Tone Overall`. After clicking `Point` they are `Fix this` and `Keep this`.
   - A Point note at the playhead on "more excited" saves `scope: "point"` and `on: "round-2-gerald-tone/more-excited"`, and draws a marker on that lane only.
   - A Whole note is listed and not drawn.
4. **Blind.** Names become `Read 1`, `Read 2`. The fold row says `picked a read`, and doesn't contain `Gerald`.
5. **Tooltips.** A read with a 90-character description shows it cut off. Its meta element's `data-tip` equals the full text, and a short description has no `data-tip`. The On select's `data-tip` is `Round 2 · Gerald, tone · more sombre` when "more sombre" is selected.
6. **Legacy (Review Focus 1, 2).** A read added with no `round` shows under a heading `Voiceover`. A legacy note `on: "s1:t1"` is listed and the page has no errors.
7. **Missing files (Review Focus 5).** Deleting a read's file shows the missing mark, and the tab still renders.

Run: `npm run build && npx playwright test e2e/audio.spec.ts --retries=0 -g "Voiceover|round"`
Expected: FAIL. The current tab still renders the assembled read and sections.

- [ ] **Step 3: Implement** `Lanes` heading/fold/tooltip support, the lib helpers, and the new `Voice.tsx` as specified above.
  - Use `AudioStage`'s `headerExtra` for Blind, as `VariantTab` does.
  - Keep `onPendingChange`, `toast` and `onChanged` wiring as they are.

- [ ] **Step 4: Run all gates**

Run: `npm run build && npx vitest run && npm run typecheck`, then the full e2e suite 5 times: `for i in 1 2 3 4 5; do npx playwright test --retries=0; done`
Expected: all green every run.

- [ ] **Step 5: Screenshot.** Take a Playwright screenshot of the Voiceover tab with two rounds at 1440×900 and save it to the controller's scratchpad path given in the dispatch.

- [ ] **Step 6: Commit**

```bash
git add web e2e test
git commit -m "feat(web): Voiceover is rounds of whole reads — Whole or Point notes, older rounds fold"
```

---

### Task 4: Mix plays the newest round's pick

**Files:**
- Modify: `web/src/ui/Mix.tsx` (the VO lane source, near line 56)
- Modify: `web/src/lib.ts` (any `mixHeard`/VO helper still built on the assembled read)
- Test: `test/web/lib.test.ts`, `e2e/audio.spec.ts` (the Mix section)

**Interfaces:**
- **Consumes:** `voiceRounds` and `heardVoice` from Task 3.
- **Produces:** Mix's VO lane:
  - it plays `heardVoice(voiceRounds(lanes, picks))` at offset 0;
  - its name column reads `Voiceover`, with the meta `${round.name} · ${read.name}`;
  - with nothing picked anywhere, it shows the existing "Nothing picked" mark and is left out of loudness.

- [ ] **Step 1: Write the failing tests**
- **Unit (parity):** for the same lanes and picks, the web `heardVoice` file equals the server's `mixInputs(..., ["voice"], ...)` file. Mirror the three cases from Task 1: an older round picked, a newer pick wins, and nothing picked.
- **E2E:**
  - Round 1 has Gerald picked and Round 2 has nothing picked. Mix's VO lane meta is `Round 1 · Voices · Gerald`, and `heard()` includes Gerald's clip.
  - Then pick Round 2's "more sombre". The meta updates and the loudness request is re-sent (existing request-count pattern).
  - Unpick both. The VO lane shows "Nothing picked".

- [ ] **Step 2: Run and see them fail**

Run: `npm run build && npx vitest run test/web/lib.test.ts && npx playwright test e2e/audio.spec.ts --retries=0 -g "Mix"`
Expected: the new tests FAIL. Old Mix VO tests that relied on takes also fail. Rewrite those to rounds, keeping what they asserted about mute, solo and loudness.

- [ ] **Step 3: Implement.** Replace Mix's VO source with `heardVoice`. Remove the assembled-read path from Mix and from any lib helper only Mix used.

- [ ] **Step 4: Run all gates.** These are the same as Task 3 Step 4, including 5× e2e.

- [ ] **Step 5: Commit**

```bash
git add web e2e test
git commit -m "feat(web): Mix plays the newest round's voice pick"
```

---

### Task 5: Docs

**Files:**
- Modify: `README.md` (the "Audio review" paragraph), `AGENTS.md` (the audio and voice workflow), `skills/rushes/SKILL.md`

**Content (§18.1, §18.5):**
- **Voice reads are always whole reads.** Register them with `rushes_add_variant` (`stage: "voice"`, `round`, `description` in `meta`), or `rushes add variant voice <file> --name NAME --round NAME`.
- **Rounds:**
  - Round 1 is the same script in several voices.
  - Later rounds are variations of the picked voice.
  - A small fix to a marked word can go in the current round.
  - Say what changed in `description`.
- **Script edits.** Wording is fixed on the Script tab. When VO already exists, re-record the picked voice with the corrected script as a new read in a new round.
- **Voiceover notes** are Whole (speaker, pacing, tone, overall) or Point (`Fix this` / `Keep this` at a time). There are no ranges or Rise/Fall marks on Voiceover.
- **Mix** plays the newest round's pick.
- **Takes and `rushes_add_take`** remain only for compatibility. Remove any advice to use them.
- **The `on` form** for a read is `"<lane id>/<variant id>"`, where the lane id is the slugged round name.

- [ ] **Step 1:** Edit the three files. Verify every tool name, flag and field against `src/mcp/tools.ts` and `src/cli/main.ts`.
- [ ] **Step 2:** Run `npm run build && npx vitest run`. Then from a clean temp dir, run `cd "$(mktemp -d)" && npx -y "git+file://$REPO#$(git -C "$REPO" branch --show-current)" --help | head -1`, capturing `REPO` before the `cd`.
- [ ] **Step 3: Commit**

```bash
git add README.md AGENTS.md skills/rushes/SKILL.md
git commit -m "docs: Voiceover rounds — whole reads, Whole or Point notes"
```
