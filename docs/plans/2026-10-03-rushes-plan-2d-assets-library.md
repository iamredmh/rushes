# Rushes Plan 2d: the Assets library

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Assets tab into a library. A folder sidebar sits on the left (Screenshots, Cuts, Voiceover, Music, Sound effects, Scripts & docs, Images, Captions, Exports, Delivery, Edit files). Each folder gets a view built for its kind, plus search, sort, a film filter and a grid/list toggle. Audio plays inline, Markdown previews in place, an Open button launches the file in its default app, and Export notes writes a Markdown file to share.

**Architecture:**
- **Server:**
  - `project.json` gains registered `files`.
  - The asset index adds the new kinds and auto-discovers top-level docs and captions plus everything in `exports/`.
  - New routes: `POST /api/open` (safe types only), `POST /api/exports/notes`, and `POST /api/reveal { project: true }`.
- **Agents:** two new tools, `rushes_add_file` and `rushes_export_notes`, with matching CLI commands.
- **Dashboard:** the Assets tab is rebuilt as a sidebar plus views.

**Tech Stack:** as Plans 1–2c.

**Spec:** `docs/specs/2026-10-02-rushes-design.md` §16 (binding), plus §15 and earlier where §16 is silent.

## Global Constraints

- **Dependencies:** runtime dependencies stay exactly `@hono/node-server`, `@modelcontextprotocol/sdk`, `hono`, `zod`. Add no dependency of any kind: no Markdown library and no zip library.
- **Guards:** every route keeps the Host/Origin/JSON guard and the §14.1 project guard.
- **File allow-list:** `/media`, `/api/reveal` and `/api/open` act only on listed assets (exact path match). Anything else gets 404, and the response never reveals whether a file exists.
- **Open:**
  - `/api/open` additionally refuses any extension outside the §16.3 safe list, with 415 `unsafe_type`.
  - It spawns with an argument array and never a shell.
  - `RUSHES_NO_REVEAL=1` makes reveal and open log-only. Tests must never open anything.
- **Markdown preview:**
  - Escape all HTML before applying any formatting.
  - Never produce raw HTML from file content, never make links clickable, and never use `dangerouslySetInnerHTML` with unescaped content.
- **Visual system (spec §10):**
  - Colours: ground `#0C0D0F` / `#141518` / `#1C1E22`, text `#EEEEF0`, accent `#7C93FF`, to-do `#F5B740`, done `#4CC38A`.
  - Type: Figtree for UI text at 15px and up. JetBrains Mono only for timecodes, ids, shot numbers and file paths.
  - Controls: icon buttons with tooltips that name the key. Status as marks. No helper captions.
- **Keyboard:**
  - Space plays.
  - ←/→ step one frame (Shift: ten).
  - I/O set in and out.
  - B box, G grab, N new note.
  - 1–7 switch tabs (7 is Assets).
  - [/] previous and next film.
  - ? opens shortcuts, Esc closes.
  - ↑/↓ move between folders in the Assets sidebar.
- **Data safety:** nothing pending is ever dropped, and old data loads. A `project.json` without `files` must still validate.
- **Git:**
  - Commits use the repo's local identity, `iamredmh <17407420+iamredmh@users.noreply.github.com>`. Never change git config.
  - Each message ends with a blank line and then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Never push.
- **Prose:** UK English. No client or brand names and no private or local paths in anything committed, including plan docs.

## Review Focus

1. **Open must never run code.** `POST /api/open` for a registered `.command`, `.sh`, `.app`, `.html` or `.js`, and for an unregistered `.md`, gets 415 or 404 and spawns nothing. *(Task 1)*
2. **Markdown injection.** A doc containing `<script>`, `<img onerror>` or `[x](javascript:…)` renders as inert text. *(Task 2)*
3. **Hundreds of screenshots.** The library stays responsive and lazy-loads. Search and filters behave the same at 200 items. *(Task 2)*
4. **Auto-discovery stays in its lane.** Hidden files, `.rushes/`, sub-folders other than `exports/`, and non-matching extensions never appear. *(Task 1)*
5. **Inline audio:** only one plays at a time, and it stops when the folder or tab changes. *(Task 2)*

---

### Task 1: Server, agent and CLI

