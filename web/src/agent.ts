// Send to AI in the desk (§28): what the chip, a note's badge, the who-line and the live strip say, and what the
// desk does after Send. Pure: the words come from the agent's status (GET /api/agent and the SSE `agent` event)
// and the notes the desk already holds, so every tab says the same thing.
import { noteState } from "../../src/core/noteState.js";
import type { ActivityLine, AgentId, AgentPhase, AgentStatus, Note, SendHandOver } from "./types.js";

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
