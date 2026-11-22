// Send to AI in the desk (§28): what the chip, a note's badge, the who-line and the live strip say, and what the
// desk does after Send. Pure: the words come from the agent's status (GET /api/agent and the SSE `agent` event)
// and the notes the desk already holds, so every tab says the same thing.
import { alwaysLabel } from "../../src/core/alwaysLabel.js";
import { AGENT_HELP, signInLabel } from "../../src/core/agentHelp.js";
import { clock } from "../../src/core/logText.js";
import { noteState } from "../../src/core/noteState.js";
import type { JumpTarget } from "./changelog.js";
import type { ActivityLine, AgentId, AgentInfo, AgentPhase, AgentRules, AgentStatus, AlwaysRule, AskChoice, Note, PendingAsk, SendHandOver } from "./types.js";

/** A note as these helpers read it. */
export type NoteLite = Pick<Note, "id" | "batch" | "status" | "fixVersion">;

const NAMES: Readonly<Record<AgentId, string>> = { claude: "Claude Code", codex: "Codex" };

/** The agent by name, or "your agent" when none is chosen. */
export const agentName = (id: AgentId | null): string => (id ? NAMES[id] : "your agent");

/** The phases in which the agent is on a turn: its current note is the one it is working on. */
const RUNNING: ReadonlySet<AgentPhase> = new Set<AgentPhase>(["starting", "working", "waiting"]);

/** "note 2 of 3": where the current note sits among its batch's notes, or null when it is in no batch the desk holds. */
function place(note: string | null, notes: readonly NoteLite[]): string | null {
  const batch = note === null ? null : notes.find((n) => n.id === note)?.batch ?? null;
  if (batch === null) return null;
  const inBatch = notes.filter((n) => n.batch === batch);
  return `note ${inBatch.findIndex((n) => n.id === note) + 1} of ${inBatch.length}`;
}

/** The top bar's chip: what the agent is doing, or null when there is nothing to show (off, idle). */
export function chipText(s: AgentStatus, notes: readonly NoteLite[]): string | null {
  const a = agentName(s.agent);
  let text: string;
  switch (s.phase) {
    case "starting": text = `Starting ${a}`; break;
    case "working": {
      const at = place(s.current.note, notes);
      text = at ? `${a} · ${at}` : `${a} is working`;
      break;
    }
    case "waiting": text = `${a} is waiting for you`; break;
    case "finished": text = `${a} finished`; break;
    case "failed": text = `${a} didn't finish`; break;
    default: return null;
  }
  return s.batches.length > 1 ? `${text} · ${s.batches.length} batches` : text;
}

/** How long an ended run's chip stays, after its newest Activity line (plan 2, decision 2). */
export const CHIP_KEEP_MS = 600_000;

/**
 * Whether the top bar shows the chip at `now`: never off or idle; always while the run goes; an ended run (finished,
 * failed) until its newest line is ten minutes old. An ended run with no lines to date it still shows.
 */
export function chipShows(s: AgentStatus, now: number): boolean {
  if (s.phase === "off" || s.phase === "idle") return false;
  if (s.phase !== "finished" && s.phase !== "failed") return true;
  if (s.lines.length === 0) return true;
  const newest = Math.max(...s.lines.map((l) => Date.parse(l.at)));
  return !(now - newest > CHIP_KEEP_MS);
}

/** The chip's look: a spinner while busy, the to-do colour while it waits on you, done, and over for a failure. */
export function chipTone(phase: AgentPhase): "busy" | "todo" | "done" | "over" {
  if (phase === "waiting") return "todo";
  if (phase === "finished") return "done";
  if (phase === "failed") return "over";
  return "busy";
}

/** Stop shows while the agent is starting, on a turn, or waiting on an ask: the phases a Stop can end. */
export const canStop = (phase: AgentPhase): boolean => RUNNING.has(phase);

export type NoteBadge = { kind: "working" | "with" | "unfinished" | "fixed"; text: string };

/**
 * I3: the agent Send to AI uses really has this sent note: a run holds its batch (queued, starting or on it), a turn is
 * on the note itself. A note sent by
 * copying a prompt, or in a batch whose hand-over was refused, is with "your agent", whatever the switch says.
 */
