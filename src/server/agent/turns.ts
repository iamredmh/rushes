// §28.3: one turn's work is one batch. §35 removed the follow-up turn (the user's answer on a note, §28.5): notes go
// one way, and a new note on the same moment is how the user follows up.
import { AGENT_LINES } from "../../core/agentActivity.js";
import type { AgentPermissions, Batch } from "../../core/schema.js";

/** One turn's work: a batch. */
export interface TurnJob {
  kind: "batch";
  batchId: string;
  /** How Activity and the Change Log name the turn. */
  label: string;
  prompt: string;
  /** §33: the batch's permission row, read from the user's rules when it was sent. The agent runs the batch in that row's mode. */
  level?: AgentPermissions;
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** A batch's turn by what it holds (M7): "3 notes", or its script lines when it holds no note. Never its id. */
export const batchLabel = (b: Pick<Batch, "noteIds" | "sectionIds" | "label">): string =>
  b.label ? b.label : b.noteIds.length === 0 && b.sectionIds.length > 0 ? count(b.sectionIds.length, "script line", "script lines") : count(b.noteIds.length, "note", "notes");

export const batchJob = (b: Batch): TurnJob => ({ kind: "batch", batchId: b.id, label: batchLabel(b), prompt: b.prompt + "\n\n" + AGENT_LINES });
