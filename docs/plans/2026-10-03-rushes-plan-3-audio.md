# Rushes Plan 3: the audio tabs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Voiceover, Music, Sound effects and Mix tabs. Each one has:
- sample-locked switching between variants on one Web Audio clock;
- waveforms;
- a muted picture preview that follows the audio;
- notes that can be on a lane, a cue or a section, scoped as a point, a range or the whole thing;
- quick marks (Rise, Fall, Louder, Quieter with a dB amount);
- picks;
- Blind mode for Music;
- mute and solo, plus a loudness readout (via ffmpeg) on Mix.

**Architecture:**
- **Server:** adds `marks` to notes, audio-aware batch prompts, mark-aware exports, and a loudness route.
- **Dashboard:** a pure-logic audio module (unit-tested), a thin Web Audio engine on top of it, one shared `AudioStage` layout, and per-tab configuration for Music, SFX, Voiceover and Mix.

**Tech Stack:** as in Plans 1–2d. Web Audio API, no new dependencies.

**Spec:** `docs/specs/2026-10-02-rushes-design.md` §17 (binding), with §6, §8 and §14.5 behind it.

## Global Constraints

- **Dependencies:** runtime dependencies stay exactly `@hono/node-server`, `@modelcontextprotocol/sdk`, `hono` and `zod`. Add no dependency of any kind, including audio libraries.
- **Guards:** every route keeps the Host/Origin/JSON guard and the project guard. Media is still served only for listed assets, with the CSP and attachment rules from Plan 2d.
- **ffmpeg** is optional. Spawn it with an argument array, never through a shell. When it isn't on PATH, features degrade gracefully. Tests inject a fake runner and never require ffmpeg.
- **Visual system (spec §10):**
  - Colours: ground `#0C0D0F`/`#141518`/`#1C1E22`, text `#EEEEF0`, accent `#7C93FF`, to-do `#F5B740`, done `#4CC38A`. Stage colours: VO `#4FD1C5`, music `#A78BFA`, SFX `#FB923C`.
  - Type: Figtree for UI text at 15px and up. JetBrains Mono only for timecodes, ids, shot numbers and file paths.
  - Controls: icon buttons whose tooltips name the key, status shown as marks, no helper captions.
  - Card and tile CSS uses explicit grid tracks (`minmax(0, 1fr)`), never content-sized auto tracks. Safari spills content-sized tracks; see the Plan 2d fix.
- **Keyboard:**
  - Space plays.
  - ←/→ steps one frame, Shift+←/→ steps ten.
  - I/O sets in and out.
  - N makes a new note.
  - 1–7 switch tabs.
  - [/] go to the previous/next film.
  - ? shows shortcuts.
  - Esc closes.
- **Data safety:**
  - Nothing pending is ever dropped.
  - Old data still loads: a note without `marks` validates.
  - Only one thing plays at a time across the dashboard. The Assets inline player and an audio tab never play together.
- **Tests:**
  - Never open apps (`RUSHES_NO_REVEAL=1`).
  - Audio fixtures are generated in code as small WAVs, never downloaded.
  - The e2e suite must pass 5 consecutive default-parallel runs with no retries.
- **Git:**
  - Use the repo's local identity, `iamredmh <17407420+iamredmh@users.noreply.github.com>`. Never change git config.
  - End each message with a blank line and then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Never push.
- **Prose:** UK English. No client or brand names, and no local paths.

## Review Focus

1. **Switching never moves the playhead or clicks.** Changing variant mid-play is a 4 ms gain ramp on the same clock: the engine time before and after differs by less than one render quantum, and the sources are never restarted. *(Tasks 2 and 3)*
2. **Picture and audio stay in sync.** After a seek, and while playing, the preview is within one frame of the audio clock. *(Tasks 2 and 3)*
3. **Notes land on the right thing.** A range note with marks on Music, a note on an SFX cue, and a note on a VO section each save the right `on`, `t`, `tOut` and `marks`, and render on the right lane. *(Tasks 1, 3 and 4)*
4. **Resources are cleaned up.** Leaving an audio tab stops playback and releases its sources. Switching tabs repeatedly doesn't pile up AudioContexts. *(Task 2)*
5. **Loudness never blocks.** With no ffmpeg, the Mix tab shows `—`. A slow ffmpeg run never freezes the UI, results are cached, and nothing is spawned in tests. *(Tasks 1 and 5)*

---

### Task 1: Server — note marks, audio prompts, loudness