export function agentHolds(n: NoteLite, s: AgentStatus | null): boolean {
  if (!s || noteState(n) !== "sent") return false;
  return (n.batch !== null && s.batches.includes(n.batch)) || (RUNNING.has(s.phase) && s.current.note === n.id);
}

/**
 * The badge on a note's card, by priority: being worked on, with the agent, not finished, fixed. Null for none (§35: no
 * Needs you). `unfinished` (§35.7) is the status line of the note's batch when the agent's turn on it ended with the note
 * unanswered ("Not finished: …"): shown while the note is still sent and no run holds it again.
 */
export function noteAgentBadge(n: NoteLite, s: AgentStatus | null, unfinished: string | null = null): NoteBadge | null {
  if (s && s.current.note === n.id && RUNNING.has(s.phase)) return { kind: "working", text: s.current.doing ?? "Working on it" };
  const state = noteState(n);
  const holds = agentHolds(n, s);
  if (state === "sent" && unfinished && !holds) return { kind: "unfinished", text: unfinished };
  // Named only while the agent has the note (agentHolds); otherwise it is with "your agent".
  const named = holds ? s!.agent : null;
  if (state === "sent") return { kind: "with", text: `With ${agentName(named)}` };
  if (state === "done" && n.fixVersion) return { kind: "fixed", text: `Fixed in ${n.fixVersion}` };
  return null;
}

/**
 * What the desk does with Send's answer (POST /api/batches `agent`). "dialog" is today's "Sent to agent" dialog with
 * Copy prompt: no hand-over, or a refusal where nothing was started (runner.ts SendResult). A Stop's refusal and a
 * recalled start say so instead, with or without a reason.
 */
export function afterSend(r: SendHandOver | undefined): "dialog" | "handed" | "starting" | "recalled" | "stopped" | "busy" {
  if (r === undefined) return "dialog";
  const flags = r as { stopped?: true; recalled?: true; starting?: true; busy?: true };
  // §35.7: Send again refused while the agent is still on that film's work: nothing to copy, it says why.
  if (r.handedTo === null && flags.busy) return "busy";
  if (r.handedTo === null && !flags.stopped && !flags.recalled) return "dialog";
  if (flags.stopped) return "stopped";
  if (flags.recalled) return "recalled";
  if (flags.starting) return "starting";
  return "handed";
}

/** Under Send while Send to AI is on: what the agent may do without asking. */
export function whoLine(s: AgentStatus): string {
  const may = WHO_MAY[s.permissions](agentName(s.agent));
  return s.session ? `${may} · next Send continues the conversation` : may;
}

/** The live strip: the last `max` activity lines, newest first. */
export const liveLines = (s: AgentStatus, max = 20): ActivityLine[] => (max > 0 ? s.lines.slice(-max).reverse() : []);

/** The live strip in Activity: "live" while the run goes, "ended" (collapsed to one line) once it finished or failed with
 *  lines to show, null when there is nothing to show (off, idle, or an ended run with no lines). */
export function stripMode(s: AgentStatus): "live" | "ended" | null {
  if (s.phase === "off" || s.phase === "idle") return null;
  if (s.phase === "finished" || s.phase === "failed") return s.lines.length > 0 ? "ended" : null;
  return "live";
}

/** The collapsed strip's one line. */
export const runLabel = (n: number): string => `Show the run (${n})`;

/** A strip line's text: the agent wrote it, so hidden and bidi characters are spelled out. */
export const stripLine = (l: ActivityLine): string => revealText(l.text);

// ---- the Send to AI row above Send, and the agent menu (task 3) ----

/** The row has the agent's name and its switch: an agent is named and the user has answered the sheet (a project's own
 *  agent.json can't turn "Set up Send to AI" into a ready switch). */
export const rowReady = (s: AgentStatus): boolean => s.asked && s.agent !== null;

/** The row: the agent it sends to, or the way in when none is chosen or the sheet has not been answered. */
export const rowText = (s: AgentStatus): string => (rowReady(s) ? `Send to AI · ${agentName(s.agent)}` : "Set up Send to AI");

