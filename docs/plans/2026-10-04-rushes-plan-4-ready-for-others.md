# Rushes Plan 4: Ready for Other People — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Rushes easy for someone else to pick up, try and trust. That means:
- locked tabs that explain themselves;
- an example project;
- a health check;
- CI in Chromium and WebKit;
- opt-in proxies;
- Mix levels;
- npm readiness.

**Architecture:** Each part plugs into existing seams:
- **Server:** Hono routes and the single-writer store. Proxies run as one ffmpeg job per version, with progress over the existing SSE stream.
- **Web:** the Preact tabs. Locked tabs get a real page, Picture gets the proxy bar and switch, and Mix gets level sliders.
- **CLI and MCP:** they gain `demo` and `doctor` / `rushes_doctor`.
- **Repo:** CI is a GitHub Actions workflow.

**Tech Stack:** TypeScript (ESM, NodeNext), Hono, zod, Preact 10, Vite 8, Web Audio, ffmpeg/ffprobe (optional at runtime), vitest, Playwright (Chromium + WebKit), GitHub Actions.

**Spec:** `docs/specs/2026-10-02-rushes-design.md` §19, which is binding. It refers back to §6, §15–§18.

## Global Constraints

- **Language and type:** UK English in all copy and docs. Type is 15px or larger everywhere.
- **Dependencies:** runtime dependencies stay exactly `@hono/node-server`, `@modelcontextprotocol/sdk`, `hono` and `zod`. Dev dependencies may be added only if the task says so.
- **ffmpeg:** optional at runtime. Every ffmpeg path degrades gracefully, with a plain message, when it's missing. ffmpeg and ffprobe are spawned with an args array and never through a shell.
- **Rendering:**
  - Grids use explicit tracks (`minmax(0,1fr)`).
  - No per-frame React state.
  - The test hook exists only with `?test=1`.
- **Tests:**
  - Tests never open apps (`RUSHES_NO_REVEAL=1`).
  - e2e must pass 5 consecutive default-parallel runs with `--retries=0`. From Task 7 on, that includes WebKit.
  - Never touch ports 4410, 4430, 4431, 4432 or 8765.
- **Privacy:** no client or brand names and no personal paths in tracked files.
- **Git:** commit with the repo's existing identity; never change git config. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **House style:**
  - icon buttons with `data-tip` tooltips;
  - status shown as marks;
  - no helper text beyond what the spec names.
- **Nothing pending is ever dropped:** `notePending` stays the single definition.
- **Large files and long jobs:** anything that writes large files or runs long jobs on the user's machine needs an explicit button, visible progress and Cancel.

## Review Focus

1. **The server restarts mid-proxy.** No half-written file should be left posing as a proxy. On start, the server deletes any `proxies/*.partial.mp4`, and a version's `proxy` record exists only after a completed render. *(Task 3.)*
2. **Create proxy is pressed twice** (two tabs, or a double click). There must be exactly one job per version; the second request joins the first and gets its job id. *(Task 3.)*
3. **The original file is missing or unreadable when a proxy starts.** The job fails visibly, with the reason, and the UI returns to the offer. There is no crash and nothing is left behind. *(Tasks 3 and 4.)*
4. **`rushes demo` is run into a non-empty folder, or without ffmpeg.** It refuses with one line and writes nothing. *(Task 5.)*
5. **`rushes doctor` is run outside any project folder.** It still reports the environment checks, and the project checks read "no project here". *(Task 6.)*

---

## File structure

