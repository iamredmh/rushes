# Rushes: the Visuals tab (§25)

Status: DRAFT, 12 October 2026. Designed with Red in a question-by-question session the same day; every decision in 25.2 is his. The mockup (`2026-10-12-rushes-visuals-mockup.html`) shows the tab with a 12-page carousel, a still in two ratios, a three-page cover, the locked state and a page that cannot load. It is built (25.12).

## 25.1 The problem

Alongside videos, Red's work produces stills, standalone posts and carousels. They need the same review loop a cut gets: look closely, mark the exact region that is wrong, say what to change, send it to the agent, see the next version. Today that happens in one-off review pages built per campaign, which carry a great deal Rushes does not need (copy decks, source notes, decision checklists, status pills, file lists). Marking up is the whole job, as it is on Picture, Voiceover, Music and Sound effects.

The video loop pins a note to a moment in time. An image has no time, and one image can carry several marks, so a note is pinned to what it is on: which visual, which page, which aspect ratio, and where on the image.

Rushes still does not make images. The agent registers them.

## 25.2 Decisions (agreed with Red, 12 October 2026)

1. **A new stage, Visuals, one tab per project.** It sits after Mix and before Assets, so it is key `7` and Assets becomes `8`. It is locked, with an ask-your-agent prompt, until one visual is registered. A visual belongs to the project, not to a film.
2. **A visual is one post.** A still, or a carousel of pages. Each page has an image in each aspect ratio the visual comes in. A still is a visual with one page.
3. **One page at a time in a large frame, with the page strip under it**, as in the review page Red liked. Not a filmstrip of every page side by side (too small to mark), and not a vertical stack of pages. Aspect ratios are chips on the visual.
4. **The tab scrolls vertically between visuals.** Each visual fills the view and the page snaps to it gently. Red does not want a decision to make here: **whichever visual crosses the middle of the view is the current one.** Nothing is clicked to make a visual current.
5. **Notes are pinned to what they are on, not to scroll position.** A note carries its visual, its version, its page, its aspect ratio, and a region (a box as fractions of the image), a point pin, or neither (the whole image). Moving between pages, ratios and visuals never loses or moves a note.
6. **The notes column lists the whole tab's notes**, grouped by visual and then page, like Picture's right column. The current visual's group is highlighted and full strength; every other group is faded but readable and clickable.
7. **The composer can only add to the visual in view, and says so**: "Adding to: Launch carousel · page 3 · 4:5 · v2". A draft stays tied to the visual it began on ("Draft for …", with a Go to it button) and is never silently moved. Clicking a note on another visual does not let you add to it from where you are: it scrolls to that visual, so the view and the composer's target cannot disagree.
8. **A follow-up note is another note** on the same visual, as on Picture. No threads.
9. **The agent registers each visual with one tool call** (`rushes_add_visual`). No folder scan in this release.
10. **Versions belong to the visual**, like a cut's. The agent registers "version 2" and sends only what changed; everything else is inherited. The tab shows the newest version, with a version chip to look back. Notes stay on the version they were made on ("from v1") until the agent replies and marks them done (Red can open one again). A box from an older version is not drawn on a newer image (the thing it marked may have moved); it stays in the list, and clicking it shows that version with the box. That is a look back, and it lasts only until a newer version is registered: then the visual shows the newest again, on the same page and ratio (`remember` and `resolveView` in `web/src/visuals.ts`; the version chip does the same).
11. **The carousel footer** is under the frame: Previous, a count (`03 / 12`), Full screen and Next, with the page strip below. The strip shows about eight pages with the active page first, and more pages come in on the right as you advance (near the end it stops scrolling, so the last pages still fill the strip).
12. **Full screen is view-only.** It is for looking at detail. Marking happens back in the tab. It shows the page large with its boxes, Previous and Next, and Esc closes it.

## 25.3 Data: `.rushes/visuals.json`

A new file, kept like `brief.json`: written only by the server through `Store`, created on first write, so a project that never uses Visuals gains nothing. Videos stay in `project.json`.