**Files:**
- Modify: `src/core/schema.ts`, `src/core/notes.ts`, `src/core/batches.ts`, `src/core/exportNotes.ts`, `src/server/app.ts`, `src/cli/main.ts`
- Create: `src/server/loudness.ts`
- Test: `test/core/notes.test.ts`, `test/core/tabs-batches.test.ts`, `test/core/exportNotes.test.ts`, `test/server/loudness.test.ts` (new), `test/server/app.test.ts`, `test/cli/main.test.ts`

**Interfaces (produces):**
```ts
// schema.ts
export const MarkSchema = z.object({ kind: z.enum(["rise", "fall", "louder", "quieter"]), db: z.number().min(0.5).max(24).optional() });
// NoteSchema gains: marks: z.array(MarkSchema).max(4).default([])   (louder/quieter need db; rise/fall must not carry db; no duplicate kinds)
export function markLabel(m: Mark): string; // "Rise" | "Fall" | "Louder 3 dB" | "Quieter 3 dB"
// loudness.ts
export interface LoudnessRunner { (args: string[]): Promise<{ code: number; stderr: string }> }
export function ffmpegAvailable(run?: LoudnessRunner): Promise<boolean>;
export interface MixInput { file: string /* abs */; offset: number /* seconds */; stage: "voice" | "music" | "sfx" }
export function mixInputs(project, script, picks, lanes: ("voice"|"music"|"sfx")[], root): MixInput[];
export function loudnessArgs(inputs: MixInput[]): string[];  // ffmpeg -nostats -i ... -filter_complex "[0]adelay=...[a0];...;amix=inputs=N:normalize=0,ebur128=peak=true" -f null -
export function parseEbur128(stderr: string): { integrated: number | null; truePeak: number | null };
export async function measureMix(...): Promise<{ available: boolean; integrated: number | null; truePeak: number | null; musicUnderVo: number | null }>;
```

**Behaviour:**
- **Notes.** `POST /api/notes` and `PATCH` accept `marks`. Validation:
  - `louder`/`quieter` require `db`;
  - `rise`/`fall` reject `db`;
  - duplicate kinds are a 400;
  - marks only on stages `voice`, `music`, `sfx` and `mix`.
- **Batch prompt.** For audio stages, `buildPrompt` reads: `Use rushes_get_batch and rushes_get_picks, fix each note (marks such as "Fall" or "Quieter 3 dB" are part of the note), register the new variant or take, then rushes_reply.`
- **Exports.** `notesMarkdown` and the CLI `rushes notes` append marks after the timecode: `**0:12.00–0:15.00** · Fall · Quieter 3 dB · to do — …`.
- **`mixInputs`:**
  - VO uses each section's picked take, or its newest, offset at `section.start`, plus the picked `voice` variant, offset 0.
  - Music uses the picked variant of each `music` lane, or the first, offset 0.
  - SFX uses the picked pass, or the first.
  - Missing files are skipped.
- **`POST /api/mix/loudness { lanes }`:**
  - Runs ffmpeg through an injectable runner (`AppOptions.loudnessRunner`, defaulting to a spawn of `ffmpeg` with an argument array).
  - The result is cached in memory by a key made from the inputs' paths, mtimes and offsets.
  - Returns `{ available: false }` when ffmpeg is missing.
  - `musicUnderVo` = music integrated minus VO integrated, each measured alone over the VO's span (or `null` if either lane is missing).
  - Times out after 60 s with a 504.

- [ ] **Step 1: write the failing tests:**
  - mark validation (all the rules above);
  - `markLabel`;
  - old notes without marks load;
  - the audio-stage prompt wording;
  - export and CLI output with marks;
  - `mixInputs` offsets for 2 sections (picked and newest), music pick and SFX pick;
  - `loudnessArgs` for 3 inputs (exact array);
  - `parseEbur128` on a real captured ffmpeg summary block (include one fixture string);
  - the route with a fake runner: available result, caching (the runner is called once for two identical requests), unavailable result, and the timeout returning 504.
- [ ] **Step 2:** run the tests and see them fail.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run `npx vitest run && npm run typecheck`. Both must pass.
- [ ] **Step 5:** commit with `feat(server): note marks, audio batch prompts and the mix loudness readout`.

---

### Task 2: The audio engine (web)

**Files:**
- Create:
  - `web/src/audio/timeline.ts`: pure. Gains, scheduling, drift, peaks, the VO assembly.
  - `web/src/audio/engine.ts`: Web Audio, thin.
  - `web/src/audio/useAudioStage.ts`: a hook.
- Test:
  - `test/web/timeline.test.ts` (new);
  - `e2e/fixtures/wav.ts` (new; generates a WAV in code);
  - `e2e/audio.spec.ts` (new).

