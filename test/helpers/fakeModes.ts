import type { AgentInfo } from "../../src/server/agent/detect.js";

/** The modes each real adapter offers (claude-agent-acp 0.107.3 with Auto; codex-acp 2.7.0), its default first. */
export const CLAUDE_MODES = ["auto", "default", "acceptEdits", "plan"];
export const CODEX_MODES = ["agent", "read-only", "workspace-write", "agent-full-access"];

/** FAKE_ACP_MODES for the fake agent standing in for this agent's adapter. */
export const fakeModesEnv = (a: AgentInfo): { FAKE_ACP_MODES: string } => ({
  FAKE_ACP_MODES: (a.id === "codex" ? CODEX_MODES : CLAUDE_MODES).join(","),
});
