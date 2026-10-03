# Rushes Plan 2b: project IDs, packs, picture lock and shots

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tie every dashboard tab to one project so tabs can never write into the wrong project. Add numbered pills for switching films in a pack, a visible and lockable picture version, and a storyboard shot strip that notes refer to.

**Architecture:**
- Projects get an 8-character id stored in `project.json`. The dashboard lives at `/p/<id>/` and sends that id with every request, and the server refuses a mismatch with `409 wrong_project`.
- Picture lock and shots are new fields on videos and versions, edited through two new routes, two MCP tools and three CLI commands.
- The dashboard header gains film pills, a "Picture vN" label and a lock button. The Picture tab gains a shot strip under the timeline.

**Tech Stack:** the same as Plans 1 and 2. TypeScript (NodeNext, ESM), Hono, zod, the MCP SDK, Preact 10 + Vite 8, vitest, Playwright.

**Spec:** `docs/specs/2026-10-02-rushes-design.md`, and above all **§14** (binding; it wins over earlier sections).

## Global Constraints

- **Runtime dependencies stay exactly** `@hono/node-server`, `@modelcontextprotocol/sdk`, `hono`, `zod`. Add no dependency of any kind, runtime or dev.
- **Every route keeps the Plan 1 guard:**
  - the Host must be 127.0.0.1 or localhost;
  - writes must be `application/json` from a local Origin.
  The new project-id check (Task 2) runs after that guard and never replaces it.
- **Media:** `GET /media?path=` serves only registered paths or `.rushes/grabs/<safe>.png`. Anything else is 404.
- **Visual system (spec §10):**
  - Colours: ground `#0C0D0F`/`#141518`/`#1C1E22`, text `#EEEEF0`, accent `#7C93FF`, to do `#F5B740`, done `#4CC38A`.
  - Type: Figtree for the UI at 15px and up; JetBrains Mono for timecodes, ids and shot numbers only.
  - Controls: icon buttons with tooltips that name the key, status as marks, no helper captions on screen.
- **Keyboard:**
  - Space play;
  - ←/→ one frame (Shift: ten);
  - I/O in and out;
  - B box;
  - G grab;
  - N new note;
  - 1–6 tabs;
  - `[`/`]` previous/next film (new);
  - ? shortcuts;
  - Esc close.
- **Times sent to the server** are the video element's time snapped to its frame (`snap()`), never stale React state.
- **Nothing pending is ever dropped:** In/Out, a box, a grab or a half-typed note survives new cuts, refreshes and film switches.
- **Old data loads.** A `project.json` or `notes.json` written by Plan 1 or 2 (no `id`, no `shots`, no `lockedVersion`, no note `shot`) must still validate, through schema defaults or optionals.
- **Git:** commits use this repo's local identity (`iamredmh <17407420+iamredmh@users.noreply.github.com>`). Never change git config. Every commit message ends with a blank line and then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.
- **Prose** in docs and UI is UK English.
- **No client or brand names** and no private paths in anything committed.

## Review Focus

1. **A stale tab after port reuse.** Project A's tab is open, A's server stops, and project B's server starts on the same port. The tab must show the "isn't running here any more" banner, keep the typed note, and write nothing to B. *Task 4 e2e.*
2. **Switching films with marks pending** must be refused with a toast, and nothing is lost. *Task 5 e2e.*
3. **A Plan 2 `project.json`** (no id) gets an id on first start, exactly once, and the id survives restarts. *Tasks 1 and 2.*
4. **Shot boundaries:**
   - a note exactly on a shot's start belongs to that shot;
   - a note before the first shot has `shot: null`;
   - a note past the last start belongs to the last shot.
   *Task 1.*
5. **Locking at a version that doesn't exist** is a 404. Adding a cut to a locked video works and warns. The dashboard opens on the locked cut, not the newest. *Tasks 2 and 5.*

---

### Task 1: Core data — project id, picture lock, shots

**Files:**
- Modify: `src/core/ids.ts`, `src/core/schema.ts`, `src/core/project.ts`, `src/core/notes.ts`
- Test: `test/core/project.test.ts`, `test/core/notes.test.ts` (add cases)

