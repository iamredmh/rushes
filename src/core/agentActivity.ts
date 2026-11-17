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

/** What a masked secret reads as. */
const MASK = "•••";
/** A secret's value: a quoted string (quotes and all), or a run up to a space, a quote or a shell separator. */
const VALUE = String.raw`(?:"[^"]*"|'[^']*'|[^\s'"&|;]+)`;
/** M3: the common shapes of a secret in a command, each with the part kept before its value. */
const SECRETS: readonly RegExp[] = [
  // An Authorization header, whatever its scheme: "Authorization: Bearer x", "Authorization: Basic x", "authorization:x".
  new RegExp(String.raw`(\bAuthorization:\s*)(?:[A-Za-z]+\s+(?=[^\s'"]))?[^\s'"]+`, "gi"),
  new RegExp(String.raw`(\bBearer\s+)[^\s'"]+`, "g"),
  new RegExp(String.raw`((?<![\w-])--(?:token|password)(?:=|\s+))${VALUE}`, "gi"),
  new RegExp(String.raw`((?<![\w-])(?:password|token|api_key|apikey)=)${VALUE}`, "gi"),
  new RegExp(String.raw`(\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*_(?:KEY|TOKEN|SECRET)=)${VALUE}`, "g"),
];

/**
 * `text` with the value of each secret it shows replaced by •••: a bearer token, an Authorization header, --token and
 * --password, password=, token=, api_key= and apikey=, and a NAME_KEY, NAME_TOKEN or NAME_SECRET variable. For the
 * Activity line only: the ask card shows the command as it is, since that is what the user is asked to allow.
 */
export function maskSecrets(text: string): string {
  return SECRETS.reduce((t, re) => t.replace(re, `$1${MASK}`), text);
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
      // Secrets are masked before anything is cut, so a cut can't leave part of one showing.
      let text = maskSecrets(u.title);
      if (SHELL.has(title)) {
        const raw = u.rawInput as { command?: unknown } | null | undefined;
        const first = typeof raw?.command === "string" ? raw.command.split(/\r\n|\r|\n/).map((l) => l.trim()).find((l) => l !== "") : undefined;
        text = first ? `Ran a command: ${oneLine(withoutRoot(maskSecrets(first), root), COMMAND_MAX)}` : "Ran a command";
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