/** Under Send: the who-line while Send to AI is on, what Send does while it is off. */
export const footLine = (s: AgentStatus): string => (s.on ? whoLine(s) : "Copies a prompt for your own chat");

/**
 * §34: the OS the desk runs on, which names the sign-in button. A first guess from the browser (the desk is local, so it
 * is the same computer), then what the server says in its detect answer (setDeskPlatform).
 */
let deskPlatform: string = guessPlatform();
function guessPlatform(): string {
  const p = typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`;
  return /Win/i.test(p) ? "win32" : /Mac/i.test(p) ? "darwin" : /Linux|X11|CrOS/i.test(p) ? "linux" : "darwin";
}
export function setDeskPlatform(p: unknown): void {
  if (typeof p === "string" && p) deskPlatform = p;
}
/** "Sign in in Terminal" on a Mac, "Sign in in Command Prompt" on Windows, "Sign in in a terminal" on Linux (§34). */
export const signInWord = (): string => signInLabel(deskPlatform);

/** §34: what the desk shows for an agent that can't be used yet, with a command to copy and, to install, a link. */
export interface AgentHelp { kind: "install" | "update" | "signIn"; command: string; url?: string }
export const helpFor = (a: Pick<AgentInfo, "id" | "installed" | "outdated" | "signIn">): AgentHelp | null => {
  const h = AGENT_HELP[a.id];
  if (!a.installed) return { kind: "install", command: h.install, url: h.url };
  if (a.outdated) return { kind: "update", command: h.update };
  return null;
};
export const HELP_WORDS = { copy: "Copy", copied: "Copied", setup: "Setup guide", inTerminal: "Run this in a terminal, then try again:" } as const;

/** The agent menu's words, as the plan gives them. */
export const MENU_WORDS = {
  sendTo: "Send notes to",
  signedIn: "Signed in",
  notSignedIn: "Not signed in",
  signIn: "Sign in in Terminal",
  fresh: "Start a fresh conversation",
  may: "What it may do without asking",
  always: "Always rules",
  noRules: "No Always rules yet",
  remove: "Remove",
  footer: "Switch off: Send copies a prompt, as now",
} as const;

/**
 * §33: the permission menu's four rows, the same for both agents, in the agent menu and the first-Send sheet's second
 * step. Bypass is last. `hint` is the row's help line.
 */
export const PERMISSION_CHOICES: readonly { value: AgentRules["permissions"]; label: string; hint: string }[] = [
  { value: "ask-all", label: "Manual", hint: "Always ask" },
  { value: "project-edits", label: "Accept edits", hint: "Edit files in this project without asking" },
  { value: "auto", label: "Auto", hint: "The agent decides: its own safety check approves or refuses each step. Rushes sees only what it asks, and no longer guards .rushes and .git" },
  { value: "bypass", label: "Bypass", hint: "Accepts everything: nothing asks, nothing is checked, .rushes and .git included" },
];

/** §33: the one-line warning shown when Bypass is picked, the way Claude Code warns of its bypass mode. */
export const BYPASS_WARNING = "Bypass: the agent runs every command and edits any file with nothing asked or checked, .rushes and .git included.";

/** §33: a change of row applies from the next Send; a batch already running keeps its own. */
export const NEXT_SEND_LINE = "Applies from the next Send.";

/** Under Send: what the agent may do without asking, by row. */
const WHO_MAY: Record<AgentRules["permissions"], (name: string) => string> = {
  "ask-all": () => "Asks before everything",
  "project-edits": () => "Edits files in this project, asks before commands",
  auto: (name) => `Auto: ${name} decides what to ask`,
  bypass: () => "Bypass: nothing asks, nothing is checked",
};

export interface MenuAgent { id: AgentId; name: string; signedIn: boolean; current: boolean; /** §34: "Getting <agent> ready…" while its connector downloads. */ note?: string }

/** "Send notes to": each agent detection found installed, in its order, the one Send to AI uses ticked. */
export function menuAgents(detected: readonly AgentInfo[] | null, s: AgentStatus): MenuAgent[] {
  return (detected ?? []).filter((a) => a.installed).map((a) => {
    const note = connectorNote(a);
    return { id: a.id, name: a.name, signedIn: a.signedIn, current: a.id === s.agent, ...(note ? { note } : {}) };
  });
}

/** The Always rules, each by its label, with the rule itself for Remove (DELETE names a rule by kind and command). */
export const ruleRows = (s: AgentStatus): { rule: AlwaysRule; label: string }[] => s.always.map((rule) => ({ rule, label: alwaysLabel(rule) }));

/** How many rows the menu's arrows move through: each agent and its Sign in, Start fresh, the two permissions, each Remove. */
export function menuRowCount(s: AgentStatus, agents: readonly MenuAgent[]): number {
  return agents.reduce((n, a) => n + (a.signedIn ? 1 : 2), 0) + (s.session ? 1 : 0) + PERMISSION_CHOICES.length + s.always.length;
}

/**
 * The row focus goes to once rule `index` of `s` (the status before) is removed, counted in the menu after it: the next
 * rule's Remove, else the previous one's, else the menu's first row. The Removes are the menu's last rows.
 */
export function focusAfterRemove(s: AgentStatus, agents: readonly MenuAgent[], index: number): number {
  const first = menuRowCount(s, agents) - s.always.length;
  const left = s.always.length - 1;
  if (index < left) return first + index;
  if (left > 0) return first + left - 1;
  return 0;
}

// ---- the first-Send sheet, and what the desk does with Send's answer (task 4) ----

/** The sheet's words, as the plan gives them; two small steps, each a question (ruling P2-R3). */
export const SHEET_WORDS = {
  who: "Who should get these notes?",
  copy: "Copy a prompt, as now",
  copyButton: "Copy a prompt",
  next: "Next",
  back: "Back",
  cancel: "Cancel",
  notInstalled: "Not installed",
  noKey: "Rushes never sees a password or key. The agent uses your own sign-in.",
  setUp: "Set up",
} as const;

/** Step 2's question. */
export const mayQuestion = (id: AgentId): string => `What may ${agentName(id)} do without asking?`;
/** Step 2's button when notes will go to the agent once it is set up. */
export const sendToLabel = (id: AgentId): string => `Send to ${agentName(id)}`;
/** Step 2's button when nothing waits (I3): it sets the agent up and sends nothing. */
export const useLabel = (id: AgentId): string => `Use ${agentName(id)}`;

/** A row of step 1: an agent, or copying a prompt as now. */
export type SheetPick = AgentId | "copy";
export interface SheetRow {
  pick: SheetPick;
  name: string;
  state: "ready" | "signedOut" | "missing" | "outdated" | "copy";
  note: string | null;
  /** §34: install or update help, for a missing or outdated agent. */
  help?: AgentHelp;
}

/** §34: an agent's connector still downloading (or failed), for the note under its row. Null when ready or not known. */
export function connectorNote(a: AgentInfo): string | null {
  const c = a.connector;
  if (!c || c.state === "ready" || c.state === "missing") return null;
  return c.state === "fetching" ? `Getting ${a.name} ready…` : `${a.name}'s connector didn't download: Send tries again`;
}

/** Step 1's rows: every agent detection knows, in its order, by state (one not installed can't be picked), then the copy row. */
export function sheetRows(detected: readonly AgentInfo[] | null): SheetRow[] {
  const agents = (detected ?? []).map((a): SheetRow => {
    if (!a.installed) return { pick: a.id, name: a.name, state: "missing", note: SHEET_WORDS.notInstalled, help: helpFor(a)! };
    if (a.outdated) return { pick: a.id, name: a.name, state: "outdated", note: `${a.version ?? "This version"} is too old: update it`, help: helpFor(a)! };
    if (!a.signedIn) return { pick: a.id, name: a.name, state: "signedOut", note: MENU_WORDS.notSignedIn };
    return { pick: a.id, name: a.name, state: "ready", note: connectorNote(a) ?? MENU_WORDS.signedIn };
  });
  return [...agents, { pick: "copy", name: SHEET_WORDS.copy, state: "copy", note: null }];
}

/** The row picked when the sheet opens: the current agent if it is ready, else the first ready agent, else copy. */
export function sheetDefault(rows: readonly SheetRow[], current: AgentId | null): SheetPick {
  const ready = rows.filter((r) => r.state === "ready");
  return (ready.find((r) => r.pick === current) ?? ready[0])?.pick ?? "copy";
}

/** What step 1's button does with the row picked: copy now, go on to step 2, or say the agent can't be used yet. */
export function whoNext(pick: SheetPick, rows: readonly SheetRow[]): "copy" | "may" | "signedOut" | "missing" {
  if (pick === "copy") return "copy";
  const state = rows.find((r) => r.pick === pick)?.state;
  // §34: an outdated agent can't be picked, as one not installed can't.
  return state === "ready" ? "may" : state === "signedOut" ? "signedOut" : "missing";
}

/** Under an agent's row when step 1 goes on with it not signed in: the server's own words for that refusal. */
export const notSignedInWhy = (id: AgentId): string => `${agentName(id)} is not signed in. Choose ${signInWord()}, then try again.`;

/** Where the sheet is: step 1 with its row picked, or step 2 for an agent with its choice. */
export type Sheet = { step: "who"; pick: SheetPick } | { step: "may"; agent: AgentId; permissions: AgentRules["permissions"] };

/** The sheet's primary button. `sends`: confirming hands notes to the agent (notes wait, or a filed batch does). */
export const sheetPrimary = (s: Sheet, sends: boolean): string =>
  s.step === "may" ? (sends ? sendToLabel(s.agent) : useLabel(s.agent)) : s.pick === "copy" ? SHEET_WORDS.copyButton : SHEET_WORDS.next;

/**
 * What the desk does after Send, from `afterSend`: a toast for a hand-over, a start or a recall (no dialog, nothing
 * copied), nothing after a Stop, and today's dialog otherwise. `why` is the line above the dialog's prompt, given only
 * while Send to AI is on (off, the dialog is exactly today's). `handed`: the notes went to an agent.
 */
export interface SendFollow { toast: { text: string; ms: number } | null; dialog: boolean; why: string | null; handed: boolean }

export function followSend(r: SendHandOver | undefined, s: AgentStatus | null): SendFollow {
  const none: SendFollow = { toast: null, dialog: false, why: null, handed: false };
  const said = r && "why" in r ? r.why : null;
  switch (afterSend(r)) {
    case "handed": return { ...none, toast: { text: `Sent to ${agentName(r!.handedTo)}`, ms: 2400 }, handed: true };
    case "starting": return { ...none, toast: { text: `Starting ${agentName(r!.handedTo)}`, ms: 2400 }, handed: true };
    case "recalled": {
      const name = agentName(s?.agent ?? null);
      // The runner's reason may say "<A> could not start: …" itself; the toast names the agent once.
      const lead = `${name} could not start: `;
      const why = (said ?? "").replace(/\.$/, "");
      return { ...none, toast: { text: `${name} couldn't start: ${why.startsWith(lead) ? why.slice(lead.length) : why}. The notes are back in to do.`, ms: 6000 } };
    }
    case "stopped": return none;
    case "busy": return { ...none, toast: { text: said ?? "Your agent is still working on this film", ms: 4000 } };
    default: return { ...none, dialog: true, why: s?.on && said ? said : null };
  }
}

