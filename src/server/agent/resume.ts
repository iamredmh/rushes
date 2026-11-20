// §35.5: the command that goes back to the agent's conversation, from the session kept in the project's agent.json.
// Checked against the installed CLIs (20 Nov 2026): Claude Code's ACP session id is a Claude Code session, which
// `claude --resume <id>` opens when run in the project folder; Codex's is its thread id, which `codex resume <id>` opens.
import type { AgentId, AgentSettings } from "../../core/schema.js";
import { shQuote } from "./terminal.js";

export interface Resume {
  agent: AgentId;
  session: string;
  /** What to run, as the desk shows it to copy. */
  command: string;
  /** The words after the program, for the terminal opener to run the detected program with. */
  args: string[];
}

/** The resume arguments per agent. */
export const RESUME_ARGS: Readonly<Record<AgentId, (session: string) => string[]>> = {
  claude: (s) => ["--resume", s],
  codex: (s) => ["resume", s],
};

const PROGRAM: Readonly<Record<AgentId, string>> = { claude: "claude", codex: "codex" };

/** A word quoted for the shell the user will paste into: cmd on Windows, a POSIX shell elsewhere. */
const quoteFor = (platform: NodeJS.Platform, w: string): string => (platform === "win32" ? (/^[A-Za-z0-9_.:-]+$/.test(w) ? w : `"${w.replace(/"/g, "")}"`) : shQuote(w));

/** The resume for a kept session, or null when there is none to go back to. */
export function resumeFor(session: AgentSettings["session"], _root: string, platform: NodeJS.Platform): Resume | null {
  if (!session?.id) return null;
  const args = RESUME_ARGS[session.agent](session.id);
  return { agent: session.agent, session: session.id, args, command: [PROGRAM[session.agent], ...args].map((w) => quoteFor(platform, w)).join(" ") };
}