| Area | Files |
|---|---|
| Locked tabs | `web/src/ui/App.tsx` (`Empty`, `show`, `showAssets`), `web/src/lib.ts` (`UNLOCK_HINT` → `LOCKED_TAB` copy + `agentPrompt`), `web/src/styles.css` |
| Levels | `src/core/schema.ts` (`PicksSchema.levels`), `src/server/app.ts` (`PUT /api/picks`), `src/server/loudness.ts` (per-input `volume`), `web/src/ui/Mix.tsx`, `web/src/ui/Lanes.tsx` (a control slot), `web/src/lib.ts` (`laneGains`), `src/core/batches.ts` |
| Proxies (server) | `src/core/schema.ts` (`VersionSchema.proxy`, `ProjectSchema.autoProxy`), `src/core/media.ts` (`proxyNeed`), new `src/server/proxy.ts` (job runner), `src/server/app.ts` (routes, SSE, frame extraction), `src/server/start.ts` (startup clean-up), `src/mcp/tools.ts` (`rushes_add_version` result) |
| Proxies (web) | `web/src/ui/Picture.tsx`, new `web/src/ui/ProxyBar.tsx`, `web/src/useRushes.ts` (the `proxy` SSE event), `web/src/lib.ts` (`FOLDERS` + Proxies), `web/src/ui/Assets.tsx`/`AssetViews.tsx` |
| Demo | new `src/cli/demo.ts`, `src/cli/main.ts` |
| Doctor | new `src/cli/doctor.ts`, `src/cli/main.ts`, `src/mcp/tools.ts` (`rushes_doctor`) |
| CI + WebKit | new `.github/workflows/ci.yml`, `playwright.config.ts` (projects), `e2e/fixture.ts` (permissions per browser), the vertical box measuring fix (`web/src/ui/Picture.tsx` box code) |
| Follow-ups | `web/src/ui/Voice.tsx`, `web/src/audio/engine.ts`, `web/src/ui/AudioStage.tsx` (keys) |
| npm | `package.json` (`files`, `prepublishOnly`), `src/setup/harnesses.ts` (`SOURCE`), README/AGENTS/SKILL |

---

### Task 1: Locked tabs explain themselves (§19.1)

**Files:**
- Modify: `web/src/ui/App.tsx` (`Empty` around lines 18-30; `show`/`showAssets`, which currently toast "Nothing to review in … yet")
- Modify: `web/src/lib.ts` (`UNLOCK_HINT`, lines 95-101)
- Modify: `web/src/styles.css`
- Test: `test/web/lib.test.ts`, `e2e/dashboard.spec.ts`

**Interfaces:**
- Produces: `LOCKED_TAB: Record<Stage | "assets", { what: string; unlocks: string; ask: string }>`, the copy for each tab. Use the wording below.
- Produces: `agentPrompt(stage, projectName: string, filmName: string | null): string`, which returns the copyable request.

Copy, used verbatim:

| Tab | what | unlocks | prompt (with `{p}` the project and `{f}` the film) |
|---|---|---|---|
| Script | Read the VO line by line and suggest your own wording. | Your agent adds the script. | `In Rushes project "{p}", add the voiceover script{for "{f}"} with rushes_set_script, one section per line with start and end times.` |
| Picture | Watch each cut, leave timecoded notes and lock the picture. | Your agent adds a cut. | `In Rushes project "{p}", add the latest cut{of "{f}"} with rushes_add_version.` |
| Voiceover | Compare whole reads in rounds and pick one. | Your agent adds voice reads. | `In Rushes project "{p}", record two or three voice reads{for "{f}"} and add each with rushes_add_variant (stage "voice", round "Round 1 · Voices") with a one-line description.` |
| Music | Compare music beds against the picture and pick one. | Your agent adds music beds. | `In Rushes project "{p}", make two or three music beds{for "{f}"} and add each with rushes_add_variant (stage "music") with a one-line description.` |
| Sound effects | Compare SFX passes, cue by cue. | Your agent adds an SFX pass. | `In Rushes project "{p}", make a sound-effects pass{for "{f}"} and add it with rushes_add_variant (stage "sfx") with its cues.` |
| Mix | Balance voice, music and effects and check loudness. | Unlocks with a cut and any audio. | `In Rushes project "{p}", add a cut and at least one voice read, music bed or SFX pass{for "{f}"}.` |
| Assets | Every file in the project in one place. | Unlocks with the first cut, take, track or screenshot. | `In Rushes project "{p}", add the first cut{of "{f}"} with rushes_add_version.` |

