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
- `on` names what the note is about. It's `null` for picture, or a lane, variant, take, cue or section id on the other tabs.
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
| Voiceover | any section has a take, or a `voice` lane has at least one variant | Assembled read, with the selected section's takes lined up under it in real time | Picture preview, notes |
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
- Variant cards carry a name and a one-line description (`meta.description`), like the Night Drive set. Switching variants keeps the playhead.
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
  screenshots/          frame grabs        hero-60s_v3_00m12.05s_f726.png
  exports/              (later) notes and markers for Premiere and Resolve
  .rushes/              Rushes' own records (hidden; not for editing by hand)
```

Rushes creates `screenshots/` itself on the first grab. It never creates the other folders; they're a convention for agents.

### 15.2 Screenshots
- **G and the camera button** save the frame as a PNG to `screenshots/{video}_{version}_{MM}m{SS.ss}s_f{frame}.png`. The time is `frame / fps`, using the version's fps, falling back to the project's. Minutes are zero-padded to two digits, seconds to `SS.ss`. An example is `hero-60s_v3_00m12.05s_f726.png`. Grabbing the same frame twice overwrites the same file.
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