**Interfaces (produces; later tasks use these exact names):**
```ts
// ids.ts
export const PROJECT_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function newProjectId(): string; // 8 chars from the alphabet, crypto-random

// schema.ts
export const ProjectIdSchema = z.string().regex(/^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/);
export const ShotSchema = z.object({
  n: z.number().int().positive(),
  name: z.string().trim().min(1).max(80),
  start: z.number().nonnegative(),
  tag: z.string().trim().max(24).default(""),
});
export type Shot = z.infer<typeof ShotSchema>;
// VersionSchema gains: shots: z.array(ShotSchema).max(200).default([])
// VideoSchema gains:   lockedVersion: z.string().nullable().default(null)
// ProjectSchema gains: id: ProjectIdSchema.optional()   (optional so Plan 2 files still load)
// NoteSchema gains:    shot: z.object({ n: z.number().int().positive(), name: z.string() }).nullable().default(null)

// project.ts
export function ensureProjectId(p: Project): boolean; // sets p.id when missing; true if it changed anything
export interface ShotInput { name: string; start: number; tag?: string }
export function setShots(p: Project, videoId: string, versionId: string | undefined, shots: ShotInput[]): Version;
export function lockPicture(p: Project, videoId: string, versionId: string | null): Video;
export function shotAt(shots: Shot[], t: number): { n: number; name: string } | null;
// addVersion: a new version copies the previous version's shots (deep copy). The first version has [].
```

Rules:
- **`setShots`:**
  - `versionId` undefined means the newest version.
  - An unknown video or version throws `NotFoundError`.
  - Sort by `start`, then renumber `n` from 1.
  - Duplicate starts throw `InvalidError("Two shots start at 1.70 s")`, with the time formatted to 2 decimals.
  - When the version's `duration` is known, a `start` ≥ duration throws `InvalidError`.
  - Over 200 shots throws `InvalidError`.
  - It replaces the list and returns the version.
- **`lockPicture`:**
  - `versionId` null unlocks.
  - An unknown video or version throws `NotFoundError`.
  - It returns the video.
- **`shotAt`:** returns the last shot whose `start ≤ t`, or null when `t` is before the first shot's start or the list is empty.
- **`addNote` in `notes.ts`:** stays pure. The shot is stamped by the server (Task 2), so `NewNote` gains an optional `shot?: { n: number; name: string } | null` that is passed through.

- [ ] **Step 1: Write the failing tests.** In `test/core/project.test.ts`:
  - **`newProjectId`:** 8 chars, only alphabet characters, and 200 calls give 200 distinct ids.
  - **`ensureProjectId`:**
    - sets an id on a project without one and returns true;
    - a second call returns false and leaves the id unchanged;
    - a project parsed from a Plan 2 JSON fixture with no `id` validates via `ProjectSchema`.
  - **`addVersion`:**
    - v2 inherits v1's shots;
    - mutating v2's shots doesn't touch v1;
    - v1 of a new video has `[]`.
  - **`setShots`:**
    - sorts and renumbers;
    - defaults to the newest version;
    - throws for a duplicate start, for a start ≥ duration, and for an unknown version.
  - **`lockPicture`:** locks, unlocks with null, and throws for an unknown version.
  - **`shotAt`:**
    - t before the first start returns null;
    - t exactly at shot 2's start returns shot 2;
    - t after the last start returns the last shot;
    - an empty list returns null.
  - **`NoteSchema`:** a Plan 2 note with no `shot` validates, with `shot: null`.