```
{ schema: 1, rev, visuals: [Visual] }

Visual   { id, name, kind: "still" | "carousel", versions: [VisualVersion], addedAt }
VisualVersion
         { id: "v1", addedAt, label, note,
           pages: [Page] }                    // resolved: every page, in order
Page     { n, images: [Image] }               // one image per aspect ratio
Image    { ratio: "4x5", file, width, height }
```

- **ids**: a visual's id is a short slug of its name, unique in the project (`launch-carousel`). Versions are `v1`, `v2`, … per visual.
- **Resolved, not diffed.** A version stores every page and every image it shows, including those it inherited. The dashboard never works inheritance out; the server does it when the version is registered (25.5).
- **Ratios** are derived from the image's own size with the same helper video formats use (`ratioLabel`, `ratioId`; the id is the label with `x`, such as `4x5`). The agent does not name them. Two images of one page that have the same ratio are refused (`same_ratio`), as for formats.
- **Image size** is read from the file's header (png, jpg, webp, gif; no ffmpeg needed) by a small pure function in `src/core/imageSize.ts`.
- **Files** stay where they are. Rushes never copies, resizes or reencodes an image. Paths are project-relative and checked as video renders are (inside the project, not a link out, a real image of a type the browser shows inline).
- **Older Rushes** loading a newer project keeps the file as it is: the schema is a loose object like the others.

## 25.4 Notes on visuals

