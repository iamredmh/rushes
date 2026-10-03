# Rushes Plan 2c: Screenshots and the Assets tab

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Frame grabs are saved as screenshots in a visible `screenshots/` folder. A last tab, Assets, gathers every file the project has, with Download, Save as, Show in Finder and Copy path.

**Architecture:**
- **Server:** grabs are written under `screenshots/` with readable names. An asset index is built from the registered media plus the screenshot folders, and served at `GET /api/assets`. `/media` gains a download mode, and `POST /api/reveal` hands a listed file to the OS file manager.
- **Dashboard:** gains the Assets tab.
- **Agents:** `rushes_list_assets` and `rushes assets` expose the same list.

**Tech Stack:** as Plans 1–2b.

**Spec:** `docs/specs/2026-10-02-rushes-design.md` §15 (binding), with §14 and earlier where §15 is silent.

## Global Constraints

- **Dependencies.** Runtime dependencies stay exactly `@hono/node-server`, `@modelcontextprotocol/sdk`, `hono` and `zod`. Add no dependency of any kind.
- **Guards.** Every route keeps the Plan 1 Host/Origin/JSON guard and the §14.1 project guard.
- **What may be served or revealed.** `/media` and `/api/reveal` act only on registered media, `screenshots/<safe>.png` or `.rushes/grabs/<safe>.png`. Anything else gets a 404, and the response never reveals whether a file exists.
- **No shell, no side effects in tests.**
  - Reveal spawns its command with an argument array, never through a shell.
  - Tests must never open Finder or Explorer. Honour `RUSHES_NO_REVEAL=1`, which the e2e fixture and vitest setup set. Unit tests inject a fake revealer.
- **Visual system (spec §10):**
  - Colours: ground `#0C0D0F` / `#141518` / `#1C1E22`, text `#EEEEF0`, accent `#7C93FF`, to-do `#F5B740`, done `#4CC38A`.
  - Fonts: Figtree for UI text at 15px and up; JetBrains Mono for timecodes, ids, shot numbers and file paths only.
  - Controls are icon buttons whose tooltips name the key. Status is shown as marks, with no helper captions.
  - Tooltips inside the header open downwards.
- **Keyboard:**
  - Space: play.
  - ← / →: one frame (with Shift, ten).
  - I / O: in and out.
  - B: box.
  - G: grab.
  - N: new note.
  - 1–7: tabs (7 = Assets).
  - [ / ]: previous and next film.
  - ?: shortcuts.
  - Esc: close.
- **Nothing pending is ever dropped.**
- **Old data still loads.** Plan 2 grabs under `.rushes/grabs/` keep working.
- **Git.**
  - Commits use the repo's local identity (`iamredmh <17407420+iamredmh@users.noreply.github.com>`). Never change git config.
  - Each message ends with a blank line and then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Never push.
- **Prose** is UK English. No client names (Caffeine, OISY, DFINITY) and no private paths.

## Review Focus

1. **Path traversal through reveal and download.** `POST /api/reveal` with `../../etc/passwd`, an absolute path, `screenshots/../.rushes/notes.json` or a symlink name gets a 404. Only listed assets are acted on. *(Task 1)*
2. **Tests open nothing.** No test may launch Finder. *(Tasks 1 and 2, via the env var and an injected revealer)*
3. **A deleted file** is listed as missing; Download, Save as and Show are disabled; nothing crashes. *(Tasks 1 and 2)*
4. **Download file names** with spaces, accents or non-Latin characters get a correct `Content-Disposition`. *(Task 1)*
5. **A grab on its own** no longer blocks a film switch, and the note can still attach it. *(Task 2)*

---

### Task 1: Server, agent and CLI

**Files:**
- Modify: `src/server/files.ts`, `src/server/app.ts`, `src/server/start.ts` (pass the revealer), `src/mcp/tools.ts`, `src/cli/main.ts`
- Create: `src/server/assets.ts`, which builds the index, and `src/server/reveal.ts`, the OS reveal
- Test: `test/server/assets.test.ts` (new), `test/server/app.test.ts`, `test/mcp/tools.test.ts`, `test/cli/main.test.ts`

**Interfaces (produces):**
```ts
// src/server/assets.ts
export type AssetKind = "screenshot" | "cut" | "take" | "music" | "sfx" | "voice";
export interface Asset {
  kind: AssetKind; path: string; abs: string; name: string;
  size: number | null; modified: string | null; missing: boolean;
  video?: string; version?: string; frame?: number; t?: number;   // screenshots + cuts
  section?: string;                                                // takes
  lane?: string; variant?: string;                                 // variants
}
export function screenshotName(video: string, version: string, frame: number, fps: number): string;
// -> "hero-60s_v3_00m12.05s_f726.png"
export async function listAssets(store: Store, project: Project, script: Script): Promise<Asset[]>;
// src/server/files.ts
export const SCREENSHOT_PATH: RegExp; // /^screenshots\/[a-z0-9][a-z0-9._-]*\.png$/
// src/server/reveal.ts
export type Revealer = (abs: string) => Promise<void>;
export const osRevealer: Revealer; // honours RUSHES_NO_REVEAL=1 (logs "reveal <abs>" to stderr instead)
// AppOptions gains: reveal?: Revealer   (default osRevealer)
```