`{for "{f}"}` renders as ` for "Hero"` when a film is known, and as nothing otherwise. `{of "{f}"}` works the same way.

Behaviour:
- **Clicking a locked tab opens it.** Its page shows the icon, the tab name, `what`, `unlocks` and a **Copy prompt for your agent** button. The button writes to the clipboard; if the clipboard is refused, it selects the prompt text in a read-only box. A toast confirms "Prompt copied".
- **No notes column on a locked page.**
- **Tooltip:** a locked tab's `data-tip` is `Locked: ask your agent for <noun>`. The nouns are: the script, a cut, voice reads, music beds, an SFX pass, a cut and some audio, and files (for Assets).
- **Keys:** the 1–7 keys open locked tabs too. The pending-note guard still applies.
- **The "is coming" branch of `Empty`:** delete it if no tab is unbuilt (`BUILT` is all true). Otherwise keep it.

- [ ] **Step 1: Write the failing tests.**
  - **Unit:** `agentPrompt("music", "Launch", "Hero")` equals the table's Music prompt with ` for "Hero"`. With `null` it has no film clause. Every key in `LOCKED_TAB` has non-empty `what`, `unlocks` and `ask`.
  - **e2e:** in a project with only a cut:
    1. Click Music. The URL and tab state show Music selected, the page shows `Compare music beds against the picture and pick one.`, and there's no `.notes` column.
    2. Click Copy prompt. `navigator.clipboard.readText()` contains `rushes_add_variant (stage "music")`. Read the clipboard only in Chromium; in WebKit assert the toast instead.
    3. Hover the locked Music tab. Its `data-tip` is `Locked: ask your agent for music beds`.
    4. Press `4`, the Music key, and the Music locked page opens.
- [ ] **Step 2: Run them and see them fail.** Run: `npm run build && npx vitest run test/web/lib.test.ts && npx playwright test e2e/dashboard.spec.ts --retries=0 -g "locked"`. Expected: FAIL. Today a toast shows and the tab doesn't open.
- [ ] **Step 3: Implement it**, as described above.
- [ ] **Step 4: Run all the gates.** Build, vitest, typecheck, then the full e2e suite 5×.
- [ ] **Step 5: Screenshot and commit.** Save a 1440×900 screenshot of the locked Music page to the scratchpad path the dispatch gives. Commit as `feat(web): locked tabs explain themselves and offer a prompt for your agent`.

---

### Task 2: Levels on Mix (§19.6)

**Files:**
- Modify: `src/core/schema.ts` (`PicksSchema`)
- Modify: `src/server/app.ts` (`PicksBody`, `PUT /api/picks`)
- Modify: `src/server/loudness.ts` (`mixInputs` carries `gainDb`; `filterComplex` adds `volume=<db>dB` per input; the cache key includes levels)
- Modify: `src/core/batches.ts` (the Mix prompt)
- Modify: `web/src/ui/Mix.tsx`
- Modify: `web/src/ui/Lanes.tsx` (a slot in the control column, or reuse `ctl` children)
- Modify: `web/src/lib.ts` (`laneGains` takes levels)
- Modify: `web/src/styles.css`
- Test: `test/server/app.test.ts`, `test/server/loudness.test.ts`, `test/core/tabs-batches.test.ts`, `test/web/lib.test.ts`, `e2e/audio.spec.ts`

**Interfaces:**
- **Picks schema:** `PicksSchema` gains `levels: z.object({ voice: z.number(), music: z.number(), sfx: z.number() }).partial().default({})`.
- **`PUT /api/picks` body:** `levels?: { voice?: number | null; music?: number | null; sfx?: number | null }`.
  - A value outside −24..6, or not on a 0.5 step, gives a 400.
  - `null` deletes the key, which means 0.
- **Mix inputs:** `MixInput` gains `gainDb: number`, and `mixInputs` sets it from `picks.levels[stage] ?? 0`.
- **Lane gains:** `laneGains(lanes, muted, soloed, levels)` returns each lane's gain as `dbToGain(level) × muteSolo`, where `dbToGain(db) = 10 ** (db / 20)`.

