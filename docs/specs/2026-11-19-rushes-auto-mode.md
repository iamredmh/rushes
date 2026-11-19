# §33 The permission menu: Manual, Accept edits, Auto, Bypass

## 33.1 The problem

Red (19 Nov 2026), on the Rushes desks: "there's still too many instances of allow once all the time." Under "Edit files in this project" every shell command asks. An Always rule is a command's first two words (`alwaysWords`, `src/core/agentRules.ts`), so for `cp` or a script, whose second word is a file path, the rule never matches again. Chained and piped commands always ask, and Always rules are per project.

## 33.2 Decision (Red, 19 Nov 2026: "Yes, add Auto")

One permission menu, four rows, the same for both agents, in the agent menu and the first-Send sheet's second step:

| Row | Help line | Claude Code runs in | Codex runs in |
|---|---|---|---|
| **Manual** (`ask-all`) | Always ask | `default` (asks Rushes) | `read-only` (asks Rushes) |
| **Accept edits** (`project-edits`) | Edit files in this project without asking | `default` (asks Rushes) | `read-only` (asks Rushes) |
| **Auto** (`auto`) | The agent decides: its own safety check approves or refuses each step. Rushes sees only what it asks, and no longer guards .rushes and .git | `auto` (Claude's classifier) | `agent` (Codex "Auto review") |
| **Bypass** (`bypass`) | Accepts everything: nothing asks, nothing is checked, .rushes and .git included | `bypassPermissions` | `agent-full-access` |

The ids of the first two are kept, so rules files written before §33 still read. Code: `AgentPermissionsSchema` (`src/core/schema.ts`), `AGENT_MODE` (`src/server/agent/adapters.ts`), `PERMISSION_CHOICES` (`web/src/agent.ts`).

## 33.3 The modes, checked against the installed adapters (19 Nov 2026)

- Claude (`claude-agent-acp` 0.107.3): `auto` and `bypassPermissions` are in its mode catalog (`dist/session-mode.js` `buildAvailableModes`), and `claude --permission-mode` takes the same ids. `bypassPermissions` is offered only when not running as root outside a sandbox and not disabled in settings; `auto` only when the user's settings don't disable it. When the session's model can't run auto, the adapter falls back to `acceptEdits` (`AUTO_MODE_FALLBACK`): edits go through, commands still ask Rushes. The runner accepts that fallback for Auto and says so in Activity.
- Codex (`codex-acp` 2.7.0, README `INITIAL_AGENT_MODE`): `agent` (approvals reviewer "auto_review") and `agent-full-access` (approval policy "never").
- A mode the session doesn't offer fails the start closed, and the notes go back to to do, as for the ask mode (R14, R15).

## 33.4 Rules

- **Only the user picks Auto or Bypass**, from the agent menu or the sheet. The row is kept in the user's rules file outside the project (R10); `permissions` in a project's `agent.json` is never read.
- **In Auto and Bypass Rushes is no longer the gatekeeper** for `.rushes` and `.git`. What the agent still asks in Auto is decided as under Accept edits; in Bypass it is allowed.
- **Bypass shows a one-line warning** when picked, in the menu and the sheet. It is never a default: a new project that would inherit Bypass from the §32 Mac-wide default starts in Accept edits.
- **Auto may be the Mac default** (§32): picked once, new projects start in Auto.
- **A brand-new Mac starts in Accept edits.** The sheet's second step has Accept edits picked, and Bypass last.
- **A batch already running keeps the row it started in.** A change applies from the next Send. Each Send carries the row it was made under; when it differs from the running agent's, the agent is started again in the new mode, loading the same conversation, before that Send's turn. While a batch runs in Auto or Bypass, what it asks goes by that row. While it runs in Manual or Accept edits, a switch between those two applies to Rushes's own decisions at once, as before §33; a switch to Auto or Bypass waits for the next Send.
- **Red's projects are not changed.** No stored rules or Mac default are rewritten by this release; Auto is picked in the menu.

## 33.5 Tests

Unit: old ids read; each row maps to its Claude and Codex mode (configOptions, set_mode, INITIAL_AGENT_MODE); Auto and Bypass fail closed when not offered; Claude's acceptEdits fallback; Bypass allows and Auto decides as Accept edits; a running batch keeps its row and the next Send restarts the agent in the new one; an idle agent restarts on a row change; Bypass is never adopted from the default and Auto is; nothing in agent.json sets a row (R10). e2e: the menu's four rows and the Bypass warning; the sheet's four rows; a §32 second project inheriting Auto.
