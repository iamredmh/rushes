# Rushes, for agents

Rushes is a local review desk. Your user watches the work in a browser, leaves timecoded notes, edits the script and picks audio variants. You read that feedback, act on it, and reply. Everything is saved in the project's `.rushes/` folder, and one local server is the only thing that writes to it.

## Setup (once per machine)

```bash
npx -y github:iamredmh/rushes setup
```

This registers the Rushes MCP server with every supported harness it finds (Claude Code, Codex, Cursor, Claude Desktop, Gemini CLI), and installs the skill where the harness supports skills. If it added anything, ask the user to restart the app. Use `--dry-run` to preview, and `--only claude-code,codex` to limit it.

## The loop

1. **Register what you made.**
   - A render: `rushes_add_version` with `video` and `file`. Run it again for each new cut.
   - A VO script: `rushes_set_script` with sections `{start, end, current}` in seconds. It merges by `id`: send only the sections you changed, with their ids, plus any new ones without an id. Sections you leave out are kept, with their takes. Pass `replace: true` only when you mean to replace the whole script. `rushes_get_script` reads the whole script back.
   - VO takes: `rushes_add_take` for each section.
   - Music beds, SFX passes or alternative VO lanes: `rushes_add_variant` with `stage` `music`, `sfx` or `voice`.
2. **Open it for the user:** `rushes_open`. A tab unlocks as soon as it has something in it.
3. **Wait for feedback.** The user presses **Send to agent**, which saves a batch and gives them a prompt to paste to you. Call `rushes_get_batch` to read the latest batch, its notes and any changed script sections.
4. **Fix each note.** A note has `stage`, `scope` (`point`, `range` or `whole`), `t`, `tOut`, `on` (the lane, variant, take, cue or section it's about), `text`, and optionally `box` (normalised 0 to 1) and `grab` (a PNG path in `.rushes/grabs/`).
5. **Register the new cut** with `rushes_add_version` and note what changed.
6. **Reply to every note** in one `rushes_reply` call. For each, set `status: "done"`, a one-line `reply`, `fixT` (when the fix is visible in the new cut, in seconds) and `fixVersion`. If you didn't fix a note, leave it `todo` and say why in `reply`.
7. **Script batches.** When a section's `proposed` differs from `current`, the user rewrote the line. Adopt it by calling `rushes_set_script` with just that section's `id`, `start`, `end` and the new `current`; the other sections stay as they are. The proposal then clears itself, and a flagged section goes back to draft. A changed line makes that section's existing takes stale, so record new takes and add them.

## Tools

The MCP server has eleven tools: `rushes_open`, `rushes_status`, `rushes_add_version`, `rushes_add_variant`, `rushes_set_script`, `rushes_get_script`, `rushes_add_take`, `rushes_list_notes`, `rushes_get_batch`, `rushes_reply` and `rushes_get_picks`. Each takes an optional `project` folder, which defaults to the folder the harness started in.

## Rules

- Never edit `.rushes/*.json` by hand while the server is running. Use the tools, or the CLI (`rushes add`, `rushes notes`, `rushes reply`).
- You own a note's `reply`, `fixT` and `fixVersion`. The user owns its text, times and box. Either of you can set `status`.
- Times are seconds from the start of the video, as numbers (e.g. `31.05`).
- A server you start through the tools stops by itself after two hours with nothing connected. The next tool call starts it again. `rushes stop` stops it now.
- Prefer H.264 MP4 for cuts: browsers can't play ProRes, and some can't play HEVC.

## Without MCP

```bash
npx -y github:iamredmh/rushes open
npx -y github:iamredmh/rushes add version renders/hero_v2.mp4 --video "Hero 60s" --note "logo hold"
npx -y github:iamredmh/rushes notes --stage picture --status todo --json
npx -y github:iamredmh/rushes reply n_8f2k3a "Held the phone 0.5 s longer" --done --fix-t 12.9 --fix-version v2
```
