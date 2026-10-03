import { slugify } from "./ids.js";
import type { Note, Project, Stage } from "./schema.js";

// Picture notes are grouped by film and version; the other stages list straight through.
// Script isn't included here -- script edits live in script.json, not notes.json.
const STAGE_ORDER: Exclude<Stage, "script">[] = ["picture", "voice", "music", "sfx", "mix"];
const STAGE_TITLES: Record<Exclude<Stage, "script">, string> = {
  picture: "Picture",
  voice: "Voiceover",
  music: "Music",
  sfx: "Sound effects",
  mix: "Mix",
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The server's local date, as YYYY-MM-DD. */
function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localDateTime(d: Date): string {
  return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// A small local copy of web/src/lib.ts's fmt()/noteTime(): minutes:seconds.hundredths, rounded to
// hundredths before splitting so 59.999s carries into the next minute rather than printing 60.00s.
// Duplicated rather than imported -- src/ and web/ are separate TypeScript projects.
function fmt(t: number): string {
  const cs = Math.round(Math.max(0, t) * 100);
  const m = Math.floor(cs / 6000);
  const s = ((cs - m * 6000) / 100).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
}

function noteTime(t: number | null, tOut: number | null): string {
  if (t === null) return "Whole";
  return tOut !== null ? `${fmt(t)}–${fmt(tOut)}` : fmt(t);
}

function noteLines(n: Note): string[] {
  const shot = n.shot ? ` · shot ${pad(n.shot.n)}` : "";
  const status = n.status === "done" ? "done" : "to do";
  const lines = [`- **${noteTime(n.t, n.tOut)}**${shot} · ${status} — ${n.text}`];
  if (n.reply) lines.push(`  - Reply: ${n.reply}`);
  if (n.grab) lines.push(`  - Screenshot: ${n.grab}`);
  return lines;
}

/**
 * The project's notes as Markdown: a title and export date, then one `##` section per stage
 * that has notes, in workflow order (script is never included -- it lives in script.json).
 * Picture notes are further grouped under a `### <Film> · <version>` heading per film and
 * version that has notes, in the project's own video/version order. Nothing is escaped (this
 * is a file, not HTML), and the same input always produces the same string.
 */
export function notesMarkdown(project: Project, notes: Note[], now: Date): string {
  const lines: string[] = [`# ${project.name} — notes`, `Exported ${localDateTime(now)}`];

  for (const stage of STAGE_ORDER) {
    const stageNotes = notes.filter((n) => n.stage === stage);
    if (stageNotes.length === 0) continue;
    lines.push("", `## ${STAGE_TITLES[stage]}`);

    if (stage === "picture") {
      for (const video of project.videos) {
        for (const version of video.versions) {
          const group = stageNotes.filter((n) => n.video === video.id && n.version === version.id);
          if (group.length === 0) continue;
          lines.push("", `### ${video.name} · ${version.id}`);
          for (const n of group) lines.push(...noteLines(n));
        }
      }
    } else {
      for (const n of stageNotes) lines.push(...noteLines(n));
    }
  }

  return lines.join("\n") + "\n";
}

/** "<project-slug>-notes-<YYYY-MM-DD>.md", dated by the server's local clock. */
export function exportFileName(projectName: string, now: Date): string {
  return `${slugify(projectName)}-notes-${localDate(now)}.md`;
}
