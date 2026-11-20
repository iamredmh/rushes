// §28.3: what the runner tells the agent beside the batch prompt, and how the agent's session/update
// notifications read as Activity lines. Pure: the server and its tests share it.
import { oneLine } from "./labels.js";

/** Added after the batch prompt in what the runner sends. The prompt stored in batches.json never carries it. */
export const AGENT_LINES =
  "Before you start on each note, call rushes_working_on with the note's id and what you are doing, in a few plain words.\n" +
  "Reply on each note with rushes_reply saying only what you did, in a sentence or two. Never ask the user a question in Rushes, about the work or the setup: the user writes a new note to follow up. If a note is unclear, do your best reading and say what you did.\n" +
  "If you could not do a note, say so in one line and leave it to do. If you can't go on without the user doing something outside Rushes (a sign-in, a missing key, a missing file), call rushes_attention once with a one-line title and the note's id, then carry on with the other notes.\n" +
  "Only add a new version when the picture or sound changed.\n" +
  "Wait for each command to finish before you reply on a note; do not run work as a background task.\n" +
  "Read and search files with your own file tools, not shell commands (no cat, head, grep, or python -c to read a file). " +
  "Keep each shell command to one plain command; do not chain with && or ; or pipe, because a chained command can only be allowed once at a time.";

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

/** A command's text from a tool call's input: Claude's `command` string, or Codex's argv. Null when it has none. */
function commandOf(raw: unknown): string | null {
  const c = (raw as { command?: unknown } | null | undefined)?.command;
  if (typeof c === "string") return c;
  if (Array.isArray(c) && c.every((x) => typeof x === "string")) return c.join(" ");
  return null;
}

/** A tool call as the tracker has heard it so far. */
interface HeardCall { title: string | null; kind: string | null; raw: unknown; said: boolean }

/**
 * Task 10 (3): Activity lines from a session's updates, knowing each tool call's story. A tool call that runs a command
 * (a shell title, or an execute call whose input holds a command) says nothing until it ends. Claude announces it
 * `pending`, before any ask and before its input has streamed in; Codex announces it `in_progress` when the item starts
 * (codex-acp 2.7.0 toToolStatus sends no pending), and an ask for that started command can come after. So its one line
 * comes at `completed`, "Ran a command: <first line, clipped, secrets masked>", or at `failed`, which covers a refusal
 * or a decline as well as a failed run. Any other tool call says its title at once, as activityLine does.
 */
export class ActivityTracker {
  private readonly calls = new Map<string, HeardCall>();

  constructor(private readonly root: string) {}

  line(update: unknown): string | null {
    if (typeof update !== "object" || update === null) return null;
    const u = update as Record<string, unknown>;
    const id = typeof u.toolCallId === "string" ? u.toolCallId : null;
    if ((u.sessionUpdate !== "tool_call" && u.sessionUpdate !== "tool_call_update") || id === null) return activityLine(update, this.root);
    const known = this.calls.get(id);
    const call: HeardCall = {
      title: typeof u.title === "string" ? u.title : known?.title ?? null,
      kind: typeof u.kind === "string" ? u.kind : known?.kind ?? null,
      raw: u.rawInput !== undefined ? u.rawInput : known?.raw,
      said: known?.said ?? false,
    };
    this.calls.set(id, call);
    if (this.isLookup(call) && !this.isCommand(call)) {
      // Round 3: a read or a search (Codex's parse of a `cat` or `rg` it starts before its ask) says its title once it
      // completes, the same rule as a command.
      if (call.said || u.status !== "completed" || call.title === null) return null;
      call.said = true;
      return activityLine({ sessionUpdate: "tool_call", title: call.title }, this.root);
    }
    if (!this.isCommand(call)) return u.sessionUpdate === "tool_call" && !known ? activityLine(update, this.root) : null;
    if (call.said) return null;
    const status = u.status;
    // Only the end counts: Codex reports a command in_progress when it starts, which can be before its approval.
    if (status !== "completed" && status !== "failed") return null;
    call.said = true;
    const text = this.commandText(call);
    const lead = status === "failed" ? "A command failed or was not run" : "Ran a command";
    return oneLine(text ? `${lead}: ${text}` : lead, ACTIVITY_LINE_MAX);
  }

  private isLookup(c: HeardCall): boolean {
    return c.kind === "read" || c.kind === "search";
  }

  private isCommand(c: HeardCall): boolean {
    const title = c.title?.trim() ?? "";
    if (OWN_TOOL.test(title) || HOUSEKEEPING.has(title)) return false;
    return SHELL.has(title) || (c.kind === "execute" && (commandOf(c.raw) !== null || (title !== "" && !/^mcp(__|\.)/.test(title) && !isMcpInput(c.raw))));
  }

  private commandText(c: HeardCall): string | null {
    const raw = commandOf(c.raw);
    const title = c.title?.trim() ?? "";
    const source = raw ?? (title !== "" && !SHELL.has(title) ? title : null);
    if (source === null) return null;
    const first = source.split(/\r\n|\r|\n/).map((l) => l.trim()).find((l) => l !== "");
    if (!first) return null;
    const text = oneLine(withoutRoot(maskSecrets(first), this.root), COMMAND_MAX);
    return text === "" || text === "…" ? null : text;
  }
}

/** An MCP tool call's input, as Codex sends it ({ server, tool, arguments }): not a command. */
function isMcpInput(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && "server" in raw && "tool" in raw;
}
