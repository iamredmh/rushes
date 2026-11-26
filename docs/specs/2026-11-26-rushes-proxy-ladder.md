# §37 Several proxy qualities, a ladder that steps down, and polish

## 37.1 The problem

Red, 26 Nov 2026, after using 0.16.0 on Cloud Engines Shorts through the relay:

- The progress bar in a Proxies tab row is "massive". It should be a thin line.
- Tooltips near a panel's edge are cut off (Test connection's, in the Proxies tab, on the left).
- "Make proxies now" doesn't read as a button. It should be blue.
- He wants to tick more than one quality (say 1080p Low and 720p Low), make them for the cut he is on with one button, and have the player fall back to the lower one when the higher one struggles.
- Kept as he likes it: the list of cuts with their proxies, and Delete / Delete all.

## 37.2 Decision (Red, 26 Nov 2026)

1. **Checkboxes, not radios**: one or more qualities per project.
2. **More than one proxy per cut**, one per quality.
3. **A ladder**: with Proxies on, the player plays the best ticked quality that is ready, and steps down one rung when it keeps stalling. It never steps back up by itself.
4. **Make proxies for this cut** and **Make proxies for all films (N)**, both filled blue.
5. **One tooltip layer** for the whole app, never clipped.

**Replaces from §36:** the one-preset radio group (36.7 Quality), one proxy per cut and "making one at another preset replaces the old" (36.4), "older quality, remake?" (36.4, 36.7), Make proxies now (36.7, renamed and widened), and "one job per cut" (36.6, now one job per cut and quality). **Kept from §36:** the presets and their encode (36.3), the queue's order and states (36.6), the proxies/ folder and names, the toolbar button's two states, Test connection, the stall hint with Proxies off, Grab Frame from the original.

## 37.3 Qualities and records

In `project.json`:

- `proxyPresets`: the ticked qualities, a non-empty list, kept in ladder order. Default `["1080l"]`. On reading, §36's `proxyPreset: "720l"` becomes `proxyPresets: ["720l"]`, and `proxyPreset` is dropped on the next write.

On each version:

- `proxies`: at most one proxy per quality, keyed by preset id: `{ "1080l": {…}, "720l": {…} }`. Default `{}`. On reading, §36's `proxy` moves under its `preset`, and a §19.5 proxy with no preset under `legacy`. File names are unchanged: `proxies/<film-slug>_<version>_proxy-<preset>.mp4` (and §19.5's `…_proxy.mp4` for `legacy`).

**The ladder** is the ticked qualities in quality order: 1080p High, 1080p Low, 720p High, 720p Low.

**Not in use.** A proxy at a quality that isn't ticked (and every `legacy` one) is kept, says "Not in use", and isn't played. It can be deleted as before. Ticking its quality again puts it back in use, with nothing remade.

## 37.4 Making proxies

- **One job per cut and quality.** Asking again for the same cut and quality joins the job there. Jobs at different qualities of one cut queue side by side, one running at a time, newest cut first (36.6). Within one cut, the better quality goes first.
- `POST /api/videos/:video/versions/:version/proxy` takes `{ preset }` for one quality, or no body for **every ticked quality the cut is missing**. It returns `{ job, jobs }`.
- `POST /api/proxies` (**Make proxies for all films**): every ticked quality each film's latest cut is missing, for films in play.
- `DELETE /api/videos/:video/versions/:version/proxy?preset=720l` deletes one; without `preset`, every proxy of the cut.
- `PUT /api/project/settings` takes `proxyPresets` (and §36's `proxyPreset` as a one-item list, for older clients). An empty list is refused: "Keep at least one quality ticked."
- **Always make proxies** makes every ticked quality for each new cut, and for the latest cut of each film when it is switched on or a quality is ticked.
- `rushes_add_version` and `POST /api/versions` return `proxyJobs` (a list) where §36 returned `proxyJob`.

## 37.5 On the desk

### The Proxies tab

- **Quality**: four checkboxes, same labels and hints. Unticking the last one is refused, and a line under the group says "Keep at least one quality ticked."
- Under it, two buttons, filled blue (`btn primary`) while there is something to make, otherwise disabled (`aria-disabled`) with the reason in the tooltip:
  - **Make proxies for this cut (n)**: every ticked quality the cut on screen is missing (n of them). The cut on screen is the film and version selected in the desk; with none, "Open a cut to make its proxies".
  - **Make proxies for all films (N)**: §36's Make proxies now. N counts proxies, not films.
- **The list**: as in §36 (each film's latest cut plus every cut with a proxy, newest first), now with one line per proxy the cut has (quality, size, "In use" or "Not in use", Delete), one line per job being made (with a 4 px progress line and Cancel), and a small **Make** button for each ticked quality it is missing. **Delete all proxies** as before.

### The player

- **Proxies off**: originals, as in §36.
- **Proxies on**: the best ticked quality that is ready. With none ready, the original and §36's "No proxy for this cut" bar (its Make proxy makes every ticked quality the cut is missing).
- **Stepping down**: when the player stalls repeatedly (two waits of 1 s or more within 30 s, as the §36 hint counts them) and a lower ticked quality is ready, it switches to the next one down, keeping the playhead and play/pause (§36's swap). One rung at a time, at most once every 10 s.
- **Never up by itself.** A step down holds until the cut changes or Red picks **Back to best**. (A proxy that finishes while a cut is open plays if it is the best ready one and the player hasn't stepped down, as in §36.)
- **The quality label**, top left of the picture while Proxies are on: "1080p Low", "720p Low · stepped down", or "Original". It opens a small menu: each ready ticked quality, Original, and Back to best. A pick there holds until the cut changes.
- **The toolbar button** keeps two states. Its tooltip names what's playing: "Proxies on · playing 720p Low (stepped down)".
- With one quality ticked there is nothing to step down to, so the player behaves as in §36.

### Tooltips

Every `data-tip` is drawn by one fixed-position layer at the root of the page (`web/src/tips.ts`), so no panel's overflow clips it. Call sites are unchanged.

- It shows above the element, or below when there's no room above, or where the context asks for below (`.tip-below`, the top bar, tab rows) or beside (the tool strip). It moves sideways to stay at least 8 px inside the window on both sides.
- Shown on hover and on `:focus-visible`, no delay, the same 0.12 s fade, colours and type. Escape hides it. It never takes pointer events.
- The per-context look that used to be written on `::after` (smaller type in the desk, wrapping for `.tip-wrap`, `pre-line` for take names, a maximum width) is now written as custom properties on the element (`--tip-side`, `--tip-size`, `--tip-wrap`, `--tip-max`), which the layer reads.
- It sits above everything on the page (it used to be z-index 30 inside its own panel, under a menu or sheet laid over that panel; now nothing covers it).

### The row progress bar

`.pbar` was written for the bar under the player, where it sits in a row. In a Proxies tab row its parent is a column, so `flex: 1 1 120px` gave it a 120 px-plus height. `.proxrow .pbar` is now a 4 px line across the row.

## 37.6 Choices made

- **`legacy` proxies are never played.** §36 played a §19.5 proxy as "1080p (older)". With a ladder of ticked qualities it has no rung, so it is Not in use. Red's Cloud Engines Shorts proxies were all made at 1080p Low and 720p Low by 0.16.0, so they keep playing.
- **A proxy that finishes mid-review can change the picture** if the player hasn't stepped down and it is now the best ready one. This is §36's behaviour when a proxy arrives; stepping up after a stall never happens by itself.