- [ ] **Step 2:** Run `npx vitest run test/core`. Expect the new cases to fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run && npm run typecheck`. Expect everything green.
- [ ] **Step 5: Commit** with subject `feat(core): project ids, picture lock and shot lists`.

---

### Task 2: Server — the project's address, the guard, shots and lock routes, port 4580

**Files:**
- Modify: `src/server/start.ts`, `src/server/app.ts`
- Test: `test/server/app.test.ts`, `test/server/start.test.ts` (add cases)

**Interfaces:**
- **Consumes:** Task 1.
- **Produces:**
  - `DEFAULT_PORT = 4580`.
  - `Running` gains `id: string` and `dashboardUrl: string` (`${url}/p/${id}/`).
  - `startServer` calls `store.update("project", ensureProjectId)` only when the read project has no `id`, after `store.init`, so restarts never bump rev.
  - `createApp` reads the project id lazily on first need and caches it, because the id never changes once set.

Routes and behaviour:
- **`GET /api/health`** → `{ ok, app: "rushes", version, root, id, name }`.
- **`GET /`** → `302` to `/p/<id>/`.
- **`GET /p/:id`** (no trailing slash) → `302` to `/p/:id/`.
- **`GET /p/:id/`:**
  - The id matches: serve the built `index.html`, or the placeholder when unbuilt, as `GET /` did before.
  - The id doesn't match: a small HTML page with status **404** and the text "The Rushes project this address belongs to isn't running on this port. Ask your agent to open it again." Escape anything interpolated.
- **Project guard middleware** (runs after the Plan 1 guard, on every path):
  - It reads the id from the `x-rushes-project` header, or failing that the `project` query parameter.
  - When an id is present and differs from this project's: `409 { error: "wrong_project", message: "This page is for a different Rushes project" }`.
  - When absent: carry on, so MCP, CLI and curl are unaffected.
- **`PUT /api/videos/:video/shots`**
  - Body: `{ version?: string, shots: { name: string, start: number ≥0, tag?: string }[] }`. Max 200.
  - Uses `setShots` and returns `{ version }`.
- **`PUT /api/videos/:video/lock`**
  - Body: `{ version: string | null }`.
  - Uses `lockPicture` and returns `{ video }`.
- **`POST /api/versions`:** when the video already had `lockedVersion`, the reply also carries `warning: "Picture is locked at v4"`.
- **`POST /api/notes`:**
  - When `stage === "picture"` and `video`, `version` and `t` are all set and that version exists, stamp `shot = shotAt(version.shots, t)` inside the same `store.update` (read the project first).
  - The client never sends `shot`; strip it if sent.

- [ ] **Step 1: Write the failing tests.** In `test/server/app.test.ts`:
  - health has an `id` matching `ProjectIdSchema` and the project's `name`;
  - `GET /` gives 302 with the location `/p/<id>/`;
  - `/p/<id>` gives 302 with the slash added;
  - `/p/<id>/` gives 200 HTML;
  - `/p/zzzzzzzz/` gives 404 and the text "isn't running on this port";
  - `GET /api/state` with a wrong `x-rushes-project` gives 409 `wrong_project`;
  - the right header gives 200, and no header gives 200;
  - `GET /api/events?project=<wrong>` gives 409;
  - `POST /api/notes` with a wrong header gives 409 and notes.json is unchanged;
  - shots PUT sorts and renumbers, and a duplicate start gives 400;
  - lock PUT locks;
  - locking an unknown version gives 404;
  - adding a cut to a locked video gives 201 with a warning;
  - a picture note at t = 1.7 on a version whose shots are [0 "Title", 1.7 "Window rises in"] gets `shot { n: 2, name: "Window rises in" }`;
  - a script note gets `shot: null`.

  In `test/server/start.test.ts`:
  - a project without an id gets one on start;
  - a second start of the same folder keeps the same id and the same project rev;
  - `running.dashboardUrl` ends with `/p/<id>/`;
  - `DEFAULT_PORT` is 4580.
- [ ] **Step 2:** Run the new tests. Expect them to fail.
- [ ] **Step 3:** Implement. Update the 4317 references in tests to 4580 where they're about the default; host-guard tests that just need a port number can use any number.
- [ ] **Step 4:** Run `npx vitest run && npm run typecheck`. Expect everything green.
- [ ] **Step 5: Commit** with subject `feat(server): every project gets an address of its own, plus shot and lock routes`.

---

### Task 3: MCP tools and CLI

**Files:**
- Modify: `src/mcp/tools.ts`, `src/mcp/ensure.ts` (only if needed), `src/cli/main.ts`
- Test: `test/mcp/tools.test.ts`, `test/cli/main.test.ts`, `test/e2e/stdio.test.ts` (if it counts tools)

**Interfaces:**
- **Consumes:** the Task 2 routes and health.
- **Produces:**
  - **`rushes_open`:** returns `{ url }`, where `url` is the dashboard URL `${base}/p/${id}/` taken from `GET /api/health`. It opens that URL.
  - **`rushes_set_shots`** with input `{ project?, video, version?, shots: [{ name, start, tag? }] }` calls `PUT /api/videos/:video/shots`. The description says: "Set the storyboard shot list for a cut. Shots are numbered by start time; a new cut copies the previous cut's shots until you send new ones."
  - **`rushes_lock_picture`** with input `{ project?, video, version: string | null }` calls `PUT /api/videos/:video/lock`. The description says: "Lock a video's picture at a version (the dashboard then opens on it, and audio review plays against it), or unlock with version null."
  - The tool count goes from 11 to 13. Update any test that counts tools.
  - **CLI:**
    - `open`/`serve` print the dashboard URL (`…/p/<id>/`) and open it. This covers the "already running" path too: fetch health to build the URL.
    - `rushes add shots <file.json> --video NAME [--version V]` reads a JSON array of `{ name, start, tag? }`. It prints `Shots set on <video> <version>: N`.
    - `rushes lock <video> <version>` prints `Picture locked at <version>`.
    - `rushes unlock <video>` prints `Picture unlocked`.
    - `rushes notes` (human output) shows `shot 02` after the timecode when a note has a shot.
    - HELP gains the three new lines, and `--port 4580` replaces `--port 4317`.

- [ ] **Step 1: Write the failing tests:**
  - the tools list includes both new tools;
  - `rushes_set_shots` round-trips via the in-process server, the way the existing tool tests do;
  - `rushes_lock_picture` locks and unlocks;
  - `rushes_open`'s url matches `/\/p\/[a-z2-9]{8}\/$/`;
  - CLI `add shots` reads a temp JSON file and sets them;
  - CLI `lock`/`unlock`;
  - CLI `open --no-browser` prints a `/p/<id>/` URL;
  - HELP contains `add shots`, `lock` and `unlock`.
- [ ] **Step 2:** Run them. Expect them to fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run && npm run typecheck`. Expect everything green.
- [ ] **Step 5: Commit** with subject `feat(mcp,cli): set shots, lock picture, and open the project's own address`.