**Behaviour:**
- **`POST /api/grabs`** (body unchanged):
  - Writes to `screenshots/<screenshotName(...)>`, creating the folder, and returns `{ grab: "screenshots/<name>" }`.
  - The fps is the version's, falling back to the project's.
  - Video ids and version ids are already constrained by the route's regex.
- **`GET /media`:**
  - Also serves `SCREENSHOT_PATH` matches.
  - With `download=1`, adds `Content-Disposition: attachment; filename="<ascii fallback>"; filename*=UTF-8''<percent-encoded>`.
- **`GET /api/assets`** → `{ assets }`. Order: screenshots (newest modified first), then cuts (by video in project order, newest version first), then takes, voice, music and sfx in manifest order. The dashboard and agents never sort.
- **`listAssets`:**
  - Cuts come from `project.videos[].versions`, takes from `script.sections[].takes`, and variants from `project.lanes`, where the lane stage gives `voice`, `music` or `sfx`.
  - Screenshots are every `*.png` directly in `screenshots/` and in `.rushes/grabs/`, parsed back to video, version and frame where the name matches the pattern.
  - `stat` gives `size` and `modified`. A missing file gives `missing: true` with nulls.
  - `abs` comes from `fromManifestPath`.
- **`POST /api/reveal { path }`:**
  - The path must equal the `path` of an asset in `listAssets`, otherwise 404.
  - A missing file gives 404.
  - Calls `opts.reveal(abs)` and returns `{ ok: true }`.
- **`osRevealer`:**
  - On macOS it runs `spawn("open", ["-R", abs])`.
  - On Windows it runs `spawn("explorer.exe", ["/select," + abs])`.
  - On other platforms it runs `spawn("xdg-open", [dirname(abs)])`.
  - All three are detached, with stdio ignored and errors swallowed but logged.
- **MCP `rushes_list_assets`**, input `{ project?, kind? }`. Description: "Every file in the project: cuts, VO takes, music, SFX and screenshots, with absolute paths. Use it to find a screenshot the user grabbed." There are now 14 tools.
- **CLI `rushes assets [--kind K] [--json]`.** Human output is one line per asset: `<kind padded> <path> <size human>`, plus `missing` when the file is gone. Add it to HELP.

- [ ] **Step 1: Write the failing tests.**
  - `screenshotName("hero-60s","v3",726,60)` gives `hero-60s_v3_00m12.10s_f726.png`; 59.999 s rounds correctly.
  - The grab route writes to `screenshots/`, and the file exists.
  - `/media` serves a screenshot; `download=1` sets the disposition for a name containing spaces or "é".
  - `/api/assets` lists one asset of each kind in the right order, and reports a missing cut as `missing`.
  - Reveal with an injected fake revealer:
    - a listed path calls it with the right `abs`;
    - `../`, absolute, unregistered and `screenshots/../x` paths give 404 and never call it;
    - a missing file gives 404.
  - Old `.rushes/grabs/x.png` is listed and served.
  - The MCP tools count is 14, and `rushes_list_assets` round-trips.
  - CLI `assets --json`.
  - Set `RUSHES_NO_REVEAL=1` in vitest config (`test.env`) so nothing can open Finder.