/**
 * I4, for now: brief and storyboard lines are never handed to the agent, only shown in "Message for your agent" to copy.
 * When the notes did go to an agent, that dialog says so above the lines. Null when no notes went (`f` null: no batch).
 */
export const planLead = (f: SendFollow | null, s: AgentStatus | null): string | null =>
  f?.handed ? `${agentName(s?.agent ?? null)} has the notes. These lines aren't sent to it yet.` : null;

// ---- the ask cards in the notes panel (task 5) ----

/** The card's fixed words; Always is the server's own label (PendingAsk.always), never made here. */
export const ASK_WORDS = { once: "Allow once", no: "No" } as const;

/** The card's first line. */
export const askLead = (id: AgentId | null): string => `${agentName(id)} wants to:`;

/** The card's bold line when the ask's title is only its command, which the mono block below already shows. */
export const ASK_RUN_HEADING = "Run a command";

const sameCommand = (s: string): string => s.trim().replace(/^`+|`+$/g, "").replace(/\s+/g, " ").trim();

/**
 * The card's bold line (Task 10, 5): the ask's title, with hidden characters spelled out, or "Run a command" when the
 * title is the command itself (after trimming, whitespace runs and wrapping backticks), so the command isn't shown twice.
 */
export function askHeading(ask: Pick<PendingAsk, "title" | "command">): string {
  if (ask.command && sameCommand(ask.title) === sameCommand(ask.command)) return ASK_RUN_HEADING;
  return revealText(ask.title);
}