---

### Task 4: Dashboard — tied to its project

**Files:**
- Modify: `web/src/api.ts`, `web/src/useRushes.ts`, `web/src/ui/App.tsx`, `web/src/styles.css`, `e2e/fixture.ts`
- Test: `e2e/dashboard.spec.ts` (add tests)

**Behaviour:**
- **`api.ts`:**
  - `projectId()` reads the id from `location.pathname` (`/p/<id>/`). It returns `null` when absent, as in old tabs on `/`; the server redirects those anyway.
  - Every fetch sends `x-rushes-project: <id>` when there is one.
  - `mediaUrl(path)` appends `&project=<id>`.
  - Export `eventsUrl()`, which returns `/api/events?project=<id>`.
- **`useRushes`:**
  - It opens `eventsUrl()`.
  - When any call fails with `ApiError` code `wrong_project` (including `refresh`), it sets `wrongProject = true`.
  - It keeps the last good `state`, so the page stays readable, and stops treating the error as an ordinary `problem`.
  - It exposes `wrongProject: boolean`.
  - On an EventSource error, it calls `refresh()` once. A 409 there flips `wrongProject`.
- **`App`:**
  - Sets `document.title = "<project name> · Rushes"` whenever the name changes.
  - The header crumb starts with the project name, then the id in the mono face, dimmed (`class="pid"`).
  - When `wrongProject` is set, it shows a fixed banner across the top (`role="alert"`, class `banner lost`) reading: "This tab is for <name>, which isn't running here any more. Ask your agent to open it again." Here `<name>` is the last known project name.
  - Writes fail with 409 on their own, and the Plan 2 toasts plus kept text already cover what's typed. The banner must not hide the note box.
- **`e2e/fixture.ts`:**
  - `rushes.url` becomes the dashboard URL printed by `serve`. Update the stdout regex to capture the full `http://127.0.0.1:\d+/p/[a-z2-9]{8}/`.
  - Add `rushes.base` (origin only) for API calls.
  - Add `rushes.swapProject()`. It stops this server, waits for exit, then starts `serve` on a *different* fresh project folder **on the same port**, and waits for its URL. Teardown must kill whichever child is current.

**Tests (add to `e2e/dashboard.spec.ts`):**
1. **"every project has its own address and title":**
   - `page.goto(rushes.url)`;
   - the URL matches `/p/<id>/`;
   - the title is `My Film · Rushes`;
   - the header shows the id.
