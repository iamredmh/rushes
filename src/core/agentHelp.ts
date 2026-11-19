// §34: help for an agent that's missing, outdated or signed out, the same on every OS. Pure, so the desk bundles it too.
import type { AgentId } from "./schema.js";

/** Install and update help per agent. Both install with npm, which comes with Node, so the command is the same everywhere. */
export const AGENT_HELP: Record<AgentId, { install: string; update: string; url: string; min: string; signInArgs: string[] }> = {
  claude: {
    install: "npm install -g @anthropic-ai/claude-code",
    update: "claude update",
    url: "https://docs.claude.com/en/docs/claude-code/setup",
    // `claude auth status`, which detection uses, is there from 2.0.
    min: "2.0.0",
    signInArgs: ["auth", "login"],
  },
  codex: {
    install: "npm install -g @openai/codex",
    update: "npm install -g @openai/codex@latest",
    url: "https://developers.openai.com/codex/cli",
    // The oldest seen working with codex-acp 2.7.0 (19 Nov 2026, the Mac mini). codex-acp itself targets ^0.166.
    min: "0.163.0",
    signInArgs: ["login"],
  },
};

/** The sign-in button's words on this OS (§34). */
export function signInLabel(platform: string): string {
  if (platform === "darwin") return "Sign in in Terminal";
  if (platform === "win32") return "Sign in in Command Prompt";
  return "Sign in in a terminal";
}