/**
 * The card's buttons, in order: Allow once, then Always only when the server offers one (a non-blank label: never for
 * a chained command, an untyped call or a path outside the project), then No. Each is a choice the answer route takes.
 */
export function askChoices(ask: Pick<PendingAsk, "always">): { choice: AskChoice; label: string }[] {
  const always = ask.always.trim() !== "" ? [{ choice: "always" as const, label: ask.always }] : [];
  return [{ choice: "once", label: ASK_WORDS.once }, ...always, { choice: "no", label: ASK_WORDS.no }];
}

/**
 * How long a card must stay where it is before its buttons take a press: one that has just arrived, or moved up when
 * one above it was answered, drops presses until then, so the second click of a double-click can't answer it unread.
 */
export const ASK_ARM_MS = 450;

/** What a card's place depends on: the asks above it. A new value re-arms the card (ASK_ARM_MS). */
export const askArmKey = (ids: readonly string[], index: number): string => ids.slice(0, index).join(" ");

/**
 * Characters that change how a command reads without being seen: bidi controls (which can reorder what is shown), zero
 * widths, joiners and other invisibles, controls other than tab and newline, line and paragraph separators, variation
 * selectors and the tag characters. The card shows each as its code point instead.
 */
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFFB\u{E0000}-\u{E0FFF}]/u;
const HIDDEN_ALL = new RegExp(HIDDEN.source, "gu");

