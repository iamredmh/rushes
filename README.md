# Rushes

A local review desk for video made with AI agents.

Your agent renders a cut, writes a voiceover script or generates music beds. Rushes shows that work stage by stage in your browser:

- **Script:** your edits sit beside the agent's lines.
- **Picture:** timecoded notes, ranges, boxes on the frame and frame grabs.
- **Picture waveform:** the cut's own audio, drawn quietly in the timeline, so you can see where the sound is.
- **Voiceover, Music, Sound effects:** variants you can switch between with no gap.
- **Mix:** everything playing together.

Your notes are saved as plain files in your project. The agent reads them, fixes things and replies on each one, and you see each reply arrive.

It runs on your machine. There's no account, no API key and no server to sign up for. You need [Node.js](https://nodejs.org) 20.19 or newer (or 22.12+ on the 22 line).

> Status: early. The Script, Picture, Voiceover, Music, Sound effects and Mix tabs, the MCP tools and the CLI all work today.

## Get started

Tell your agent:

> Use github.com/iamredmh/rushes as my review tool for video, voiceover and music.

That's all. Your agent reads the next section and sets itself up.

## For agents: set yourself up

If your user asked you to use Rushes, do this:

1. Run this once. It finds every supported harness on the machine and registers the Rushes MCP server, plus the Rushes skill where the harness supports skills:

   ```bash
   npx -y rushes setup
   ```

   (Before publishing to npm, the GitHub form also works: `npx -y github:iamredmh/rushes setup`.)

   It prints one line per harness. Existing config is kept and a `.rushes.bak` backup is written first. Run it with `--dry-run` first if you want to show the user the changes before making them. A machine already set up through the GitHub form is recognised as Rushes too — setup switches it to the npm launch instead of adding a second registration.
2. If it added anything, tell the user to restart the app (or start a new session) so the `rushes_*` tools load.
3. From then on, follow [AGENTS.md](AGENTS.md). In short: register what you made, call `rushes_open`, wait for the user to press **Send to agent**, then `rushes_get_batch`, fix the notes, and `rushes_reply`.

The MCP server has twenty tools: `rushes_open`, `rushes_status`, `rushes_add_version`, `rushes_add_format`, `rushes_add_variant`, `rushes_set_script`, `rushes_get_script`, `rushes_add_take`, `rushes_list_notes`, `rushes_list_assets`, `rushes_get_batch`, `rushes_reply`, `rushes_get_picks`, `rushes_set_shots`, `rushes_lock_picture`, `rushes_add_file`, `rushes_export_notes`, `rushes_scan`, `rushes_bring_in` and `rushes_doctor`.

If you can't run commands, give the user the matching line from **Manual setup** below.

## Manual setup

| Harness | How |
|---|---|
| **Claude Code**: plugin, which includes the skill | `/plugin marketplace add iamredmh/rushes` then `/plugin install rushes@iamredmh` |
| **Claude Code**: MCP only | `claude mcp add --scope user rushes -- npx -y rushes mcp` |
| **Codex** | add to `~/.codex/config.toml`:<br>`[mcp_servers.rushes]`<br>`command = "npx"`<br>`args = ["-y", "rushes", "mcp"]` |
| **Cursor** (`~/.cursor/mcp.json`), **Claude Desktop** (`claude_desktop_config.json`), **Gemini CLI** (`~/.gemini/settings.json`) | `{ "mcpServers": { "rushes": { "command": "npx", "args": ["-y", "rushes", "mcp"] } } }` |

On Windows, `rushes setup` writes the launch as `cmd /c npx -y rushes mcp` (in JSON: `"command": "cmd", "args": ["/c", "npx", "-y", "rushes", "mcp"]`), because harnesses can't start `npx` directly there. Do the same if you set it up by hand.

### Other harnesses

Any MCP client that can launch a local stdio server works. Point it at `npx -y rushes mcp`. Agents with no MCP support can use the CLI instead (`rushes add`, including `rushes add format` for another shape of a cut, `rushes notes`, `rushes reply`): see [AGENTS.md](AGENTS.md).

ChatGPT's apps can't run local MCP servers yet. Use Codex, OpenAI's agent, instead.

## Use it yourself

```bash
cd your-project
npx -y rushes open    # opens the review desk in your browser
npx -y rushes stop    # stops it
```

`rushes open` also looks through the folder for the files that go with the cut, and says what it brought in and what it left (see **Finding your other files**).

Each project opens at its own address, `http://127.0.0.1:4580/p/<id>/` — safe to run several projects at once.

