import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentId, AgentPermissions } from "../../core/schema.js";
import type { AdapterSpec, McpServerSpec } from "./acp.js";
import type { AgentInfo } from "./detect.js";
import { cacheDir } from "./connectors.js";
import { searchPath } from "./spawn.js";
import { RUSHES_SERVER } from "./ownTools.js";

/** The adapters and their pinned versions live with the fetch that installs them (§34). */
export { ADAPTERS } from "./connectors.js";

/*
 * R14/R15: the session mode in which the agent asks Rushes (session/request_permission) before it acts, instead of
 * approving its own actions. The runner sends session/set_mode with it after every session/new and session/load,
 * when the session offers it. Used for Manual and Accept edits, the two rows where Rushes is the gatekeeper. Never
 * acceptEdits, plan or dontAsk (Claude). The modes where the agent, or its own reviewer, decides (Claude's auto and
 * bypassPermissions, Codex's agent and agent-full-access) are used only for the Auto and Bypass rows (§33, AGENT_MODE
 * below), which only the user picks, from the agent menu or the first-Send sheet, never from anything in the project.
 *
 * Claude (claude-agent-acp 0.107.3, read 17 Nov 2026):
 *   - dist/session-mode.js:47-48: with no permissions.defaultMode in the user's settings a session starts in `auto`
 *     ("Claude handles permission decisions", :312) when the catalog offers it. That is F1.
 *   - `default` is "Manual: Always ask before making changes" (dist/session-mode.js:290-292). In it Claude Code calls
 *     the adapter's canUseTool for every action its own rules don't already allow, and canUseTool always ends in
 *     requestPermissionFromClient, i.e. session/request_permission (dist/v1/acp-agent.js:6608-6710; :6646 "Do not
 *     auto-allow here based on the session's advertised mode"). The user's own allow rules still win (F3).
 *   - No env var or launch flag sets the initial mode (the only env the adapter reads is listed in its README and
 *     dist; none is a mode). The setup requests take `configOptions` instead (the "Session options" RFD,
 *     dist/initial-config-options.js; advertised as sessionCapabilities.options, dist/v1/acp-agent.js:531-532):
 *     session/new and session/load apply them before they answer (dist/v1/acp-agent.js:601-611, 767-783, via
 *     selectSessionConfigOption :5753, config id "mode" = MODE_CONFIG_ID, dist/session-mode.js:5). So no prompt
 *     ever runs in `auto`; the set_mode after it is the second guard.
 */
export const ASK_MODE: Record<AgentId, string> = {
  claude: "default",
  /*
   * Codex (codex-acp 2.7.0, read 17 Nov 2026; docs/permission-profiles.md is not in the published package, so this
   * is from its README and dist/index.js):
   *   - README:76 names INITIAL_AGENT_MODE: read-only, workspace-write, agent, agent-full-access, permission-profile:<id>.
   *     dist/index.js:42225-42229 reads it at every session open; an unknown id falls back to `agent`.
   *   - The default is `agent` (dist/index.js:42151), "Auto review": approvalsReviewer "auto_review" (:42125-42140),
   *     the Guardian Review seen in F2 (:35577). `agent-full-access` has approvalPolicy "never". Neither asks Rushes.
   *   - `read-only` (:42096-42108): approvalPolicy "on-request", approvalsReviewer "user", read-only sandbox,
   *     "Requires approval to edit files and access the internet." (:42099). With reviewer "user" the app-server's
   *     approval requests reach CodexApprovalHandler (:40127), which sends session/request_permission for commands
   *     (:40138) and file changes (:40166, :40211-40216). A file change arrives as kind "edit" with its paths as
   *     locations (FileChangeReporter.permission, :35234), so Rushes allows edits inside the project under
   *     project-edits and asks under ask-all. Each turn passes the mode's own approvalPolicy and approvalsReviewer
   *     (:43888-43889), so the user's Codex config can't turn Guardian back on for a built-in mode.
   *   - Chosen over `workspace-write` (also on-request, reviewer "user", :42109-42124): there the sandbox lets Codex
   *     write anywhere in the project with no ask at all, so Rushes would never see in-project edits, even under
   *     ask-all. In read-only every write, by patch or by command, needs an approval, and that approval is Rushes's.
   *   - Limit: no built-in mode uses the `untrusted` policy. A command that only reads, inside the read-only sandbox,
   *     still runs with no ask (the sandbox lets it read outside the project).
   */
  codex: "read-only",
};