**Interfaces (produces):**
```ts
// timeline.ts (pure)
export interface Clip { id: string; lane: string; path: string; offset: number; duration: number }   // offset = where it starts on the timeline
export function laneGains(lanes: { id: string; muted?: boolean; solo?: boolean }[]): Record<string, number>; // solo wins over mute
export function activeVariantGain(selected: string, variantId: string): 0 | 1;
export function startPlan(clips: Clip[], at: number): { id: string; when: number /* ctx delay */; offset: number /* into buffer */ }[]; // clips that overlap `at` or start later
export function needsVideoSync(videoTime: number, audioTime: number, fps: number): boolean;            // |Δ| > 1/fps
export function computePeaks(channel: Float32Array, buckets: number): Float32Array;                   // max |x| per bucket
export function assembleRead(sections, picks, takes): Clip[];                                          // §17.5
export function timelineLength(videoDuration: number | null, clips: Clip[]): number;
// engine.ts
export class AudioEngine {
  constructor(ctx?: AudioContext);
  load(path: string): Promise<{ duration: number; peaks: Float32Array; streamed: boolean }>;  // decode + peak cache; >15 min or decode failure → streamed via <audio>
  setClips(clips: Clip[]): void;
  setLaneGain(lane: string, gain: number): void;      // 4 ms ramp on ctx clock
  play(at: number): void; pause(): void; seek(t: number): void;
  get time(): number; get playing(): boolean;
  onTick(cb: (t: number) => void): () => void;         // rAF while playing
  dispose(): void;                                      // stops sources, closes ctx
}
```

**Behaviour:** follow spec §17.2.
- Seek and play restart the sources from `startPlan`.
- `setLaneGain` uses `setTargetAtTime` or a linear ramp over 4 ms, starting at `ctx.currentTime`.
- `dispose` is called when the hook unmounts.
- A module-level "one player" bus stops the Assets inline player when an audio tab starts, and the reverse.
- **WAV fixture:** `makeWav({ seconds, freq, sampleRate: 22050 })` returns a mono 16-bit PCM WAV `Buffer`, and is deterministic.