A server your agent starts in the background stops by itself after two hours with nothing connected.

### Try it first: `rushes demo`

No project to hand? Build one:

```bash
npx -y rushes demo    # creates ./rushes-demo and opens it
```

It generates a complete example on your machine — a 30 s test film in two cuts, a short script, voice reads in two rounds, two music beds, an SFX pass, and example notes on Picture, Voiceover, Music and Mix — so every tab has something in it from the start. Nothing is downloaded and nothing ships with Rushes; it's all made locally with ffmpeg and, where available, your system's text-to-speech. It needs ffmpeg — without it, `demo` says so and points you at `rushes doctor`. It refuses to write into a folder that isn't empty. Pass a folder name to put it somewhere else, and `--no-browser` to skip opening it.

### Health check: `rushes doctor`

```bash
npx -y rushes doctor          # Node, ffmpeg, which agents have Rushes, this project, free disk space
npx -y rushes doctor --json   # the same checks as data
```

Each check prints ✓ or ✗ with a plain fix, e.g. `✗ Claude Code — the Rushes MCP server isn't registered. Fix: rushes setup --only claude-code`. Only the Node version (and, inside a project, its files) has to pass; ffmpeg is recommended (proxies and loudness need it) but not required, and doctor warns when your ffmpeg was built without libx264, which proxies and the demo encode with. Run it from inside a project folder to add file, server and disk checks. Agents get the same checks from the `rushes_doctor` tool.

## Shortcuts

In the Picture tab:

- **Space** play or pause
- **←/→** step one frame (Shift: ten)
- **I/O** set in and out
- **B** draw a box
- **G** grab a frame
- **N** new note

In the Voiceover, Music, Sound effects and Mix tabs:

- **Space** play or pause
- **←/→** step one frame (Shift: ten)
- **I/O** set in and out
- **N** new note

Anywhere:

- **1–7** switch tab (7: Assets)
- **[ / ]** previous/next film
- **Alt+←/→** previous/next format (Picture)
- **?** shortcuts
- **Esc** close

## Locked tabs

Every tab is visible from the start, in workflow order, even before there's anything in it. A locked tab isn't a dead end: open it and it explains itself — what the tab is for, what unlocks it, and a **Copy prompt for your agent** button that copies a ready-to-paste request naming your project, the film, and the tool your agent should use, e.g.:

> In Rushes project "Launch", make two or three music beds for "Hero" and add each with rushes_add_variant (stage "music") with a one-line description.

When the project's folder already holds files for a locked Voiceover, Music or Sound effects tab, its page also says how many were found and offers a **Review** button, such as "14 music files found in this project". See **Finding your other files**, below.

Hovering a locked tab shows a short tooltip, e.g. "Locked: ask your agent for music beds". The Assets tab follows the same rule.

## Finding your other files

An agent only shows what it registers, but the work that goes with a cut usually sits in the same folder: the voiceover, the music, the effects. So when a project is opened, Rushes looks through the folder itself, and brings in the **current set** for the newest cut so those tabs have something to review.

