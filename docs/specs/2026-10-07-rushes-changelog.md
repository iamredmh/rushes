# Rushes: short version labels and the Change Log (§22)

Status: design agreed with Red in chat on 7 October 2026 (newest first; a drawer from the header, opened by a small **Change Log** button); the written spec is for review; not built. This file extends `2026-10-02-rushes-design.md` and is numbered §22. §21 (formats) is a separate file, so the two can land in either order; where they meet (the version list, the header, VersionSchema) this spec says so.

## 22.1 The problems

1. **The version list is a wall of text.** Picture's version control is the browser's own dropdown, and each entry is the version id followed by the whole note an agent wrote for it ("v6 · launch 1.45x slower; each zoomed request types itself out; crowd on a wider oval, 22 bubbles, zero overlaps; …"). A dropdown can't truncate, so with five or six versions it fills the screen.
2. **Nothing says what happened, in order.** Cuts, voice reads, music, sound effects and notes all move forward in turns: picture, then audio, then back to picture. Rushes keeps the current state of each, but not the story between them, so someone picking the project up later (Red, another person, or an agent in a fresh session) has to reconstruct it from file dates.

## 22.2 Decisions

1. **A version gets a short label.** `Version.label`, 48 characters at most, optional. The long text stays in `note`. When there is no label, one is derived from the note (§22.4), so every existing project improves without anyone writing anything.
2. **The dropdown becomes a list.** One line per version: version id, short label, how long ago. The full note appears beside the list on hover or focus, and under the picture for the version on show.
3. **The Change Log is written by Rushes as things happen.** It is a new append-only file, `.rushes/log.json`, owned by the server like every other `.rushes` file. Each entry is one line.
4. **It reads newest first**, grouped by day. (Red's choice, so the latest work is at the top.)
5. **A small button, "Change Log", in the header opens a drawer on the right.** It is not a tab: a log is not a stage of the work.
6. **Agents can write to it and read it.** `rushes_log` adds a line (a decision, a change of direction); `rushes_get_log` lets an agent catch up at the start of a session. People can add a line too.
7. **Short, not detailed.** One line per event, never the content of a note or a reply. Anything that happens many times in a row is collapsed into one line (§22.5).

## 22.3 Data

All additions are optional or new, so every 0.2.x file loads unchanged.

```ts
// VersionSchema gains
label: z.string().trim().max(48).default("")

// New file .rushes/log.json
LogFileSchema = { schema: 1, rev: number, entries: LogEntry[] }   // max 5000; the oldest are dropped past that

LogEntry = {
  id: string,
  at: string,                         // ISO time, set by the server
  area: "script" | "picture" | "voice" | "music" | "sfx" | "mix" | "assets" | "project",
  kind: "cut" | "variant" | "take" | "script" | "picks" | "notes-sent" | "replies" | "lock" | "files" | "entry",
  text: string,                       // one line, 160 characters at most
  video: string | null,               // for a jump to Picture
  version: string | null,
  ref: string | null,                 // "<lane>/<variant>" or "<section>:<take>" for a jump, else null
  by: "user" | "agent" | "rushes",
}
```

`area` reuses the existing stage names, plus `assets` (files added) and `project` (anything that is about the whole project). `by: "rushes"` is for entries Rushes makes from its own events; `by: "agent"` and `by: "user"` are entries somebody wrote, and for events they carry who caused it where Rushes can tell (an agent registering a cut over the API is `agent`; a button press in the dashboard is `user`).

## 22.4 The short label

- **Written by the agent.** `rushes_add_version` takes `label` (48 characters or fewer). AGENTS.md and SKILL.md say: give every cut a short label that says what changed, and put the detail in `note`.
- **Derived when missing.** A pure function `shortLabel(version)` in `src/core/labels.ts` (no dependencies, shared with the dashboard):
  1. Use `label` if it is not empty.
  2. Otherwise take `note`; strip a leading `vN:` or `vN -` that repeats the version id; strip a leading `(batch …):`.
  3. Cut at the first `;`, `. `, ` — ` or ` (` that comes after the first 12 characters.
  4. If it is still over 48 characters, cut at the last word boundary before 47 and add `…`.
  5. If there is no note, use the cut's file name without its extension.
- Example (from a real project): "v6: launch 1.45x slower; each zoomed request types itself out; …" becomes **launch 1.45x slower**. "v3 (batch b_1): zoom in on each of the first four requests …" becomes **zoom in on each of the first four requests and back out** cut to 48 with an ellipsis.
- `shortLabel` is used by the version list, Assets › Cuts titles, the Change Log lines for cuts and the Send-to-agent prompt.

## 22.5 What gets logged

Rushes writes an entry at the moment it commits the change. One line each. Text is built from short labels and names, never from notes or replies.

| Event | Area | Text (example) |
|---|---|---|
| A cut is added (`POST /api/versions`) | picture | `v6 added: launch 1.45x slower` |
| Picture is locked or unlocked | picture | `Picture locked at v6` |
| A music or sound-effects variant is added | music / sfx | `Music: "Night drive, driving drop" added to night-drive` |
| A voiceover take is added | voice | `Voiceover: take 2 added to "Intro"` |
| The script is set or replaced | script | `Script set: 6 sections` |
| Picks change | mix | `Picks: voice "Vo Jules, full read", music "Night drive, held back"` (consecutive pick changes within 10 minutes are one entry, updated in place) |
| Notes are sent to the agent | notes | `3 notes sent from Picture` |
| The agent replies | notes | `Agent replied to 3 notes (2 done)` (one line per reply call; calls in a burst are one line counting every note) |
| Files are added | assets | `2 files added: Scripts & docs` |
| Someone adds a line | any | the line itself |
| A format is added (once §21 is built) | picture | `9:16 added to v2` |

**Not logged:** individual notes, mix levels, screenshots, proxies, anything automatic such as the scan's current set (that is one line: `Brought in 3 files with v6`, by `rushes`).

**Collapsing:** an entry of the same `kind` and `area`, by the same `by`, within 2 minutes of the last one is merged into it (`"3 variants added"`) so a batch of registrations doesn't flood the log.

## 22.6 Projects that already exist

- On first read of a project with no `.rushes/log.json`, the server **backfills once** from data that has dates: every cut (`addedAt`), every batch (`createdAt`), every file (`addedAt`). Backfilled entries have `by: "rushes"`. A small marker (`backfilled: true` in the file) stops it happening twice.
- **Audio has no dates today.** Variants and takes were never timestamped. They are listed as one undated line each at the bottom, under "Before the log": `Music: night-drive (3 variants)`. These lines are computed when the log is read, not stored.
- From the first run of this version, new variants and takes carry no extra data; the log entry is their date.

## 22.7 Agent surface

- **`rushes_log`** `{ text, area?, video?, version?, ref? }`: adds one line (by `agent`). `text` is trimmed and cut to 160 characters. Without `area` it is `project`.
- **`rushes_get_log`** `{ limit?, area?, since? }`: returns the newest `limit` entries (default 30, at most 200), newest first, plus `earlier: number` for what was left out.
- **`rushes_add_version`** gains `label`.
- **CLI:** `rushes log [--limit n] [--area x] [--md]` prints the log (`--md` prints Markdown); `rushes log add "text" [--area x]` adds a line.
- **Send to agent:** the prompt gains a short "Recent changes" block: the last five log lines (newest first).
- **Export:** the Exports folder's **Export notes** button also writes `change-log-YYYY-MM-DD.md` (newest first, one heading per day). `rushes log --md` prints the same text.
- **AGENTS.md / SKILL.md:** at the start of a session, read `rushes_get_log`; when you change direction, add a line with `rushes_log`; give every cut a `label`.

## 22.8 The dashboard

### The version list (Picture header)

- The control is a button showing the shown version and its short label (`v6 · launch 1.45x slower`), one line, truncated with an ellipsis. It replaces the native select. It is a menu button: Enter or Space opens a list, arrows move, Home and End jump, Esc closes, type-ahead on the version number.
- **Each row:** version id (mono), short label, the time since it was added (`2 h ago`), and a small lock mark on the locked version. Newest at the top, as now. One line per row, never wrapping.
- **The full note** appears in a detail panel to the right of the list while a row is hovered or focused (never a native tooltip: it would be cut off), with the duration and shot count under it. A touch device shows the detail under the row when it is selected.
- **Under the picture:** the version on show keeps its full note in a quiet line, two lines at most with a "More" control.
- With §21 built, the format toggle stays beside this control.

### The Change Log button and drawer

- A text button **Change Log** with a small clock-arrow icon sits in the header, left of Send to agent. A small dot on it means entries arrived since the drawer was last opened (the last seen id is kept in the browser).
- The drawer slides in from the right, 440 px wide (full width under 560 px), over the page without dimming it. It is not modal: the dashboard stays usable. Esc or the close button shuts it and returns focus to the button. It keeps its open state per session.
- **Inside**, top to bottom:
  1. A one-line input, "Add a line to the log", Enter to add (by `user`).
  2. Filter chips: All, Picture, Voice, Music, Sound effects, Mix, Notes, Files. One chip is on at a time; the choice is remembered for the session.
  3. The list, newest first, under day headings ("Today", "Yesterday", then "Mon 5 Oct"). Each row: the time (`14:32`), an area tag with the stage colour, the one-line text, and for entries that have a place to go a small arrow; clicking the row opens that tab or version or variant.
  4. At the bottom "Before the log" (the undated audio lines), when there are any.
  5. A footer button **Export as Markdown**.
- Live: entries appear at the top as they are written (the existing change event); the list does not jump while it is being read: if the viewer has scrolled, a "N new" pill appears at the top instead.
- Empty log: "Nothing yet. Rushes writes a line here whenever a cut, a take or a variant is added."
- Type is 15 px or larger; the drawer is a landmark region with an accessible name; rows are buttons; the filter chips are a radio group; reduced motion removes the slide.

## 22.9 Edge cases

| Case | Behaviour |
|---|---|
| A cut has no label and no note | The label is the file name without extension. |
| A note starts with something that is not the version ("Picture v1, silent. Night globe …") | Nothing is stripped; the first clause is used. |
| A label longer than 48 characters is sent | The agent call is refused with the limit; a hand-edited file with a longer one is shown cut at 48 with an ellipsis. |
| `log.json` is missing or corrupt | The log reads as empty (and backfills if it is missing); a corrupt file is moved aside as `log.json.bad` and `rushes doctor` says so. Nothing else is affected. |
| The log passes 5000 entries | The oldest are dropped; the drawer notes "Earlier entries were removed". |
| Two writes at once | Appends go through `store.update` like every other file, so they serialise. |
| An older Rushes server | `rushes_log` and `rushes_get_log` report that the running Rushes is older, as the discovery tools do. |
| The same event twice (a retried request) | Collapsing (§22.5) merges them; the text is the same so the line is not doubled. |

## 22.10 Not in this release

- Editing or deleting log lines.
- A line for every note, or any detail of a note or reply.
- Dating the audio that already exists. (Only new work is dated, and old audio is one line each.)
- Search across the log.
- A side-by-side of two versions.

## 22.11 Review focus

1. A project from 0.2.2 opens unchanged: no label, the version list shows derived labels, the log backfills cuts, batches and files once and never again.
2. Long and awkward notes: derived labels never exceed 48 characters, never cut in the middle of a word, never repeat the version id, and handle empty notes and notes made only of punctuation.
3. A burst of registrations (ten variants in a second) makes a handful of log lines, not ten.
4. The drawer while the page keeps changing: no focus loss, no list jump while reading, the "N new" pill; opening and closing with the keyboard returns focus.
5. A log that is missing, corrupt, huge or written by two agents at once.
6. Safari: the version list, the detail panel and the drawer use explicit grid tracks (`minmax(0,1fr)`), and long labels truncate rather than push the layout wider.
