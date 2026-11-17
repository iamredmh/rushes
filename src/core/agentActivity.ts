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
export const ACTIVITY_LINE_MAX = 200;

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
