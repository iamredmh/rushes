# §32 Send to AI is set up once per Mac

## 32.1 The problem

Send to AI keeps the user's answer to the first-Send sheet ("Who should get these notes?"), the agent they chose and what it may do in a rules file per project (`<config>/rushes/agent-rules/<sha16(realpath root)>.json`, R10). A new project has no file, so it starts not set up, and the sheet appears again on every project's first Send. Red (19 Nov 2026): "once you have Rushes connected to Claude, that should be it… not every time a new Rushes project launches."

## 32.2 Decision (Red, 19 Nov 2026)

Send to AI is set up once per Mac. The user's last choice is the default for every new project.

## 32.3 The default

- `<config>/rushes/agent-defaults.json`, beside `agent-rules/`: `{ agent, permissions }`. `agent` is `claude`, `codex` or `null` (Copy a prompt). The folder is 0700, the file 0600, and writes are atomic (tmp + rename), as for the rules files. Code: `src/server/agent/rules.ts` (`AgentDefaultsFile`), `src/server/agent/setupOnce.ts`.
- **When it is written** (last choice wins): the user answers the sheet (an agent, with what it may do; or Copy a prompt, which sets `agent: null`), changes what the agent may do in the agent menu, picks an agent in the menu, or turns the switch on. Turning Send to AI off on one project does not change it. The desk's Copy a prompt sends `prompt: true` to `POST /api/agent/setup`, so the route can tell it from the switch turned off.
- **Always rules are never in it.** They stay per project.
- A default that can't be read, or is damaged, is no default: the sheet asks, and its answer writes the default again.

## 32.4 New projects

- A project with no rules file of its own starts from the default the first time the desk loads it (`GET /api/agent`), when the server starts, or on its first Send, whichever comes first, once per server: its rules file is written as `setUp: true`, the default agent, the default permissions and `always: []`. When the default names an agent, the project's `agent.json` is turned on for that agent (a session for another agent is dropped). Send then goes straight to the agent, with no sheet.
- With no default yet, nothing changes: the sheet asks once, and its answer becomes the default.
- A project that has a rules file keeps it. The default is only ever read for a project with none.
- **The default agent isn't available** (not installed, or not signed in): Rushes does not fall back to another agent. Send is refused, and the refused-Send banner and Send again (I3) say why and hand the notes over once the agent is ready.

## 32.5 Consent (R10) is kept

The default is the user's own file, outside every project. Nothing in a project folder is read to decide whether Send to AI is set up: a project's `agent.json` turned on, or files named like the default or a rules file inside the project, still hand nothing over until the user's own rules file names the same agent. A project whose `agent.json` names another agent goes to the user's default agent, never the project's.

## 32.6 With the tests

Each vitest worker has its own config folder and starts every test with no default (`test/helpers/configDir.ts`), and every e2e server gets its own `XDG_CONFIG_HOME`, so a default set while testing, or on the Mac running the tests, never sets up another test's project.

Replaces: the per-project first-Send sheet in README ("The first time you press Send…"), which now asks once per Mac.