const codeOf = (c: string): string => `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`;

/** Text for display, split into plain runs and hidden characters shown as `<U+XXXX>`. Display only: never sent anywhere. */
export function revealParts(s: string): ({ text: string } | { hidden: string })[] {
  const parts: ({ text: string } | { hidden: string })[] = [];
  let from = 0;
  for (const m of s.matchAll(HIDDEN_ALL)) {
    if (m.index > from) parts.push({ text: s.slice(from, m.index) });
    parts.push({ hidden: codeOf(m[0]) });
    from = m.index + m[0].length;
  }
  if (from < s.length) parts.push({ text: s.slice(from) });
  return parts;
}

/** The same as one string, for a label read aloud or a title. */
export const revealText = (s: string): string => s.replace(HIDDEN_ALL, codeOf);

// ---- a note's thread and its Fixed in <v> (task 6); §35: no reply box, notes go one way ----

/** A note as the badge reads it. */
export const noteLite = (n: Note): NoteLite => ({ id: n.id, batch: n.batch, status: n.status, fixVersion: n.fixVersion });

/** How many of a thread's last replies a card shows before Show all. */
export const THREAD_SHOWN = 3;

/** A line of a note's thread: the agent's reply, its plain text, and its local time ("" for a legacy reply with none). */
export interface ThreadLine { by: "agent"; text: string; time: string }

/**
 * A note's thread as its card shows it: the last THREAD_SHOWN replies, oldest first, with "Show all (n)" when there are
 * more (all of them once `all`). A note from before threads, with its old `reply` and nothing in `replies`, shows that
 * text as the agent's (the server migrates it into replies[0] when it reads a file, so this is a fallback). §35: the
 * thread is the agent's replies, read-only; an answer the user wrote on a note before 0.14.0 is kept but not shown.
 */