- [ ] **Step 2:** Run the tests and see them fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run && npm run typecheck`. Everything must pass.
- [ ] **Step 5:** Commit with `feat(server): screenshots folder, the asset index, downloads and reveal in Finder`.

---

### Task 2: Dashboard — screenshots and the Assets tab

**Files:**
- Modify:
  - `web/src/ui/App.tsx`: add the tab, key 7 and the shortcuts list.
  - `web/src/ui/Picture.tsx`: grab toast; a grab is not pending.
  - `web/src/useRushes.ts`: also fetch `/api/assets` on refresh, exposed as `assets`.
  - `web/src/lib.ts`: `formatBytes`, `assetSections`.
  - `web/src/ui/Icon.tsx`: download, save, folder and copy icons.
  - `web/src/styles.css`.
  - `e2e/fixture.ts`: set `RUSHES_NO_REVEAL=1` in the spawned server's env.
- Create: `web/src/ui/Assets.tsx`
- Test: `test/web/lib.test.ts`, `e2e/dashboard.spec.ts`

**Behaviour:**
- **Tab:**
  - Assets is the 7th tab, after Mix, with an icon and the label "Assets".
  - It unlocks when `assets.length > 0`, using the same locked look and hint as the other tabs. Hint: "It unlocks once the project has a cut, a take, a track or a screenshot."
  - It shows no to-do dot.
- **Sections:**
  - `assetSections(assets)` returns `[{ title, kind, items }]` in spec order, leaving out empty sections.
  - Titles: Screenshots, Cuts, Voiceover, Music, Sound effects. Voiceover holds takes plus voice variants.
  - Cuts show `Film · vN` and the version note.
- **Screenshots:**
  - A grid of thumbnails (`img` from `mediaUrl(path)`), 4:3 cells, `object-fit: contain` on the ground colour.
  - Under each: the time and frame in mono, plus the film and version.
  - Clicking opens a lightbox (`role="dialog"`, Esc closes) with the full image and the same actions.
- **Rows** (all other kinds): name, then folder in mono and `--text-3`, then size and date (`formatBytes`, plus a short date), then the actions.
- **Actions** (icon buttons, `data-tip` and `aria-label`):
  - **"Download":** `<a href={mediaUrl(path)+"&download=1"} download>`.
  - **"Save as…":** only when `"showSaveFilePicker" in window`. It fetches the blob and writes it via the picker. A user cancel (AbortError) is silent; any other failure is a toast.
  - **"Show in Finder" / "Show in Explorer" / "Open folder"**, by `navigator.platform` / userAgent. It POSTs `/api/reveal` and toasts on failure.
  - **"Copy path":** puts `abs` on the clipboard and toasts "Path copied". If the clipboard is refused, it toasts "Couldn't reach the clipboard".
- **Missing files:** the row is dimmed with a "missing" mark (a mark, not a sentence), and its actions are disabled.
- **Picture:**
  - After a grab, the toast reads `Saved to screenshots/<name>`.
  - A grab alone no longer counts as pending: remove `grab` from the pending condition. The chip still attaches to the next note.
  - The note chip label stays "Frame N".

**Tests:**
- **Unit:**
  - `formatBytes` (B / KB / MB / GB at 1024 steps, one decimal above KB).
  - `assetSections` order, grouping and empty sections dropped.
- **e2e "a grabbed frame is saved as a screenshot and shows up in Assets with its actions":**
  1. Add a cut, step 30 frames and press G.
  2. Expect the toast to contain `Saved to screenshots/hero_v1_00m01.00s_f30.png`.
  3. Press 7, then expect one `.shot-tile` (or the class you choose) with an image and a "Download" link whose href contains `download=1`.
  4. Click "Show in Finder" and expect no error toast. The server runs with `RUSHES_NO_REVEAL=1`.
  5. Click "Copy path" and expect the "Path copied" toast. Grant clipboard permissions in the test context.
- **e2e "a grab alone doesn't stop you switching films":**
  1. Add two films and grab on the first.
  2. Press `]` and expect the second film's pill to be pressed.
  3. Go back, type a note and press Enter. The note was saved with `grab` set.
- **e2e "a deleted file is marked missing in Assets":** add a cut, delete its file on disk, open Assets, then expect the row to be marked missing and its Download link disabled (`aria-disabled`).
- **Screenshot:** save one of the Assets tab with two screenshots and two cuts to `/private/tmp/claude-501/-Users-redmh-Documents-Projects-Video-Production/cf3f6bb8-8add-4421-80dd-acf0e51cb4c0/scratchpad/assets-tab.png`.

- [ ] Write the tests and see them fail.
- [ ] Implement.
- [ ] Run `npm run build && npx vitest run && npm run typecheck && npx playwright test` with Playwright three times. All must pass.
- [ ] Commit with `feat(web): screenshots you can find, and the Assets tab`.

---

### Task 3: Docs

**Files:** `README.md`, `AGENTS.md`, `skills/rushes/SKILL.md`

- **README:**
  - A short "Screenshots and assets" paragraph.
  - Key `7` in the shortcuts.
  - The project-folder layout from spec §15.1, as a code block.
- **AGENTS.md:**
  - The folder convention, with a note to save renders, takes, beds and passes there.
  - `rushes_list_assets`, with when to use it (the user says "use the screenshot I just took").
  - Screenshots live in `screenshots/`.
  - The tool count is fourteen.
- **SKILL.md:** the same essentials in a few lines.
- **Verify:**
  - `npm run build && npx vitest run && npm run typecheck && npx playwright test` all pass.
  - The fresh install `cd "$(mktemp -d)" && npx -y "git+file://$HOME/Developer/rushes#plan-2c-assets" --help | head -1` prints the help line.
- [ ] Commit with `docs: screenshots, the Assets tab and the project folder layout`.
