# Rushes: design spec

**Date:** 2 October 2026
**Owner:** Red Morley Hewitt (`iamredmh`)
**Status:** Approved, 2 October 2026
**Layout reference:** the round three layout mockup (private for now; the dashboard in Plan 2 replaces it)

---

## 1. What Rushes is

Rushes is a local review desk for video made with an AI agent. You open it from your project folder. It shows the work stage by stage (script, picture, voiceover, music, sound effects, mix), and you mark it up the way an editor would, with timecoded notes, ranges, boxes on the frame and frame grabs.

Every note, edit and pick is saved as plain files in the project. The agent reads those files and acts on them, then replies on each note and marks it done.

It solves a gap that every agent harness has today. The agent makes a video, then hands back a Markdown file or a filename. There's no good way to look at the work, point at a moment, and say what to change.

**Who it's for:** anyone producing video with Claude Code or another agent harness (Codex, Cursor, anything that speaks MCP or can read files). That's Red first, then the open-source community.

**What success looks like:**
1. A new user says to their agent "Use github.com/iamredmh/rushes as my review tool". The agent sets itself up, and the user is reviewing within two minutes, with nothing to install except Node.
2. With the MCP server added, an agent can register a cut, read the open notes, reply to each one, and push the next version, and the dashboard updates live without a reload.
3. Red uses it on a real project instead of a one-off review artifact.

### What stays the same as the existing review artifacts

One-off review pages built for real client films proved the core loop. Rushes keeps:
- notes tagged with time, frame and version;
- older notes jumping to the time they were fixed (`fixT`) in the newer cut;
- sample-locked switching between variants (the VO Polish method);
- the existing keyboard shortcuts.

## 2. Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Where it runs | Locally. One Node package: CLI, local web server, web UI and MCP server | Works with any harness, and needs no accounts or hosting |
| Client sharing | **Out of scope.** No share links, no guest comments | Red: the value is in focusing on your own edits |
| Agent loop | Files plus an MCP server | Any harness can read the files, and MCP gives proper tools |
| Layout | One stage tab at a time, in workflow order, each unlocked only when the project has that element | Red: showing everything at once was too much |
| Notes | Down the right of every tab, never underneath. Point, In/Out range, or whole-track | Red's review notes |
| Visual style | Rushes' own clean, minimal style. Icon buttons with tooltips, status shown as marks, very few labels | Red: don't copy the artifact look, and don't over-explain |
| Name and home | **Rushes**, `github.com/iamredmh/rushes`, MIT licence, npm `rushes` | Both names were free on 2 October 2026 |
| Distribution | **The public GitHub repo is the product.** Anyone can tell their agent "use github.com/iamredmh/rushes as my review tool" and it installs and works. You need only Node: no accounts, no keys, nothing set up by Red | Red: give people the workflow he's learned, with nothing standing in the way |

## 3. Out of scope for v1

- Sharing links, guest reviewers, accounts, authentication.
- Generating audio inside Rushes (TTS, music, SFX). The agent does generation and Rushes only reviews. This keeps API keys out of the tool.
- Editing the timeline or re-cutting picture inside Rushes.
- NLE round-trip, i.e. exporting markers to Premiere or Resolve. This is a strong v2 candidate (see section 12).
- Hosted or cloud mode.

---

## 4. Architecture

```
rushes (one npm package, TypeScript, Node ≥ 20)
├─ core/      data model, schemas (zod), read/write the .rushes folder, unlock rules, version remap
├─ server/    local HTTP server (Hono): REST API + server-sent events + serves the built web UI
├─ web/       the dashboard (Preact + Vite), built to static files shipped in the package
├─ mcp/       MCP server over stdio (@modelcontextprotocol/sdk), a thin client of the server API
└─ cli/       `rushes open | mcp | add | doctor`
```

**One writer.** Only the HTTP server writes to `.rushes/`. The web UI and the MCP server both go through its API. If the MCP server finds no server running for that project, it starts one, detached. A lockfile, `.rushes/server.json` (`{port, pid, startedAt}`), lets every process find the running server. This removes write races between the agent and the browser.

**Live updates.** The server pushes a change event over SSE after every write, whether it came from the UI or the agent. The UI re-renders that piece. It also watches `.rushes/` for hand edits, such as an agent writing files directly without MCP, and validates and broadcasts those too.

**No native dependencies.** Playback, waveforms and frame grabs all happen in the browser. ffmpeg and ffprobe are optional. When present, they make browser-playable proxies and read accurate media metadata (section 9).

## 5. Project folder and file format

Rushes adds one folder to the project root. Media stays where it is, and paths are relative to the project root.

```
my-project/
  .rushes/
    project.json     manifest: videos, versions, audio lanes and variants, fps
    script.json      VO sections
    notes.json       every note on every tab
    picks.json       which variant or take is in use per lane or section
    batches.json     what was sent to the agent, and when
    grabs/           frame grabs, PNG, named {video}_{version}_f{frame}.png
    proxies/         generated playable copies (gitignored)
    server.json      running-server lockfile (gitignored)
```

The files are plain JSON with two-space indentation and stable key order, so diffs read cleanly in git. Every file has a top-level `"schema": 1` and a `"rev"` counter that the server increments on each write.

### project.json
```json
{
  "schema": 1, "rev": 12,
  "name": "spring-launch",
  "fps": 60,
  "videos": [
    { "id": "hero", "name": "Hero 60s",
      "versions": [
        { "id": "v3", "file": "renders/hero_v3.mp4", "duration": 60.0, "addedAt": "2026-10-02T14:10:00Z", "note": "logo hold" }
      ] }
  ],
  "lanes": [
    { "id": "music", "stage": "music", "name": "Music",
      "variants": [ { "id": "a", "name": "Deep house", "file": "audio/music_a.wav", "meta": { "bpm": 120, "key": "A minor" } } ] },
    { "id": "sfx", "stage": "sfx", "name": "Sound effects",
      "variants": [ { "id": "pass-a", "name": "Pass A", "file": "audio/sfx_a.wav",
                      "cues": [ { "id": "swipe", "name": "Swipe", "t": 31.05 } ] } ] }
  ]
}
```

### script.json
```json
{
  "schema": 1, "rev": 4, "wordsPerSecond": 2.6,
  "sections": [
    { "id": "s2", "start": 13.0, "end": 30.0,
      "current": "Every file, on every device, the moment you save it.",
      "proposed": "Every file, on every device, before you've put the kettle on.",
      "direction": "Lighter. Smile on \"kettle\".",
      "status": "flagged",
      "takes": [ { "id": "t2", "file": "audio/vo_s2_t2.wav", "duration": 5.0 } ] }
  ]
}
```
`current` is the agent's line and `proposed` is the user's edit. A row counts as changed when `proposed` differs from `current`. Status is one of `draft`, `approved` or `flagged`.

