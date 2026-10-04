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

When the user wants to share notes with someone else, call `rushes_export_notes` (CLI: `rushes export notes`). It writes every note, grouped by stage and, for Picture, by film and version, to a dated Markdown file in `exports/`, and returns its path.

## A demo project

No project to show yet? Run `npx -y rushes demo <folder> --no-browser`, then `rushes_open` with `project: "<folder>"`. The demo makes a complete example on the user's machine — a cut in two versions, a script, voice reads in two rounds, two music beds, an SFX pass and example notes — all generated locally with ffmpeg. Always pass `--no-browser`: without it the command stays running as the server and never returns. It refuses a folder that isn't empty.

## Locked tabs and the prompts they copy

Every tab is visible from the start, in workflow order, even before it has anything in it. Opening a locked tab explains what it's for and what unlocks it, and offers a **Copy prompt for your agent** button. If the user pastes you one of these, it's a direct, already-scoped request — act on it the same as any other instruction, e.g.:

> In Rushes project "Launch", make two or three music beds for "Hero" and add each with rushes_add_variant (stage "music") with a one-line description.

## The loop

1. **Register what you made.**
   - A render: `rushes_add_version` with `video` and `file`. Run it again for each new cut. When the cut is likely to play badly in a browser (4K or larger, over 1.5 GB, or a codec such as ProRes), the reply carries `proxySuggested: true` and `proxyReason`; Picture then offers the user a proxy. Prefer H.264 MP4 to begin with and this won't come up.
   - A VO script: `rushes_set_script` with sections `{start, end, current}` in seconds. It merges by `id`: send only the sections you changed, with their ids, plus any new ones without an id. Sections you leave out are kept, with their takes. Pass `replace: true` only when you mean to replace the whole script. `rushes_get_script` reads the whole script back.
   - A voice read: `rushes_add_variant` with `stage: "voice"` and `round` (the round's name, e.g. "Round 2 · Gerald, tone" — reads in one round are compared side by side; a new direction gets a new round, a small fix to a marked word can stay in the current one). Say in `description` what the read is, or what changed from the one it's based on. `rushes_add_take` stays in the file format and API for compatibility only; voiceover work doesn't use it.
   - Music beds or SFX passes: `rushes_add_variant` with `stage` `music` or `sfx`. Give it `meta: {description: "..."}`, shown on its lane card in place of `bpm`/`key`; SFX passes also take `cues` (`{name, t}` in seconds), labelled on the waveform.
   - The storyboard's shots, once you have the first cut: `rushes_set_shots` with `video`, optional `version` (defaults to the newest) and `shots` as `{start, name, tag?}`. Send new timings whenever a later cut moves them.
2. **Open it for the user:** `rushes_open`. Each project's dashboard lives at its own address, `/p/<id>/` — safe to run more than one project at once. A tab unlocks as soon as it has something in it.
3. **Wait for feedback.** The user presses **Send to agent**, which saves a batch and gives them a prompt to paste to you. Call `rushes_get_batch` to read the latest batch, its notes and any changed script sections.
4. **Fix each note.** A note has `stage`, `scope` (`point`, `range` or `whole` — Voiceover only ever uses `point` or `whole`; it has no Range scope), `t`, `tOut`, `on` (the lane, variant, take, cue or section it's about), `text`, and optionally `box` (normalised 0 to 1), `grab` (a PNG path in `screenshots/`; older notes may point to `.rushes/grabs/`) and `shot` (the shot it falls in, `{n, name}`, worked out by the server from the version's shots — not yours to set). On an audio stage, `on` is `"<laneId>/<variantId>"` for a music bed, SFX pass or voice read (the lane and variant ids `rushes_add_variant` returns) — on Voiceover the lane id is the round's slugged name, so `on` names the round and the read together — or `"<laneId>/<variantId>:<cueId>"` for an SFX cue. On Mix it's `null` for the whole mix, `"vo"` for the VO lane (the newest round with a pick), or `"<laneId>/<variantId>"` for the music or SFX lane. Older notes may carry a bare variant id, `"vo"` on Voiceover itself, a section id, `"<sectionId>:<takeId>"` for a take, `"<variantId>:<cueId>"` or a bare cue id; Rushes still lists these with a sensible label, but none of them name a read any more. On Music, Sound effects and Mix, a note can also carry `marks` — short feedback like `Fall` (bring the level down over the range) or `Quieter 3 dB` (3 dB lower over the range). `rushes_list_notes`, `rushes_get_batch` and exported notes all show them. Marks are the user's, like a note's text and times — you read and act on them, you don't set them. Voiceover notes carry no marks: a note there is **Whole** (`Speaker`, `Pacing`, `Tone` or `Overall` — about the read as a whole) or **Point** (`Fix this` or `Keep this`, marked at the playhead).
5. **Register the new cut** with `rushes_add_version` and note what changed. If the video is locked, the reply carries `warning: "Picture is locked at vN"`; the version is still added.
6. **Reply to every note** in one `rushes_reply` call. For each, set `status: "done"`, a one-line `reply`, `fixT` (when the fix is visible in the new cut, in seconds) and `fixVersion`. If you didn't fix a note, leave it `todo` and say why in `reply`.
7. **Audio batches.** On Voiceover, Music, Sound effects or Mix, call `rushes_get_picks` first, so you know which read or variant is in use before you fix anything. On Mix, it also returns `levels: { voice?, music?, sfx? }` in dB — where the user wants each lane to sit. Don't try to change these; they're set from the dashboard's sliders and only tell you the balance the user has already chosen. Then fix each note:
   - **Voiceover:** register a new whole read with `rushes_add_variant` (`stage: "voice"`) — a new round for a new direction (another voice, a different tone), or the current round for a small fix to a marked word. Say in `description` what changed.
   - **Music or Sound effects:** make the new bed or pass the text and marks ask for, and register it as in step 1.

   Then reply as in step 6. Mix plays the newest round's picked voice read; takes are never mixed.
8. **Script batches.** When a section's `proposed` differs from `current`, the user rewrote the line. Adopt it by calling `rushes_set_script` with just that section's `id`, `start`, `end` and the new `current`; the other sections stay as they are. The proposal then clears itself, and a flagged section goes back to draft. If voiceover already exists, re-record the picked voice with the corrected script and register it with `rushes_add_variant` as a new read in a new round.

## Tools

The MCP server has seventeen tools: `rushes_open`, `rushes_status`, `rushes_add_version`, `rushes_add_variant`, `rushes_set_script`, `rushes_get_script`, `rushes_add_take`, `rushes_list_notes`, `rushes_list_assets`, `rushes_get_batch`, `rushes_reply`, `rushes_get_picks`, `rushes_set_shots`, `rushes_lock_picture`, `rushes_add_file`, `rushes_export_notes` and `rushes_doctor`. Each takes an optional `project` folder, which defaults to the folder the harness started in.

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
npx -y rushes add version renders/hero_v2.mp4 --video "Hero 60s" --note "logo hold"
npx -y rushes notes --stage picture --status todo --json
npx -y rushes reply n_8f2k3a "Held the phone 0.5 s longer" --done --fix-t 12.9 --fix-version v2
npx -y rushes add variant voice gerald.wav --name Gerald --round "Round 1 · Voices"
npx -y rushes add shots shots.json --video "Hero 60s" --version v2
npx -y rushes add file brief.pdf --kind doc
npx -y rushes export notes
npx -y rushes doctor --json
```

`shots.json` is a JSON array of `{name, start, tag?}`, or that array wrapped as `{"shots": [...]}`.
