// §35.4: notes go one way. On start, once (idempotent): a note left in the old Needs you state (sent, the agent's word
// last) goes back to to do, keeping its replies, so the next Send takes it again. A start has no run in flight, so no
// note is with the agent for real at this moment except one whose batch was refused (I3), which has no agent reply.
import { leftAsking, recallNote } from "../core/noteState.js";
import type { Store } from "../core/store.js";

/** The ids moved back to to do (none: nothing written). */
export async function settleOldQuestions(store: Store): Promise<string[]> {
  const notes = await store.read("notes");
  if (!notes.notes.some(leftAsking)) return [];
  const { result } = await store.update("notes", (f) => {
    const moved: string[] = [];
    for (const n of f.notes.filter(leftAsking)) if (recallNote(f.notes, n.id)) moved.push(n.id);
    return moved;
  });
  return result;
}
