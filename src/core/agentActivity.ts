// §28.3: what the runner tells the agent beside the batch prompt, and how the agent's session/update
// notifications read as Activity lines. Pure: the server and its tests share it.
import { oneLine } from "./labels.js";

/** Added after the batch prompt in what the runner sends. The prompt stored in batches.json never carries it. */
export const AGENT_LINES =
  "Before you start on each note, call rushes_working_on with the note's id and what you are doing, in a few plain words.\n" +
  "If you are not sure what a note means, ask on the note with rushes_reply (no status) and go on to the next one. The user answers on the note.\n" +
  "Only add a new version when the picture or sound changed.\n" +
  "Wait for each command to finish before you reply on a note; do not run work as a background task.";

/** An Activity line is one line of at most this many characters. */
export const ACTIVITY_LINE_MAX = 120;
/** A command in a line is cut to this many characters. */
const COMMAND_MAX = 80;

/** The agent's own Rushes calls, in Claude's spelling (mcp__rushes__rushes_x) and Codex's (mcp.rushes.rushes_x). */
const OWN_TOOL = /^mcp(__|\.)rushes(__|\.)rushes_/;
/** Tool calls that are the agent's housekeeping, not work on the notes. */
const HOUSEKEEPING: ReadonlySet<string> = new Set(["Load skill", "ToolSearch", "Guardian Review", "Preparing file…"]);
/** The titles an adapter gives a shell command. */
const SHELL: ReadonlySet<string> = new Set(["Terminal", "Bash"]);

/**
 * `text` with the project folder cut from every path in it: "<root>/a/b" reads "a/b", the folder itself ".". Only
 * the root followed by a slash, or the root alone (at the end, or before a line break, quote, bracket or punctuation),
 * and only where a path starts (M7): "<root> 2/a" and "<root>-old/a" are other folders and stay as they are. A root
 * followed by a space may be such a folder, so it is left whole.
 */
function withoutRoot(text: string, root: string): string {
  const base = root.replace(/[\\/]+$/, "");
  if (!base) return text;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const at = new RegExp(`(?<![\\w./-])${escaped}(?:/|(?=$|[\\r\\n"'\`),;:\\]]))`, "g");
  return text.replace(at, (m) => (m.endsWith("/") && m.length > base.length ? "" : "."));
}

/**
 * One session/update as an Activity line, or null when it isn't worth one: a tool call is its title, a plan
 * its number of steps. Message chunks are too chatty, and kinds this build doesn't know are left out.
 */
export function activityLine(update: unknown, root: string): string | null {
  if (typeof update !== "object" || update === null) return null;
  const u = update as Record<string, unknown>;
  switch (u.sessionUpdate) {
    case "tool_call": {
      if (typeof u.title !== "string") return null;
      const title = u.title.trim();
      if (OWN_TOOL.test(title) || HOUSEKEEPING.has(title)) return null;
      let text = u.title;
      if (SHELL.has(title)) {
        const raw = u.rawInput as { command?: unknown } | null | undefined;
        const first = typeof raw?.command === "string" ? raw.command.split(/\r\n|\r|\n/).map((l) => l.trim()).find((l) => l !== "") : undefined;
        text = first ? `Ran a command: ${oneLine(withoutRoot(first, root), COMMAND_MAX)}` : "Ran a command";
      }
      const line = oneLine(withoutRoot(text, root), ACTIVITY_LINE_MAX);
      return line === "" || line === "…" ? null : line;
    }
    case "plan": {
      const n = Array.isArray(u.entries) ? u.entries.length : 0;
      return `Planned ${n} ${n === 1 ? "step" : "steps"}`;
    }
    default:
      return null;
  }
}
