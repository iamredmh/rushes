// §28.3: what the runner tells the agent beside the batch prompt, and how the agent's session/update
// notifications read as Activity lines. Pure: the server and its tests share it.
import { oneLine } from "./labels.js";

/** Added after the batch prompt in what the runner sends. The prompt stored in batches.json never carries it. */
export const AGENT_LINES =
  "Before you start on each note, call rushes_working_on with the note's id and what you are doing, in a few plain words.\n" +
  "If you are not sure what a note means, ask on the note with rushes_reply (no status) and go on to the next one. The user answers on the note.";

/** An Activity line is one line of at most this many characters. */
export const ACTIVITY_LINE_MAX = 200;

/** `text` with the project folder cut from every path in it: "<root>/a/b" reads "a/b", the folder itself ".". */
function withoutRoot(text: string, root: string): string {
  const base = root.replace(/[\\/]+$/, "");
  if (!base) return text;
  return text.split(base + "/").join("").split(base).join(".");
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
      const line = oneLine(withoutRoot(u.title, root), ACTIVITY_LINE_MAX);
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