UI, per the mockup at `.superpowers/sdd/<plan>/approved-mockup.html`. The controller copies it in.
- The control column is M, S, then the slider (`<input type="range" min="-24" max="6" step="0.5">`) with the value `−14.0 dB` in mono.
- Use a real minus sign, U+2212, and a `+` prefix for positive values.
- Double-click resets the level to 0.
- Saving is debounced by 300 ms and goes through `PUT /api/picks`, so the value persists and other tabs see it over SSE.
- `aria-label="<Lane> level"`.
- Every grid has explicit tracks, and the control column is widened so the value never spills.

- [ ] **Step 1: Write the failing tests.**
  - **Server:** `PUT` with `{levels:{music:-14}}` stores it; `{levels:{music:-30}}` gives a 400; `{levels:{music:-13.3}}` gives a 400; `{levels:{music:null}}` removes it.
  - **Loudness:** `filterComplex` puts `volume=-14dB` on the music input, and a level change changes the cache key.
  - **Prompt:** the Mix batch prompt contains `levels`.
  - **Unit:** `laneGains` with level −6 gives about 0.501, and mute still wins.
  - **e2e:**
    1. Drag the music slider to −14. The value reads `−14.0 dB` and `inspect().lanes.music` is about 0.1995.
    2. Reload. It's still −14.
    3. Double-click the slider and it reads `0.0 dB`.
    4. The loudness request is re-sent after the change, using the request-count pattern.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run all the gates.** Build, vitest, typecheck, then the full e2e suite 5×.
- [ ] **Step 5: Screenshot and commit.** Save a screenshot of Mix with levels. Commit as `feat: Mix levels — per-lane dB, saved with the picks, measured by loudness`.

---

### Task 3: Proxies — server (§19.5)

**Files:**
- Modify: `src/core/schema.ts`. `VersionSchema` gains `proxy: z.object({ file, width, height, bytes, createdAt }).nullable().default(null)`. `ProjectSchema` gains `autoProxy: z.boolean().default(false)`.
- Modify: `src/core/media.ts`. Add `proxyNeed(probe, bytes): { reason: string } | null`.
- Create: `src/server/proxy.ts`, the job runner.
- Modify: `src/server/app.ts`, for the routes and the frame endpoint.
- Modify: `src/server/start.ts`, for start-up clean-up.
- Modify: `src/mcp/tools.ts` and `src/cli/main.ts`, so `add_version` reports `proxySuggested`.
- Test: `test/core/media.test.ts` (create if absent), `test/server/proxy.test.ts` (new), `test/server/app.test.ts`.

**Interfaces:**
- **`proxyNeed`** returns a reason when any of these holds, and `null` otherwise:
  - `width > 3000 || height > 3000`, giving "It's a 4K file";
  - `bytes > 1.5e9`;
  - the codec isn't one of `h264`, `vp9` or `av1`, giving e.g. "It's a ProRes file". Name the codec in plain words: `prores` → ProRes, `dnxhd` → DNx, `hevc` → HEVC.

  When several hold, combine them: "It's a 4K ProRes file (2.3 GB), which browsers struggle with". The probe gains `codec`, `width`, `height` and `pixFmt` where `probe()` doesn't already return them.
- **`ProxyJobs`:**
  - `start(videoId, versionId): Job`. It dedupes per version: a running job for the same version is returned as is.
  - `cancel(jobId)` stops the job with SIGTERM, then SIGKILL after 2 s, and deletes `*.partial.mp4`.
  - Each job emits progress events `{ video, version, pct, state: "running" | "done" | "failed" | "cancelled", reason? }`. pct is parsed from `-progress pipe:1` `out_time_us` divided by the duration.
- **Encode arguments** (an args array, no shell):
  ```
  -hide_banner -y -i <orig>
  -vf scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))'
  -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -fps_mode passthrough
  -c:a aac -b:a 160k -movflags +faststart
  -progress pipe:1 <proxies/slug_version_proxy.partial.mp4>
  ```
  On success, rename the file to the final name, then `store.update("project")` to set `version.proxy`.