### notes.json
```json
{
  "schema": 1, "rev": 31,
  "notes": [
    { "id": "n_8f2k", "stage": "picture", "video": "hero", "version": "v3",
      "on": null, "scope": "range", "t": 31.05, "tOut": 33.10, "frame": 1863,
      "text": "Share-sheet scene is too fast to read the folder name.",
      "box": null, "grab": null,
      "status": "done", "reply": "Slowed to 2.4 s, holding on the name.", "fixT": 31.40, "fixVersion": "v4",
      "batch": "b_3", "createdAt": "2026-10-02T14:20:11Z", "by": "user" }
  ]
}
```
- `stage` is one of `script | picture | voice | music | sfx | mix`.
- `on` names what the note is about. It's `null` for picture (and for the whole mix on Mix). On the audio tabs it's `"<lane id>/<variant id>"` for a variant, `"<lane id>/<variant id>:<cue id>"` for an SFX cue, `"vo"` for the assembled read (or Mix's VO lane), `"<section id>:<take id>"` for a take, or a section id. Lane and variant ids are slugs, so the `/` and `:` never clash, and lane ids are unique across the project, so two lanes' same-named variants stay apart (§17.8).
- `scope` is `point | range | whole`.
- `box` holds normalised coordinates `{x,y,w,h}` from 0 to 1.
- **Field ownership** keeps conflicts away. The user owns `text`, `box`, `grab`, `scope`, `t` and `tOut`. The agent owns `reply`, `fixT` and `fixVersion`. Either side can set `status`.

### picks.json and batches.json
`picks.json` maps `lane id → variant id`, and `section id → take id`. `batches.json` lists `{id, stage, noteIds, sentAt, prompt}` for each time the user pressed Send.

## 6. Tabs and unlock rules

The tabs always appear in this order. A tab is locked (dimmed, with a padlock and no content) until its condition is true:

| Tab | Unlocks when | Main area | Right column |
|---|---|---|---|
| Script | `script.json` has at least one section | Section rows: current line on the left, your version on the right, a fit bar, direction, play, revert, flag and approve | none (the rows are the notes) |
| Picture | at least one video version | Player, transport, timeline with note markers and spans | Notes, frame grabs, composer |
| Voiceover | a `voice` lane has at least one read | Rounds of whole reads, the newest round open (§18) | Picture preview, notes |
| Music | a `music` lane has at least one variant | One lane per bed (name, BPM, key). Use button. Blind mode | Picture preview, notes |
| Sound effects | an `sfx` lane has at least one variant | One lane per pass, cues labelled on the waveform | Picture preview, notes |
| Mix | Picture is unlocked, plus at least one audio tab | VO, music and SFX lanes with mute and solo, plus a loudness readout (when ffmpeg is available) | Picture preview, notes |

Each tab shows a dot when it has open items. The **Send to agent** count and prompt only cover the tab you're on, because Red works one stage at a time.

### Interaction rules on every tab
- `Space` plays or pauses, `←` and `→` step one frame, `I` and `O` set in and out, `N` focuses the note box, `G` grabs a frame (Picture only), and `1` to `6` switch tabs. Every control's tooltip names its key, and one popover lists them all.
- The note box takes its scope from context. With no range set it's a point at the playhead. Once In and Out are set it's a range. Whole is picked explicitly. On audio tabs, the **On** menu defaults to the lane you last clicked.
- Quick-start chips per tab, such as Tempo, Key or Ending for music, put a prefix in the note box. They only start a note and never send anything.
- To mark a note done or open it again, you tick its circle.
- A note from an older version shows the version it came from. Once the agent sets `fixT`, clicking the note jumps to `fixT` in the current cut.

## 7. The agent loop

### How the agent finds out about notes
An MCP server can't wake the agent up on its own. So **Send to agent**:
1. puts this tab's open, unbatched notes (or changed script rows) into a new batch in `batches.json`;
2. builds a short prompt, e.g. "Work through picture batch b_4 on spring-launch / Hero 60s v3. 3 notes. Use rushes_list_notes then rushes_reply.";
3. copies the prompt to the clipboard, so you paste it into your agent.

An agent with the MCP can also call `rushes_get_batch` with no arguments to pick up the most recent batch, so pasting the prompt is optional.

### MCP tools (v1)
There are eleven tools here; §14.6 adds two more. Every tool takes an optional `project` path, which defaults to the working directory.

| Tool | Does |
|---|---|
| `rushes_open` | Starts the server if it isn't running, returns the URL, and opens the browser |
| `rushes_status` | Lists the tabs, which are unlocked, and the to-do count on each |
| `rushes_add_version` | Registers a new cut of a video (`file`, optional `note`) and returns the new version id |
| `rushes_add_variant` | Adds a music bed or SFX pass to a lane (`stage`, `name`, `file`, optional `meta`, `cues`) |
| `rushes_set_script` | Adds or updates script sections (`start`, `end`, `current`). Merges by `id` by default, so sections left out are kept; `replace: true` replaces the whole script |
| `rushes_get_script` | The whole script: every section with its line, the user's proposal, direction, status and takes |
| `rushes_add_take` | Attaches a VO take to a section |
| `rushes_list_notes` | Notes filtered by `stage`, `status`, `batch` or `version` |
| `rushes_get_batch` | The latest batch, or one by id, with its notes and changed script rows |
| `rushes_reply` | Replies to a note: `reply`, `status`, optional `fixT` and `fixVersion`. Accepts a list, so a whole batch is one call |
| `rushes_get_picks` | The variant and take in use per lane and section |

The CLI mirrors these so agents without MCP can still use Rushes: `rushes add version <file>`, `rushes add variant music <file> --name "Deep house"`, `rushes notes --stage picture --status todo --json`, `rushes reply <id> "..." --done --fix-t 31.40`.

### Getting Rushes into anyone's harness

The public repo is the whole install. Nobody needs anything from Red: no npm account, no keys, no hosted service.

- **Runs straight from GitHub.** `npx -y github:iamredmh/rushes <command>` works before any npm release, because the package's `prepare` script builds it on install (about 7 seconds the first time, cached after that). Once Plan 4 publishes to npm, the source becomes `rushes`. It lives in one constant (`SOURCE`), so docs and config change in one place.
- **One command an agent can run:** `npx -y github:iamredmh/rushes setup`.
  - It finds the installed harnesses (Claude Code, Codex, Cursor, Claude Desktop, Gemini CLI) by their config folder or command.
  - It registers the MCP server with each one. Claude Code goes through `claude mcp add --scope user`. The others get their config file merged.
  - It copies the skill where the harness reads skills (Claude Code and Codex).
  - It never removes or rewrites other settings, backs up a changed config to `*.rushes.bak`, leaves a broken config untouched, and supports `--dry-run` and `--only`.
- **A Claude Code plugin in the same repo.** `.claude-plugin/plugin.json`, a marketplace named `iamredmh` (`.claude-plugin/marketplace.json` with `source: "./"`), the root `.mcp.json` and `skills/rushes/SKILL.md`. Install with `/plugin marketplace add iamredmh/rushes` then `/plugin install rushes@iamredmh`.
- **The README talks to agents first.** A user only has to say "Use github.com/iamredmh/rushes as my review tool". The README's "For agents: set yourself up" section tells the agent to run `setup`, ask for a restart, and then follow `AGENTS.md`.
- **Requirement:** Node.js 20.19 or newer (22.12+ on the 22 line; Vite 8 builds the dashboard on a git install). ChatGPT's apps can't launch local MCP servers, so the README points ChatGPT users to Codex.

### What ships for agents
- `AGENTS.md` at the repo root, plus a `skills/rushes/SKILL.md`. Together they explain the loop: register media, open, wait for a batch, list notes, fix, reply with `fixT`, add the version.
- The README gives a manual install line per harness for anyone who doesn't want to run `setup`, e.g. Claude Code: `claude mcp add --scope user rushes -- npx -y github:iamredmh/rushes mcp`.

## 8. Playback engine

- **Picture:** an HTML `<video>` element. The frame is `round(currentTime × fps)`, using the project fps. Frame stepping seeks by `1/fps`.
- **Audio lanes:** each variant is decoded into an `AudioBuffer`. Switching variants fades two gain nodes over 4 ms on one `AudioContext` clock, so the switch is sample-locked with no gap, as in the VO Polish page.
- **Sync:** the audio clock is the master whenever lanes are playing. The video's own audio is muted on the audio tabs, and the video is nudged back if it drifts more than one frame.
- **Limits:** a fully decoded lane costs about 23 MB per stereo minute. v1 targets pieces up to about 15 minutes. Anything longer streams through media elements with drift correction, and switching may then not be sample-locked. The UI says so in a tooltip on the lane.
- **Waveforms:** peaks are computed in the browser from the decoded audio and cached in memory. When ffmpeg is present, the server can precompute them into `.rushes/peaks/`.
- **Frame grab:** the current frame is drawn to a canvas at the video's full resolution. The PNG is posted to the server, saved to `grabs/`, and attached to the next note.

## 9. Error handling

| Situation | What Rushes does |
|---|---|
| A video won't play in the browser (ProRes, some HEVC) | The player shows a frame-sized message: "This file won't play in a browser" with a **Make a playable copy** button. That runs ffmpeg to H.264 in `.rushes/proxies/`, and notes still refer to the original version. If ffmpeg is missing, the message gives the install command |
| A referenced file is missing | The lane or version shows as missing, playback skips it, and `rushes doctor` lists every missing path |
| A `.rushes` file has invalid JSON or fails the schema | The server refuses to write to it, keeps a `.bak` and shows a banner naming the file. Nothing gets overwritten |
| An agent writes a file directly with a stale `rev` | The server rejects it and returns the current `rev`. The MCP tools retry on the fresh state |
| Two browser tabs are open | Both get the same SSE stream. Writes merge per field (section 5, field ownership) |
| The port is in use | The server tries the next ten ports and updates `server.json` |
| The server isn't running when the MCP is called | The MCP starts it, detached, then carries on |

## 10. Visual system

This comes from the round three mockup:
- **Ground:** dark, so picture can be judged. `#0C0D0F` page, `#141518` app, `#1C1E22` raised surfaces, `#25282D` hover.
- **Text:** `#EEEEF0`, with `#A3A6AD` for secondary and `#70737A` for tertiary.
- **Accent:** `#7C93FF`, used once per screen for the primary action. Status colours are to do `#F5B740` and done `#4CC38A`.
- **Lane colours:** VO `#4FD1C5`, music `#A78BFA`, SFX `#FB923C`.
- **Type:** Figtree for the UI (body 15px and up) and JetBrains Mono for timecodes only. Both are bundled, with no CDN at runtime.
- **Controls:**
  - Solid filled buttons, 36px tall.
  - Icon buttons with tooltips that include the key.
  - Segmented controls for filters and scope.
  - The only rings: around the selected lane and the changed script row.
- **Rules:** no helper captions on screen. Status shows as a mark, not a word. Explanations live in the README and the in-app shortcuts popover.

## 11. Testing

- **Core unit tests (vitest):**
  - schema validation;
  - unlock rules for every tab;
  - batch creation;
  - field-ownership merge;
  - `rev` conflict handling;
  - the `fixT` jump;
  - the fit maths (words ÷ words-per-second against the slot).
- **Server tests:** every REST endpoint against a temp project folder, SSE events firing after writes, the lockfile life cycle.
- **MCP tests:** each tool called through the SDK's in-memory transport against a temp project.
- **End-to-end (Playwright):** a fixture project with tiny generated media (2-second clips and tones, made by a script and committed small). It checks that:
  - each tab unlocks as its media is added;
  - a note survives a reload;
  - a reply sent through MCP appears live;
  - In/Out creates a range note;
  - a frame grab saves a PNG;
  - switching music variants doesn't stop playback.
- **Demo project:** `npx rushes demo` writes a small sample project with every tab unlocked. It's used in the README GIF and the first-run check.

## 12. Later (not v1)

- Export notes as markers to Premiere (FCP7 XML) and Resolve (EDL or markers), and read markers back. Red's Premiere round-trip work is the starting point.
- Version diff view: two cuts side by side with notes mapped across.
- Optional hosted share mode, if the community asks for it.
- A light theme.

## 13. Resolved questions

Red agreed all three on 2 October 2026.

1. **Frame rate:** read fps with ffprobe when it's installed. Otherwise use the `project.json` fps, and fall back to 30.
2. **Stale takes:** when a section's `current` text changes after a take exists, mark that take `stale: true`. The UI shows a small "text changed since this take" mark.
3. **Package name:** publish as `rushes`, and reserve `@iamredmh/rushes` as well.

## 14. Projects, packs, picture lock and shots (agreed 2 October 2026)

Red asked for these after seeing Plan 2. They come from the earlier one-off review pages: the multi-film score review and the shot-by-shot tips review. These additions are binding, and they win wherever an earlier section disagrees.

### 14.1 Every project has an ID, and every dashboard is tied to it
Red often runs several projects at once, in different conversations. Each project already gets its own server, on its own port. The risk is port reuse. Project A's server stops (idle, or `rushes stop`), and project B's server later starts on the same port. A's old browser tab then quietly reconnects to B, and a note typed in that tab would land in B.

- `project.json` gets an `id`: 8 characters from `abcdefghjkmnpqrstuvwxyz23456789` (lower-case letters and digits, without the look-alikes 0, o, 1, l and i). It's created the first time a server starts for the project, and it never changes. An existing project without an `id` gets one then.
- The dashboard lives at `/p/<id>/`, for example `http://127.0.0.1:4580/p/k7m2x9qa/`. `GET /` redirects there. Every URL Rushes prints or opens is the `/p/<id>/` one. The browser tab's title is `<project name> · Rushes`, and the header shows the project name with the id beside it, dimmed, in the mono face.
- The dashboard sends its id with every request: the `x-rushes-project` header on fetches, and `?project=<id>` on `/api/events` and `/media`, where headers can't be set. The server rejects a request whose id doesn't match its own, with `409 wrong_project`. Requests without an id (the MCP server, the CLI, curl) are unaffected.
- `/p/<other-id>/` serves a short page, with status 404. It says the project that address belongs to isn't running on this port, and to ask your agent to open it again.
- When the dashboard gets `wrong_project`, it shows a fixed banner: "This tab is for <name>, which isn't running here any more. Ask your agent to open it again." Nothing is written anywhere, and whatever you'd typed stays in its box.
- Two conversations on the same project share that project's one server (§4), so they can't overwrite each other. The project id doesn't change that.
- `/api/health` adds `id` and `name`.
- The default port moves from 4317 to **4580**. 4317 is OpenTelemetry's standard port, and other local tools listen on it. Rushes still tries the next ten ports when one is taken.

### 14.2 Packs: switching between films
- When a project has more than one video, the header's video picker becomes a row of numbered pills, one per video, in the order they were added: `1 Hero 60s`, `2 Cutdown 15s`, and so on. A pill shows a to-do dot when that video has open Picture notes.
- Each film remembers its own chosen version and playhead for as long as the page is open. Coming back to a film puts you where you were.
- `[` and `]` move to the previous and next film. They don't wrap.
- If marks are pending on the film you're watching (§ Plan 2: In/Out, a box, a grab or a half-typed note), switching films is refused with a toast: "Add or clear your note on <video> first". Nothing pending is ever dropped.

### 14.3 The version, and picture lock
- The header always reads **Picture v4**: a "Picture" label, then the version picker for the film you're on.
- A video can be locked at one version: `lockedVersion` on the video in `project.json`, `null` by default. A lock mark next to the picker shows the state, with the tooltip "Picture locked at v4". You can lock or unlock from the dashboard with the lock button beside the picker. Your agent can do the same with `rushes_lock_picture`.
- While a video is locked, the dashboard opens on the locked version instead of the newest. If newer cuts exist, the "vN ready" chip from Plan 2 offers them, and nothing jumps on its own. Plan 3's audio tabs play against the locked picture when there is one, and the newest cut otherwise.
- `rushes_add_version` on a locked video still works, and its reply carries `warning: "Picture is locked at v4"`, so the agent knows.

### 14.4 Shots
- A version can carry a shot list from the storyboard: `shots` on the version, each with `n` (1, 2, 3 … in time order), `name`, `start` in seconds and an optional `tag` such as `ESTABLISH`. A shot runs until the next shot's start, or the end of the cut.
- A new version starts with a copy of the previous version's shots, until the agent sends new timings. The agent sets them with `rushes_set_shots` (video, version defaulting to the newest, and the list as `{ name, start, tag? }`). The server sorts them by `start` and numbers them. Starts must be unique, at or after 0, and inside the cut's duration when that's known. A list holds at most 200 shots, a name at most 80 characters, and a tag at most 24.
- Under the timeline, a strip shows one card per shot: `02 · 1.70s`, the name, and the tag in small caps. The card for the shot under the playhead is highlighted, and clicking a card pauses and seeks to its start. Shot boundaries show as small ticks on the timeline. The timecode reads `… · shot 02`.
- Every Picture note records the shot it falls in, as a snapshot `{ n, name }`. The server works this out from the note's time and the version's shots. A rename later doesn't rewrite old notes. The note list shows `Shot 02 · Window rises in` under the timecode, and the agent sees `shot` in `rushes_get_batch` and `rushes_list_notes`.

### 14.5 Audio choices on locked picture (Plan 3)
These are recorded here, and Plan 3 builds them.
- Variant cards carry a name and a one-line description (`meta.description`), like a set of named alternates. Switching variants keeps the playhead.
- A range note on an audio tab can carry quick marks: **Rise**, **Fall**, **Louder**, **Quieter**. Louder and Quieter take a dB amount. These are stored as `marks: [{ kind, db? }]`, so "0:12–0:15 · Fall · −3 dB" reaches the agent as data, not just prose.

### 14.6 New MCP tools and CLI
| Tool | Does |
|---|---|
| `rushes_set_shots` | Sets the shot list for a version (`video`, optional `version`, `shots`) |
| `rushes_lock_picture` | Locks a video's picture at a version, or unlocks it with `version: null` |

CLI: `rushes add shots <file.json> --video NAME [--version V]`, `rushes lock <video> <version>` and `rushes unlock <video>`.

## 15. Screenshots and the Assets tab (agreed 3 October 2026)

Red uses Grab Frame to save a still: to share with a colleague, to hand to the agent, or to keep. Files made during a project are hard to find again. So grabs go somewhere visible, and an Assets tab gathers everything in one place. This section is binding, and it wins over §5 and Plan 2 wherever they differ.

### 15.1 Project folders
Rushes recommends this layout. AGENTS.md tells agents to follow it. Rushes still finds any file an agent registers, wherever it lives.

```
my-film/
  renders/              cuts               hero-60s_v3.mp4
  audio/
    voiceover/          VO takes           s02_take3.wav
    music/              music beds         deep-house.wav
    sfx/                SFX passes         sfx_pass-a.wav
  screenshots/          frame grabs        hero-60s_v3_00m12.10s_f726.png
  exports/              (later) notes and markers for Premiere and Resolve
  .rushes/              Rushes' own records (hidden; not for editing by hand)
```

Rushes creates `screenshots/` itself on the first grab. It never creates the other folders; they're a convention for agents.

### 15.2 Screenshots
- **G and the camera button** save the frame as a PNG to `screenshots/{video}_{version}_{MM}m{SS.ss}s_f{frame}.png`. The time is `frame / fps`, using the version's fps, falling back to the project's. Minutes are zero-padded to two digits, seconds to `SS.ss`. An example is `hero-60s_v3_00m12.10s_f726.png`. Grabbing the same frame twice overwrites the same file.
- **The toast** reads `Saved to screenshots/<name>`.
- **Attaching to a note:** the grab is still offered on the note box as a chip you can remove. Because the file is already saved, a grab on its own no longer counts as pending (§14.2). Only In/Out, a box or typed text does.
- **Old grabs:** notes that point at `.rushes/grabs/*.png` from Plans 1–2 keep working. `/media` serves both locations.

### 15.3 The Assets tab
- **Placement:** always the last tab, after Mix, with key `7`. It unlocks once the project has at least one asset: a cut, take, variant or screenshot.
- **Sections, in order:**
  - **Screenshots:** a thumbnail grid, newest first. Clicking a thumbnail shows it full size; Esc closes it.
  - **Cuts:** grouped by film, newest version first.
  - **Voiceover:** VO takes and voice variants.
  - **Music**
  - **Sound effects**
  - A section with nothing in it isn't shown.
- **Each row or tile** shows the file name, its folder (in mono), its size and when it was made. A file that's gone from disk is marked missing, and its actions are disabled.
- **Actions** are icon buttons with tooltips:
  - **Download:** a normal browser download, to Downloads.
  - **Save as…:** choose the folder and name. Shown only where the browser supports `showSaveFilePicker` (Chrome, Edge).
  - **Show in Finder:** "Show in Explorer" on Windows, "Open folder" on Linux.
  - **Copy path:** the absolute path, so you can paste it into a chat with your agent.

### 15.4 Server and agent
- **`GET /api/assets`** returns `{ assets: Asset[] }`. Each asset has:
  - `kind`: `screenshot`, `cut`, `take`, `music`, `sfx` or `voice`;
  - `path`: manifest-relative;
  - `abs`: the absolute path;
  - `name`;
  - `size` and `modified` (null when the file is missing);
  - `missing`;
  - plus `video`/`version`/`frame`/`t` for screenshots and cuts, `section` for takes, and `lane`/`variant` for variants.
  It covers every registered media file plus every `*.png` directly inside `screenshots/` and `.rushes/grabs/`.
- **`/media?path=…&download=1`** adds `Content-Disposition: attachment` with the file name, encoded per RFC 6266 and 5987. `/media` also serves `screenshots/<safe name>.png`.
- **`POST /api/reveal { path }`** reveals a file in the system file manager:
  - macOS: `open -R <abs>`;
  - Windows: `explorer.exe /select,<abs>`;
  - other platforms: `xdg-open <dir>`.
  It's spawned without a shell. Only paths that `/api/assets` would list are accepted; anything else is a 404. When `RUSHES_NO_REVEAL=1` is set, the server logs instead of opening anything. Tests set this.
- **The MCP tool `rushes_list_assets`** (optional `kind`) returns the same list. The CLI command is `rushes assets [--kind K] [--json]`. There are now 14 tools.
- **The project guard (§14.1)** applies to every one of these routes, as to any other.

## 16. The Assets library (agreed 3 October 2026)

Once a project has hundreds of screenshots, the Assets tab as one long page buries everything below them. Red also wants every project file in one place: music, scripts, images, captions, exports, deliverables and edit files, each one quick to find, open, download or locate on disk. This section is binding, and it wins over §15.3 where they differ.

### 16.1 Layout
- A **sidebar** on the left lists folders vertically, each with a count. Folders appear in this order: Screenshots, Cuts, Voiceover, Music, Sound effects, Scripts & docs, Images, Captions, Exports, Delivery, Edit files.
  - A folder with nothing in it isn't shown. The exception is Exports, which always shows, because it holds the "Export notes" action.
  - ↑ and ↓ move between folders while the sidebar has focus.
  - At the foot of the sidebar, **Project folder** reveals the project root in the file manager.
- The **main area** shows the selected folder. Its header holds the folder title and count, a search box, a sort control (Newest / Oldest / Name) and a grid/list toggle. A film filter appears too (All films, or one film) for Screenshots, Cuts and Delivery.
  - Search matches the name, the folder path, the version note and the film name.
  - Each folder remembers its grid/list choice for this browser (localStorage, wrapped in try/catch).
- **Views:**
  - Screenshots and Images default to a thumbnail grid. Screenshots are grouped under `Film · vN` headings when sorted by Newest or Oldest.
  - Cuts and Delivery default to grid. Each tile shows a poster frame: a muted `<video preload="metadata">` at `#t=0.5`.
  - Voiceover, Music and Sound effects default to list. Each row has an inline **Play/Pause** button. Only one plays at a time, and switching folders or tabs stops it.
  - Scripts & docs, Captions, Exports and Edit files default to list. Selecting a Markdown, plain-text or caption file shows a read-only preview on the right. Markdown is rendered by a small built-in renderer that escapes all HTML first: headings, paragraphs, lists, bold, italic, inline code and code blocks; links are shown as text, never made clickable.
- Thumbnails and posters load lazily, so a folder with hundreds of items stays responsive.

### 16.2 New kinds and how files get in
- **New asset kinds:** `doc`, `image`, `caption`, `export`, `delivery` and `edit`, alongside §15's `screenshot`, `cut`, `take`, `music`, `sfx` and `voice`.
- **Registered files.** `project.json` gains `files: [{ id, kind, file, name, note, video, addedAt }]`.
  - `video` is optional and ties a delivery or export to a film.
  - The agent adds files with `rushes_add_file` (`kind`, `file`, optional `name`, `note` and `video`, the video given by id or name).
  - The CLI equivalent is `rushes add file <path> --kind K [--name N] [--note T] [--video V]`.
- **Found automatically:**
  - every `*.md`, `*.txt` and `*.pdf` directly in the project root becomes a `doc`;
  - every `*.srt` and `*.vtt` directly in the root becomes a `caption`;
  - every file directly in `exports/` becomes an `export`.
  - Hidden files and anything inside `.rushes/` never appear.
- **Media types:** `/media` serves every listed asset, with content types added for `.md`, `.txt`, `.srt`, `.vtt`, `.pdf`, `.gif`, `.webp`, `.prproj` and `.drp`.

### 16.3 Open in the default app
- Every item gets an **Open** button (`POST /api/open { path }`). It runs the platform's open command, without a shell:
  - macOS: `open <abs>`;
  - Windows: `explorer.exe <abs>`;
  - elsewhere: `xdg-open <abs>`.
- **Safe types only.** Open is offered and accepted only for these extensions: md, txt, pdf, srt, vtt, png, jpg, jpeg, gif, webp, mp4, mov, m4v, webm, mkv, wav, mp3, m4a, aac, flac, ogg, prproj and drp.
  - Anything else gets no Open button, and the route answers 415 `unsafe_type`.
  - Rushes never opens scripts, apps or archives, because on macOS opening those can run code.
- **Where it applies.** The path must be a listed asset, exactly as for reveal.
- **No side effects in tests.** `RUSHES_NO_REVEAL=1` also turns Open into a logged no-op, so tests open nothing.

### 16.4 Export notes
- **The button.** The Exports folder has an **Export notes** button (`POST /api/exports/notes`).
- **What it writes.** It writes `exports/<project-slug>-notes-<YYYY-MM-DD>.md` and lists it in Exports. Exporting again on the same day overwrites that file.
- **What the file contains:**
  - a title and the export date;
  - then one section per stage. Picture notes are grouped by film and version, each with its timecode or range, its shot when it has one, its status, its text, the agent's reply and the screenshot path.
  - Script sections are not included; they live in `script.json`.
- **For agents and the CLI.** `rushes_export_notes` and `rushes export notes` do the same and return the path.

### 16.5 Tools
- The MCP tools `rushes_add_file` and `rushes_export_notes` bring the total to 16. `rushes_list_assets` accepts the new kinds.
- `POST /api/reveal { project: true }` reveals the project root.

## 17. Plan 3 decisions: the audio tabs (3 October 2026)

This section builds the Voiceover, Music, Sound effects and Mix tabs, following §6 and §8, §14.5 and the approved round-three mockup. Where the earlier sections leave a choice open, this section makes it, and it is binding.

### 17.1 Shared layout (Voiceover, Music, Sound effects, Mix)
- **Left: the tracks.** The tab title (with **Blind** on Music only), then the transport (back, play/pause, forward, timecode, In/Out, the range), then the lanes. Each lane has:
  - a name column, with a colour swatch per stage (VO teal `#4FD1C5`, music violet `#A78BFA`, SFX orange `#FB923C`) and the meta beneath (`120 BPM · A minor`, or a variant's `description`);
  - a waveform track 80px tall (52px for sub-lanes) carrying that lane's note markers and spans, and the playhead;
  - a control column: **Use** / **In use** on Music, SFX and voice variants and on takes, or **M** / **S** (mute/solo) on Mix.
- **Right: a picture preview and the notes.**
  - The preview is small, muted and follows the audio clock. It plays the locked cut if there is one, otherwise the newest cut.
  - The notes column is the existing Notes panel, plus three things:
    - an **On** menu that defaults to the lane you last clicked;
    - a **Point / Range / Whole** scope switch;
    - quick-start chips (Music: Tempo, Key, Energy, Ending · Voiceover: Level, Pace, Pronunciation, Breath · SFX: Timing, Level, Swap sound, Remove · Mix: Level, Balance, Loudness).
- **Quick marks (§14.5).** When the scope is Range on an audio tab, four toggle marks appear: **Rise**, **Fall**, **Louder**, **Quieter**. Louder and Quieter take a dB amount, chosen from 1, 2, 3, 6 or 9 dB with 3 as the default. They're saved on the note as `marks: [{ kind, db? }]`.
- **Where notes are shown.** A note is drawn on the lane it's `on`. Whole notes are listed but not drawn. On the Mix tab, a note on a stage lane is drawn on that lane.
- **Keyboard.** The same keys as Picture: Space, ←/→ to move one frame of the timeline at the project fps (Shift for ten), I and O, and N. Click a lane to select it.

### 17.2 Playback engine (web)
- **One clock.** A single `AudioContext` is the master clock. Every variant in a lane is decoded to an `AudioBuffer` and runs during playback through its own `GainNode`.
- **Switching.** **Use**, and the lane you're auditioning, are gain changes ramped over 4 ms on the same clock. That makes switching sample-locked, and the playhead never moves.
- **Seeking and stopping** restart every source at the new offset.
- **Timeline length** is the duration of the cut being previewed, or the longest audio when there's no cut.
- **Fallback for long files.** A file over 15 minutes, or one that won't decode, plays through a hidden `<audio>` element with drift correction instead. The lane's tooltip then says switching isn't sample-exact.
- **Video sync.** The preview video is muted. Whenever it drifts more than one frame from the audio clock, it's seeked back.
- **Waveforms.** Peaks are computed in the browser from the decoded buffer and cached per file revision for the session, keeping the 200 most recently used.

### 17.3 Music
- **Lanes.** One lane per variant of each `music` lane, in manifest order. The card shows the name, then `meta.description` (or BPM · key).
- **Use** sets `picks.lanes[laneId] = variantId`.
- **Unpick.** An icon button beside **In use** clears the pick: `PUT /api/picks { lanes: { laneId: null } }`. With nothing picked, the first bed is auditioned again.
- **Auditioning.** Clicking a lane auditions it: you hear that variant at the playhead, while the picked one stays marked **In use**.
- **Blind** replaces the names with `Bed 1…n` in a shuffled order for the session, and hides the meta. Turning it off reveals them.

### 17.4 Sound effects
- **Lanes.** Each `sfx` variant is a lane. Its cues are labelled on the waveform at their times.
- **What a note can be on.** The On menu lists the passes and each cue (`Cue · Swipe`). A note on a pass is saved with `on` set to `<lane id>/<pass id>`; a note on a cue with `<lane id>/<pass id>:<cue id>` and `t` set to the cue's time. Older notes are still drawn where they always were (§17.8).
- **Use** works as it does on Music.

### 17.5 Voiceover
> **Superseded by §18.** The assembled read, take sub-lanes, the section switch and New take are no longer shown. What follows is kept for the record.

- **The assembled read.** The top lane is the assembled read: for each script section, its picked take (`picks.sections[sectionId]`), or its newest take when none is picked, placed at the section's `start` and played to the end of its file. Section labels (`S1`, `S2` …) mark the lane.
- **Choosing a section.** A section switch (S1 … Sn) under the lanes picks a section. Its takes then appear as sub-lanes covering that section's span. **Use** on a sub-lane sets the pick.
- **Stale takes.** A take whose text no longer matches the section's current line (`isTakeStale`) carries a "stale" mark, with the tooltip "The line changed after this take".
- **Asking for a new take.** **New take** fills the note box with `Another take of S2: ` and sets On to that section.
- **Voice variants.** Variants of a `voice` lane, such as whole alternative reads, appear as extra lanes with **Use**, like Music.
- **No script, no read.** The assembled read and the section switch appear only once the script has sections, or a note already sits on the read. With whole reads only, the tab shows just those reads; the picked one, else the first, plays, and On defaults to it.
- **Unpick.** As on Music (§17.3), a take's pick clears with `PUT /api/picks { sections: { sectionId: null } }`. Only an explicitly picked take offers it, not one in use because it is the newest.
- **What a note can be on.** The read saves `on: "vo"`, a section its id, a take `"<section id>:<take id>"` and a voice variant `"<lane id>/<variant id>"`.

### 17.6 Mix
- **Lanes.** Three lanes: Voiceover (the assembled read, or a picked voice variant in its place), Music (the picked variant) and Sound effects (the picked pass), each with **M** and **S**. Only explicit picks play: an unpicked Music or Sound effects lane is empty, never stood in for by its first variant.
- **Mute and solo.** Solo wins over mute. With nothing soloed, every unmuted lane plays.
- **Loudness.** A loudness readout appears when the server has ffmpeg. `POST /api/mix/loudness { lanes: ["voice","music","sfx"] }` mixes the picked files at their offsets and returns `{ available, integrated, truePeak, musicUnderVo }`:
  - `integrated` is LUFS integrated;
  - `truePeak` is dBTP;
  - `musicUnderVo` is the music's level relative to the VO over the VO's span, in dB.

  The server measures exactly what the tab plays: the same picked voice variant or assembled read, the same picked music and SFX variants, and the same gaps for missing files. With a picked voice variant, the VO's span is that file's own length. Results are cached by their inputs and the VO span; a failed or timed-out run is never cached, and two requests for the same inputs share one run. Without ffmpeg the readout shows `—`, with the tooltip "Install ffmpeg for loudness". After a timeout or an error, clicking the readout measures again.
- **Empty lanes.** A lane with nothing picked, or whose file is missing, shows the missing mark ("Nothing picked" or "Missing") and is left out of the loudness request. With no lane left to measure, the readout shows `—` with the tooltip "Nothing to measure".
- **View state.** Mute and solo are never saved; they reset when you leave the tab. Only the lanes you hear are measured, 500 ms after the last change.
- **Notes.** The On menu lists the whole mix (`on: null`, drawn on every lane), Voiceover (`on: "vo"`) and the picked music and sfx variants (`on: "<lane id>/<variant id>"`).

### 17.7 Agent side
- **Notes** carry `marks`. `rushes_get_batch`, `rushes_list_notes`, export notes and the CLI all show them, e.g. `Fall · Quieter 3 dB`.
- **The batch prompt** for an audio stage tells the agent to read the picks (`rushes_get_picks`), fix each note, register new variants or takes, and reply.
- **Export and the CLI** say what an audio note is on, in words: `Music · Warm keys`, `Sound effects · Pass A · Cue · Swipe`, `S2 · Take 1`, `Whole mix`.

### 17.8 What a note is `on` (conventions)
- **Values.** `null` (Picture, or the whole mix on Mix); `"<lane id>/<variant id>"` for a variant on Music, Sound effects, Voiceover or Mix; `"<lane id>/<variant id>:<cue id>"` for an SFX cue; `"vo"` for the assembled read, or Mix's VO lane; `"<section id>:<take id>"` for a take; a section id for a section.
- **Why lane-qualified.** Variant ids are unique only within their lane. Lane ids are unique across the project, and both are slugs (`[a-z0-9-]`), so `/` and `:` can't be part of either. A music bed and an SFX pass both called "Option A", or two music lanes each with an "A", can't be confused, and no variant `on` can equal `"vo"` or a section id.
- **Resolution order.** 1. the exact lane-qualified variant or cue; 2. `"vo"`; 3. a take; 4. a section; 5. the older bare forms: a bare variant id (the first lane with it; on Mix, a variant being heard first), a bare `"<pass id>:<cue id>"`, or a bare cue id (the first pass with it). Older notes draw exactly where they did before.
- **Section ids.** `rushes_set_script` refuses a new section id of `"vo"` or one containing `:` or `/`. Existing ids still load and update, and the stored schema doesn't check `on` at all.

## 18. Voiceover rounds (agreed 3 October 2026)

**Why.** Red found the Plan 3 Voiceover tab too detailed. The assembled read, the take sub-lanes and an S1–S18 switch below the fold buried the actual job.

By the time there is voiceover, the script has already been corrected on the Script tab. So the Voiceover tab only judges whole reads:
- Does the track work overall?
- Do we like the speaker?
- Is the pacing right?
- Is the tone right?

Markers are only for the odd garbled word or phrase.

Real VO work moves in rounds:
1. the same script read by several voices (e.g. Jane, Louise, Gerald);
2. one voice picked;
3. variations of that voice (more excited, more sombre).

This section is binding and replaces §17.5.

### 18.1 Two tabs, two jobs
- **Script is what's said.** Wording is fixed there before or between VO rounds. Edit a line (your version beside the agent's) and add a direction if you like. **Send to agent** batches the changed rows, as now.
- **Voiceover is how it sounds.** It holds whole reads only. Every fix comes back as a new whole read. Rushes never assembles audio itself.

### 18.2 Rounds
- **A round is a `voice` lane.** The lane's name is the round's name, e.g. "Round 1 · Voices" or "Round 2 · Gerald, tone".
- **Rounds are ordered by creation.** The newest is the current round.
- **Each round has its own pick** (`picks.lanes[laneId]`). It is set with **Use** and cleared with Unpick, as now.

### 18.3 The tab
- **The header** shows the title and **Blind** (now on Voiceover as well as Music, so voices are judged without names), then the transport. There is no script ruler.
- **The current round is open.**
  - Its name heads the group.
  - Each read is one lane with the name (e.g. "Gerald · more sombre") and its one-line `description` beneath, the waveform, then **Use** or **In use** with Unpick.
  - A name or description too long for its column is cut with an ellipsis and shows in full in a tooltip on hover.
- **Earlier rounds are folded.**
  - Each one is a single row, e.g. "Round 1 · Voices · 3 reads · picked Gerald".
  - Clicking it opens the round's lanes beneath it, and they play like any other lane.
  - More than one round can be open at once.
  - The row shows a dot when the round has open notes.
- **Gone from view:** the assembled read, take sub-lanes, the section switch, New take, any script ruler, and range spans.
- **Playback.**
  - One read is heard at a time.
  - Clicking a lane switches to it, sample-locked, with the playhead unchanged.
  - With nothing clicked, the current round's pick plays, otherwise its first read.
- **Notes.** Voiceover notes take one of two scopes, **Whole** (the default) or **Point**. There is no Range scope and there are no Rise/Fall/Louder/Quieter marks on this tab.
  - A Whole note is about the read as a whole: speaker, pacing, tone, or whether it works.
  - A Point note puts a marker on the read at the playhead: a garbled word, or a bit to keep.
- **Chips.**
  - With Whole, the chips are **Speaker**, **Pacing**, **Tone** and **Overall**.
  - With Point, they are **Fix this** and **Keep this**.
- **On.**
  - On defaults to the lane you last clicked; otherwise it is the current round's pick, otherwise the first read.
  - Its label is the read's name only. The round is shown by the group, and the full "Round 2 · Gerald · more sombre" is in the tooltip.
  - `on` is `"<lane id>/<variant id>"` (§17.8).
- **Where notes show.** Point notes are drawn as markers on their read's lane, including in a folded round once it's opened. Whole notes are listed and not drawn.
- **Fits on one screen.** With up to four reads in the current round, everything sits above the fold at 1440 × 900.

### 18.4 Data
- **Naming rounds.** `rushes_add_variant` gains `round`, the round's name.
  - With `round` and no `lane`, the lane id is the round name slugged.
  - A new lane is created on first use, with `round` as its name.
  - `lane` still works and wins.
  - The CLI gains `--round NAME`.
- **No new fields on variants.** What a read is based on goes in its `description`, e.g. "Based on more sombre, slower intro".
- **Takes.**
  - Takes and `rushes_add_take` stay in the file format and API for compatibility.
  - The dashboard and the mix ignore them, and AGENTS.md and SKILL.md stop recommending them.
  - Plan 4 decides whether to remove them.
- **Mix (§17.6).**
  - The VO lane plays the pick of the newest round that has one.
  - If no round has a pick, the lane shows "Nothing picked" and is left out of loudness, like Music and SFX.
  - The VO span used for music under VO is that read's own length.
- **Unlocking.** The tab unlocks when a `voice` lane has at least one read (§6).

### 18.5 Agent side
- **The Voiceover batch prompt** says:
  1. Read the picks.
  2. Answer the notes with new whole reads: in a new round for a new direction (other voices, a tone), or in the current round for a small fix to a marked word. Say in each read's `description` what changed.
  3. Reply.
- **The Script batch prompt** is unchanged, apart from this: when VO already exists, the agent re-records the picked voice with the corrected script and registers it as a new read in a new round.
- **Export and the CLI** name a voice note's read by its round and name, e.g. `Round 2 · Gerald · more sombre`.

## 19. Plan 4: ready for other people (agreed 4 October 2026)

**Why.** Rushes does the job. Plan 4 makes it easy for someone else to pick up, try and trust. Red agreed the order, the proxy behaviour, the levels and the locked-tab behaviour on 4 October 2026, and reviewed the mockup. This section is binding.

### 19.1 Locked tabs explain themselves
- **Every tab is always visible**, from the very start of a project, in workflow order.
- **A locked tab can be opened.** It never just shows a toast. Its page shows:
  - the tab's icon and name;
  - one sentence on what the tab is for, e.g. "Compare music beds against the picture and pick one";
  - what unlocks it, in plain words, e.g. "Your agent adds music beds to this project";
  - **Copy prompt for your agent**, which copies a ready-to-paste request naming the project and film, and the tool the agent should use, e.g. `In Rushes project "Launch", make two or three music beds for "Hero" and add each with rushes_add_variant (stage "music") with a one-line description.`
- **No notes column on a locked tab.** There's nothing to note yet.
- **Hovering a locked tab** shows a tooltip, e.g. "Locked: ask your agent for music beds".
- **Assets follows the same rules.**

### 19.2 Example project: `rushes demo [dir]`
- **What it makes.** It creates a ready-to-explore project in `dir` (default `./rushes-demo`), then opens it.
- **All media is generated on the user's machine.** Nothing is downloaded and nothing ships in the package. It contains:
  - a 30 s test-pattern film with burnt-in timecode, in two cuts (v1 and v2), with shots;
  - a short script in four sections;
  - **voice reads in two rounds.** These use the system's text-to-speech where there is one (macOS `say`). Otherwise they are clearly labelled placeholder tones;
  - two music beds (synthesised chords at two tempos);
  - one SFX pass with cues;
  - example notes on Picture, Voiceover, Music and Mix.
- **Requirements.** It needs ffmpeg. Without it, `demo` says so in one line, points to `rushes doctor`, and exits without creating anything.
- **Never overwrites.** It refuses to write into a non-empty folder.

### 19.3 Health check: `rushes doctor`
- **What it checks**, one line each with ✓ or ✗ and a plain fix:
  - the Node version (≥ 20.19, or ≥ 22.12 on the 22 line);
  - ffmpeg and ffprobe on the PATH, with their version;
  - which agent harnesses have the Rushes MCP registered (reusing `setup`'s detection);
  - whether a Rushes server is running for this folder (port, project id);
  - whether the project files are valid;
  - free disk space when there are proxies.
- **Output.** `--json` gives the same checks as data.
- **Exit code.** It exits non-zero if a required check fails. ffmpeg is recommended, not required.
- **For agents.** The MCP tool `rushes_doctor` returns the JSON.

### 19.4 Tested on every change
- **What CI runs.** A GitHub Actions workflow runs on each push and pull request:
  - Node 20.19 and 22.x;
  - `npm ci`, build, typecheck and vitest;
  - Playwright in **Chromium and WebKit**, with ffmpeg installed so the probe and loudness paths are exercised;
  - `npm pack --dry-run`, failing if anything outside the allowed files would ship.
- **WebKit fixes** that must land with it:
  - the test setup only grants clipboard permissions where the browser supports them;
  - **a box drawn on a vertical cut is measured against the picture in Safari**. Today it is measured against the 16:9 frame, which is a real bug.

### 19.5 Proxies: the user's choice, never silent
- **When Rushes offers one.** For a cut that's likely to play badly:
  - 4K or larger on either edge;
  - over 1.5 GB;
  - a codec browsers can't play reliably (ProRes, DNx, HEVC 10-bit, anything that isn't H.264, VP9 or AV1);
  - or the browser reports a playback error.

  The server works this out with ffprobe when the cut is added. Without ffmpeg, nothing is offered.
- **The offer** is a bar under the player. It says why in a few words (e.g. "It's a 4K ProRes file (2.3 GB), which browsers struggle with"), then has a **Create proxy** button. The button's tooltip reads: "Makes a lightweight 1080p copy on your drive so this cut previews smoothly. About N MB. Your original isn't changed."
- **While it's made.**
  - The bar reads "Creating proxy", with progress in % and **Cancel**.
  - Cancel stops ffmpeg and deletes the partial file.
  - Progress reaches every open tab over SSE.
- **When it's done.**
  - "✓ Proxy ready", with its path and size.
  - A **Proxy / Original** switch appears on the player, with tooltips. It defaults to Proxy, and the choice is remembered per film.
  - Notes, timecodes and frame numbers are identical on both.
- **The checkbox.** "Create proxies for new cuts like this automatically" is saved per project (`project.json`, `autoProxy`) and off by default. When it's on, a new cut that meets the criteria starts a proxy straight away, with the same visible progress and Cancel.
- **The file.**
  - It goes in a visible `proxies/` folder, named `<film-slug>_<version>_proxy.mp4`.
  - It is H.264, at most 1920 px on the long edge, same frame rate and duration, yuv420p, AAC audio, with faststart.
  - Its record (`file`, `width`, `height`, `bytes`, `createdAt`) is stored on the version as `proxy`.
- **Assets** gets a **Proxies** folder listing each proxy with its size, and a **Delete proxy** button. Deleting removes the file and the record. The original is never touched.
- **Grab Frame** always takes the still from the **original**, at full quality. The server extracts the exact frame with ffmpeg, so the still is the same whichever file is playing.
- **Agents.** `rushes_add_version` returns `proxySuggested: true` and a reason when a cut meets the criteria.

### 19.6 Levels on Mix
- **The slider.** Each Mix lane (Voiceover, Music, Sound effects) has a level slider:
  - −24 dB to +6 dB in 0.5 dB steps;
  - the value shown as e.g. `−14.0 dB`;
  - double-click resets it to 0;
  - arrow keys move it 0.5 dB at a time;
  - it is labelled for screen readers.
- **Stored in `picks.json`** as `levels: { voice?, music?, sfx? }` in dB, defaulting to 0. `PUT /api/picks` accepts them, and `null` resets one to 0. `rushes_get_picks` returns them.
- **Playback.**
  - Each lane's gain is the level combined with mute and solo, ramped like any other gain change.
  - Levels never change files.
- **Loudness** (§17.6) applies the levels before measuring, and the cache key includes them.
- **The Mix batch prompt** tells the agent that levels are where the user wants each lane to sit.

### 19.7 Publishing to npm
- **What ships.** The package publishes as `rushes`. `files` lists only `dist`, `web-dist`, `skills`, `.claude-plugin`, `.mcp.json`, `README.md`, `AGENTS.md` and `LICENSE`, so no tests, fixtures, docs or plans ship.
- **The build.** `prepublishOnly` runs the build and the tests.
- **The source switch.** The `SOURCE` constant is now `rushes`, and the docs switch from `github:iamredmh/rushes` to it in the same release (README keeps one line noting the GitHub form still works before the npm publish lands). `LEGACY_SOURCES` keeps the old `github:iamredmh/rushes` launch recognised: `rushes setup` finds a harness already registered that way and switches its registration to the npm launch in place, rather than adding a duplicate, and `rushes doctor` still reports it as registered (with a detail saying it's on the older GitHub launch) rather than missing.
- **Publishing is done with Red, not by an agent alone.** Red runs `npm login` once in Terminal, which confirms in the browser. Then, with Red's OK at the time, `npm publish`. If npm asks for a one-time code, Red enters it.

### 19.8 Follow-ups folded in
- **Voiceover memory.**
  - Only decode the current round, opened folds and the selected read.
  - A folded round's buffers are released, under a small LRU cap.
- **Re-rendering a file mid-play** no longer stops playback. That lane rejoins once it decodes.
- **Space on a focused button** activates the button, e.g. "Measure again", instead of playing.

### 19.9 Picture waveform
- **Where it shows.** A quiet waveform of the cut's own audio inside Picture's timeline bar.
  - The bar keeps its height, so nothing in the layout moves.
  - It's drawn in a muted grey-blue (`--text-3` at low opacity), under the ranges, shot ticks, note markers and playhead.
  - It's a `<canvas>` scaled for the screen's pixel ratio and redrawn only when its peaks, its size or the timeline's length change, never per frame. It's `aria-hidden`, since the slider already has a label.
- **How the server makes it.**
  - When a cut is added, or the dashboard asks for one that has none, ffmpeg decodes the **original's** first audio stream (never a proxy's), mono at 8 kHz as raw floats, and the server reduces it while it streams to about 2000 buckets, each the largest absolute amplitude, normalised to 0..1. A long film is never held in memory.
  - Audio that starts after 0:00 is padded with silence from 0:00 (`aresample=async=1:first_pts=0`), so the waveform lines up with the picture.
  - ffmpeg reads only local files (`-protocol_whitelist file,pipe`) in ordinary video and audio containers (`-format_whitelist`), so a playlist or concat list registered as a cut is refused rather than followed to other files or the network.
  - Decodes run in the background, two at a time and never twice for the same cut, and are killed when the server closes. Each has a timeout of 60 s plus the file's size read at 5 MB/s, held between 5 and 60 minutes. `GET /api/state` never waits on one.
  - The result is `.rushes/peaks/<video>_<version>_<hash>.json`, where the hash is of the file's path, size and mtime: `{ "v": 1, "buckets": 2000, "duration": 68.67, "peaks": [0..1, 3 decimals] }`. A cut with no audio stream is saved as `{ "v": 1, "audio": false }`, so it isn't decoded again on the next start.
  - It's written to a temp name and renamed into place. At start-up, a temp file left by a stopped server is deleted, and so is any peaks file in `.rushes/peaks/` that no current cut owns (by its `<video>_<version>_` prefix). Only names Rushes writes are ever removed, and a `.rushes/peaks` that is a link to another folder is never swept or written into. A peaks file is only read when it's under 64 KB with at most 2000 peaks in 0..1, matching its `buckets`; anything else is made again. A failed decode writes nothing (it's remembered until the server restarts). When the file is re-rendered, the old revision's peaks file for that cut is removed. A file rewritten with its size and mtime both kept (`cp -p`, `rsync -t`) looks unchanged, so it keeps its old waveform until either changes.
  - A `change` event goes out when a peaks file lands, so open tabs ask again.
- **The route.** `GET /api/videos/:video/versions/:version/peaks`, behind the same project guard as every other route:
  - 200 with the JSON when it's ready;
  - 202 while it's being made;
  - 204 when the cut has no audio;
  - 501 `{ "error": "no_ffmpeg" }` without ffmpeg;
  - 404 `missing_file` when the original isn't there, and 422 `no_peaks` when the decode failed.
- **The dashboard.**
  - It asks for the shown cut's peaks. On 202 it asks again when the next `change` arrives, or after a gentle back-off.
  - On 501, a cut under 100 MB and 15 minutes (the length as the player reads it) is fetched through `/media` and decoded in the browser (`decodeAudioData`, then `mixPeaks`, which takes `computePeaks` of each channel); anything larger or longer, or a length the player never learns, gets no waveform.
  - The browser's decoder gives the samples but not when the audio starts, so in the fallback a cut whose audio starts late is drawn from 0:00, early by that much. The server's waveform doesn't have this problem.
  - On 204, or any other answer, nothing is drawn.
  - Results are cached per version and file revision. Switching versions or films never shows the previous cut's waveform.