**Files:**
- Modify: `src/core/schema.ts` (`FileEntrySchema`, `ProjectSchema.files`), `src/core/project.ts` (`addFile`), `src/server/assets.ts`, `src/server/files.ts` (content types), `src/server/app.ts`, `src/server/reveal.ts` (add `osOpener`, and reveal-project support), `src/mcp/tools.ts`, `src/cli/main.ts`
- Create: `src/core/exportNotes.ts` (pure: build the Markdown)
- Test: `test/core/project.test.ts`, `test/core/exportNotes.test.ts` (new), `test/server/assets.test.ts`, `test/server/app.test.ts`, `test/mcp/tools.test.ts`, `test/cli/main.test.ts`

**Interfaces (produces):**
```ts
// schema.ts
export const FileKindSchema = z.enum(["doc", "image", "caption", "export", "delivery", "edit"]);
export const FileEntrySchema = z.object({ id, kind: FileKindSchema, file: z.string().min(1), name: z.string().min(1).max(120),
  note: z.string().max(500).default(""), video: z.string().nullable().default(null), addedAt: z.string() });
// ProjectSchema gains: files: z.array(FileEntrySchema).default([])
// project.ts
export function addFile(p: Project, input: { kind; file; name?; note?; video? }, now?: Date): FileEntry; // video resolved via resolveVideo; name defaults to basename; id unique slug
// assets.ts — AssetKind gains "doc" | "image" | "caption" | "export" | "delivery" | "edit"; Asset gains note?: string
// reveal.ts
export type Opener = (abs: string) => Promise<void>;
export const osOpener: Opener;               // honours RUSHES_NO_REVEAL
export const OPEN_SAFE_EXT: ReadonlySet<string>; // the §16.3 list, lower-case, no dot
// AppOptions gains: open?: Opener
// exportNotes.ts
export function notesMarkdown(project: Project, notes: Note[], now: Date): string;
export function exportFileName(projectName: string, now: Date): string; // "<slug>-notes-YYYY-MM-DD.md"
```

**Behaviour:** follow spec §16.2 to §16.5 exactly.
- **Ordering in `listAssets`:**
  - Existing kinds keep §15's order. The new kinds follow, in the order doc, image, caption, export, delivery, edit.
  - Registered files come in manifest order.
  - Auto-discovered files are sorted by name, and a path that is also registered appears once, with the registered metadata.
- **`candidatePaths`** includes registered files and auto-discovered ones under the same rules, so reveal, open and `/media` all agree with the list.
- **`POST /api/open { path }`:**
  - The path must be listed and the file must exist; otherwise 404.
  - The extension must be in `OPEN_SAFE_EXT`; otherwise 415 `unsafe_type`.
  - If both pass, call `opts.open(abs)`.
- **`POST /api/reveal`** also accepts `{ project: true }`, which reveals `store.root` with `open <root>` (on macOS, the folder itself, not `-R`).
- **`POST /api/exports/notes`** writes the file to `exports/` atomically (temporary file, then rename) and returns `{ path }`.
- **MCP tools:** `rushes_add_file` and `rushes_export_notes`, making 16 in total.
- **CLI commands:** `rushes add file …` and `rushes export notes`. Add both to HELP.

