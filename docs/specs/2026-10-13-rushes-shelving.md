# Rushes: shelving a film (§26)

Status: DRAFT, 13 October 2026. Designed with Red in a question-by-question session the same day; every decision in 26.2 is his. The mockup (`2026-10-13-rushes-shelving-mockup.html`) shows the top bar with fifteen films, the overflow list, the Shelved list, a shelved film's banner and the empty states. It is built (26.12).

## 26.1 The problem

A film is a `video` in the project (the pills across the top, each with its versions). Some films go nowhere: a cut is developed, and then it is not wanted. Today there is no way to take it out of the working set. It stays in the top bar for ever, its open notes keep counting in Send to agent and the tab dots, and with fourteen or fifteen films the bar is crowded.

Red does not want to delete these films (the work may come back, and nothing should be lost). He wants to demote them: out of the way, out of the counts, recoverable.

## 26.2 Decisions (agreed with Red, 13 October 2026)

1. **Shelve, reversible.** A shelved film is demoted, not deleted. Its cuts, notes, picks, takes and files are kept. One click restores it.
2. **The top bar overflows into a menu.** How many films show as pills follows the window's width; the rest fold into a **+N** button that opens a list. The current film is always a pill. A **Shelved (N)** button sits at the end of the pack.
3. **A shelved film's open notes stop counting, and are kept.** They leave the Send to agent count, the tab to-do counts, the pill dots, new batches and Export notes. They are still in the project and count again when the film is restored.
4. **A new cut from the agent restores the film.** New work means it is in play again; the Change Log says so.
5. **Only the user shelves and restores,** from the dashboard. The agent can see which films are shelved and leaves them alone, but cannot shelve or restore. There is still no new MCP tool (twenty-three).
6. **The action is a Film menu, not an icon on the pill.** A button in the header's right-hand cluster, beside the Change Log, opens a short menu for the film you are in. Pills only switch films, so a film cannot be shelved by a stray click on a pill you were not working in (an icon that appears on hover also widens the pill and makes the bar jump under the mouse). **Restore** is on the Shelved list and on a shelved film's banner; restoring is harmless, so it needs no such care. No manager panel.
7. **The menu holds only Shelve / Restore to start with.** The padlock stays on the bar as the lock's one place, so its state is visible at a glance. The menu is where later film actions would go.

Decisions made in the design beyond these (cheap to reverse):

8. A shelved film opens **view-only**: the film greyed, a banner "Shelved · Restore", and no marking or note adding. It can be looked at and played.
9. Shelving the current film moves to the next film in play (the one to its right, else the one to its left). With none left, Picture shows an empty state that points at the Shelved list.
10. When one film is in play the pack collapses to the crumb (as it does for a one-film project today), but **Shelved (N)** stays reachable.
11. A film with a locked picture can be shelved; the lock is untouched.
12. Only a new **cut** restores. Other agent calls on a shelved film (a reply, a format, a take, a pick) work as they do today and leave it shelved.

## 26.3 Data

`project.json`: a film gains one field.

```json
{ "id": "key", "name": "Key", "versions": [], "lockedVersion": null, "shelved": "2026-10-13T10:00:00.000Z" }
```

`shelved` is an ISO time while the film is shelved. It is optional: absent (or `null`) means the film is in play, and restoring removes the key, so every existing project loads and saves unchanged and `rev`/`schema` do not change. Shelving writes only this field.

`src/core/project.ts` gains `shelveFilm(project, videoId, shelved, now?)`: it sets the field or removes the key, and returns the film. It is a no-op that still succeeds when the film is already in the asked state (idempotent), and it throws `no_such_video` for an unknown film.

A film is **in play** when `shelved === null`. One helper, `inPlay(video)`, and one for notes, `noteInPlay(note, project)`, are the only places the rule is written: a note is in play unless its `video` names a shelved film (a note with no film is always in play).

## 26.4 What "out of play" does

A shelved film's notes (every stage) are left out of:

- **`tabStates`** to-do counts (and so the dots on the tabs and the number on Send to agent),
- **`createBatch`**: a batch never includes them, and the batch prompt never asks for a fix on a shelved film,
- **`notesMarkdown`** (Export notes), which omits a shelved film's section,
- **`GET /api/notes`**, unless `includeShelved=true`,
- the **pill dots** in the dashboard.

A batch already sent keeps what it had. Nothing is closed or changed: shelving writes only `shelved`. The Change Log gets `film shelved` and `film restored` events (area `picture`, kind `film`): "Film “Key” shelved", "Film “Key” restored".

A new cut (`POST /api/versions`) on a shelved film removes `shelved` in the same write and logs two lines: "Film “Key” restored", then the cut's own line as always ("v3 added: …").

## 26.5 The agent surface

