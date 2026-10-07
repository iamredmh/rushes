# Rushes: formats (§21)

Status: design agreed with Red on 7 October 2026; not built. This file extends `2026-10-02-rushes-design.md` and is numbered §21 so it follows §20 (finding the project's other files). It is a separate file so it can land without touching the main spec until the build merges.

## 21.1 The problem

A piece is often delivered in several aspect ratios: 1:1, 4:5, 9:16 and 16:9 are the usual four. They are the same edit, reframed: same length, same timing, different crop and layout. Rushes has no idea that this is one piece in four shapes. A cut is one file, so an agent can register only one of them, and the reviewer cannot look at the others or say that a note belongs to one of them.

What Red asked for:
- A toggle in Picture that offers exactly the formats this cut has, greyed out when there is only one.
- Seamless switching between them while reviewing.
- Notes that can belong to one format ("the logo is too close to the edge on 9:16") without landing on the formats they don't apply to.

## 21.2 Decisions

1. **A format is a render of a cut version, not a new cut.** Version v1 of a film can carry several renders, one per aspect ratio. Shots, notes' timecodes, picture lock, replies and the audio stages all stay at the version level.
2. **The version's own `file` stays the primary render.** Nothing about an existing project changes. `formats` lists the additional renders. The primary is a format too: its ratio is read from the file.
3. **A ratio is measured, never typed.** The width and height come from ffprobe; the label is the nearest standard ratio (1:1, 4:5, 5:4, 4:3, 3:4, 3:2, 2:3, 16:9, 9:16, 21:9, 9:21) within 1%, otherwise the reduced fraction if both terms are ≤ 32, otherwise the decimal ("2.37:1").
4. **A new note belongs to the format being viewed.** When a cut has two or more formats, a new note defaults to "This format". A switch in the note composer says **This format** or **All formats** and can be changed on the note afterwards. With one format there is no switch and the note is saved for all formats (the two are the same thing).
5. **A note shows on the formats it belongs to.** Viewing 16:9 shows the 16:9 notes and the all-format notes. Notes for other formats are not shown, not dimmed.
6. **An all-format note has no drawn box.** A box is positions on one frame and means nothing on another shape. Drawing a box fixes the note to the format on screen and disables the switch with a tooltip that says why.
7. **Done is per note.** An all-format note has one status. The agent's reply says which formats it fixed; the note is marked done when the agent marks it done.

## 21.3 Data

All additions are optional with defaults, so every existing file loads unchanged.

```ts
// VersionSchema gains
formats: z.array(FormatSchema).max(8).default([])

FormatSchema = {
  id: string,          // "1x1" | "4x5" | "9x16" | "16x9" | "2.37x1" … the label with ":" replaced by "x"
  label: string,       // "9:16"
  file: string,        // path, same rules as Version.file (inside the project, or an absolute media path)
  width: int, height: int,
  duration: seconds | null, fps: number | null,
  addedAt: string,
}

// NoteSchema gains
format: string | null   // a Format id; null = all formats (default; every older note)
```

Rules:
- A format's id is unique within its version and different from the primary's id. Registering a second render with the same ratio is refused ("v1 already has 16:9. Register a re-render as a new version.").
- Proxies belong to the primary render only in this release. A format always plays from its original file. (The Proxy/Original switch is hidden while a format other than the primary is showing.)
- A format whose duration differs from the primary's by more than 0.1 s is registered, and the toggle shows a small warning mark with "9:16 is 8.4 s; the cut is 8.0 s". Notes keep their timecodes; nothing is rescaled.
- Up to 8 formats per version.
- `note.format` must name a format of that note's version or be null; otherwise the write is refused. A format that is later removed leaves its notes in place (they show under "Other formats" in the notes list, read only, with a Restore-to-all button).

## 21.4 Agent surface

- **`rushes_add_format`** `{ video?, version?, file, label? }`: registers `file` as another format of the cut (default: the newest cut of the only or newest film). `label` is only a hint when the ratio is ambiguous. Returns the id and label it settled on, or the refusal.
- **`rushes_add_version`** takes an optional `formats: [{ file }]` so an agent can register a re-render in all its shapes in one call. The primary is the first file.
- **`rushes_list_notes`** returns `format` on every note and takes an optional `format` filter (which also returns the all-format notes unless `onlyThisFormat` is set).
- **`rushes_reply`** is unchanged.
- **CLI**: `rushes add format <file> [--video] [--version] [--label]`; `rushes notes` shows the format column.
- **AGENTS.md / SKILL.md**: register every shape you rendered, put the one you consider the main one first, and when a note's format is not null fix only that format.
- **Export (Markdown)**: each note line carries its format ("9:16" or "All").

## 21.5 The dashboard

### The toggle

A segmented control in the Picture header, next to the version pill. One chip per format, always in this order so the position of a chip never changes between projects: 9:16, 4:5, 1:1, 4:3, 16:9, then anything else by width over height.

- Each chip shows the ratio and, when the version has open notes for it, a small count (notes for that format plus the all-format notes, which is exactly what you would see on switching).
- **One format:** the control shows the single chip, greyed and not focusable, with a tooltip: "One format. Your agent can add more with `rushes_add_format`." and a Copy button for a ready-made agent prompt (the same pattern as locked tabs).
- **A format the previous version had and this one lacks** stays visible, greyed, with the tooltip "Not in v2".
- Switching keeps the playhead time and whether it is playing, and keeps the selected note. The picture swaps in place; the frame box animates to the new shape in 160 ms (no animation under reduced motion).
- Keys: `[` and `]` select the previous and next format (checked against the existing shortcuts before building; if either is taken, use `Alt+←` and `Alt+→`).
- The choice is remembered per film for the session, and the primary shows first on a fresh load.

### The player

The frame takes the shape of the format. The existing layout cap for tall cuts (§19.9, `--body-top`) already handles 9:16; 4:5 and 1:1 use the same rules. The waveform and the shot strip belong to the cut and don't change when switching.

### Notes

- The composer gains a two-way switch above the text box: **This format** (with the ratio chip) | **All formats**. It defaults as in §21.2 (4) and remembers nothing between notes: every new note starts on "This format".
- Each note in the list and each marker on the timeline carries a small ratio tag; all-format notes carry "All". Markers for all-format notes are drawn as a ring, format notes as a dot.
- The note card has the same switch, so a note can be widened to all formats or narrowed to one afterwards. Widening a note that has a drawn box is refused with the reason.
- Notes of other formats are reachable from a quiet "Other formats (3)" row at the bottom of the list; opening it shows them read-only with the format tag and a button that switches to that format.

### Elsewhere

- **Assets › Cuts** lists a cut's formats as sub-rows ("v1 · 9:16"), each with open, reveal and download.
- **Grab frame** saves a screenshot of the format on screen and names it with the ratio.
- **Frames for the shot strip and note thumbnails** come from the primary unless the note's format is another one: `GET /api/videos/:video/versions/:version/frame?format=9x16`.
- **Send to agent** prompt includes the formats and the notes grouped by format.

## 21.6 Edge cases

| Case | Behaviour |
|---|---|
| Format files outside the project folder (for example a sibling `hf/renders/`) | Allowed, as for any registered media file; they play through the same serving rules as other registered files. |
| Format file missing on disk | The chip shows a warning mark; selecting it shows "File not found" in the frame; notes still work. |
| Not video (an image, a PDF) | Refused. |
| Two files with the same ratio | Second refused, see §21.3. |
| A format with no video stream or unreadable | Refused with the ffprobe reason. |
| No ffprobe | Registering a format fails with "needs ffprobe to read the ratio"; the primary behaves as today. |
| Version locked (`lockedVersion`) | Formats can still be added to a locked version (they are the same picture); notes are unaffected. |
| Format removed | `rushes_remove_format` is not in this release; a re-render is a new version. |

## 21.7 Not in this release

- A side-by-side of two formats.
- Per-format proxies.
- Discovery offering a same-length, different-ratio cut found in the project folder as "a format of this cut". The scanner already lists such files as cuts; the offer is a small follow-up.
- Per-format picture lock.

## 21.8 Review focus (what to test and look at)

1. A project from 0.2.x opens unchanged and its notes read as all-format.
2. A single-format cut: the control is greyed, no switch in the composer, notes save with `format: null`.
3. Four formats: switching keeps the time, play state and the selected note; the toggle chips never move.
4. A note written on 9:16 does not show on 16:9; an all-format note shows on both; widening and narrowing work; a boxed note cannot be widened.
5. A new version with fewer formats greys the missing ones.
6. An agent reading notes sees `format` and can filter; replying to a format note leaves other formats' notes alone.
7. Registering the same ratio twice, a non-video, a missing file and a duration mismatch behave as in §21.6 and §21.3.
8. Safari: the segmented control, the composer switch and the layout of a 9:16 picture use explicit grid tracks (`minmax(0,1fr)`).
9. Keyboard: the chips are a radio group (arrow keys, Home/End); `[` and `]` work and don't fire while typing a note.