- **When.** On open (`rushes open`, or your agent's `rushes_open`) and whenever you press **Look again** or run `rushes scan`. There's no folder watcher.
- **Where.** Only inside the project folder, up to eight folders deep. It never follows a symlink out of it, never reads a file's contents, and skips hidden folders, `node_modules` and Rushes' own `.rushes`, `proxies`, `screenshots` and `exports`. It examines up to 5,000 files. The dashboard never waits for it: a big folder shows "Looking through the folder…" and fills in as it goes.
- **What each file probably is.** The nearest folder or file-name word decides: `vo`, `voice`, `narration` for voiceover; `bed`, `music`, `score` for music; `sfx`, `foley`, `whoosh` for sound effects. Audio with no such word is "Other audio", and you choose its kind. Video files other than the registered cut are offered as other cuts.
- **The current set.** Each audio file is scored against the cut: a similar length, being made around the same time, and sharing a word or version (such as `v20`) with its name. For each kind, the best file comes in on its own only when it clearly beats the rest. That's at most one voice read, one music bed and one sound effects pass, and nothing else. Nothing is ever picked: files come in unpicked, and you choose in the dashboard. Each one carries its reasons, in plain words.
- **Assets › Found.** Everything else stays one step away, in the **Found** folder at the top of Assets. Files are grouped by folder, with their length, size and reasons, and you can play one before you bring it in. A chip in the header ("3 brought in · 118 more found") opens it while there's something new to look at.
  - **Bring in** registers the ticked files: voiceover, music and sound effects as variants, and video as cuts. It takes up to 12 files of each kind at a time, so the tabs stay quick; each voiceover folder becomes its own round.
  - **Not these** hides the ticked files for good. A **Hidden** list brings them back with **Restore**.
  - **Look again** runs the scan once more, and a filter box and kind buttons narrow the list.
  - Files already in the project are never offered twice.
- **Locked tabs say so.** If the folder holds files for a tab that's still locked, its page adds a line under the prompt, such as "14 music files found in this project" (or "1 music file found in this project"), with a **Review** button that opens Found filtered to that kind. The line follows the live count.

If the guess is wrong, ask your agent to bring in the right file: `rushes_bring_in`, or `include` on `rushes_open` for files it made for this cut, which come in whatever they score and win over the guess. `rushes_scan` lists what's left, with reasons.

The same from the command line:

```bash
npx -y rushes scan [--film NAME] [--json]
npx -y rushes bring-in <file>... [--kind voice|music|sfx|cut|doc] [--round NAME] [--film NAME]
```

- `rushes scan` looks again, brings in the current set as opening does, and prints what it brought in and the top candidates left with their reasons. `--json` prints all of them as data.
- `rushes bring-in` brings the named files in. Paths are read from the folder you run it in. `--kind` is needed when a name doesn't say (`doc` takes `md`, `txt` and `pdf`), `--round` names the voiceover round, and `--film` picks the film a cut joins. It prints one line per file, says why for any it can't bring in (a path outside the project folder is always refused), and exits 1 if any failed.

## Screenshots and the Assets library

Press **G**, or the camera button, to grab the current frame. It's saved as a PNG to `screenshots/`, named for the film, version and timecode (and, on a cut with several formats, the ratio on screen) — grabbing the same frame twice overwrites the same file.

The **Assets** tab (key `7`) is a library with a folder sidebar: Screenshots, Cuts, Voiceover, Music, Sound effects, Scripts & docs, Images, Captions, Exports, Delivery, Edit files and Proxies. Each folder has search and a sort order; Screenshots, Images, Cuts and Delivery also get a grid/list toggle, and Screenshots, Cuts and Delivery get a film filter — every other folder is list-only. Audio plays inline, one at a time, and Markdown or text files get a read-only preview. Every item has five actions: Download, Save as (Chrome and Edge only — other browsers just get Download), Open, Show in Finder and Copy path. A file your agent registered from outside the project folder (or reached through a link out of it) plays and downloads only if it is a media or document type (audio, video, images, PDF, Markdown, text, captions); for anything else, such as an editor project file on another drive, use Show in Finder or Copy path. **Open** appears, and is accepted, only for a fixed list of safe, non-executable types — never scripts, apps or archives. Top-level `.md`, `.txt`, `.pdf`, `.srt` and `.vtt` files, plus anything in `exports/`, are picked up automatically; everything else your agent registers with `rushes_add_file`. The Exports folder also has an **Export notes** button, which writes every note to a dated Markdown file there.

Rushes recommends this layout for a project folder:

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

Rushes creates `screenshots/` itself on the first grab. It never creates the other folders — they're a convention for agents to follow.

## Packs, picture lock and shots

A project with more than one film gets numbered pills in the header — `[`/`]` switch between them, and each film remembers its own version and playhead. The header reads **Picture vN**, with a lock button beside it: lock a film at a cut and the dashboard opens on that cut until you unlock it. A version can carry a shot list from the storyboard, shown as a strip under the timeline, and every Picture note records the shot it falls in.

## Formats

A piece often ships in several shapes — 9:16, 4:5, 1:1, 16:9 — the same edit reframed. Your agent registers each shape with `rushes_add_format` (or all of them at once with `rushes_add_version`'s `formats`, or `rushes add format <file>` from the command line); Rushes measures each ratio itself. Picture then shows a toggle beside the version, always in the same order (9:16, 4:5, 1:1, 4:3, 16:9), with a count of open notes on each. Switching keeps your place and whether it's playing. **Alt+←/→** steps through them.

A new note belongs to the format on screen: the switch above the note box reads **This format** | **All formats**, and you can change it on the note afterwards. A note for one format shows only there; notes for the other formats wait in a quiet **Other formats** row at the foot of the list. A drawn box always stays on the format it was drawn on. With one format there's no switch, and nothing changes. Assets › Cuts lists each format under its cut, and a frame grab is named with its ratio, such as `hero_v1_9x16_00m01.00s_f30.png`.

A format's file can sit outside the project folder, like any registered cut, and plays by the same rules. A second render of a shape the cut already has is refused: a re-render is a new version.

The format keys never fire while you're typing a note. In a text field, Alt+←/→ keeps its usual meaning: on macOS it jumps a word, and on Windows and Linux the browser may take it as Back, so click outside the note box first (or use the toggle) to switch format.

## Proxies

Some cuts play badly in a browser: 4K or larger, over 1.5 GB, a codec browsers can't play reliably (ProRes, DNx, HEVC 10-bit — anything that isn't H.264, VP9 or AV1), or one that threw a playback error. Rushes checks with ffprobe as the cut is added, and if it's likely to struggle, a bar appears under the player saying why in a few words, with a **Create proxy** button. It makes a lightweight 1080p H.264 copy on your drive — your original file is never changed — with visible progress and **Cancel**. Notes, timecodes and frame numbers are identical on the proxy and the original.

Once it's ready, a **Proxy / Original** switch appears on the player (defaults to Proxy, remembered per film). **Grab Frame** always takes the still from the original at full quality, whichever one you're watching. Tick "Create proxies for new cuts like this automatically" (off by default, saved per project) to skip the offer next time. The **Assets** tab has a **Proxies** folder listing each one with its size and a **Delete proxy** button; deleting removes only the proxy file, never the original.

Without ffmpeg, no proxy is ever offered.

## Audio review

The Voiceover, Music, Sound effects and Mix tabs share one audio engine, so switching what you hear is instant and never restarts playback or knocks picture out of sync.

Voiceover works in rounds: the same script read by a few voices, then variations of whichever one you pick. The current round is open; earlier rounds fold into one row each, and clicking a row opens it so its reads play too.

- **Use** picks a music bed, SFX pass or voice read — shown as **In use**. Clicking a lane auditions it without changing the pick. An **Unpick** button beside In use clears the pick. On Music and Sound effects the first bed or pass is auditioned; on Mix the lane is empty; on Voiceover, with nothing clicked, the current round's pick plays, or else its first read.
- **Blind** (Music and Voiceover) renames the beds `Bed 1`, `Bed 2`… — on Voiceover, each round's reads `Read 1`, `Read 2`… — in a shuffled order and masks their descriptions, so you can compare without knowing which is which.
- On Voiceover, a note is **Whole** (`Speaker`, `Pacing`, `Tone` or `Overall` — the read as a whole) or **Point** (`Fix this` or `Keep this`, marked at the playhead). There's no Range scope and no Rise/Fall/Louder/Quieter marks there.
- On Music, Sound effects and Mix, a note can carry marks: toggle **Rise**, **Fall**, **Louder** or **Quieter** (with a dB amount, 3 by default) to say how a range should change — "Fall" or "Quieter 3 dB".
- **Mix** shows a loudness readout — integrated LUFS, true peak, and the music's level under the VO — measured over exactly what Mix plays, using the newest round's picked voice read. It needs **ffmpeg** on your PATH; without it, the readout shows "—". After a timeout or an error, click the readout to measure again.
- Each **Mix** lane (Voiceover, Music, Sound effects) has a level slider, −24 dB to +6 dB in 0.5 dB steps, shown as e.g. `−14.0 dB`. Double-click resets it to 0; arrow keys move it 0.5 dB at a time. Levels are saved with your picks, never change a file, and the loudness readout is measured with them applied.

## What gets saved

```
your-project/.rushes/
  project.json   videos, versions, audio lanes and variants
  script.json    VO sections: the agent's line, your version, direction, takes
  notes.json     every note, with the agent's replies
  picks.json     which variant or take is in use, and each Mix lane's level
  batches.json   what you sent to the agent
```

Add `.rushes/` to git if you want your review history kept with the project — and `screenshots/` alongside it, since notes point to the grabs there. Keep `proxies/` out of git: proxies can run to gigabytes, and Rushes can always make them again. Rushes ignores its own temporary files.

## Develop

```bash
git clone https://github.com/iamredmh/rushes && cd rushes
npm install
npm test
npm run rushes -- open ../some-project
```

ffmpeg and ffprobe are optional. With them installed, Rushes reads frame rates and durations and can make browser-playable copies.

## Publishing (maintainers)

Run `npm login` once in Terminal — it confirms in your browser. Then, with the maintainer's OK at the time, `npm publish`. npm may ask for a one-time code; enter it when it does.

## Licence

MIT © Red Morley Hewitt
