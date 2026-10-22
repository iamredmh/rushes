---
name: rushes
description: Plan and review video work with the user in Rushes, a local review desk. Use when the user wants to start a new film or video (plan it with them first, then build), when they want to bring a film they started in the chat into Rushes (rebuild the plan from the conversation), when you've rendered a cut, written a VO script, recorded voice reads, music beds or SFX passes and the user should review them, or when the user says they left notes, pressed Send to agent, or pastes a Rushes batch prompt.
---

# Rushes

Rushes shows your work to the user stage by stage (script, picture, voiceover, music, sound effects, mix). The user leaves timecoded notes that you act on.

If the user pastes a prompt copied from a locked tab, act on it directly — it already names the project, the film and the tool to use.

## Starting a film

When the user wants a new video ("start a new film", "make a launch video", "a new project in Rushes"), plan it with them in Rushes before you build anything. They approve each step, so nothing gets built that they haven't seen.

1. **Create the project** unless one exists: `npx -y rushes new <folder> --no-browser`, then `rushes_open` with `project: "<folder>"`. It makes the folders and a `brief.md` to fill in. Always pass `--no-browser`: without it the command stays running as the server and never returns.
2. **Interview, briefly.** Ask at most three questions, and only ones whose answer changes the film: length and formats, who it is for, tone. Give each a recommended answer with its trade-off ("30 seconds fits a feed; 60 leaves room for the demo"). Never send a list of ten.
3. **Write `brief.md`.** Fill every section and leave `Status: draft`. Tell the user to open Planning › Brief in Rushes, change any row and press **Approve brief**. Rushes then sets `Status: approved` in the file itself. Never approve it yourself or change that line, and if they say it's approved in chat while the file still says `draft`, ask them to press Approve. When they press **Send to agent** on the Brief page, read `brief.md` again and keep their wording: your last version is shown as Current, so read the file before you rewrite it.
4. **Script.** Add it with `rushes_set_script`. The user edits and approves each section in Planning › Script. Read `rushes_get_script` and wait until every section is `approved`.
5. **Storyboard.** Write `storyboard.md` in the project root: a `# Storyboard: <film>` title, then one section per shot, in this shape:

   ```markdown
   ## Shot 02 · Drop a folder
   Tag: ACTION
   Length: 5
   Still: storyboard/shot-02.png
   Status: draft
   Direction:

   A folder of clips lands in the window from the right.
   ```

   `Length` is planned seconds (they become the cut's shot starts), `Still` is a project-relative picture (png, jpg, webp or gif), best saved under `storyboard/`, and `Direction` is the user's line. Make a still for each shot if your tools can; the Storyboard page shows any still the file names, registered or not. The user reads and approves each shot in Planning › Storyboard, and Rushes sets `Status: approved` itself: never set or change a shot's status yourself. When they press **Send to agent** there, read `storyboard.md` again, keep their wording, and update the still if what happens has changed.
6. **Build only when all three are approved** (`rushes_status` reports `build`: `ready`, and what it is `waitingOn`). If the user says "just build it", do. Build in whatever tool suits the film, and name each scene after its planned shot. Then register the cut with `rushes_add_version`: a film's first cut starts with the storyboard's shots by itself (each `start` the running total of the lengths before it), so call `rushes_set_shots` only when the real timings differ (a cut brought in with `rushes_scan` or `rushes_bring_in` does not: send its shots with `rushes_set_shots`). A film with no script has nothing to wait on there: the script is only waited on when the film has one. While the plan isn't all approved the reply carries `planWarning`: a nudge, not a refusal.

The brief and the storyboard are Markdown files the user reads and approves on their own pages under Planning.

## Picking up a film that's underway

When the user asks to open or review a film they started in the chat, or the project already has files but no `brief.md`, don't make them start again. Rebuild the plan from what you have, then say what you did.

1. **Open the project**, or create it where the work is: `npx -y rushes new <folder> --no-browser` (it never overwrites a `brief.md` and leaves every other file alone), then `rushes_open`.
2. **Write `brief.md` from the conversation.** Fill each section from what the user actually said. Mark anything you had to infer with `(inferred)` so they can check it. Where the chat never touched a section, write `Not discussed yet.` rather than inventing something. Put ideas they floated but didn't settle, and anything you couldn't answer, under Open questions. Keep `Status: draft`, and never approve it yourself.
3. **Register what you already made.** A script from the chat goes in with `rushes_set_script` (the user approves it in Planning › Script). Copy storyboard stills into a `storyboard/` folder in the project: copy them, never move them, so the originals stay where the user's other tools expect them. Write the shots into `storyboard.md` in the shot format above, each with `Status: draft` and a `Still:` line naming its copy (the Storyboard page shows any still the file names). Register other reference images with `rushes_add_file` (`kind: "image"`). Renders, voice reads and music beds go in as usual (`rushes_add_version`, `rushes_add_variant`). Run `rushes_scan` for audio and cuts in the folder; it doesn't look for images, so naming the stills in `storyboard.md` (or registering other images) is yours to do: you know where you saved them.
4. **Say what you filled in:** what came from the user's words, what you inferred, what you registered, and what you looked for and couldn't find ("I found four of the six stills"). Ask them to read `brief.md` under Assets › Scripts & docs.
5. **If the chat is one you can't see** (another session, another tool), say so and ask the user to paste it or point you to it. Don't reconstruct a brief from memory of a conversation you didn't have.

When a user starts briefing in the chat, offer to keep `brief.md` up to date as you go: run `rushes new` first, so the next session, or another tool, can pick it up.

## Visuals

For stills, standalone images and carousels, register one visual per post with `rushes_add_visual`: a `name` and `pages`, each page with its pictures, one per aspect ratio, in every aspect ratio the post comes in (Rushes reads each ratio from the picture). The user marks a region, a point or the whole image in the Visuals tab and sends a batch; each note names its visual, version, page, ratio, where on the picture it is (`words`) and the `file` to open. A note with no ratio is for every ratio. Fix the pictures, register a new version with `rushes_add_visual` (`visual` and only the pages that changed, each with `n`), then `rushes_reply` to each note you fixed with `status: "done"` and `fixVersion` set to it (a note you did not fix stays `todo`, with the reason in `reply`). The full contract is in `AGENTS.md`.

## Shelved films

`rushes_status` returns `films`, each with `shelved` (the time the user shelved it, or null). A shelved film is one the user has set aside: leave it alone, make no new cuts of it and fix none of its notes unless they ask. A new cut of a shelved film brings it back (`restored: true` in the reply), so make one only when they want that film worked on again. You never shelve or restore a film.

## Reviewing and fixing

1. Register what you made:
   - `rushes_add_version` for a render. Give every cut a short `label` (48 characters at most) saying what changed, and put the detail in `note`. If the cut is likely to play badly in a browser, the reply carries `proxySuggested: true` and `proxyReason`; Picture offers the user a proxy. Prefer H.264 MP4 to avoid this;
   - `rushes_add_format` for each other shape of a cut (a 9:16, 1:1 or 4:5 of the same edit): register every shape you rendered, main one first, or pass `formats: [{ file }]` to `rushes_add_version`. Its `label` is only a ratio hint such as 2.39:1, never the cut's short label;
   - `rushes_set_script` for the VO script. It merges by `id`, so send only the sections you changed; sections you leave out are kept. `rushes_get_script` reads the whole script;
   - `rushes_add_variant` for each voice read, music bed or SFX pass, with `video` set to the film it is for, or a list of films when one bed is fitted to several (only those films' tabs list it; with more than one film, one without `video` is on no film until it is put on one, and `rushes_set_films` moves an existing one). Voice reads carry `stage: "voice"` and a `round` (its name — reads in one round are compared side by side; a new direction gets a new round); say what the read is, or what changed, in `description`. Music and SFX carry `meta.description` for their lane card, and SFX passes carry `cues` as `{name, t, file?}`: the same name each time a sound comes back, and `file` (an audio file) when you know which sample you placed;
   - `rushes_set_shots` for the storyboard's shots, once you have the first cut; send new timings when a later cut moves them.
2. Call `rushes_open` and tell the user it's ready, with what it brought in and what it left (below). Each project's dashboard lives at its own address, `/p/<id>/`.
3. When the user sends a batch, call `rushes_get_batch` and fix every note in it. A batch holds every open note from every tab and film, so each note's own `stage` and `video` say where it belongs. A note carries the `shot` it falls in; on an audio stage, call `rushes_get_picks` first — on Mix it also returns `levels` (dB per lane), which you read, not set. Its `on` says what it's about: `"<lane>/<variant>"` for a bed, pass or voice read (on Voiceover the lane names the round), `"<lane>/<variant>:<cue>"` for an SFX cue, `"vo"` for the Mix VO lane, or `null` for the whole mix; older notes may carry a section id or `"<section>:<take>"`. On Music, Sound effects and Mix treat `marks` (e.g. "Fall", "Quieter 3 dB") as part of the note; Voiceover notes carry none — they're Whole (`Speaker`, `Pacing`, `Tone`, `Overall`) or Point (`Fix this`, `Keep this`) instead. A Picture note's `format` is null for every format, or a format id such as `"9x16"`: when it isn't null, fix only that format. Picks are set from the dashboard only — no tool or CLI command sets one.
4. Register the new cut with `rushes_add_version`. On a locked video the reply carries a `warning`.
5. Reply to all the notes in one `rushes_reply` call. For each note set `status: "done"`, a one-line `reply`, `fixT` (when the fix is visible in the new cut, in seconds) and `fixVersion`.
6. For script batches: when a section's `proposed` differs from `current`, adopt it with `rushes_set_script`, sending just that section with its `id`. If voiceover already exists, re-record the picked voice with the corrected script and register it with `rushes_add_variant` as a new read in a new round.
7. Lock picture with `rushes_lock_picture` only when the user says picture is locked; `version: null` unlocks it.

At the start of a session, call `rushes_get_log` to catch up (newest first; `limit`, `area`, `since`). When you change direction or make a decision, add one line per decision with `rushes_log`, not a running commentary, and never copy a note's or reply's text into it; Rushes logs cuts, formats, reads, beds, passes, takes, the script, picks, picture lock and unlock, notes sent, replies, files added and bring-ins itself. CLI: `rushes log`, `rushes log add`.

Save renders, voice reads, beds and passes under the project's `renders/`, `audio/voiceover/`, `audio/music/` and `audio/sfx/` folders. Screenshots the user grabs with G or the camera button land in `screenshots/`. Use `rushes_list_assets` (optional `kind`) to find a file the user refers to but hasn't given you a path for, such as "use the screenshot I just took".

The **Assets** tab is a library: Screenshots, Cuts, Voiceover, Music, Sound effects, Scripts & docs, Images, Captions, Exports, Delivery, Edit files and Proxies. Top-level `.md`, `.txt`, `.pdf`, `.srt` and `.vtt` files, and anything in `exports/`, are found automatically. Register everything else with `rushes_add_file` (`kind`, `file`, optional `name`, `note`, `video`): deliverables and platform exports as `delivery`, NLE project files as `edit`, storyboards/references/logos as `image`, briefs as `doc`. When the user wants to share notes, call `rushes_export_notes` — it writes a dated Markdown file to `exports/` and returns the path.

When asked to open or review work in Rushes, call `rushes_open`, then tell the user what it brought in and what it left. Rushes looks through the project folder itself and brings in the current set of files that go with the newest cut (at most one voice read, one music bed and one sound effects pass, unpicked), leaving the rest in Assets › Found. `rushes_open` returns `broughtIn` (with each file's `origin`), `alreadyIn`, `failed` and `found` (counts by kind, called `counts` by `rushes_scan`), and waits about 20 seconds, answering `scanning: true` if the folder is big. Pass `include` for files you made for this cut — `include: [{ path, kind?, round? }]` — and they come in whatever they score, and win over the scoring, for that cut, on later scans too. `rushes_open` also takes `film`. `rushes_scan` (CLI `rushes scan`) looks again, also brings in the current set, and lists the candidates left, with reasons; `rushes_bring_in` (CLI `rushes bring-in <file>...`) brings chosen files in (up to 12 files of each kind per call) and refuses any path outside the project folder. Nothing is ever picked. The user reviews the rest in Assets › Found (**Bring in**, **Not these**, **Look again**); a locked Voiceover, Music or Sound effects tab shows "14 music files found in this project" with a **Review** button when files of its kind were found.

No project to show yet? Run `npx -y rushes demo <folder> --no-browser`, then `rushes_open` with `project: "<folder>"`. The demo builds a complete working example on the user's machine, with a cut, script, voice reads, music and notes already in place. Always pass `--no-browser`: without it the command stays running as the server and never returns.

Rushes has twenty-four tools: `rushes_open`, `rushes_status`, `rushes_add_version`, `rushes_add_format`, `rushes_add_visual`, `rushes_add_variant`, `rushes_set_films`, `rushes_set_script`, `rushes_get_script`, `rushes_add_take`, `rushes_list_notes`, `rushes_list_assets`, `rushes_get_batch`, `rushes_reply`, `rushes_get_picks`, `rushes_set_shots`, `rushes_lock_picture`, `rushes_add_file`, `rushes_export_notes`, `rushes_log`, `rushes_get_log`, `rushes_scan`, `rushes_bring_in` and `rushes_doctor` (environment and project health check) — `rushes_add_take` stays only for compatibility and isn't used for voiceover. The full contract is in `AGENTS.md` at the package root.
