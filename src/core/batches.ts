import { chipOrder, versionFormats } from "./formats.js";
import type { Batch, BatchesFile, Note, NotesFile, Project, Script, Stage } from "./schema.js";
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
    prompt: buildPrompt(ctx.project.name, stage, id, notes.length, sections.length, stage === "picture" ? formatLines(ctx.project, notes) : []),
  };
  ctx.batches.batches.push(batch);
  return batch;
}

// §17.7: the audio tabs (Voiceover, Music, Sound effects, Mix) point the agent at the picks as
// well as the notes, since fixing a note there usually means registering a new take or variant
// and re-picking it, not just posting a new cut.
const AUDIO_STAGES: readonly Stage[] = ["voice", "music", "sfx", "mix"];

const FORMAT_STEPS =
  "A note with a format is for that format only: fix it there and leave the others. An all-format note is for every format: say in your reply which formats you fixed. Register every shape of the new cut (rushes_add_version with formats, or rushes_add_format).";

/** §21.5: for a Picture batch, each cut with formats, its shapes and how many notes each has, then how to fix them. */
export function formatLines(project: Pick<Project, "videos">, notes: Pick<Note, "video" | "version" | "format">[]): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const n of notes) {
    const key = `${n.video}\u0000${n.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const video = project.videos.find((v) => v.id === n.video);
    const version = video?.versions.find((v) => v.id === n.version);
    // The cut's own file is a shape beside the listed formats, even while its size is unknown (hand-edited).
    const total = (version?.formats?.length ?? 0) + 1;
    if (!video || !version || total < 2) continue;
    const views = versionFormats(version);
    const main = views.find((f) => f.primary);
    const ordered = chipOrder(views.filter((f) => !f.primary));
    const names = main ? [`${main.label} (main)`, ...ordered.map((f) => f.label)].join(", ") : `${ordered.map((f) => f.label).join(", ")} and the cut's own file`;
    const here = notes.filter((x) => x.video === n.video && x.version === n.version);
    const counts = [
      { label: "all formats", k: here.filter((x) => x.format === null).length },
      ...(main ? [main, ...ordered] : ordered).map((f) => ({ label: f.label, k: here.filter((x) => x.format === f.id).length })),
    ].filter((c) => c.k > 0);
    lines.push(`${video.name} ${version.id} has ${total} formats: ${names}. Notes: ${counts.map((c) => `${c.k} for ${c.label}`).join(", ")}.`);
  }
  if (lines.length) lines.push(FORMAT_STEPS);
  return lines;
}

export function buildPrompt(project: string, stage: Stage, batchId: string, notes: number, sections: number, extra: string[] = []): string {
  const parts: string[] = [];
  if (notes) parts.push(`${notes} note${notes === 1 ? "" : "s"}`);
  if (sections) parts.push(`${sections} script section${sections === 1 ? "" : "s"}`);
  const steps =
    stage === "script"
      ? "Use rushes_get_batch, take each section's proposed line, then rushes_set_script with just those sections (it merges by id). If voiceover already exists, re-record the picked voice with the corrected script and register it with rushes_add_variant as a new read in a new round."
      : stage === "voice"
        ? "Use rushes_get_batch and rushes_get_picks. Answer the notes with new whole reads (rushes_add_variant with stage voice and round): a new round for a new direction, or the current round for a small fix to a marked word. Say in each read's description what changed. Then rushes_reply."
        : stage === "mix"
          ? // §19.6: rushes_get_picks also carries each lane's level -- where the user wants it sitting.
            'Use rushes_get_batch and rushes_get_picks, fix each note (marks such as "Fall" or "Quieter 3 dB" are part of the note), register the new variant, then rushes_reply. The picks\' levels say where the user wants each lane to sit.'
          : AUDIO_STAGES.includes(stage)
            ? 'Use rushes_get_batch and rushes_get_picks, fix each note (marks such as "Fall" or "Quieter 3 dB" are part of the note), register the new variant, then rushes_reply.'
            : "Use rushes_get_batch, fix each note, then rushes_reply with a fixT for each and rushes_add_version for the new cut.";
  return `Work through ${STAGE_NAMES[stage]} batch ${batchId} on ${project}: ${parts.join(" and ")}.\n${[...extra, steps].join("\n")}`;
}

export function latestBatch(file: BatchesFile): Batch | undefined {
  return file.batches[file.batches.length - 1];
}
