# Rushes: the Plan tab, made for people (§38)

Status: AGREED, 27 November 2026. Red described what he wants in one message, picked the summary card for the brief, and said to build all of it without further stops. This extends §24 (start here), §27 (the desk) and §31 (films). The number is provisional.

## 38.1 The problem

Plan holds Brief, Script and Storyboard. All three were built for the agent: the brief is raw Markdown in text boxes, the storyboard is a column of small stills beside text fields, and the script shows what you changed only as a struck-through copy of the old line. Red rarely goes back into Plan once planning is done, and when he does it is hard to take in quickly. The test he gave: someone handed the project cold should understand it in a minute, and Red coming back to it should find it easy to act on.

Three things are missing outright:

1. **Films after the first have no brief.** Each film can have `films/<film-id>/brief.md` (§31.3), but in the Cloud Engines shorts only the first film has one; the briefs for EU only and North America stayed in chat, which Rushes cannot read.
2. **A storyboard still cannot be marked up.** Picture and Visuals let you drag a box or drop a pin and write a note that goes to the agent with Send. Storyboard has no notes at all (§24.12 ruled them out); you can only edit text.
3. **The script has no history.** The agent overwrites it. You cannot see the version before, or bring a line back from it.

## 38.2 Goals, non-goals

Goals: a brief you read, not parse; each film's brief built on the project's; a storyboard you look at shot by shot and mark up like a visual; a script whose changes and versions are visible.

Non-goals: Rushes still does not write the brief, generate stills or rewrite the script. The agent does, in the files. No new approval rules: Approve stays the user's alone (§24.3 item 2). No change to the Review or Assets workspaces.

Anti-goals: rebuilding tools Picture and Visuals already have (the box and pin, the notes panel, Send to AI); a page that looks like a form.

## 38.3 Brief

### At a glance

The brief opens with a card: **At a glance**. It is the brief in short lists, for someone with twenty seconds.

- The agent writes it as a section of `brief.md` headed `## At a glance`, first after the title. Each line is `- Label: value` (`- Ask: …`, `- Length: 10–20 s`, `- Audience: …`, `- Deliver: …`, `- Must: …`, `- Never: …`). Labels are free; those six are what the skill asks for. A label may repeat (two `- Must:` lines) and they are listed together.
- The card shows each label once, in bold small caps, with its values as a short list beside it. A line that is not `- Label: value` is shown as a plain bullet.
- The card is edited like any section (38.3, Sections) and its edits count like any section's.
- **With no At a glance section**, the card is built from the brief itself: the first sentence of each of the first five sections, under each heading, marked *From the sections*. Under it, a line: "Ask your agent for an At a glance summary" with a copy-prompt button. The fallback is never written to the file.

### Sections

Below the card, the other sections, rendered as reading text with the existing safe Markdown renderer (`web/src/markdown.ts`): headings, paragraphs, lists, bold, code. Each section is a card with its heading and an **Edit** button (pencil, labelled, top right) that turns the body into the text box it is today; **Done** (or Escape, or leaving the box) turns it back. Saving, the hash check and reopening an approved brief work exactly as now (§24.11).

- A contents line under At a glance lists the section headings as chips; a click scrolls to that section.
- A section the user changed shows **Edited by you** with the change marked in the text: words removed struck through in red, words added underlined in green, against the agent's version. One shared word-level diff (38.6) is used here, on the storyboard and on the script. Revert stays.
- A section longer than about 12 lines is shown cut down with **Show all**.

### A brief for each film

The first film's brief is the root `brief.md`, as now. It is also **the project brief**.