- `GET /api/tabs` (so `rushes_status`) gains `films: [{ id, name, shelved }]`, every film with its mark (`shelved` is the time or `null`), so the agent knows which films to leave alone. No new tool; `rushes_status`'s description gains one sentence.
- `rushes_add_version` and `rushes add version`: the reply says `restored: true` when the cut brought a film back.
- `AGENTS.md`, `skills/rushes/SKILL.md` and the README say: a shelved film is the user's decision to set a cut aside; do not make new cuts of it or fix its notes unless told, and a new cut restores it.

## 26.6 The dashboard

**The pack** (`FilmPack`, replacing the inline pack in `App.tsx`) lists only films in play. How many are pills follows the width of the header alone: about one film for every 190 px, never fewer than three or more than twelve (`maxPills`). The header's own layout already makes the pills' names give way to each other (an ellipsis); this stops fifteen films being crushed to nothing. The films past that number fold into **+N**, which opens a list of them (number, name, open-note dot; choosing a row opens the film). The current film is always shown as a pill, in place of the last of the others if it would not have been. When every film fits there is no +N. Escape closes either list. The pack and the Shelved button are two direct children of the header, so the header's existing rules for the pack apply to it unchanged.

**A pill** only switches films: a number, the name and the open-note dot, with nothing on hover and no change in width.

**The Film menu** is a button (icon `more`, three dots) at the start of the header's right-hand cluster, before Shortcuts and the Change Log, with the tooltip "Film actions · Key". It opens a small menu headed by the current film's name, with one entry: **Shelve film** (`Shift+S` shown beside it). On a shelved film the entry reads **Restore film**. Choosing Shelve closes the pill up in the bar and a toast says "“Key” shelved · Undo" for a few seconds; Undo restores it. The button is always there, in every tab and in a one-film project, so a project's only film can be shelved too (the empty state in this section then applies). It is a real button with an `aria-label`, Tab reaches it, Escape closes the menu. Its tooltip opens leftwards so it never lies over the Shortcuts button's.

**Header room.** The Film button needs about 46 px. The header's two width steps move up by that much (the "Picture" label goes at 1340 px and under, not 1280; the Change Log button is its icon at 1620 px and under with two formats or more, not 1560), and at those widths the found chip's, the version control's and the gaps' minimums tighten a little, so the existing guarantee that a long project's header stays one row from 1101 px holds.

**Shelved (N)** appears at the end of the pack whenever N is above zero. It opens a list of shelved films, greyed, each with its name, number of cuts, the date it was shelved and a **Restore** icon. Choosing a row opens that film view-only.

**A shelved film's view.** The page shows the film as usual, dimmed, under a banner: "Shelved on 13 Oct · Restore". The cut can be played and its version menu opened. The mark tools (In, Out, box and grab, and their keys), the note composer and Lock are off, and the picture is dimmed; the banner's Restore puts them back. The format toggle stays on: switching format is only looking.

**Empty state.** With every film shelved, Picture shows "All films are shelved" and a button that opens the Shelved list.

**Keys.** `Shift+S` shelves the current film and, on a shelved film, restores it. No other shortcut uses it (the Shortcuts sheet lists Space, the arrows, O, B, G, N, the tab digits, `[` `]`, `?` and Esc), and it is added to that sheet. `[` and `]` (previous and next film) skip shelved films: they step through the films in play; from a shelved film they go to the nearest film in play before or after it.

Icon names: `more` (three dots) for the Film menu button, `shelve` (a box with a lid, new) for the entry and the Shelved button, and `undo` (existing) for Restore. No emoji; SVG only.

## 26.7 Server

- `PUT /api/videos/:video/shelve` with `{ shelved: boolean }` → `200 { video }`. `404 no_such_video`. Idempotent. Logs the Change Log line only when the state changes.
- `GET /api/state` already carries every film with the new field; the dashboard needs nothing else.
- `POST /api/versions` restores as in 26.4.
- `GET /api/notes?includeShelved=true` as in 26.4.

## 26.8 Edge cases

- Shelving the current film while a note on it is half-typed is refused with the message switching films already gives, "Add or clear your note on Key first", because shelving moves you to another film.
- Two sessions shelve the same film: the second is a no-op.
- A film shelved with notes in a batch that is still open: the batch stays; its notes are not hidden from the batch view.
- Restoring a film whose number in the pack would be above the others keeps its position in the project's order; numbers on the pills are positions among films in play.
- A project where nothing is shelved looks and works exactly as it does now.

## 26.9 Testing

Unit: `shelveFilm` (set, clear, idempotent, unknown film), `inPlay`/`noteInPlay`, `tabStates` counts, `createBatch`, `notesMarkdown`, the Change Log events, `POST /api/versions` restoring, `GET /api/tabs` `films`, `GET /api/notes`, `PUT .../shelve`.

