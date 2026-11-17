// Send to AI in the desk (§28): what the chip, a note's badge, the who-line and the live strip say, and what the
// desk does after Send. Pure: the words come from the agent's status (GET /api/agent and the SSE `agent` event)
// and the notes the desk already holds, so every tab says the same thing.
import { alwaysLabel } from "../../src/core/alwaysLabel.js";
import { noteState } from "../../src/core/noteState.js";
import type { ActivityLine, AgentId, AgentInfo, AgentPhase, AgentRules, AgentStatus, AlwaysRule, Note, SendHandOver } from "./types.js";

/** A note as these helpers read it. The desk's notes carry `needsYou` from the server's `withState`. */
export type NoteLite = Pick<Note, "id" | "batch" | "status" | "fixVersion"> & { needsYou?: boolean };

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
    case "question": text = `${a} has a question`; break;
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
  if (phase === "waiting" || phase === "question") return "todo";
  if (phase === "finished") return "done";
  if (phase === "failed") return "over";
  return "busy";
}

/** Stop shows while the agent is starting, on a turn, or waiting on an ask: the phases a Stop can end. */
export const canStop = (phase: AgentPhase): boolean => RUNNING.has(phase);

export type NoteBadge = { kind: "working" | "needsYou" | "with" | "fixed"; text: string };

/** The badge on a note's card, by priority: needs you, being worked on, with the agent, fixed. Null for none. */
export function noteAgentBadge(n: NoteLite, s: AgentStatus | null): NoteBadge | null {
  if (n.needsYou) return { kind: "needsYou", text: "Needs you" };
  if (s && s.current.note === n.id && RUNNING.has(s.phase)) return { kind: "working", text: s.current.doing ?? "Working on it" };
  const state = noteState(n);
  if (state === "sent") return { kind: "with", text: `With ${agentName(s?.agent ?? null)}` };
  if (state === "done" && n.fixVersion) return { kind: "fixed", text: `Fixed in ${n.fixVersion}` };
  return null;
}

/**
 * What the desk does with Send's answer (POST /api/batches `agent`). "dialog" is today's "Sent to agent" dialog with
 * Copy prompt: no hand-over, or a refusal where nothing was started (runner.ts SendResult). A Stop's refusal and a
 * recalled start say so instead, with or without a reason.
 */
export function afterSend(r: SendHandOver | undefined): "dialog" | "handed" | "starting" | "recalled" | "stopped" {
  if (r === undefined) return "dialog";
  const flags = r as { stopped?: true; recalled?: true; starting?: true };
  if (r.handedTo === null && !flags.stopped && !flags.recalled) return "dialog";
  if (flags.stopped) return "stopped";
  if (flags.recalled) return "recalled";
  if (flags.starting) return "starting";
  return "handed";
}

/** Under Send while Send to AI is on: what the agent may do without asking. */
export function whoLine(s: AgentStatus): string {
  const may = s.permissions === "ask-all" ? "Asks before everything" : "Edits files in this project, asks before commands";
  return s.session ? `${may} · next Send continues the conversation` : may;
}

/** The live strip: the last `max` activity lines, newest first. */
export const liveLines = (s: AgentStatus, max = 20): ActivityLine[] => (max > 0 ? s.lines.slice(-max).reverse() : []);

// ---- the Send to AI row above Send, and the agent menu (task 3) ----

/** The row: the agent it sends to, or the way in when none is chosen. */
export const rowText = (s: AgentStatus): string => (s.agent ? `Send to AI · ${agentName(s.agent)}` : "Set up Send to AI");

/** Under Send: the who-line while Send to AI is on, what Send does while it is off. */
export const footLine = (s: AgentStatus): string => (s.on ? whoLine(s) : "Copies a prompt for your own chat");

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

export const PERMISSION_CHOICES: readonly { value: AgentRules["permissions"]; label: string }[] = [
  { value: "project-edits", label: "Edit files in this project" },
  { value: "ask-all", label: "Ask me for everything" },
];

export interface MenuAgent { id: AgentId; name: string; signedIn: boolean; current: boolean }

/** "Send notes to": each agent detection found installed, in its order, the one Send to AI uses ticked. */
export function menuAgents(detected: readonly AgentInfo[] | null, s: AgentStatus): MenuAgent[] {
  return (detected ?? []).filter((a) => a.installed).map((a) => ({ id: a.id, name: a.name, signedIn: a.signedIn, current: a.id === s.agent }));
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