2. **"a tab left open after its project stops never writes into the project that takes its port":**
   1. Add a cut, open the page and type a note without submitting.
   2. Call `rushes.swapProject()`.
   3. Expect the `.banner.lost` alert containing "isn't running here any more" (allow time for the SSE retry).
   4. Press Enter to submit. Expect the note text still in the box.
   5. Expect the new project's `GET /api/notes` to return `[]`.

- [ ] **Steps:**
  1. Write the tests and see them fail (after `npm run build`).
  2. Implement.
  3. Run `npm run build && npx playwright test` three times. Expect all green each time.
  4. Run `npx vitest run && npm run typecheck`.
  5. Commit with subject `feat(web): each tab belongs to one project and says so when that project is gone`.

---

### Task 5: Dashboard — film pills, Picture vN and picture lock

**Files:**
- Modify: `web/src/ui/App.tsx`, `web/src/ui/Picture.tsx`, `web/src/ui/Icon.tsx` (a `lock`/`unlock` icon if missing), `web/src/styles.css`, `web/src/lib.ts` (pure helpers, unit-tested in `test/web/lib.test.ts`)
- Test: `e2e/dashboard.spec.ts`, `test/web/lib.test.ts`

**Behaviour:**
- **Film pills:**
  - When `project.videos.length > 1`, the header shows `nav.pack` with one `button.pill` per video, in order. Each pill reads `<n> <name>`, with the number in a small circle.
  - `aria-pressed` marks the current pill.
  - A to-do dot shows when the video has to-do Picture notes.
  - With a single video, the name shows as plain text, as it does now.
- **Per-film memory:**
  - App keeps `Map<videoId, { versionId: string | null; held: boolean; t: number }>`.
  - Switching films saves the current film's playhead. Picture reports it through a new `onTime(t)` prop, called on pause, seek and unmount.
  - Coming back restores the version and seeks to the saved `t` once metadata loads. Picture gets a new `startAt` prop.
