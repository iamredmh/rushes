---
name: rushes
description: Plan and review video work with the user in Rushes, a local review desk. Use when the user wants to start a new film or video (plan it with them first, then build), when you've rendered a cut, written a VO script, recorded voice reads, music beds or SFX passes and the user should review them, or when the user says they left notes, pressed Send to agent, or pastes a Rushes batch prompt.
---

# Rushes

Rushes shows your work to the user stage by stage (script, picture, voiceover, music, sound effects, mix). The user leaves timecoded notes that you act on.

If the user pastes a prompt copied from a locked tab, act on it directly — it already names the project, the film and the tool to use.

## Starting a film

When the user wants a new video ("start a new film", "make a launch video", "a new project in Rushes"), plan it with them in Rushes before you build anything. They approve each step, so nothing gets built that they haven't seen.

1. **Create the project** unless one exists: `npx -y rushes new <folder> --no-browser`, then `rushes_open` with `project: "<folder>"`. It makes the folders and a `brief.md` to fill in. Always pass `--no-browser`: without it the command stays running as the server and never returns.
2. **Interview, briefly.** Ask at most three questions, and only ones whose answer changes the film: length and formats, who it is for, tone. Give each a recommended answer with its trade-off ("30 seconds fits a feed; 60 leaves room for the demo"). Never send a list of ten.
3. **Write `brief.md`.** Fill every section and leave `Status: draft`. Tell the user to read it in Assets › Scripts & docs. When they say in chat that it's approved, change the line to `Status: approved`. Never approve it yourself.
4. **Script.** Add it with `rushes_set_script`. The user edits and approves each section in the Script tab. Read `rushes_get_script` and wait until every section is `approved`.
5. **Storyboard.** Write `storyboard.md` in the project root: `Status: draft`, then a table with one row per shot (number, name, tag, length in seconds, what happens). Make a still for each shot if your tools can, save them in `storyboard/`, and register each with `rushes_add_file` (`kind: "image"`). The user approves in chat; then set `Status: approved`. Never approve it yourself.
6. **Build only when all three are approved.** If the user says "just build it", do. Build in whatever tool suits the film, and name each scene after its planned shot. Then register the cut with `rushes_add_version` and the planned shots with `rushes_set_shots` (each `start` is the running total of the lengths before it), so Picture notes carry their shot.

The brief and the storyboard are plain Markdown files in the project folder. The user reads them under Assets and approves them in chat.

## Reviewing and fixing

1. Register what you made:
   - `rushes_add_version` for a render. Give every cut a short `label` (48 characters at most) saying what changed, and put the detail in `note`. If the cut is likely to play badly in a browser, the reply carries `proxySuggested: true` and `proxyReason`; Picture offers the user a proxy. Prefer H.264 MP4 to avoid this;
   - `rushes_add_format` for each other shape of a cut (a 9:16, 1:1 or 4:5 of the same edit): register every shape you rendered, main one first, or pass `formats: [{ file }]` to `rushes_add_version`. Its `label` is only a ratio hint such as 2.39:1, never the cut's short label;
   - `rushes_set_script` for the VO script. It merges by `id`, so send only the sections you changed; sections you leave out are kept. `rushes_get_script` reads the whole script;
   - `rushes_add_variant` for each voice read, music bed or SFX pass. Voice reads carry `stage: "voice"` and a `round` (its name — reads in one round are compared side by side; a new direction gets a new round); say what the read is, or what changed, in `description`. Music and SFX carry `meta.description` for their lane card, and SFX passes carry `cues` as `{name, t, file?}`: the same name each time a sound comes back, and `file` (an audio file) when you know which sample you placed;
   - `rushes_set_shots` for the storyboard's shots, once you have the first cut; send new timings when a later cut moves them.