Visual notes are ordinary notes in `notes.json` with `stage: "visuals"`. `STAGES` gains `"visuals"`. Everything that already works (the agent's reply, the done tick, batches, `rushes_list_notes`, Export notes, the Change Log) applies unchanged.

| Field | On a visual note |
|---|---|
| `stage` | `"visuals"` |
| `video` | `null` |
| `version` | the visual's version, `"v2"` |
| `on` | `"<visual id>/<page>"`, for example `"launch/3"` |
| `format` | the ratio id the region or pin was drawn on, `"4x5"`. `null` means every ratio (allowed only when there is no region or pin) |
| `scope` | `"whole"` (an image has no time; `t`, `tOut` and `frame` are null) |
| `box` | the region, as fractions of the image (existing `BoxSchema`), or `null` |
| `pin` | **new**: `{ x, y }` as fractions, or `null`. A note has a `box`, a `pin` or neither, never both |
| `marks`, `shot`, `grab` | not used (`marks` stays audio-only) |
| `fixVersion` | the visual version in which the agent says it is fixed |

- `NoteSchema` gains the optional `pin`; the `superRefine` rules gain: no box and pin together; pin and box coordinates inside 0..1; `visuals` notes are `whole`.
- `checkNoteFormat` today allows a `format` only on Picture. It now also allows one on a Visuals note, checked against the ratios of the note's visual version (`unknown_format` otherwise), and requires one when there is a box or pin, because a region on the portrait image is not the same place on the landscape one.
- The server checks `on` names a real visual and a real page of the note's version, and that the version exists.

## 25.5 The agent surface

One new MCP tool, so there are twenty-three. There is no CLI command for it (the call is nested; YAGNI).

**`rushes_add_visual`**

```
{ name?: string,            // a new visual: its name
  visual?: string,          // or: the id (or name) of an existing visual, for a new version
  kind?: "still" | "carousel",   // new visual only; default: carousel if more than one page, else still
  label?: string,           // a short note about this version, as for cuts (48 characters)
  pages: [ { n?: number, files: string[] } ] }
```

- A new visual (`name`): `pages` lists every page in order, each with the files of that page (one per aspect ratio). Page numbers are 1, 2, …; `n` may be left out. Every page must have the same set of ratios.
- A new version (`visual`): `pages` lists only the pages that **changed** or are **new**, each with `n`. Pages not listed are inherited from the previous version. A listed page may give only the ratios that changed; the others are inherited for that page.
- The grid check, after inheriting: the version's pages are 1 to the highest `n` (so pages can be added at the end, never removed), its ratios are the previous version's plus any new ones, and **every page must have an image for every ratio**. If a cell is missing the call fails and names it ("page 4 has no 16:9 image").
- Errors name the file and say why: `not_in_project`, `not_an_image`, `unreadable`, `same_ratio` (two files of one page share a ratio), `ratio_set` (a new visual's pages disagree on ratios), `no_such_visual`, `grid_incomplete`. A rejected call changes nothing.
- It returns `{ visual, version, pages, ratios }`. A visual's tab count in `rushes_status` includes it; the tab's `todo` is its open notes.
- **Replying.** `rushes_reply` works as for any note. The agent sets `fixVersion` to the version that fixes it; the dashboard then jumps from the note to that page in that version.
- **`rushes_get_batch` and `rushes_list_notes`** return visual notes with their visual's name and id, page, version, ratio, shape (`region`, `pin` or `image`), the region or pin as fractions **and** in words ("left third, top third"), and the exact file path of that page's image in that ratio, so the agent can open the right file.
- **The batch prompt** for a Visuals batch tells the agent to read the batch, change each marked image, register a new version with `rushes_add_visual` (only the changed pages), and `rushes_reply` to each note with the version that fixes it. A note with no ratio is for every ratio: say which you fixed.
- **Export notes** gains a Visuals section grouped like the column. The **Change Log** gets a `visuals` area, so "Version 2 of the launch carousel" lines read like cuts do.
- **Skill and `AGENTS.md`** gain a short section, "Visuals", saying when to register one, the one-call shape, that inherited pages need not be sent, and that the user marks regions and the agent marks each note it fixed done, with `fixVersion`, as on every other tab (the user can open one again).

## 25.6 The dashboard

Layout as in the mockup. Two columns, as on Picture: the visuals on the left, the notes column on the right with the composer at its foot (stacked on a narrow screen).

**The visuals column.** A vertical stack of full-height sections inside a scroll container with `scroll-snap-type: y proximity`. Each section is one visual:

- **Header:** name, kind (and page count), a version chip (a menu when there is more than one version; viewing an older one shows a banner "Viewing v1, an older version"), and the ratio chips (a plain size label when there is only one).
- **Frame:** the current page at the chosen ratio, sized to fit the section so there is no scroll inside it (a `ResizeObserver` sizes it; the aspect ratio is the image's own). All of that page's boxes and pins for this ratio and version are drawn on it, numbered to match the notes list. Done notes are drawn green, open ones amber, the selected one heavier.
- **Footer (carousel):** Previous, `03 / 12`, Full screen, Next, and the page strip. The strip is about eight pages wide with the active page first (clamped so the last pages fill it); each page carries a badge with its open notes. A still has Full screen and its ratio chips only.
- **Current visual.** An `IntersectionObserver` on the scroll container with `rootMargin: "-50% 0px -50% 0px"` marks the section crossing the middle as current. The current section has a strong outline; the others are slightly dimmed (and click-through: a click on another visual's frame scrolls it into view rather than marking it).

**Marking.** On the current visual's frame, drag draws a region and click drops a pin; both are clamped to the image, a drag under 2% in either direction is ignored, and a click without dragging is a pin. Either opens the composer attached to the shape. **Whole image** in the composer makes a note with no shape. It applies to every ratio; when the visual has several ratios the composer offers "Just 4:5" to keep it to the one in view. `Esc` cancels a draft. Marking is off when an older version is showing (a banner explains) and off in full screen.

**The notes column.** `Notes · N open across M visuals`, then one group per visual that has notes: a header (name, "looking at" on the current one, open count), then its pages, then the notes: number, text, tags (ratio, `v2` or `from v1`, `region` / `point` / `whole image`), the agent's reply, and the done tick. The current visual's group has the accent border and background; the other groups are at 45% opacity, 80% on hover. When the current visual changes, the list scrolls to its group. Clicking a note selects it and scrolls the visuals column to its visual, sets that visual's page, ratio and version to the note's, and flashes the box. Clicking a group header scrolls to that visual. A note with a `fixVersion` and a reply offers "Show in v2".

**The composer.** Its target line always names where a note would go and is always the visual in view: **Adding to** (blue) when the draft, or the absence of one, matches the visual in view; **Draft for … Go to it** (amber) when a draft started on another visual and the person has scrolled on. Starting a new mark on a different visual while a non-empty draft exists is refused with a message ("Finish or discard your draft on …"), never by silently moving or dropping the draft. Adding the note saves it to the visual the draft began on.

**Keys** (for the current visual; the existing digit keys are unchanged except `7` is Visuals and Assets is `8`): `←` `→` previous and next page, `R` cycles the ratio, `↑` `↓` previous and next visual, `N` focuses the composer, `Esc` cancels a draft or closes full screen. They do nothing while a text box has focus. Frame stepping, In and Out do not apply here.

**Full screen** is a dialog with the page large on a dark ground, its boxes shown, Previous, Next and Close, `←` `→` and `Esc`. No marking, no composer.

**States.** Locked (nothing registered): the Visuals tab shows a lock; its page is the empty pane with the prompt to copy. A page whose image cannot load shows "Can't load page 3: <path>" in its frame; whole-image notes still work. A visual with notes on a ratio it no longer has (a hand-edited file) keeps them listed, with "ratio no longer available".

## 25.7 Server

- `FILES.visuals` (`visuals.json`), `Store` defaults and created-on-write as `brief.json` is. `GET /api/state` carries `visuals`; `GET /api/tabs` (so `rushes_status`) gains a `visuals` tab entry. `tabStates` gets the visuals file: unlocked when there is at least one visual, `todo` is the open Visuals notes.
- `POST /api/visuals` registers a visual or a version (the tool's HTTP side), with the checks in 25.5, in one `Store` update.
- Notes: the existing note routes take `stage: "visuals"`; the format check and the `on` check in 25.4 run there. A visual note's `version` is stamped and checked like a cut note's.
- `/media`: every image of every visual version is registered media (`registeredMedia` gains them), so the existing path, link and content-type checks serve them. Nothing else is served.
- Batches: `Send to agent` on the Visuals tab builds a batch from that tab's open notes, as for the other stages, with the prompt in 25.5.

## 25.8 Edge cases

- **Two visuals with the same name**: refused (`duplicate_name`); a new version is the way to change one.
- **An image replaced on disk under the same path** with a new version not registered: Rushes shows what is at the path; there is no image hashing. (The agent is told to register a version.)
- **Huge images**: served as they are; the browser scales them. No thumbnails are made (the strip uses the same file).
- **Page cap**: a visual may have at most 100 pages (`too_many_pages`), the same kind of cap as the 200 shots a cut holds.
- **Deleting or renaming**: not supported in this release (hand-editing `visuals.json` works; the server keeps the file as it is).
- **Old projects**: no change until a visual is registered; no migration.
- **Keyboard and focus**: the dashboard's existing rules apply (icon buttons with tooltips, body text 15px and up, visible focus). The page strip and ratio and version chips are buttons in tab order; boxes are not focusable (the notes list is the keyboard route to a note).

## 25.9 Testing

Test-first, as every step so far.

- **Unit:** `imageSize` on real png, jpg, webp and gif fixtures and on junk; the version resolution (inheritance, added pages, a new ratio needing every page, a missing cell, no removal); note schema and `checkNoteFormat` for visual notes; `tabStates`; the batch prompt and Export notes text.
- **Server:** `POST /api/visuals` and its every error (a rejected call changes nothing); notes on visuals (their `on`, `format` and `pin` rules); `/media` serves registered visual images and nothing else; `rushes_status` counts; the MCP tool and its schema, the tool count (23), the skill and `AGENTS.md` wording tests.
- **Browser** (Chromium and WebKit): scroll makes the visual crossing the middle current (outline, composer target and notes group follow); drag draws a region and click a pin, clamped; the composer names its target and a draft stays on its visual and offers Go to it; a new mark on another visual with a non-empty draft is refused; clicking a faded note scrolls to its visual, sets page, ratio and version and flashes the box; ratio chips and the version chip; the strip puts the active page first and the badges count; Previous, Next and the keys; full screen opens, shows boxes, and cannot mark; the locked and cannot-load states; an older version shows no boxes and cannot be marked.

## 25.10 Not in this release

A folder scan or Assets › Found offering images; per-page revisions; comparing two versions side by side; removing pages or visuals; renaming; threaded replies; marking in full screen; thumbnails or resizing; a `rushes add visual` command; copy, captions, source notes, checklists and any other panel the review pages carried.

## 25.11 Files touched (for the plan)

`src/core/schema.ts` (STAGES, `pin`, visuals schema, FILES), `src/core/store.ts`, `src/core/visuals.ts` (new: resolve and checks), `src/core/imageSize.ts` (new), `src/core/notes.ts`, `src/core/tabs.ts`, `src/core/batches.ts`, `src/core/exportNotes.ts`, `src/core/log.ts` and `logEvents.ts`, `src/server/app.ts` (routes, state, tabs), `src/server/files.ts` (`registeredMedia`), `src/server/start.ts`, `src/mcp/tools.ts`, `web/src/types.ts`, `web/src/lib.ts`, `web/src/ui/Visuals.tsx` (new), `web/src/ui/App.tsx`, `web/src/ui/Icon.tsx`, `web/src/styles.css`, e2e and unit tests, `AGENTS.md`, `skills/rushes/SKILL.md`, `README.md`.

## 25.12 As built (12 October 2026)

- **Pictures.** The agent lists a page's files; Rushes reads each file's size from its first 256 KB (`src/core/imageSize.ts`: png, jpeg, gif, webp; a jpeg stored on its side, EXIF orientation 5 to 8, is read as the shape a browser draws it) and names the ratio with the helpers video formats use. Two pictures of one shape on a page are `same_ratio`. A path outside the project, or with a link anywhere in it, is `not_in_project`; a non-picture or a picture whose size cannot be read is `not_an_image`; a file that cannot be opened is `unreadable`. `viaLink` lives in `src/server/links.ts`, shared with the storyboard's stills. A rejected call writes nothing, not even `visuals.json`.
- **Registering.** Core codes: `bad_name`, `bad_pages`, `too_many_pages`, `duplicate_name` (the same name or the same slug), `no_such_visual`, `ratio_set`, `grid_incomplete`. A new version may add pages at the end with no gap and a new ratio only if every page gets it; a still stays one page.
- **Notes.** A Visuals note has `scope: "whole"`, `on: "<visual id>/<page>"`, `format` the ratio id (required with a region or a point, `null` for every ratio), and a `box`, a new `pin` (`{ x, y }`), or neither. The server checks the visual, version, page and ratio (`no_such_visual`, `no_such_version`, `no_such_page`, `unknown_format`, `shape_needs_format`).
- **What the agent reads.** `GET /api/notes` and `GET /api/batches/:id` return each Visuals note with a `visual` object: `visual` (id, name), `version`, `page`, `ratio` (a label, or null), `shape` (`region`, `pin`, `image`), `region`, `pin`, `words` and `file`. The words come from the thirds a region covers (at least 40% of a third): "left third, top third", "right two thirds, bottom third", "the centre", "the whole picture"; a point is "left, bottom" or "the centre".
- **The tab.** The strip shows eight pages with the active one first (clamped at the end); the current visual is chosen by an `IntersectionObserver` on the middle of the scroll area; a draft is tied to its visual; a new mark elsewhere is refused while a draft has words; full screen is view-only. The keys are read through a ref, so a key pressed straight after a click never meets the previous render's handler. Fractions are kept to four places.
- **Change Log.** Area `visuals`, kind `visual`: "“Launch carousel” v2 added: Shorter headline"; an unlabelled version says only "added".
- **Not built:** as 25.10.
