# Rushes: design spec

**Date:** 2 October 2026
**Owner:** Red Morley Hewitt (`iamredmh`)
**Status:** Approved, 2 October 2026
**Layout reference:** the round three mockup, https://claude.ai/artifact/JMHzZuUHo4pRSZ34Z2Jnnr

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

The Caffeine Shorts and OISY Tips review pages proved the core loop. Rushes keeps:
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
There are eleven tools. Every tool takes an optional `project` path, which defaults to the working directory.

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
- **Requirement:** Node.js 20 or newer. ChatGPT's apps can't launch local MCP servers, so the README points ChatGPT users to Codex.

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
