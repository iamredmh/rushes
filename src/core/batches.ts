import { chipOrder, versionFormats } from "./formats.js";
import { STAGES, type Batch, type BatchesFile, type Note, type NotesFile, type Project, type Script, type Stage } from "./schema.js";
import { EmptyBatchError } from "./errors.js";
import { noteInPlay } from "./project.js";
import { isChanged } from "./script.js";
import { TAB_NAMES } from "./logEvents.js";

const STAGE_NAMES: Record<Stage, string> = {
  script: "script",
  picture: "picture",
  voice: "voiceover",
  music: "music",
  sfx: "sound effects",
  mix: "mix",
  visuals: "visuals",
};

/**
 * Gather open, unsent items into a batch: to-do notes with no batch yet, and changed or flagged
 * script sections. With a stage, only that tab's; with none (Send to agent), every tab's, on every
 * film in play. A batch whose items all come from one tab is that tab's batch; one that spans tabs
 * has no stage.
 */
export function createBatch(
  ctx: { project: Project; script: Script; notes: NotesFile; batches: BatchesFile },
  stage?: Stage,
  now = new Date(),
): Batch {
  // §26: a shelved film is never asked about; its open notes stay unsent.
  const notes = ctx.notes.notes.filter((n) => (stage === undefined || n.stage === stage) && n.status === "todo" && n.batch === null && noteInPlay(n, ctx.project));
  const sections = stage === undefined || stage === "script" ? ctx.script.sections.filter((s) => isChanged(s) || s.status === "flagged") : [];
  if (notes.length === 0 && sections.length === 0) throw new EmptyBatchError(stage);

  const id = `b_${ctx.batches.batches.length + 1}`;
  for (const n of notes) n.batch = id;
  // The tabs it covers, in tab order.
  const stages = STAGES.filter((st) => (st === "script" && sections.length > 0) || notes.some((n) => n.stage === st));
  const only = stages.length === 1 ? stages[0] : null;
  const picture = notes.filter((n) => n.stage === "picture");
  const batch: Batch = {
    id,
    stage: only,
    noteIds: notes.map((n) => n.id),
    sectionIds: sections.map((s) => s.id),
    sentAt: now.toISOString(),
    prompt: only
      ? buildPrompt(ctx.project.name, only, id, notes.length, sections.length, only === "picture" ? formatLines(ctx.project, picture) : [])
      : buildWidePrompt(ctx.project, id, notes, sections.length),
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

/** What the agent does with one tab's notes (or, on Script, its changed sections). */
function stepsFor(stage: Stage): string {
  return stage === "script"
    ? "Use rushes_get_batch, take each section's proposed line, then rushes_set_script with just those sections (it merges by id). If voiceover already exists, re-record the picked voice with the corrected script and register it with rushes_add_variant as a new read in a new round."
    : stage === "voice"
      ? "Use rushes_get_batch and rushes_get_picks. Answer the notes with new whole reads (rushes_add_variant with stage voice and round): a new round for a new direction, or the current round for a small fix to a marked word. Say in each read's description what changed. Then rushes_reply."
      : stage === "mix"
        ? // §19.6: rushes_get_picks also carries each lane's level -- where the user wants it sitting.
          'Use rushes_get_batch and rushes_get_picks, fix each note (marks such as "Fall" or "Quieter 3 dB" are part of the note), register the new variant, then rushes_reply. The picks\' levels say where the user wants each lane to sit.'
        : stage === "visuals"
          ? // §25.5: the note's picture is named in the batch; the new picture goes in as a new version of the visual.
            "Use rushes_get_batch: each note names its visual, version, page and aspect ratio, where on the picture it is (a region or a point, as fractions and in words) and the file to open. Change each marked picture, register the result as a new version with rushes_add_visual (send only the pages that changed), then rushes_reply to each note you fixed with status \"done\" and fixVersion set to that version. A note with no ratio is for every ratio: say in your reply which ratios you fixed."
          : AUDIO_STAGES.includes(stage)
          ? 'Use rushes_get_batch and rushes_get_picks, fix each note (marks such as "Fall" or "Quieter 3 dB" are part of the note), register the new variant, then rushes_reply.'
          : "Use rushes_get_batch, fix each note, then rushes_reply with a fixT for each and rushes_add_version for the new cut.";
}

export function buildPrompt(project: string, stage: Stage, batchId: string, notes: number, sections: number, extra: string[] = []): string {
  const parts: string[] = [];
  if (notes) parts.push(`${notes} note${notes === 1 ? "" : "s"}`);
  if (sections) parts.push(`${sections} script section${sections === 1 ? "" : "s"}`);
  return `Work through ${STAGE_NAMES[stage]} batch ${batchId} on ${project}: ${parts.join(" and ")}.\n${[...extra, stepsFor(stage)].join("\n")}`;
}

/**
 * The prompt for a batch that spans tabs: what is in it, tab by tab with the films each tab's notes
 * are on, then what to do on each tab.
 */
export function buildWidePrompt(project: Pick<Project, "name" | "videos">, batchId: string, notes: Pick<Note, "stage" | "video" | "version" | "format">[], sections: number): string {
  const lines: string[] = [];
  const counts: string[] = [];
  for (const stage of STAGES) {
    const here = notes.filter((n) => n.stage === stage);
    const k = here.length + (stage === "script" ? sections : 0);
    if (k === 0) continue;
    const what = stage === "script" && sections > 0
      ? [here.length ? `${here.length} note${here.length === 1 ? "" : "s"}` : "", `${sections} script section${sections === 1 ? "" : "s"}`].filter(Boolean).join(" and ")
      : `${here.length} note${here.length === 1 ? "" : "s"}`;
    // The films a tab's notes are on, by name, so the agent passes the right one to rushes_get_picks.
    const films = [...new Set(here.map((n) => n.video).filter((v): v is string => !!v))].map((v) => project.videos.find((x) => x.id === v)?.name ?? v);
    counts.push(`${TAB_NAMES[stage]}: ${what}${films.length ? ` (${films.join(", ")})` : ""}`);
    const extra = stage === "picture" ? formatLines(project, here) : [];
    lines.push(`${TAB_NAMES[stage]}: ${[...extra, stepsFor(stage)].join(" ")}`);
  }
  const total = notes.length + sections;
  const head = `Work through batch ${batchId} on ${project.name}: ${total} item${total === 1 ? "" : "s"} across ${counts.length} tabs. Each note says its tab (stage) and film (video); on an audio tab, pass that film to rushes_get_picks.`;
  return [head, ...counts.map((c) => `- ${c}`), ...lines].join("\n");
}

export function latestBatch(file: BatchesFile): Batch | undefined {
  return file.batches[file.batches.length - 1];
}