2. Call `rushes_open` and tell the user it's ready, with what it brought in and what it left (below). Each project's dashboard lives at its own address, `/p/<id>/`.
3. When the user sends a batch, call `rushes_get_batch` and fix every note in it. A note carries the `shot` it falls in; on an audio stage, call `rushes_get_picks` first — on Mix it also returns `levels` (dB per lane), which you read, not set. Its `on` says what it's about: `"<lane>/<variant>"` for a bed, pass or voice read (on Voiceover the lane names the round), `"<lane>/<variant>:<cue>"` for an SFX cue, `"vo"` for the Mix VO lane, or `null` for the whole mix; older notes may carry a section id or `"<section>:<take>"`. On Music, Sound effects and Mix treat `marks` (e.g. "Fall", "Quieter 3 dB") as part of the note; Voiceover notes carry none — they're Whole (`Speaker`, `Pacing`, `Tone`, `Overall`) or Point (`Fix this`, `Keep this`) instead. A Picture note's `format` is null for every format, or a format id such as `"9x16"`: when it isn't null, fix only that format. Picks are set from the dashboard only — no tool or CLI command sets one.
4. Register the new cut with `rushes_add_version`. On a locked video the reply carries a `warning`.
5. Reply to all the notes in one `rushes_reply` call. For each note set `status: "done"`, a one-line `reply`, `fixT` (when the fix is visible in the new cut, in seconds) and `fixVersion`.
6. For script batches: when a section's `proposed` differs from `current`, adopt it with `rushes_set_script`, sending just that section with its `id`. If voiceover already exists, re-record the picked voice with the corrected script and register it with `rushes_add_variant` as a new read in a new round.
7. Lock picture with `rushes_lock_picture` only when the user says picture is locked; `version: null` unlocks it.

At the start of a session, call `rushes_get_log` to catch up (newest first; `limit`, `area`, `since`). When you change direction or make a decision, add one line per decision with `rushes_log`, not a running commentary, and never copy a note's or reply's text into it; Rushes logs cuts, formats, reads, beds, passes, takes, the script, picks, picture lock and unlock, notes sent, replies, files added and bring-ins itself. CLI: `rushes log`, `rushes log add`.

Save renders, voice reads, beds and passes under the project's `renders/`, `audio/voiceover/`, `audio/music/` and `audio/sfx/` folders. Screenshots the user grabs with G or the camera button land in `screenshots/`. Use `rushes_list_assets` (optional `kind`) to find a file the user refers to but hasn't given you a path for, such as "use the screenshot I just took".

The **Assets** tab is a library: Screenshots, Cuts, Voiceover, Music, Sound effects, Scripts & docs, Images, Captions, Exports, Delivery, Edit files and Proxies. Top-level `.md`, `.txt`, `.pdf`, `.srt` and `.vtt` files, and anything in `exports/`, are found automatically. Register everything else with `rushes_add_file` (`kind`, `file`, optional `name`, `note`, `video`): deliverables and platform exports as `delivery`, NLE project files as `edit`, storyboards/references/logos as `image`, briefs as `doc`. When the user wants to share notes, call `rushes_export_notes` — it writes a dated Markdown file to `exports/` and returns the path.

When asked to open or review work in Rushes, call `rushes_open`, then tell the user what it brought in and what it left. Rushes looks through the project folder itself and brings in the current set of files that go with the newest cut (at most one voice read, one music bed and one sound effects pass, unpicked), leaving the rest in Assets › Found. `rushes_open` returns `broughtIn` (with each file's `origin`), `alreadyIn`, `failed` and `found` (counts by kind, called `counts` by `rushes_scan`), and waits about 20 seconds, answering `scanning: true` if the folder is big. Pass `include` for files you made for this cut — `include: [{ path, kind?, round? }]` — and they come in whatever they score, and win over the scoring, for that cut, on later scans too. `rushes_open` also takes `film`. `rushes_scan` (CLI `rushes scan`) looks again, also brings in the current set, and lists the candidates left, with reasons; `rushes_bring_in` (CLI `rushes bring-in <file>...`) brings chosen files in (up to 12 files of each kind per call) and refuses any path outside the project folder. Nothing is ever picked. The user reviews the rest in Assets › Found (**Bring in**, **Not these**, **Look again**); a locked Voiceover, Music or Sound effects tab shows "14 music files found in this project" with a **Review** button when files of its kind were found.

No project to show yet? Run `npx -y rushes demo <folder> --no-browser`, then `rushes_open` with `project: "<folder>"`. The demo builds a complete working example on the user's machine, with a cut, script, voice reads, music and notes already in place. Always pass `--no-browser`: without it the command stays running as the server and never returns.

Rushes has twenty-two tools: `rushes_open`, `rushes_status`, `rushes_add_version`, `rushes_add_format`, `rushes_add_variant`, `rushes_set_script`, `rushes_get_script`, `rushes_add_take`, `rushes_list_notes`, `rushes_list_assets`, `rushes_get_batch`, `rushes_reply`, `rushes_get_picks`, `rushes_set_shots`, `rushes_lock_picture`, `rushes_add_file`, `rushes_export_notes`, `rushes_log`, `rushes_get_log`, `rushes_scan`, `rushes_bring_in` and `rushes_doctor` (environment and project health check) — `rushes_add_take` stays only for compatibility and isn't used for voiceover. The full contract is in `AGENTS.md` at the package root.
