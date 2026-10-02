# Rushes

A local review desk for video made with AI agents.

Your agent renders a cut, writes a voiceover script or generates music beds. Rushes shows that work stage by stage in your browser:

- **Script:** your edits sit beside the agent's lines.
- **Picture:** timecoded notes, ranges, boxes on the frame and frame grabs.
- **Voiceover, Music, Sound effects:** variants you can switch between with no gap.
- **Mix:** everything playing together.

Your notes are saved as plain files in your project. The agent reads them, fixes things and replies on each one, and you see each reply arrive.

It runs on your machine. There's no account, no API key and no server to sign up for. You need [Node.js](https://nodejs.org) 20.19 or newer (or 22.12+ on the 22 line), and git (needed to install straight from GitHub until Rushes is on npm).

> Status: early. The Script and Picture tabs, the MCP tools and the CLI work today. The audio tabs (Voiceover, Music, Sound effects, Mix) are next.

## Get started

Tell your agent:

> Use github.com/iamredmh/rushes as my review tool for video, voiceover and music.

That's all. Your agent reads the next section and sets itself up.

## For agents: set yourself up

If your user asked you to use Rushes, do this:

1. Run this once. It finds every supported harness on the machine and registers the Rushes MCP server, plus the Rushes skill where the harness supports skills:

   ```bash
   npx -y github:iamredmh/rushes setup
   ```

   It prints one line per harness. Existing config is kept and a `.rushes.bak` backup is written first. Run it with `--dry-run` first if you want to show the user the changes before making them.
2. If it added anything, tell the user to restart the app (or start a new session) so the `rushes_*` tools load.
3. From then on, follow [AGENTS.md](AGENTS.md). In short: register what you made, call `rushes_open`, wait for the user to press **Send to agent**, then `rushes_get_batch`, fix the notes, and `rushes_reply`.

The MCP server has eleven tools: `rushes_open`, `rushes_status`, `rushes_add_version`, `rushes_add_variant`, `rushes_set_script`, `rushes_get_script`, `rushes_add_take`, `rushes_list_notes`, `rushes_get_batch`, `rushes_reply` and `rushes_get_picks`.

If you can't run commands, give the user the matching line from **Manual setup** below.

## Manual setup

| Harness | How |
|---|---|
| **Claude Code**: plugin, which includes the skill | `/plugin marketplace add iamredmh/rushes` then `/plugin install rushes@iamredmh` |
| **Claude Code**: MCP only | `claude mcp add --scope user rushes -- npx -y github:iamredmh/rushes mcp` |
| **Codex** | add to `~/.codex/config.toml`:<br>`[mcp_servers.rushes]`<br>`command = "npx"`<br>`args = ["-y", "github:iamredmh/rushes", "mcp"]` |
| **Cursor** (`~/.cursor/mcp.json`), **Claude Desktop** (`claude_desktop_config.json`), **Gemini CLI** (`~/.gemini/settings.json`) | `{ "mcpServers": { "rushes": { "command": "npx", "args": ["-y", "github:iamredmh/rushes", "mcp"] } } }` |

On Windows, `rushes setup` writes the launch as `cmd /c npx -y github:iamredmh/rushes mcp` (in JSON: `"command": "cmd", "args": ["/c", "npx", "-y", "github:iamredmh/rushes", "mcp"]`), because harnesses can't start `npx` directly there. Do the same if you set it up by hand.

### Other harnesses

Any MCP client that can launch a local stdio server works. Point it at `npx -y github:iamredmh/rushes mcp`. Agents with no MCP support can use the CLI instead (`rushes add`, `rushes notes`, `rushes reply`): see [AGENTS.md](AGENTS.md).

ChatGPT's apps can't run local MCP servers yet. Use Codex, OpenAI's agent, instead.

## Use it yourself

```bash
cd your-project
npx -y github:iamredmh/rushes open    # opens the review desk in your browser
npx -y github:iamredmh/rushes stop    # stops it
```

A server your agent starts in the background stops by itself after two hours with nothing connected.

## Shortcuts

In the Picture tab:

- **Space** play or pause
- **←/→** step one frame (Shift: ten)
- **I/O** set in and out
- **B** draw a box
- **G** grab a frame
- **N** new note

Anywhere:

- **1–6** switch tab
- **?** shortcuts
- **Esc** close

## What gets saved

```
your-project/.rushes/
  project.json   videos, versions, audio lanes and variants
  script.json    VO sections: the agent's line, your version, direction, takes
  notes.json     every note, with the agent's replies
  picks.json     which variant or take is in use
  batches.json   what you sent to the agent
  grabs/         frame grabs
```

Add `.rushes/` to git if you want your review history kept with the project. Rushes ignores its own temporary files.

## Develop

```bash
git clone https://github.com/iamredmh/rushes && cd rushes
npm install
npm test
npm run rushes -- open ../some-project
```

ffmpeg and ffprobe are optional. With them installed, Rushes reads frame rates and durations and can make browser-playable copies.

## Licence

MIT © Red Morley Hewitt