export function noteThread(n: Pick<Note, "reply" | "replies">, all = false): { lines: ThreadLine[]; more: string | null } {
  const agents = n.replies.filter((r) => r.by === "agent");
  const lines: ThreadLine[] = agents.length > 0
    ? agents.map((r) => ({ by: "agent" as const, text: r.text, time: clock(new Date(r.at)) }))
    : n.replies.length === 0 && n.reply.trim() !== "" ? [{ by: "agent", text: n.reply.trim(), time: "" }] : [];
  if (all || lines.length <= THREAD_SHOWN) return { lines, more: null };
  return { lines: lines.slice(-THREAD_SHOWN), more: `Show all (${lines.length})` };
}

/**
 * Where "Fixed in <v>" goes: on that version, to the fix's time; on another version of the cut, to that version (through
 * the desk's jump, as a Change Log row goes) and then its time. Null when there is nowhere to go, and the badge is text.
 */
export function fixGo(
  n: Pick<Note, "stage" | "video" | "status" | "fixVersion" | "fixT">,
  version: string | null,
): { kind: "seek"; t: number } | { kind: "jump"; to: JumpTarget; t: number | null } | null {
  if (n.status !== "done" || !n.fixVersion) return null;
  if (n.fixVersion === version) return n.fixT !== null ? { kind: "seek", t: n.fixT } : null;
  if (n.stage === "picture" && n.video) return { kind: "jump", to: { tab: "picture", video: n.video, version: n.fixVersion }, t: n.fixT };
  return null;
}

/**
 * A badge's words as shown: the agent's own parts (what it is doing, the fix version it names) with hidden characters
 * spelled out, so a bidi control can't reorder the line or a button that navigates. Rushes' own words are unchanged.
 */
export const badgeText = (b: NoteBadge): string => revealText(b.text);

/** A reply's text as shown: each of its lines, split as revealParts splits it, the newlines between them kept. */
export const threadParts = (text: string): ReturnType<typeof revealParts>[] => text.split("\n").map(revealParts);

// ---- the new cut (§28): a cut the agent adds while the desk is open ----

/** The version in `next` that `prev` did not have, the last one when several arrived together; null when none did. */
export function newCutFor(prev: readonly string[], next: readonly string[]): string | null {
  const had = new Set(prev);
  for (let i = next.length - 1; i >= 0; i--) if (!had.has(next[i]!)) return next[i]!;
  return null;
}

/** The film and versions the desk last saw. */
export interface CutMemory { film: string | null; versions: string[] }

/**
 * One look at the film on screen. The first look at a film (the first load, or a switch to another film) only sets what
 * is known: whatever the film already had is not news. After that, a version the film gains is `arrived`. A cut added by
 * the user is told the same way: the desk is not told who added it.
 */
export function stepCuts(memory: CutMemory | null, film: string | null, versions: readonly string[]): { memory: CutMemory; arrived: string | null } {
  const now = { film, versions: [...versions] };
  const arrived = memory && memory.film === film ? newCutFor(memory.versions, versions) : null;
  return { memory: now, arrived };
}

/** What to do about an arrived cut: `show` switches to it now; `offer` leaves the picture and gives a Show button and a dot. */
export interface CutAction { text: string; show: boolean; offer: boolean; dot: boolean }

/**
 * `busy`: something holds the picture where it is (playing, a note or mark being made, a locked picture). `shown` is the
 * cut on screen: one already on screen needs no Show and no dot.
 */
export function cutAction(arrived: string | null, shown: string | null | undefined, busy: boolean): CutAction | null {
  if (arrived === null) return null;
  const text = `${revealText(arrived)} is in`;
  if (!busy) return { text, show: shown !== arrived, offer: false, dot: false };
  if (shown === arrived) return { text, show: false, offer: false, dot: false };
  return { text, show: false, offer: true, dot: true };
}

/** The cut the Cut menu's dot is for: the unseen one, until it is on screen, or the film changes, or it goes. */
export function unseenCut(unseen: { film: string | null; id: string } | null, film: string | null, shown: string | null | undefined, versions: readonly string[]): string | null {
  if (!unseen || unseen.film !== film || unseen.id === shown || !versions.includes(unseen.id)) return null;
  return unseen.id;
}
