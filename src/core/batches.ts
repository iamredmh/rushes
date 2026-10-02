import type { Batch, BatchesFile, NotesFile, Project, Script, Stage } from "./schema.js";
import { EmptyBatchError } from "./errors.js";
import { isChanged } from "./script.js";

const STAGE_NAMES: Record<Stage, string> = {
  script: "script",
  picture: "picture",
  voice: "voiceover",
  music: "music",
  sfx: "sound effects",
  mix: "mix",
};

/**
 * Gather this tab's open, unsent items into a batch: to-do notes with no
 * batch yet, and (on the script tab) changed or flagged sections.
 */
export function createBatch(
  ctx: { project: Project; script: Script; notes: NotesFile; batches: BatchesFile },
  stage: Stage,
  now = new Date(),
): Batch {
  const notes = ctx.notes.notes.filter((n) => n.stage === stage && n.status === "todo" && n.batch === null);
  const sections = stage === "script" ? ctx.script.sections.filter((s) => isChanged(s) || s.status === "flagged") : [];
  if (notes.length === 0 && sections.length === 0) throw new EmptyBatchError(stage);

  const id = `b_${ctx.batches.batches.length + 1}`;
  for (const n of notes) n.batch = id;
  const batch: Batch = {
    id,
    stage,
    noteIds: notes.map((n) => n.id),
    sectionIds: sections.map((s) => s.id),
    sentAt: now.toISOString(),
    prompt: buildPrompt(ctx.project.name, stage, id, notes.length, sections.length),
  };
  ctx.batches.batches.push(batch);
  return batch;
}

export function buildPrompt(project: string, stage: Stage, batchId: string, notes: number, sections: number): string {
  const parts: string[] = [];
  if (notes) parts.push(`${notes} note${notes === 1 ? "" : "s"}`);
  if (sections) parts.push(`${sections} script section${sections === 1 ? "" : "s"}`);
  const steps =
    stage === "script"
      ? "Use rushes_get_batch, take each section's proposed line, then rushes_set_script with just those sections (it merges by id)."
      : "Use rushes_get_batch, fix each note, then rushes_reply with a fixT for each and rushes_add_version for the new cut.";
  return `Work through ${STAGE_NAMES[stage]} batch ${batchId} on ${project}: ${parts.join(" and ")}.\n${steps}`;
}

export function latestBatch(file: BatchesFile): Batch | undefined {
  return file.batches[file.batches.length - 1];
}
