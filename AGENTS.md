# Rushes, for agents

Rushes is a local review desk. Your user watches the work in a browser, leaves timecoded notes, edits the script and picks audio variants. You read that feedback, act on it, and reply. Everything is saved in the project's `.rushes/` folder, and one local server is the only thing that writes to it.

## Setup (once per machine)

```bash
npx -y rushes setup
```

This registers the Rushes MCP server with every supported harness it finds (Claude Code, Codex, Cursor, Claude Desktop, Gemini CLI), and installs the skill where the harness supports skills. If it added anything, ask the user to restart the app. Use `--dry-run` to preview, and `--only claude-code,codex` to limit it. A harness already registered through the older `github:iamredmh/rushes` launch is recognised as Rushes too; setup switches it to the npm launch in place, never adding a duplicate.

If setup doesn't seem to have worked, or the user asks you to check your own environment, call `rushes_doctor` (or `rushes doctor [--json]` from the CLI). It reports the Node version, whether ffmpeg/ffprobe are on PATH, which agent harnesses have Rushes registered, and — run from inside a project — whether its files are valid, whether a server is already running for it, and free disk space. Read-only: it never starts a server or changes anything.

## Project folders

Rushes recommends this layout; save your output there rather than wherever's convenient:

```
my-film/
  renders/              cuts               hero-60s_v3.mp4
  audio/
    voiceover/          voice reads        gerald.wav
    music/              music beds         deep-house.wav
    sfx/                SFX passes         sfx_pass-a.wav
  screenshots/          frame grabs        hero-60s_v3_00m12.10s_f726.png
  exports/              exported notes, plus anything you save there
  .rushes/              Rushes' own records (hidden; not for editing by hand)
```

Save renders to `renders/`, voice reads to `audio/voiceover/`, music beds to `audio/music/` and SFX passes to `audio/sfx/`. Screenshots live in `screenshots/` — the user's G key and camera button grab there; Rushes creates the folder itself on the first grab. `rushes_list_assets` (optional `kind`) returns every registered asset plus every screenshot. Call it when the user refers to something they haven't given you a path for — "use the screenshot I just took" — instead of guessing the file name.

## The Assets library

The **Assets** tab is a library of every project file, organised into folders: Screenshots, Cuts, Voiceover, Music, Sound effects, Scripts & docs, Images, Captions, Exports, Delivery, Edit files and, once a cut has one, Proxies. Proxies are listed and deleted from there; you never register or remove one yourself — see proxies, below.

Some of it needs no registering. A `*.md`, `*.txt`, `*.pdf`, `*.srt` or `*.vtt` file directly in the project root, and anything saved directly into `exports/`, are found automatically.

Everything else, register with `rushes_add_file` (`kind`, `file`, optional `name`, `note` and `video`):

- **deliverables** — final masters and platform exports — as `delivery`;
- **NLE project files** — `.prproj`, `.drp` — as `edit`;
- **storyboards, references and logos** as `image`;
- **briefs** as `doc`.

The CLI equivalent is `rushes add file <path> --kind K [--name N] [--note T] [--video V]`.

When the user wants to share notes with someone else, call `rushes_export_notes` (CLI: `rushes export notes`). It writes every note, grouped by stage and, for Picture, by film and version, to a dated Markdown file in `exports/`, writes the Change Log beside it as `exports/change-log-<date>.md`, and returns both paths.

## A demo project

No project to show yet? Run `npx -y rushes demo <folder> --no-browser`, then `rushes_open` with `project: "<folder>"`. The demo makes a complete example on the user's machine — a cut in two versions, a script, voice reads in two rounds, two music beds, an SFX pass and example notes — all generated locally with ffmpeg. Always pass `--no-browser`: without it the command stays running as the server and never returns. It refuses a folder that isn't empty.

## Locked tabs and the prompts they copy