Browser (Chromium, and WebKit for the new spec): shelve from the Film menu and see the bar close up and the Send to agent count drop; Undo; the +N overflow with a narrow window and the current film kept visible; the Shelved list and Restore; a shelved film opens view-only with its banner; a new cut through the API restores it; `Shift+S`; the all-shelved empty state; a project with nothing shelved unchanged.

## 26.10 Not in this release

Deleting a film for good; a manager panel; shelving from a pill; moving Lock into the Film menu; shelving a single cut (version) rather than a film; an agent tool to shelve or restore; shelving the Visuals tab's visuals.

## 26.11 Files touched (for the plan)

`src/core/schema.ts`, `project.ts`, `tabs.ts`, `batches.ts`, `exportNotes.ts`, `log.ts`/`logEvents.ts` (core); `src/server/app.ts` (route, tabs, notes, versions); `src/mcp/tools.ts` (the status sentence); `src/cli/main.ts` (`rushes status` lists shelved films); `web/src/ui/FilmPack.tsx`, `FilmMenu.tsx` and `useDismiss.ts` (new), `App.tsx`, `Picture.tsx` and `Notes.tsx` (a `readOnly` prop), `Icon.tsx`, `styles.css`, `changes.css` (the header's width steps), `web/src/lib.ts` (`inPlay`, `maxPills`, and the rules for which film is next); `e2e/shelving.spec.ts` (new); `README.md`, `AGENTS.md`, `skills/rushes/SKILL.md`; their tests.

## 26.12 As built (13 October 2026)

- **Data.** `Video.shelved` is an optional string (an ISO time): absent, or null from a hand-edited file, means in play. `shelveFilm` sets it (keeping the first time a film was shelved) or deletes the key, so a restore leaves nothing behind and a project that never shelves a film is byte-for-byte what it was. `inPlay` and `noteInPlay` (`src/core/project.ts`) are the only places the rule is written; the dashboard's `inPlay` is in `web/src/lib.ts`. A note on a film that is gone is still in play.
- **What stops counting.** `tabStates`, `createBatch`, `notesMarkdown` and `GET /api/notes` (unless `includeShelved=true`) go through `noteInPlay`. Nothing is closed or changed.
- **Server.** `PUT /api/videos/:video/shelve` with `{ shelved: boolean }` answers `{ video }` (404 for a film that is not there, 400 for a body that is not true or false) and logs only a change: "Film “Key” shelved" or "restored" (area `picture`, kind `film`, merge `replace`). `POST /api/versions` removes the mark in the same write, logs "Film “Key” restored" before the cut's own line, and replies `restored: true`; a refused cut changes nothing. `GET /api/tabs` gains `films`.
- **Found.** A file brought in with no film named joins a film in play, never a shelved one (`anchorCut` passes shelved films over while any film is in play). A bring-in that does restore a film (it names it, or every film is shelved) answers `restored: [{ id, name }]` and logs "Film “Key” restored" before the brought-in line.
- **The agent.** The `rushes_status`, `rushes_add_version` and `rushes_list_notes` descriptions, `AGENTS.md`, the skill and the README say what a shelved film is. `rushes status` prints a `shelved` line, and `rushes add version` says "(it was shelved: restored)". Still twenty-three tools.
- **The pack.** `maxPills(width)` is one film for every 190 px of header, between 3 and 12, and `shownFilms` keeps the current film a pill. The pack and the Shelved button are two direct children of the header. `packShown` decides when pills show at all: two films in play, or one in play while a shelved film is open. `[` and `]` step through films in play (`neighbourVideo`).
- **The Film menu** (`FilmMenu.tsx`) is first in the header's right-hand cluster, its tooltip opens leftwards, and its list and the two pack lists close on Escape (`useDismiss.ts`, bound in a layout effect so a key pressed at once is not missed). Shelving the film you are in goes to `filmAfterShelving`, or to the empty state, and is refused with the switching message while a note is half-typed. The toast has an Undo that restores the film and returns to it. `Shift+S` toggles, and is ignored while typing.
- **A shelved film** opens with Picture's `readOnly` (In, Out, box and grab buttons and keys off, the note box hidden), Lock disabled, the picture dimmed, and a `ShelvedBanner` with Restore. The audio tabs (Voiceover, Mix, Music, Sound effects) hide their note box too while a shelved film is open, since a note left there would never be counted or sent.
- **Header room.** The two width steps moved up by the Film button's room: the Picture label goes at 1340 px and under (was 1280), the Change Log button is its icon at 1620 px and under with two formats or more (was 1560), and at the narrow step the found chip (56 px), the version control (72 px) and the gaps (8 px) tighten a little.
- **Not built:** as 26.10.