- **Switching keys:** `[` and `]` go to the previous and next film, with no wrap. They're ignored while typing. Add both to the shortcuts popover.
- **Pending marks:** if Picture reports pending (Plan 2's `onPendingChange`), switching films is refused with the toast "Add or clear your note on <video name> first", and the current film stays. This covers pills, keys and the Video select if it remains anywhere.
- **Picture vN:**
  - The header shows a `Picture` label (Figtree, `--text-3`) immediately before the version picker.
  - Beside the picker is a lock button: `aria-label` "Lock picture at vN" or "Unlock picture", with a matching `data-tip`.
  - When locked, the picker shows a lock mark and the tooltip "Picture locked at vN".
  - Clicking calls `PUT /api/videos/:id/lock` and toasts on failure.
- **Locked default:**
  - With `lockedVersion` set and no version chosen by hand, the film opens on the locked version.
  - The "vN ready" chip shows when a newer version exists. Derive it from `lockedVersion`, the same way `held` works.
  - Nothing auto-jumps while locked.
- **Pure helpers in `lib.ts`, unit-tested:**
  - `defaultVersion(video)` returns the locked version if there is one, otherwise the newest.
  - `neighbourVideo(videos, currentId, dir: -1 | 1)` returns an id or null.

**Tests:**
- **Unit:** `defaultVersion` and `neighbourVideo`.
- **e2e "a pack shows a pill per film, and each film remembers where you were":**
  1. Add two cuts to "Hero" and one to "Cutdown" through the API. Add a `video` parameter to `addCut` in the fixture; it defaults to "Hero".
  2. Expect two pills.
  3. Step 15 frames on Hero, then press `]`. Expect the Cutdown pill pressed and the timecode at 0:00.00.
  4. Press `[`. Expect the Hero pill pressed and the timecode back at 0:00.50.
- **e2e "switching films with a note half-typed is refused, and the note is kept":** type in the note box, click the other pill, then expect the toast "Add or clear your note on Hero first", the Hero pill still pressed and the text still there.
- **e2e "a locked picture opens on the locked cut":**
  1. Add cuts v1 and v2, then lock at v1 through the API.
  2. Load the page. Expect the Version picker at v1, the lock mark visible, and the chip "v2 ready".
  3. Click Unlock. Expect the API to report `lockedVersion: null`.

- [ ] **Steps:**
  1. Write the tests and see them fail.
  2. Implement.
  3. Run `npm run build && npx playwright test` three times. Expect all green each time.
  4. Run `npx vitest run && npm run typecheck`.
  5. Commit with subject `feat(web): film pills, Picture vN and picture lock`.

---

### Task 6: Dashboard — the shot strip

**Files:**
- Modify: `web/src/ui/Picture.tsx`, `web/src/ui/Notes.tsx`, `web/src/styles.css`, `web/src/lib.ts` (+ `test/web/lib.test.ts`)
- Test: `e2e/dashboard.spec.ts`

**Behaviour:**
- **`lib.ts`:**
  - `shotAt` mirrors the core rule. Copy it rather than importing from `src/`, because the web bundle imports types only.
  - `shotLabel(n)` returns `"02"`, zero-padded to 2 digits, or 3 digits once n ≥ 100.
- **The strip:** when the version has shots, a `div.shots` row sits under the `.ends` row.
  - It scrolls horizontally and doesn't wrap.
  - It holds one `button.shot` per shot, containing:
    - `<span class="mono">02 · 1.70s</span>`;
    - the name;
    - the tag in small caps (`text-transform: uppercase; letter-spacing`), using the mono face at its existing small mono size, since mono is exempt from the 15px rule.
  - The current shot (`shotAt(shots, t)`) gets `aria-current="true"` and an accent outline, and the strip keeps it scrolled into view while playing (`scrollIntoView({ block: "nearest", inline: "nearest" })`).
  - Clicking a card pauses and seeks to its start.
- **Timeline ticks:** `div.tick` on `.track` at each shot start except 0.
- **Timecode:** the timecode area reads `… · shot 02` when inside a shot.
- **Notes:** a note with `shot` shows `Shot 02 · Window rises in` under its timecode in the Notes list (`class="shotref"`, `--text-3`, 15px).

**Tests:**
- **Unit:** `shotLabel`; web `shotAt` matches the core cases from Task 1.
- **e2e "the shot strip names each shot, follows the playhead, and notes record their shot":**
  1. Add a cut, then `PUT /api/videos/hero/shots` with `[{name:"Title card",start:0,tag:"establish"},{name:"Window rises in",start:1.7,tag:"reveal"},{name:"Wide, cursor enters",start:2.8}]`.
  2. Load the page. Expect three `.shot` cards, the first with `aria-current`.
  3. Click the second card. Expect the timecode 0:01.70 and the second card current.
  4. Add a note. Expect the API note's `shot` to be `{ n: 2, name: "Window rises in" }` and the note list to show "Shot 02 · Window rises in".
  5. Expect 2 ticks on the timeline.

- [ ] **Steps:**
  1. Write the tests and see them fail.
  2. Implement.
  3. Run `npm run build && npx playwright test` three times. Expect all green each time.
  4. Run `npx vitest run && npm run typecheck`.
  5. Commit with subject `feat(web): the shot strip, and notes that know their shot`.

---

### Task 7: Docs and full verification

**Files:** `README.md`, `AGENTS.md`, `skills/rushes/SKILL.md`, and the CLI HELP if anything was missed.

- **README:**
  - The usage section mentions that each project opens at its own address.
  - Shortcuts add `[`/`]`.
  - A short "Packs, picture lock and shots" paragraph in the same terse style. No more than 6 lines.
- **AGENTS.md:**
  - Document `rushes_set_shots` (send the storyboard's shots right after the first cut, and new timings when a cut moves them).
  - Document `rushes_lock_picture` (lock once the user says picture is locked).
  - Document the `shot` field on notes.
  - Document `warning` on `add_version`.
  - Note that URLs look like `/p/<id>/`.
- **`skills/rushes/SKILL.md`:** the same essentials, in a few lines.
- **UK English.** Change any `4317` left in docs to `4580` (but don't touch `docs/plans/*`).
- **Verify:**
  1. Run `npm run build && npx vitest run && npm run typecheck && npx playwright test`. All green.
  2. Run the fresh install `cd "$(mktemp -d)" && npx -y "git+file://$HOME/Developer/rushes#plan-2-dashboard" --help | head -1`. Expect the help line.
- [ ] **Commit** with subject `docs: project addresses, packs, picture lock and shots`.