- **Another film with its own `films/<id>/brief.md`**: a strip above At a glance reads "Builds on the project brief" with **Show** (opens the project brief's At a glance card, read-only, inline). The film's own brief is everything else on the page.
- **Another film with no brief of its own**: the page shows the project brief read-only, under a notice: "This film has no brief of its own yet. Ask your agent to write one from your chat." with a copy-prompt button. The prompt names the file, `films/<id>/brief.md`, and asks for an At a glance section and only what is different for this film (its ask, its length, its claims, its look), not a copy of the project brief. Approve is hidden for a brief that is shown read-only.
- The skill and `AGENTS.md` gain the rule: when a new film is started in chat, write its `films/<id>/brief.md` before building, with At a glance first and only what differs from the project brief.

## 38.4 Storyboard

One shot at a time, large, the way Visuals shows a page.

- **The frame.** The shot's still, as large as fits beside the notes panel, its shape kept. Over it, the notes' boxes and pins, numbered, as on Visuals. A shot with no still shows the empty frame saying so; it can still take notes on the whole shot.
- **Above the frame:** `03 · ALWAYS ON`, the tag, the planned length, and the shot's status (draft, approved).
- **Under the frame:** Previous, the count (`03 / 09`), **Overview**, Next; and a strip of the shots' thumbnails, each with its number and a badge for open notes, the current one marked. Left and right arrow keys move between shots when no field has focus.
- **Under that:** what happens (the description, rendered, with Edit as on the brief), the Direction line, Edited by you with the word diff, and the approve tick. Same saves and rules as now (§24.13).
- **Overview.** The button swaps the frame for a grid of every shot: still, number, name, length, tag, approved tick, open-note badge. The planned total against the brief's target sits at its head (the bar there today). A click on a shot opens it in the frame. Overview is remembered for this browser, per project.

### Notes on shots

Shot notes are ordinary notes, so the agent's reply, the done tick, batches, Send to AI, Export notes and the Change Log apply unchanged.

- A new stage, `storyboard`. Notes on it carry the film (`video`), `version: null`, `on: "shot/<n>"` (the shot's number when the note was made), `shot: { n, name }` (already in the schema), `scope: "whole"`, and either a `box`, a `pin` or neither (the whole shot). `still` records the still's path the box or pin was drawn on.
- **Drawing.** As on Visuals: drag on the still for a box, click for a pin. The note is written in the right-hand notes panel, whose target line reads "Shot 03 · Offline" (and "· region" or "· point" when one is drawn). With nothing drawn, the note is on the whole shot. The panel lists the film's storyboard notes, the current shot's first and full strength, the others faded, as Visuals groups them; clicking another shot's note goes to that shot.
- **Finding the shot again.** A note's shot is found by its number and name: the same number and name, else the only shot with that name, else the note is listed under "Shots no longer in the storyboard". A box or pin is drawn only while the shot's still is the file it was drawn on; after the still changes, the note stays in the list marked "on the earlier still", as Visuals does for an older version.
- The Brief page keeps no notes of its own: its panel lists nothing and says "Notes on the plan are written on the Script or Storyboard page."
- `rushes_list_notes`, `rushes_get_batch`, `rushes_export_notes` and the CLI name a storyboard note "Shot 03 · Offline" (with "region" or "point"), and its batch line says which still it was drawn on so the agent can open it.
- `build.waitingOn` and the Planning marks are unchanged: notes do not block approval.

§24.12's "no notes on shots" is superseded.

## 38.5 Script

### Your changes, marked

A line you changed shows the word diff (38.6) under your field in place of the struck-through old line: removed words struck in red, added words in green. Revert stays. Direction edits show the same way, labelled Direction.

### Script versions

The script gets versions of its own, separate from the cut's.

- **A new version** is made each time the agent writes the script (`rushes_set_script`, the CLI, the API the agent uses) and the words of at least one line changed. It is a snapshot of every line as the agent wrote it: id, start, end, text. The user's own edits are not versions: they are the proposals on the newest version, as now.
- The first time a film's script is seen with no versions, what it has is kept as v1.
- Kept in `.rushes/script-versions.json` (`{ schema: 1, films: { "<film id>": [{ id: "v1", at, sections: [{ id, start, end, text }] }] } }`), written by the server through `Store`, created on first write. At most 50 versions per film; the oldest go first. An older Rushes ignores the file.
- **The pill.** At the head of the Script page: `Script v3` with a chevron. Its menu lists the versions, newest first, each with its time ("today 14:02") and "newest". It has nothing to do with the cut pill in the top bar.
- **Looking back.** Choosing an older version shows its lines read-only, each with the word diff against the newest version's line ("v1 → v3"), lines that no longer exist marked *removed since*, and lines added since marked *new in v3*. A banner says "Viewing v1, an older version" with **Back to newest**. Each older line has **Use this line**: it puts that wording into your version of the same line (by id) on the newest version, which then shows as Edited by you and goes with Send. A line whose id is gone cannot be used and says so.
- Notes, approving and flagging happen on the newest version only.
- `rushes_get_script` gains `version` (the newest version's id). No new tool.

## 38.6 The word diff

One pure function, `wordDiff(before, after)` in `web/src/lib.ts`, unit-tested: splits on whitespace (keeping it), finds the longest common subsequence of words, and returns runs of `same`, `del` and `ins`. Over 2,000 words on either side it returns one `del` and one `ins` (the whole texts) rather than spend time. One component renders it, `<Diff>` in `Planning.tsx`, replacing the struck-through paragraph in `EditedMark`. Red for removed, green for added, from the theme's tokens in both light and dark.

## 38.7 Look and words

Rushes' own style. Labelled buttons where a newcomer needs the word (Edit, Overview, Use this line, Back to newest); icon buttons with tooltips elsewhere. Copy gets a plain-English pass: no "Current", no "baseline", no "section" where "part" or the heading itself will do.

## 38.8 Build order

Each part is usable alone, in this order, with tests as elsewhere (unit for the core, Playwright in Chromium and WebKit for each page, a check that an old project loads unchanged):

1. The word diff and `<Diff>`, used by every page.
2. Brief: At a glance, rendered sections with Edit, contents chips, film briefs and the project brief, the skill and `AGENTS.md` rule.
3. Storyboard: the frame, strip and Overview; then the `storyboard` note stage end to end (schema, notes, tabs, batches, export, log, MCP, CLI) and drawing.
4. Script: the diff in rows; versions, the pill, looking back and Use this line.

## 38.9 What is left to the builder

Exact spacing and sizes, the strip's length, how the Overview grid wraps, the version menu's time format, and how the fallback At a glance picks a sentence, within the rules above.