Every tab is visible from the start, in workflow order, even before it has anything in it. Opening a locked tab explains what it's for and what unlocks it, and offers a **Copy prompt for your agent** button. When Rushes has found files for a locked Voiceover, Music or Sound effects tab in the project folder, the page adds a line under the prompt, such as "14 music files found in this project", with a **Review** button that opens Assets › Found filtered to that kind. So a user may open a locked tab, see files you haven't brought in, and ask you about them: call `rushes_scan` to list them, and `rushes_bring_in` for the ones that belong. If the user pastes you one of these, it's a direct, already-scoped request — act on it the same as any other instruction, e.g.:

> In Rushes project "Launch", make two or three music beds for "Hero" and add each with rushes_add_variant (stage "music") with a one-line description.

## The loop

1. **Register what you made.**
   - A render: `rushes_add_version` with `video` and `file`. Run it again for each new cut. Give every cut a short `label` (48 characters at most) that says what changed, e.g. `"launch 1.45x slower"`, and put the detail in `note`: the version list shows the label, and a longer one is refused. When the cut is likely to play badly in a browser (4K or larger, over 1.5 GB, or a codec such as ProRes), the reply carries `proxySuggested: true` and `proxyReason`; Picture then offers the user a proxy. Prefer H.264 MP4 to begin with and this won't come up.
   - Other shapes of the same cut (a 9:16, 1:1 or 4:5 of the 16:9: same edit, same length): register every shape you rendered, main one first. `rushes_add_version` with `file` (the main one) and `formats: [{ file }, …]` registers them all in one call; `rushes_add_format` (`file`, optional `video`, `version` and `label`) adds one to a cut already registered. Rushes measures each ratio with ffprobe; here `label` is only a ratio hint for an unusual shape such as 2.39:1 (not the cut's short label, which belongs to `rushes_add_version`). A second render with a ratio the cut already has is refused: a re-render is a new version. A shape more than 0.1 s off the cut's length is still registered, with a warning: `rushes_add_format` returns it as `warning`, and `rushes_add_version` returns a list as `formatWarnings` (there, `warning` means "Picture is locked").
   - A VO script: `rushes_set_script` with sections `{start, end, current}` in seconds. It merges by `id`: send only the sections you changed, with their ids, plus any new ones without an id. Sections you leave out are kept, with their takes. Pass `replace: true` only when you mean to replace the whole script. `rushes_get_script` reads the whole script back.
   - A voice read: `rushes_add_variant` with `stage: "voice"` and `round` (the round's name, e.g. "Round 2 · Gerald, tone" — reads in one round are compared side by side; a new direction gets a new round, a small fix to a marked word can stay in the current one). Say in `description` what the read is, or what changed from the one it's based on. `rushes_add_take` stays in the file format and API for compatibility only; voiceover work doesn't use it.
   - Music beds or SFX passes: `rushes_add_variant` with `stage` `music` or `sfx`. Give it `meta: {description: "..."}`, shown on its lane card in place of `bpm`/`key`; SFX passes also take `cues` (`{name, t, file?}`: `t` in seconds, and `file` the sample you placed there, an audio file, optional), labelled on the waveform. Give a sound the same name every time it comes back (`thud`, not `thud 2`): the Sound effects tab groups cues by name into layers, one per sound, and shows a cue's `file` on its card, where the user can play that sample on its own.
   - The storyboard's shots, once you have the first cut: `rushes_set_shots` with `video`, optional `version` (defaults to the newest) and `shots` as `{start, name, tag?}`. Send new timings whenever a later cut moves them.
2. **Open it for the user:** `rushes_open`. It also looks through the project folder and brings in the files that go with the cut (next section). Each project's dashboard lives at its own address, `/p/<id>/` — safe to run more than one project at once. A tab unlocks as soon as it has something in it.
3. **Wait for feedback.** The user presses **Send to agent**, which saves a batch and gives them a prompt to paste to you. Call `rushes_get_batch` to read the latest batch, its notes and any changed script sections.
4. **Fix each note.** A note has `stage`, `scope` (`point`, `range` or `whole` — Voiceover only ever uses `point` or `whole`; it has no Range scope), `t`, `tOut`, `on` (the lane, variant, take, cue or section it's about), `text`, and optionally `box` (normalised 0 to 1), `grab` (a PNG path in `screenshots/`; older notes may point to `.rushes/grabs/`), `shot` (the shot it falls in, `{n, name}`, worked out by the server from the version's shots — not yours to set) and, on Picture, `format` (`null` when the note is for every format, or a format id such as `"9x16"` when it's for that shape only). When a note's `format` is not null, fix only that format and leave the others alone; an all-format note is for every shape, so fix each and say in `reply` which formats you fixed. `rushes_list_notes` takes `format` (an id such as `9x16`, or its label `9:16`: that format's Picture notes plus the all-format ones) and `onlyThisFormat: true` (only that format's). On an audio stage, `on` is `"<laneId>/<variantId>"` for a music bed, SFX pass or voice read (the lane and variant ids `rushes_add_variant` returns) — on Voiceover the lane id is the round's slugged name, so `on` names the round and the read together — or `"<laneId>/<variantId>:<cueId>"` for an SFX cue. On Mix it's `null` for the whole mix, `"vo"` for the VO lane (the newest round with a pick), or `"<laneId>/<variantId>"` for the music or SFX lane. Older notes may carry a bare variant id, `"vo"` on Voiceover itself, a section id, `"<sectionId>:<takeId>"` for a take, `"<variantId>:<cueId>"` or a bare cue id; Rushes still lists these with a sensible label, but none of them name a read any more. On Music, Sound effects and Mix, a note can also carry `marks` — short feedback like `Fall` (bring the level down over the range) or `Quieter 3 dB` (3 dB lower over the range). `rushes_list_notes`, `rushes_get_batch` and exported notes all show them. Marks are the user's, like a note's text and times — you read and act on them, you don't set them. Voiceover notes carry no marks: a note there is **Whole** (`Speaker`, `Pacing`, `Tone` or `Overall` — about the read as a whole) or **Point** (`Fix this` or `Keep this`, marked at the playhead).
5. **Register the new cut** with `rushes_add_version`, with a short `label` and the detail in `note`. If the video is locked, the reply carries `warning: "Picture is locked at vN"`; the version is still added.
6. **Reply to every note** in one `rushes_reply` call. For each, set `status: "done"`, a one-line `reply`, `fixT` (when the fix is visible in the new cut, in seconds) and `fixVersion`. If you didn't fix a note, leave it `todo` and say why in `reply`.
7. **Audio batches.** On Voiceover, Music, Sound effects or Mix, call `rushes_get_picks` first, so you know which read or variant is in use before you fix anything. On Mix, it also returns `levels: { voice?, music?, sfx? }` in dB — where the user wants each lane to sit. Don't try to change these; they're set from the dashboard's sliders and only tell you the balance the user has already chosen. Then fix each note:
   - **Voiceover:** register a new whole read with `rushes_add_variant` (`stage: "voice"`) — a new round for a new direction (another voice, a different tone), or the current round for a small fix to a marked word. Say in `description` what changed.
   - **Music or Sound effects:** make the new bed or pass the text and marks ask for, and register it as in step 1.

   Then reply as in step 6. Mix plays the newest round's picked voice read; takes are never mixed.
8. **Script batches.** When a section's `proposed` differs from `current`, the user rewrote the line. Adopt it by calling `rushes_set_script` with just that section's `id`, `start`, `end` and the new `current`; the other sections stay as they are. The proposal then clears itself, and the section goes back to draft, as any section does when you change its line: a flag has been acted on, and the user approved the old words, not the new ones, so they approve again. If voiceover already exists, re-record the picked voice with the corrected script and register it with `rushes_add_variant` as a new read in a new round.

## Opening a project, and the files that go with the cut

When asked to open or review work in Rushes, call `rushes_open`, then tell the user what it brought in and what it left. Rushes looks through the project folder itself, and only inside it: it never follows a link out and never reads a file's contents. It brings in the current set of files that go with the newest cut, unpicked, so Voiceover, Music and Sound effects have something to review, and leaves everything else one step away in Assets › Found. At most one file per kind comes in, and only when it clearly matches the cut by length, time and name. Nothing is ever picked; the user chooses in the dashboard.

`rushes_open` returns `broughtIn` (every file Rushes has brought in since it started, so it can include files from earlier calls and ones the user brought in by hand; each has its kind, lane, reasons and `origin`: `auto` for the scoring, `include` for yours, `hand` for the user's), `alreadyIn` (your `include` files that were already registered), `failed` (files that couldn't come in, with the reason) and `found` (counts of what it left, by kind; `rushes_scan` calls the same counts `counts`). It waits about 20 seconds for the folder to be looked through. On a big folder it answers with `scanning: true` and carries on in the background; call `rushes_scan` or `rushes_open` again later for the rest. Say it plainly, for example: "I brought in `vo_jules/read.wav` as a voice read and `bed/theme.wav` as music. 14 more files are in Assets › Found."

Pass `include` for files you made for this cut: `include: [{ path, kind?, round? }]`. They come in whatever they score, and they win over the scoring: a kind you include (voice, music or sfx) isn't also guessed for that cut, on any later scan or restart (Rushes keeps this in `.rushes/found.json`). A newer cut is a fresh decision, and nothing already registered is ever removed. One narrow case: if Rushes had just started and had already brought in its own pick before your call arrived, both are in, unpicked. Give `kind` (`voice`, `music`, `sfx`, `cut` or `doc`) when the name doesn't say, and `round` for a voice read. `rushes_open` also takes `film`, to match the files to a film other than the newest cut's. If the scoring picked the wrong file, bring the right one in with `include` (or `rushes_bring_in`) and say which.

`rushes_scan` (CLI `rushes scan [--film NAME] [--json]`) looks again, brings in the current set as opening does, and returns the candidates that are left, best score first, up to 200 (default 100), each with its reasons. `rushes_bring_in` (CLI `rushes bring-in <file>... [--kind K] [--round NAME] [--film NAME]`, which exits 1 if any file can't come in) brings chosen files in: voice, music and sfx as variants, video as cuts, `md`, `txt` and `pdf` as docs. It refuses any path outside the project folder, reports each file it can't bring in with the reason, and takes up to 60 files at a time and up to 12 files of each kind per call (the dashboard's **Bring in** has the same cap per click, so the tabs stay quick). Each refusal is `{ path, reason, code }`: match on `code` (`outside`, `gone`, `already`, `cap`, `link`, `folder`, `hiddenFile`, `skippedFolder`, `chooseKind`, `notAudio`, `notVideo`, `notDoc`, `unknownType`, or `other`), never on the words.

The user sees the rest in **Assets › Found**, the first folder in Assets: files grouped by folder with their reasons, a play button to audition each one, **Bring in N** (the ticked files, up to 12 of each kind per click), **Not these** (hides them for good, with a **Hidden** list and **Restore**), **Look again** (the same scan as `rushes_scan`) and a header chip, "3 brought in · 118 more found", while something is new. Files in Found are never an agent's to pick for the user; whatever comes in, by you or by Rushes, is unpicked.

## The Change Log

Rushes keeps a log of what happened in the project, written as it happens (`.rushes/log.json`, oldest first on disk; every view of it is newest first): cuts, formats (another shape of a cut, e.g. "9:16 added to v2"), voice reads, music beds, sound-effects passes, takes, the script, picks, picture lock and unlock, notes sent, your replies, files added and bring-ins. A burst of registrations is one line. The user opens it from the **Change Log** button.

- **At the start of a session, call `rushes_get_log`** to catch up on what changed since you last worked on the project. It takes `limit` (default 30, at most 200), `area` and `since` (a date and time). It returns `entries` newest first, `earlier` (how many it left out), `undated` (audio from before the log) and `dropped` (lines removed past 5000).
- **When you change direction or make a decision**, add one line with `rushes_log` (`text`, optional `area`, `video`, `version`, `ref`), e.g. "Slowed the zooms: the first cut felt rushed". One line per decision, not a running commentary, 160 characters at most. The log is exported and shared, so never copy a note's or reply's text into it. Don't log what Rushes logs itself.
- **Give every cut a short `label`** (step 1 of the loop).
- CLI: `rushes log [--limit N] [--area A] [--md]` and `rushes log add "text" [--area A]`. Flags go before the text; text that starts with a dash goes after `--`: `rushes log add --area mix -- "-3 dB on the bed"`. `rushes_export_notes` also writes `exports/change-log-<date>.md`.
- Send to agent's prompt ends with the last five lines, under "Recent changes".

## Tools

The MCP server has twenty-two tools: `rushes_open`, `rushes_status`, `rushes_add_version`, `rushes_add_format`, `rushes_add_variant`, `rushes_set_script`, `rushes_get_script`, `rushes_add_take`, `rushes_list_notes`, `rushes_list_assets`, `rushes_get_batch`, `rushes_reply`, `rushes_get_picks`, `rushes_set_shots`, `rushes_lock_picture`, `rushes_add_file`, `rushes_export_notes`, `rushes_log`, `rushes_get_log`, `rushes_scan`, `rushes_bring_in` and `rushes_doctor`. Each takes an optional `project` folder, which defaults to the folder the harness started in.

## Rules

- Never edit `.rushes/*.json` by hand while the server is running. Use the tools, or the CLI (`rushes add`, `rushes notes`, `rushes reply`).
- Picks — which variant is in use per lane — are set from the dashboard only (**Use** / **Unpick**). No tool or CLI command sets one; read them with `rushes_get_picks`. Section take picks remain in the file format for compatibility only; nothing sets them any more.
- A project whose voiceover exists only as takes from before rounds keeps Voiceover locked until a voice read exists, but open notes on those takes still count towards Send to agent and can be answered with `rushes_reply`.
- You own a note's `reply`, `fixT` and `fixVersion`. The user owns its text, times and box. Either of you can set `status`.
- After the first cut, send the storyboard's shots with `rushes_set_shots`; when a new cut moves them, send new timings.
- Lock picture with `rushes_lock_picture` only when the user says picture is locked. Pass `version: null` to unlock.
- Times are seconds from the start of the video, as numbers (e.g. `31.05`).
- A server you start through the tools stops by itself after two hours with nothing connected. The next tool call starts it again. `rushes stop` stops it now.
- Prefer H.264 MP4 for cuts: browsers can't play ProRes, and some can't play HEVC.

## Without MCP

```bash
npx -y rushes open
npx -y rushes add version renders/hero_v2.mp4 --video "Hero 60s" --label "logo hold" --note "held the logo 0.5 s longer"
npx -y rushes add format renders/hero_v2_9x16.mp4 --video "Hero 60s"
npx -y rushes notes --stage picture --status todo --json
npx -y rushes reply n_8f2k3a "Held the phone 0.5 s longer" --done --fix-t 12.9 --fix-version v2
npx -y rushes add variant voice gerald.wav --name Gerald --round "Round 1 · Voices"
npx -y rushes add shots shots.json --video "Hero 60s" --version v2
npx -y rushes add file brief.pdf --kind doc
npx -y rushes export notes
npx -y rushes log --limit 20
npx -y rushes log add "Slowed the zooms" --area picture
npx -y rushes doctor --json
npx -y rushes scan --json
npx -y rushes bring-in audio/music/bed.wav --kind music
```

`shots.json` is a JSON array of `{name, start, tag?}`, or that array wrapped as `{"shots": [...]}`.