/*
 * §33: the session mode for each row of the permission menu. Manual and Accept edits use ASK_MODE, so every ask reaches
 * Rushes, which decides by the row and the Always rules (core/agentRules.ts decide). Auto and Bypass hand the decision to
 * the agent; there Rushes is no longer the gatekeeper for .rushes and .git.
 *
 * Checked 19 Nov 2026 against the installed adapters:
 *   - Claude (claude-agent-acp 0.107.3, dist/session-mode.js buildAvailableModes): `auto` ("Claude handles permission
 *     decisions", offered unless the user's settings disable auto mode) and `bypassPermissions` ("Accepts all
 *     permissions", offered unless running as root outside a sandbox or disabled in settings). The CLI's own
 *     --permission-mode takes the same two ids. When the session's model can't run auto, the adapter falls back to
 *     AUTO_MODE_FALLBACK, `acceptEdits` (dist/session-mode.js:6, effectiveMode): edits go through and commands still ask
 *     Rushes. The runner accepts that fallback for Auto and says so in Activity (AUTO_FALLBACK).
 *   - Codex (codex-acp 2.7.0, README:76 INITIAL_AGENT_MODE): `agent` (Codex's "Auto review", approvalsReviewer
 *     "auto_review") and `agent-full-access` (approvalPolicy "never").
 * A mode the session doesn't offer fails the start closed, as ASK_MODE does (runner.ts agentMode).
 */
export const AGENT_MODE: Record<AgentPermissions, Record<AgentId, string>> = {
  "ask-all": ASK_MODE,
  "project-edits": ASK_MODE,
  auto: { claude: "auto", codex: "agent" },
  bypass: { claude: "bypassPermissions", codex: "agent-full-access" },
};

/** The mode Claude's adapter falls back to when Auto isn't available for the session's model. Still asks Rushes for commands. */
export const AUTO_FALLBACK: Partial<Record<AgentId, string>> = { claude: "acceptEdits" };

/** The agent's session mode for a menu row. */
export const modeFor = (agent: AgentId, level: AgentPermissions): string => AGENT_MODE[level][agent];

/**
 * clientCapabilities._meta for initialize. Codex (codex-acp 2.7.0, read 18 Nov 2026): a turn that fails on a model or
 * service error (an unsupported model, an outage) still answers session/prompt with stopReason "end_turn". It says it
 * failed only to a client that takes JetBrains' AIR "sessionFailure" extension, in the response's
 * _meta.jetbrains.air.sessionFailure; any other client gets the error as plain agent text. So Rushes asks for that one
 * capability and no other. (Advertising AIR also marks permission options and message phases with AIR _meta, which
 * Rushes doesn't read.) Claude (claude-agent-acp 0.107.3) fails such a turn with a JSON-RPC error, so it gets nothing.
 */
export function clientMeta(agent: AgentId): Record<string, unknown> | undefined {
  return agent === "codex" ? { jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } } } : undefined;
}

/**
 * The model and effort a Claude session starts on: Sonnet at medium effort. Notes are mostly small edits to existing
 * work, so the cheaper model is the default. "sonnet" is the adapter's family alias (resolveModelPreference,
 * dist/session-model.js), the newest Sonnet the account offers. The adapter skips an entry it refuses (an unknown
 * model, an effort level the model lacks: applyInitialConfigOptions, dist/initial-config-options.js) and the session
 * keeps the user's own default, so a failure here never stops a Send. Model goes before effort: the levels depend on it.
 */
export const CLAUDE_MODEL = "sonnet";
export const CLAUDE_EFFORT = "medium";

/**
 * Extra params for session/new and session/load: Claude's initial mode for the row the Send was made under, so the
 * session is never in `auto` unless the user picked Auto (R14, §33), then its model.
 */
export function sessionSetup(agent: AgentId, level: AgentPermissions = "project-edits"): Record<string, unknown> {
  if (agent === "claude") {
    return {
      configOptions: [
        { configId: "mode", value: modeFor("claude", level) },
        { configId: "model", value: CLAUDE_MODEL },
        { configId: "effort", value: CLAUDE_EFFORT },
      ],
    };
  }
  return {};
}

/**
 * How to start the ACP adapter for an agent: `node <entry>`, with the Node running Rushes, from the cache folder (§34).
 * Never npx at run time, and never from the project folder, so nothing in the project can change what runs.
 */
export function adapterSpec(agent: AgentInfo, _root: string, level: AgentPermissions = "project-edits", entry = ""): AdapterSpec {
  // The same PATH detection used, so the agent finds node and its own tools even when the server has a thin PATH.
  const env: Record<string, string> = { PATH: searchPath() };
  if (agent.id === "claude" && agent.path) env.CLAUDE_CODE_EXECUTABLE = agent.path;
  if (agent.id === "codex" && agent.path) env.CODEX_PATH = agent.path;
  // R15: Codex starts in the mode whose approvals go to Rushes (ASK_MODE.codex), unless the user picked Auto or Bypass (§33).
  if (agent.id === "codex") env.INITIAL_AGENT_MODE = modeFor("codex", level);
  return { command: process.execPath, args: [entry], env, cwd: entry ? dirname(entry) : cacheDir() };
}

/** This package's built CLI. src/server/agent/ and dist/server/agent/ are both three folders below the package root. */
function cliPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "dist", "cli", "index.js");
}

/** dist/cli/index.js exists only after `npm run build`; callers under tsx pass RunnerOptions.mcp (Task 5). */
/** The Rushes MCP server, handed to the agent so it can call rushes_reply. Pinned to `root` (R17): its tools refuse any other folder. */
export function rushesMcp(root: string): McpServerSpec {
  return { name: RUSHES_SERVER, command: process.execPath, args: [cliPath(), "mcp", root, "--pinned"], env: [] };
}