- [ ] **Step 1: write the failing tests.**
  - Unit tests:
    - `laneGains` covers solo/mute combinations;
    - `startPlan` covers overlapping and future clips;
    - `needsVideoSync` at the one-frame boundary;
    - `computePeaks` on a known signal;
    - `assembleRead` handles picked, newest and missing takes;
    - `timelineLength`.
  - e2e (a test page is fine via the dashboard once Task 3 exists; for now, an isolated harness page served from the built dashboard isn't required):
    - drive the engine in the browser with `page.evaluate`, importing the built module through the dashboard;
    - **or** defer the e2e engine checks to Task 3, and keep this task to unit tests and a tiny smoke test.
    - Choose whichever keeps the suite stable, and say which in the report.
- [ ] **Step 2:** run them and see them fail.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run `npx vitest run && npm run typecheck`. Both must pass.
- [ ] **Step 5:** commit with `feat(web): the audio engine, one clock, sample-locked switching`.

---

### Task 3: Music and Sound effects tabs

**Files:**
- Create: `web/src/ui/AudioStage.tsx` (the shared layout), `web/src/ui/Lanes.tsx`
- Modify:
  - `web/src/ui/App.tsx`: routing, and `BUILT.music = BUILT.sfx = true`.
  - `web/src/ui/Notes.tsx`: On menu, scope switch, chips and marks. Optional props, so Picture is unchanged.
  - `web/src/lib.ts`, `web/src/styles.css`, `web/src/ui/Icon.tsx`.
- Test: `test/web/lib.test.ts`, `e2e/audio.spec.ts`, and `e2e/fixture.ts` (helpers `addVariant(stage, name, opts)` that write a generated WAV).

**Behaviour:** follow spec §17.1, §17.3 and §17.4.
- **Music lanes:** cards with name and description (or BPM · key), Use / In use, and Blind.
- **SFX lanes:** cue labels on the waveform; the On menu includes cues.
- **Transport:** play/pause, step, In/Out and range. Lane click selects and auditions.
- **Preview:** a muted picture preview top right, synced to the engine.
- **Notes:**
  - On menu, defaulting to the selected lane;
  - Point/Range/Whole;
  - chips;
  - marks, shown only in Range scope;
  - each note draws on its lane.

**Tests (e2e):**
1. **Music shows a card per bed.** It has name, description, In use / Use, and Use persists to picks via the API.
2. **Switching beds mid-play doesn't move the playhead.**
   - Play, wait 0.5 s, then click another lane.
   - Engine time is monotonic across the switch, and the gap is under 50 ms.
   - The previous variant's gain is 0, the new one's is 1. Expose the engine on `window.__rushesAudio` in the e2e build only, or read the state via data attributes.
3. **A range note with Fall and Quieter 3 dB saves the right fields.** Expected: `on`, `t`, `tOut` and `marks`. It renders on the lane.
4. **Blind hides names and reveals them.**
5. **SFX.**
   - Cues are labelled.
   - A note on `Cue · Swipe` saves `on` = cue id and `t` = cue time.
6. **The preview follows the audio.** After a seek to 2.0 s, the preview's `currentTime` is within 1/fps.
7. **Leaving the tab stops playback**, and coming back doesn't double the sources (check a source count).
8. **Assets inline audio stops** when Music starts playing, and the reverse.

- [ ] Write the tests and see them fail.
- [ ] Implement.
- [ ] Build, run the unit tests and typecheck, then run e2e 5 times with default parallelism.
- [ ] Commit with `feat(web): Music and Sound effects tabs — lanes, switching, notes with marks`.
- [ ] **Screenshot:** save Music and SFX screenshots to a scratch folder outside the repo, and give the paths in the report.

---

### Task 4: Voiceover tab

**Files:** `web/src/ui/Voice.tsx` (new, built on AudioStage), `web/src/ui/App.tsx` (`BUILT.voice = true`), `web/src/lib.ts`, styles. Test: `e2e/audio.spec.ts`, `test/web/lib.test.ts`.

**Behaviour:** follow spec §17.5.
- **Assembled read:** a top lane, with section labels.
- **Section switch:** picks the section whose takes show as sub-lanes over its span.
- **Use:** sets `picks.sections`.
- **Stale mark:** on takes, with a tooltip.
- **New take:** prefills the note box and sets On.
- **Voice variants:** shown as extra lanes.

**Tests (e2e):**
1. **The assembled read.** It places each section's picked take at its start. Checked via the clip plan exposed for tests.
2. **Using another take.** It updates `picks.sections` and the assembled read, without moving the playhead.
3. **Stale takes.** A stale take shows the mark after the agent changes the line.
4. **New take.** It fills `Another take of S2: ` and sets On to S2.
5. **A VO note on a section range with Louder 2 dB.** It saves correctly.

- [ ] Write the tests and see them fail.
- [ ] Implement.
- [ ] Build, run the unit tests and typecheck, then run e2e 5 times.
- [ ] Commit with `feat(web): Voiceover tab — assembled read, takes per section, picks`.
- [ ] **Screenshot:** save a screenshot to a scratch folder.

---

### Task 5: Mix tab

**Files:** `web/src/ui/Mix.tsx` (new), `web/src/ui/App.tsx` (`BUILT.mix = true`), styles. Test: `e2e/audio.spec.ts`, `test/web/timeline.test.ts`.

**Behaviour:** follow spec §17.6.
- **Lanes:** three of them. VO is the assembled read; Music and SFX are the picked variants.
- **Mute and solo:** M and S on each lane. Solo wins.
- **Loudness readout:**
  - It fetches `/api/mix/loudness` for the unmuted lanes, debounced by 500 ms.
  - While loading it shows a quiet "measuring" mark.
  - It shows `—` with a tooltip when ffmpeg isn't available.
  - The three values are LUFS integrated, dBTP and music under VO.

**Tests:**
- **Unit:** solo and mute gain resolution, already done in Task 2. Add the readout formatting.
- **e2e:**
  1. Mute and solo change the lane gains. Solo wins.
  2. The loudness readout shows values. The e2e fixture's server runs with real ffmpeg if it's on PATH; otherwise assert `—`. Write the test so it passes in both cases, checking the shape rather than the exact numbers.
  3. Leaving Mix stops playback.

- [ ] Write the tests and see them fail.
- [ ] Implement.
- [ ] Build, run the unit tests and typecheck, then run e2e 5 times.
- [ ] Commit with `feat(web): Mix tab — mute, solo and loudness`.
- [ ] **Screenshot:** save a screenshot to a scratch folder.

---

### Task 6: Docs

- **README.** Add a short "Audio review" paragraph covering:
  - the four tabs;
  - Use and picks;
  - Blind;
  - marks;
  - loudness needs ffmpeg.

  Add the shortcuts too.
- **AGENTS.md.** Add:
  - how to register variants with `meta.description`;
  - where takes go;
  - reading picks;
  - what marks mean (Fall = bring it down over the range; Quieter 3 dB = 3 dB lower over the range);
  - the audio batch flow.
- **SKILL.md:** the same essentials, in brief.
- **Verify:**
  - run the full suite;
  - do a fresh install with `cd "$(mktemp -d)" && npx -y "git+file://$REPO#plan-3-audio" --help | head -1`, where `$REPO` is the repo path, captured before the `cd`.
- [ ] Commit with `docs: the audio tabs, picks, marks and loudness`.