- [ ] **Step 1: Write the failing tests:**
  - `addFile`: default name, video resolved by id or name, unique id.
  - Old `project.json` without `files` loads.
  - Auto-discovery picks up top-level md, txt and pdf, srt and vtt, and `exports/*`. It ignores hidden files, `.rushes/`, `docs/sub/x.md` and `x.json`.
  - A registered file that is also auto-discovered is listed once.
  - `/api/open`:
    - a listed `.md` calls the fake opener;
    - a registered `evil.command` returns 415 and never calls it;
    - an unlisted `.md` returns 404;
    - a missing file returns 404.
  - `reveal { project: true }` calls the revealer with the root.
  - `notesMarkdown`:
    - groups by stage, then film and version;
    - includes shot, status, reply and screenshot path;
    - escapes nothing (it's a file);
    - is stable for the same input.
  - `exportFileName` slugs the project name and dates correctly.
  - The export route writes the file, and it then appears under kind `export`.
  - MCP lists 16 tools and both new tools round-trip.
  - CLI `add file` and `export notes` work.
- [ ] **Step 2:** Run the tests and see them fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run && npm run typecheck`. Everything must pass.
- [ ] **Step 5:** Commit with `feat(server): every project file in the library, open in the default app, and notes exported as Markdown`.

---

### Task 2: Dashboard — the library

**Files:**
- Modify: `web/src/ui/Assets.tsx` (rebuild), `web/src/lib.ts` (pure helpers), `web/src/ui/Icon.tsx`, `web/src/styles.css`
- Create (if useful): `web/src/ui/AssetViews.tsx`, `web/src/markdown.ts` (the safe renderer, pure)
- Test: `test/web/lib.test.ts`, `test/web/markdown.test.ts` (new), `e2e/dashboard.spec.ts`

**Pure helpers (unit-tested):**
- `FOLDERS`: the §16.1 order, with title, kinds, default view and whether a film filter applies.
- `folderItems(assets, folder, { query, sort, film })` filters, searches and sorts.
- `groupByFilm(items)` returns the `Film · vN` headings.
- `renderMarkdown(text)` returns a safe HTML string:
  - escape first;
  - then a small subset: `#`–`###` headings, paragraphs, `-` and `*` lists, `1.` lists, `**bold**`, `*italic*`, `` `code` ``, and fenced code blocks;
  - links render as their text only.

**Behaviour:** follow spec §16.1, §16.3 (the Open button, shown only for safe extensions, mirroring `OPEN_SAFE_EXT` in a web copy) and §16.4 (the Export notes button in Exports).
- **Inline audio:** use one shared `<audio>` element. Play/Pause shows the state on the row. Switching folder, tab or film stops it.
- **Markdown preview:** split view, with the list on the left and the preview on the right. Show it only for md, txt, srt and vtt. Fetch the content via `mediaUrl(path)`.
- **Grid/list:** remembered per folder in localStorage, wrapped in try/catch.
- **Keyboard:** ↑/↓ on the focused sidebar move between folders. Enter or click selects a folder.
- **Kept from Plan 2c, unchanged:** Download, Save as (streamed), Show in Finder, Copy path, the lightbox with its focus behaviour, and missing-file handling.

**Tests:**
- **Unit:**
  - `folderItems` handles search, sort and the film filter.
  - `groupByFilm` builds the right headings.
  - `renderMarkdown`:
    - `<script>alert(1)</script>` becomes escaped text;
    - `<img src=x onerror=alert(1)>` becomes escaped text;
    - `[x](javascript:alert(1))` renders the text `x` with no anchor;
    - headings, lists, bold, italic, code and fences render correctly.
- **e2e:**
  1. **"the library has a folder sidebar with counts, and ↑/↓ moves between folders".** Create screenshots, a cut, a `script.md` at the root and a registered image. Expect folder buttons with counts, empty folders absent, and Exports present.
  2. **"search and the film filter narrow the screenshots".**
  3. **"a script previews as Markdown, safely".** `script.md` contains `# Title` and `<script>`. The preview shows an `h1` "Title" and the literal text `<script>`, and no script element exists.
  4. **"audio plays inline, one at a time, and stops when you leave the folder".** Use two music variants with the test clip's audio; checking `paused` states is enough.
  5. **"Open is offered for a doc and not for an unsafe file, and Export notes adds a file to Exports".** Register `x.command` through the API using `kind: "edit"`, and expect no Open button on it.
  6. **"200 screenshots stay usable".** Generate 200 small PNGs in `screenshots/` from the fixture by copying one PNG under 200 names. Open the folder and expect it to render within the test timeout. Search narrows it to one.
- **Screenshot:** save one of the library (Screenshots folder, then Scripts & docs with a preview) to a scratch folder outside the repo, and give the path in the report.

- [ ] Write the tests and see them fail.
- [ ] Implement.
- [ ] Run `npm run build && npx vitest run && npm run typecheck && npx playwright test`, with Playwright three times. Everything must pass.
- [ ] Commit with `feat(web): the Assets library — folders, search, inline audio, previews and Open`.

---

### Task 3: Docs

- **README:** describe the library in a few lines, including the folders, the Open safe list (in one sentence) and Export notes.
- **AGENTS.md:**
  - document `rushes_add_file`, with when to register docs, images, captions, deliverables and edit files;
  - document `rushes_export_notes`;
  - say that top-level md, pdf, srt and vtt files and `exports/` are picked up automatically;
  - set the tool count to sixteen.
- **SKILL.md:** the same essentials in a few lines.
- **Check:** no local paths anywhere.
- **Verify:**
  - the full suite passes;
  - a fresh install with `repo="git+file://$PWD#plan-2d-assets-library" && cd "$(mktemp -d)" && npx -y "$repo" --help | head -1` works.
- [ ] Commit with `docs: the Assets library, Open, add_file and notes export`.
