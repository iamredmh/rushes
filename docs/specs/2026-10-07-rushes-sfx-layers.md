# Rushes: sound-effects cue layers (§23)

Status: agreed with Red on 7 October 2026 (the mockup's Option 2, "Layers by sound", with an optional source file per cue); not built. This file extends `2026-10-02-rushes-design.md` and is numbered §23, after §21 (formats) and §22 (the Change Log). It is a separate file so it can land in any order with them. The approved mockup is `2026-10-07-rushes-sfx-layers-mockup.html`. Options 1 and 3 in the mockup are not being built.

## 23.1 The problem

An SFX pass is one rendered file with up to about 200 named cues at times (§17.4). Each lane labels its cues on the waveform, and each label only gets the gap to its nearest cue, so in a busy pass most labels are cut to `cli…` or `w`. You can't tell what each cue is, which sounds repeat, or where a given sound comes in.

What Red asked for:
- Hover on any cue label or tick (or focus it from the keyboard) to see the cue's full name, its time and, when known, its source file.
- A twirl-down on each pass that opens **layers by sound**: one layer per distinct cue name, with a tick everywhere that sound comes in.
- An optional source file per cue, which shows on the card and the layer and can be auditioned.

## 23.2 Decisions

1. **The card.** Hovering or focusing a cue's label or tick shows a card with these lines:
   - the full name;
   - the time (mono) and where it falls in the pass, "cue 5 of 80" (counted in time order);
   - the source file in the lane colour, when the agent sent one. Without a file the card has no file line. The mockup's "no source file sent" is for the demo only.
2. **The chevron opens layers by sound.** A chevron in each pass's name cell opens the layers under that row:
   - one layer per distinct cue name, in order of first appearance in time;
   - the full name on the left with a count in mono (`thud ×19`);
   - a tick (a small rounded bar) at every place that sound comes in, so repeats share their layer.
3. **Ticks are controls.** Clicking a tick moves the playhead to it. The playhead runs through the layers, in step with the lane's.
4. **A cue may carry its source file.** Agents may send `file` on each cue when they register the pass. It shows on the card and on the layer. Clicking the file name on a layer plays that sample on its own, through the existing one-player bus, so auditioning stops the tab's playback and Play stops the sample.
5. **Keyboard first-class.**
   - Cue labels and ticks are buttons.
   - ←/→ move between the cues of a lane or a layer.
   - Enter moves the playhead to the focused cue.
   - The card shows on focus, and Esc hides it.
   - The chevron has `aria-expanded` and an accessible name.
6. **Open stays open.** A pass's layers stay open or shut for the session (until a reload), including across a trip to another tab.

## 23.3 Data

The only change is one optional field, so every 0.2.x project loads, and writes back, unchanged.

```ts
// CueSchema gains
file?: string   // a manifest path, as Variant.file; at most 1024 characters; absent on every older cue
```

Rules:
- A cue's `file` is optional. A cue without one is stored exactly as today, with no key and no `null`.
- It must be an audio file: `wav mp3 m4a aac aif aiff flac ogg opus`. Anything else is refused when the pass is registered, with the cue's name in the message. Its existence isn't checked then (as for a variant's own file).
- It is stored as a manifest path: relative inside the project, absolute outside it.
- `/media` serves a cue's file only because it is registered. It joins the registered-media allow-list, and the §15.5 rules apply unchanged:
  - inside the project, it is served;
  - through a symlink or an absolute path outside it, it is served only if the final real file is media.
  A stored cue file that isn't an audio file (a hand edit) is never added to the list.
- Rushes' scan for the project's other files (§20) counts cue files as registered, so samples aren't offered in Assets › Found as passes to bring in.

## 23.4 Agent surface

- **`rushes_add_variant`**: each cue in `cues` takes an optional `file` (at most 1024 characters), the sample placed at that cue. The reply's `variant.cues` carry it back.
- **No new tool.** Tool counts don't change.
- **CLI:** unchanged. `rushes add variant` has never taken cues.
- **AGENTS.md / SKILL.md:**
  - send `cues` as `{name, t, file?}`;
  - give the same sound the same name every time it comes back, because the tab groups cues by name;
  - send `file` when you know which sample you placed.

## 23.5 The dashboard

### The card
- A dark card under the cue (above it when there's no room below), kept 16 px inside the window. It never takes the pointer.
- It shows the full name (semibold), then `0:04.20 · cue 5 of 80` in mono, then the file path in mono in the lane colour when there is one.
- It is the cue's tooltip (`role="tooltip"`, and the focused cue is described by it).
- It closes on pointer leave, blur or Esc, and when its cue goes away (the layers close). It follows its cue if the page or the layers scroll.
- Type is 15 px, and a long name or path wraps inside the card.

### The pass row
- The chevron sits in the name cell, before the swatch and name, and turns as it opens.
- Its accessible name is "Layers for <pass name>". Its tooltip is "Show the layers" or "Hide the layers".
- A pass with no cues shows it disabled, as in the mockup.
- The cue labels on the waveform are buttons. They're drawn in time order and still sized to the gap to their nearest cue. Each cue's tick on the waveform also opens the card on hover.

### The layers
- The layers sit under the pass row on the same grid as the lanes, so their tracks line up exactly with the pass's track:
  - the name and `×N` count in the name column;
  - the ticks on a quiet track in the waveform column;
  - the sample's file name, as a play button, in the control column.
- Each layer has its own playhead line, moved by the same mechanism as the lane's: no per-frame component state.
- After about eight layers, the layers scroll inside their own box.
- Clicking a tick moves the playhead to it and selects the pass, without starting playback.

### Keyboard
- The cue labels of a lane, and the ticks of each layer, are each one stop in the Tab order.
- ←/→ move to the previous or next cue in time. Home and End go to the first and last. Movement never wraps.
- While a cue has focus, those keys don't step frames.
- Enter (or Space, as for any button reached by keyboard, §19.8) moves the playhead to the cue.
- Esc hides the card and leaves focus where it is.

### Mix
- Mix's Sound effects lane uses the same lane component, so it gets the card and the keyboard for its cues.
- It has no chevron (§23.7).

## 23.6 Edge cases

| Case | Behaviour |
|---|---|
| A 0.2.x project | Loads unchanged. Its cues have no file, the cards have no file line, and the layers work from names alone. |
| A `file` that isn't an audio file, or is over 1024 characters | The registration is refused (400) with the cue's name. Nothing is written. |
| A `file` that's missing on disk | The card and the layer still show it. Playing it says "Couldn't play thud_low_03.wav", and nothing is left marked as playing. |
| A `file` through a symlink, or an absolute path outside the project | Served only under §15.5: the final real file must be media. A link to a key file is a 404. |
| A hand-edited `file` naming a non-audio file (`.rushes/notes.json`) | Loads, and is never served. |
| Cues of one name that name different files | The layer shows the first file and "+N". Each tick's card names its own file. |
| "Thud" and "thud" | Two layers. Names are grouped exactly as sent, trimmed. A blank name shows as "Untitled cue". |
| Two cues at the same time | Both ticks are drawn and both are reachable by ←/→. Each card says its own "cue n of N". |
| A cue after the pass's end | Its layer tick sits at the end of the track. The card says its real time. |
| Up to ~200 cues | One button each in the lane, and one per layer tick. Nothing re-renders while playing. |
| 200 distinct names | 200 layers, scrolling after about eight. |
| An older Rushes server sent a `file` | It drops the field silently. The reply's cues show no `file`. |
| A sample already brought in as a pass (§20's current set) | It stays a pass. Naming it as a cue's file doesn't remove it. |

## 23.7 Not in this release

- The mockup's Option 1 (hover only) and Option 3 (layers packed by time).
- Layers on Mix. Its Sound effects lane merges every picked pass, so there's no single pass to open.
- Note markers on the layers. Notes still draw on the pass row.
- ↑/↓ between layers.
- Cue files in Assets (the Sound effects folder lists passes only).
- Cues from the CLI.
- Auditioning from the card itself. The card is a tooltip; the layer's file button plays the sample.

## 23.8 Review focus

1. A cue `file` that points out of the project or at something that isn't a sample (`../`, an absolute path, a symlink to a key file, a hand edit): only a registered audio file is ever served, and §15.5 still holds.
2. A busy pass (~200 cues, many repeats, some at the same moment):
   - the layers open quickly;
   - the ticks don't steal each other's card;
   - ←/→ reach every cue;
   - nothing re-renders per frame while playing.
3. Keyboard on a focused cue: ←/→ never step frames, Esc hides only the card, Enter and Space press the cue, and Tab leaves the group.
4. The card near the window's edges and inside a scrolled layer list: it stays inside the window, follows its cue, and closes when the layers close.
5. Auditioning while the tab plays, a missing sample, and leaving the tab mid-sample: one sound at a time, a clear message, and nothing stuck "playing".
6. Safari: the layers use explicit grid tracks (`minmax(0,1fr)`), and long names truncate rather than push the layout wider.