- **Routes:**
  - `POST /api/videos/:video/versions/:version/proxy` returns `{ job }`: 202, or 200 when joining a running job.
  - `DELETE /api/proxy-jobs/:job` cancels it.
  - `DELETE /api/videos/:video/versions/:version/proxy` deletes the file and the record.
  - `PUT /api/project/settings` takes `{ autoProxy }`.
  - SSE event `proxy`, carrying the progress payload above.
  - `GET /api/videos/:video/versions/:version/frame?t=<s>` returns a PNG of the original at frame `round(t*fps)/fps`, using `-ss` before `-i` plus an accurate seek and `-frames:v 1`. Picture's Grab Frame uses this whenever ffmpeg is available.
- **When a version is added:**
  - if `proxyNeed` holds, the response includes `proxySuggested: true` and `proxyReason`;
  - if `autoProxy` is on, the job starts at once.
- **Start-up:** delete `proxies/*.partial.mp4`.

- [ ] **Step 1: Write the failing tests.**
  - **`proxyNeed`:** a 3840×2160 h264 file gives a reason containing "4K". 1920×1080 h264 at 200 MB gives null. 1920×1080 prores gives "ProRes". A combined case gives "4K ProRes … (2.3 GB)".
  - **`ProxyJobs`** with an injected fake runner, as the loudness tests do:
    - two `start` calls return the same job;
    - `cancel` kills the job and the partial file is gone;
    - progress events are monotonic and end at `done` with the record set;
    - a runner that exits non-zero gives `failed` with a reason, and no record.
  - **Real ffmpeg** (skipped when it's absent): make a 2 s 640×360 ProRes clip with `testsrc`, run the job, and check the proxy exists, is h264, and has the same frame count, using `ffprobe -count_frames`.
  - **Start-up:** a stray `proxies/x.partial.mp4` is deleted when the server starts (Review Focus 1).
  - **Missing original** (Review Focus 3): the job fails with "The original file is missing".
  - **Frame endpoint:** returns `image/png` whose dimensions match the original.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run all the gates.** Build, vitest and typecheck. Run e2e once; the suite is unchanged in behaviour.
- [ ] **Step 5: Commit.** Use `feat(server): opt-in proxies — need detection, one job per cut with progress and cancel, full-quality frames from the original`.

---

### Task 4: Proxies — web (§19.5)

**Files:**
- Create: `web/src/ui/ProxyBar.tsx`
- Modify: `web/src/ui/Picture.tsx`
- Modify: `web/src/useRushes.ts` (the `proxy` SSE event goes into state)
- Modify: `web/src/lib.ts` (adds the `FOLDERS` "Proxies" folder and `formatBytes` reuse)
- Modify: `web/src/ui/Assets.tsx` and `web/src/ui/AssetViews.tsx`
- Modify: `web/src/styles.css`
- Modify: `src/server/assets.ts` (adds a `proxy` asset kind with its bytes)
- Test: `e2e/dashboard.spec.ts`, `test/web/lib.test.ts`

**Interfaces:**
- **Consumes Task 3:**
  - the routes and the SSE `proxy` event;
  - `version.proxy`;
  - the `proxySuggested`/`proxyReason` fields, also exposed on `GET /api/state` per version as `proxyNeed: string | null` (add this in this task if Task 3 didn't);
  - `project.autoProxy`;
  - the frame endpoint.

UI, following the mockup:
- **The offer bar** sits under the player. It shows only when `proxyNeed` is set, there's no proxy and no job is running. It reads `This cut may play slowly. <reason>.`, then **Create proxy** with the tooltip from §19.5. The size estimate is `duration × 8 Mbit/s` (≈ 1 MB/s), rounded to 10 MB.
- **While creating:**
  - `Creating proxy`, a bar and `N%` (mono), then **Cancel**;
  - every tab shows the same progress, because it comes from SSE;
  - on `failed`, a toast gives the reason and the bar returns to the offer.
- **Done:**
  - `✓ Proxy ready` with the path (mono) and size, shown until the film changes;
  - the **Proxy / Original** switch on the player, top left, with tooltips "Playing the lightweight copy. Notes and timings are the same." and "Play the full-quality file. It may stutter.";
  - Proxy is the default, and the choice is remembered per film in memory.
- **Checkbox:** "Create proxies for new cuts like this automatically" is bound to `PUT /api/project/settings`. It shows whenever ffmpeg is available and the film has any cut.
- **Grab Frame:** when the server has ffmpeg, it uses the frame endpoint, so stills come from the original. Otherwise it falls back to the existing canvas grab.
- **Assets › Proxies:**
  - a list folder with name, `size · WxH · from vN`, and a **Delete proxy** icon button with a confirmation;
  - deleting calls `DELETE …/proxy`;
  - the folder shows in the sidebar only once there's a proxy.
- **A playback error** (`<video>` `error` event) on a cut with no proxy shows the offer with the reason "The browser couldn't play this file". This holds even when `proxyNeed` is null.

- [ ] **Step 1: Write the failing e2e tests.** Generate a small ProRes fixture in the test setup with ffmpeg, and skip if it's absent. Use `addCut` with that file.
  1. The offer shows its reason. Create proxy → progress appears → done → the switch appears and `<video>` src points at the proxy. Switching to Original changes the src, and the current time is kept.
  2. Cancel mid-way returns to the offer, and no file is in `proxies/`. Slow the job down with a long `-re`-free source of 20 s if needed, so Cancel is reachable.
  3. Ticking the checkbox stores `autoProxy: true`, and a new qualifying cut starts a job by itself, with visible progress.
  4. Assets › Proxies lists the file with its size, and Delete removes it.
  5. Grab Frame while on Proxy saves a PNG whose width equals the original's.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run all the gates.** Build, vitest, typecheck, then the full e2e suite 5×.
- [ ] **Step 5: Screenshot and commit.** Save screenshots of the offer, the progress and the done state. Commit as `feat(web): proxies are your choice — offer, progress with cancel, Proxy/Original switch, Assets folder`.

---

### Task 5: `rushes demo` (§19.2)

**Files:**
- Create: `src/cli/demo.ts`
- Modify: `src/cli/main.ts` (adds the `demo [dir]` command and its usage line)
- Test: `test/cli/demo.test.ts`

**Interfaces:**
- **`makeDemo(dir: string, deps: { ffmpeg: Runner; say: Runner | null; now: Date }): Promise<{ dir: string }>`**
  - Injectable runners make it testable.
  - It writes media under `dir/media/` and registers everything through the store APIs, the same functions the server uses, so the project is valid.
- **Contents:**
  - A 30 s 1280×720 `testsrc2` film with a `drawtext` timecode. Use `drawtext` only if the build has it; otherwise there's no overlay. It has two cuts, v1 and v2 (v2 with a different hue), and shots every 6 s.
  - Script sections S1–S4 with plain lines about a fictional product called "Lumen".
  - Voice reads:
    - **Round 1 · Voices:** "Voice A" and "Voice B", using `say -v` with two system voices when `say` exists. Otherwise sine-tone placeholders named "Placeholder A/B (no text-to-speech on this machine)".
    - **Round 2 · Voice A, pace:** "Voice A · slower".
  - Music beds "Warm pad" and "Pulse", made from synthesised chords with ffmpeg `aevalsrc` at two tempos.
  - An SFX pass with three whooshes, from filtered noise bursts, and cues.
  - Picks set for music and Round 1.
  - Notes: one point note on Picture, one whole note on Voiceover, one range note on Music with the mark Fall, and one Mix note.
- **Refusals:**
  - if `dir` exists and isn't empty: "That folder isn't empty. Choose a new one: rushes demo <folder>", exit 1;
  - without ffmpeg: "The demo needs ffmpeg to make its media. Run rushes doctor for how to install it.", exit 1.
- **On success** it prints the folder, then runs `open` unless `--no-browser` is given.

- [ ] **Step 1: Write the failing tests.**
  - With fake runners: the non-empty folder and no-ffmpeg cases refuse without writing anything (Review Focus 4). A good run leaves a project with 1 video and 2 versions, voice lanes `round-1-voices` and `round-2-voice-a-pace`, 2 music variants, 1 SFX pass with 3 cues, and 4 notes.
  - With real ffmpeg (skipped when absent): `makeDemo` into a temp folder produces playable files. Check with ffprobe that each has a stream.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the gates.** Build, vitest and typecheck. Also run `node dist/cli/index.js demo <tmp> --no-browser` by hand and list the result.
- [ ] **Step 5: Commit.** Use `feat(cli): rushes demo builds an example project with generated media`.

---

### Task 6: `rushes doctor` and `rushes_doctor` (§19.3)

**Files:**
- Create: `src/cli/doctor.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/mcp/tools.ts`
- Test: `test/cli/doctor.test.ts`, `test/mcp/tools.test.ts`

**Interfaces:**
- **`runDoctor(env: DoctorEnv): Promise<Check[]>`**, where `Check = { id: string; ok: boolean; required: boolean; label: string; detail: string; fix?: string }`. `DoctorEnv` injects:
  - the node version;
  - `which ffmpeg` and `ffprobe` with their version;
  - the harness detection from `src/setup/harnesses.ts`, `harnesses()` and the existing config readers;
  - the cwd project state (`.rushes/` present, files valid via the zod schemas, `server.json` alive);
  - free disk space (`fs.statfs`) when `proxies/` exists.
- **The CLI** prints `✓ label — detail` or `✗ label — detail. Fix: …`. `--json` prints the array. The exit code is 1 if any required check fails.
- **`rushes_doctor`** returns the array.
- **Outside a project** (Review Focus 5): the project checks read `No Rushes project in this folder` with `ok: true, required: false`.

- [ ] **Step 1: Write the failing tests.** Use fake envs:
  - Node 18 fails with a fix.
  - No ffmpeg is `required: false` with an install fix: `brew install ffmpeg` on macOS, the winget line on Windows, and apt on Linux.
  - A corrupt `notes.json` fails with the file name.
  - Outside a project, the project checks read as above.
  - `--json` output parses.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the gates.** Build, vitest and typecheck. Also run `node dist/cli/index.js doctor` by hand in the repo and in a temp folder.
- [ ] **Step 5: Commit.** Use `feat: rushes doctor checks Node, ffmpeg, agents and the project, with plain fixes`.

---

### Task 7: WebKit in the suite, the vertical-box fix, and CI (§19.4)

**Files:**
- Modify: `playwright.config.ts`. Use two projects, `chromium` (Desktop Chrome) and `webkit` (Desktop Safari), with the same viewport.
- Modify: `e2e/fixture.ts`, or wherever `grantPermissions(["clipboard-write" …])` lives. Grant clipboard permissions only for Chromium. Tests that read the clipboard assert the toast in WebKit.
- Modify: `web/src/ui/Picture.tsx`, the box measuring code, so box coordinates are measured against the video's rendered content rect, using `object-fit: contain` maths from `videoWidth`/`videoHeight` and the element's box. Don't rely on a property WebKit computes differently.
- Create: `.github/workflows/ci.yml`
- Test: the whole e2e suite in both projects.

**CI workflow:**
- Triggers: `push` and `pull_request`.
- Matrix: node `20.19.x` and `22.x`, on `ubuntu-latest`.
- Steps:
  1. checkout;
  2. setup-node with npm cache;
  3. `sudo apt-get update && sudo apt-get install -y ffmpeg`;
  4. `npm ci`;
  5. `npm run build`;
  6. `npm run typecheck`;
  7. `npx vitest run`;
  8. `npx playwright install --with-deps chromium webkit`;
  9. `npx playwright test --retries=0`;
  10. `npm pack --dry-run --json > pack.json`, then a node one-liner that fails if any path doesn't start with an allowed prefix (`dist/`, `web-dist/`, `skills/`, `.claude-plugin/`, `.mcp.json`, `README.md`, `AGENTS.md`, `LICENSE`, `package.json`).
- On failure, upload the Playwright report as an artifact.

- [ ] **Step 1: Run the suite.** Run `npx playwright test --project=webkit --retries=0`. Expected: the 4 known failures (3 clipboard permission, 1 vertical box ratio 1.57).
- [ ] **Step 2: Fix them.** Fix the permissions per browser, then the box measuring, which also needs a unit test of the content-rect maths in `test/web/lib.test.ts`. Pull the maths into a pure `contentRect(videoW, videoH, boxW, boxH)` in lib.
- [ ] **Step 3: Run the gates.** Build, vitest, typecheck, then the full e2e suite, both projects, 5×.
- [ ] **Step 4: Check the workflow.** Validate it locally if `act` is present; otherwise check the YAML with `node -e "require('yaml')"` only if `yaml` is already a dependency, and skip this check if not. Don't add dependencies. The real check is the first push, which the controller does with the user's OK.
- [ ] **Step 5: Commit.** Use `feat: CI in Chromium and WebKit; a box on a vertical cut is measured against the picture in Safari`.

---

### Task 8: Follow-ups (§19.8)

**Files:**
- Modify: `web/src/ui/Voice.tsx`, which decides the clips: the current round, open folds and the selected read.
- Modify: `web/src/audio/engine.ts`, for the LRU release of buffers dropped from clips (cap 12) and a re-render while playing (the lane rejoins after decoding instead of `tick()` pausing).
- Modify: `web/src/ui/AudioStage.tsx`, so Space on a focused `<button>` isn't handled as play.
- Test: `test/web/engine.test.ts`, `e2e/audio.spec.ts`

**Behaviour:**
- **Folding a round** drops its reads from the engine clips unless one is selected. Playback of the heard read never restarts, so assert that sources stay stable for the heard lane.
- **Re-rendering the only clip mid-play:** replace the file and bump its rev. Playback continues; the lane is silent until decoded, then rejoins at the right offset.
- **Space with "Measure again" focused** triggers the retry, not playback.

- [ ] **Step 1: Write the failing tests**, one for each behaviour above.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run all the gates**, both browser projects, 5×.
- [ ] **Step 5: Commit.** Use `fix(web): voice rounds decode only what you can hear; a re-render keeps playing; Space on a button presses it`.

---

### Task 9: npm readiness and docs (§19.7)

**Files:**
- Modify: `package.json`. `files` gets exactly the §19.7 list. Add `prepublishOnly: "npm run build && npm run typecheck && npx vitest run"`. Bump the version to `0.2.0`.
- Modify: `src/setup/harnesses.ts`. **Do not switch `SOURCE` yet.** Add `export const NPM_SOURCE = "rushes"` and a comment saying the switch happens in the publish commit.
- Modify: `README.md`, `AGENTS.md`, `skills/rushes/SKILL.md`. Add the new commands (`demo`, `doctor`), proxies, levels, locked tabs and a "Publishing" section for maintainers: `npm login`, then `npm publish` with the maintainer's OK.
- Test: `test/setup/*` (unchanged behaviour), plus a new `test/package.test.ts` that reads `package.json` and asserts `files` equals the list.

- [ ] **Step 1: Write the failing test** for `files`.
- [ ] **Step 2: Implement it.** Then run `npm pack --dry-run` and paste the file list into the report.
- [ ] **Step 3: Run the gates.** Build, vitest, typecheck, the full e2e suite once, and the fresh-install check from a temp dir: `npx -y "git+file://$REPO#<branch>" --help`.
- [ ] **Step 4: Commit.** Use `chore: ready for npm — package files, prepublish checks, docs for demo, doctor, proxies and levels`.

The actual `npm publish` and the `SOURCE` switch happen after merge, with the user, outside this plan.
