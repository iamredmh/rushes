import { slugify } from "./ids.js";
import { markLabel, type Note, type Project, type Stage } from "./schema.js";

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

/** `text`, with every line after the first indented to `indent` (M2): a multi-line note or
 *  reply would otherwise put an unindented line straight after a list item, which most Markdown
 *  renderers (this project's own built-in one included) read as ending the list rather than
 *  continuing it. */
function continued(text: string, indent: string): string {
  return text.split("\n").join(`\n${indent}`);
}

function noteLines(n: Note): string[] {
  const marks = n.marks.length ? ` · ${n.marks.map(markLabel).join(" · ")}` : "";
  const shot = n.shot ? ` · shot ${pad(n.shot.n)}` : "";
  const status = n.status === "done" ? "done" : "to do";
  const lines = [`- **${noteTime(n.t, n.tOut)}**${marks}${shot} · ${status} — ${continued(n.text, "  ")}`];
  if (n.reply) lines.push(`  - Reply: ${continued(n.reply, "    ")}`);
  if (n.grab) lines.push(`  - Screenshot: ${n.grab}`);
  return lines;
}

// By timecode within a film and version, a whole-track note (t === null) last -- notes were
// otherwise listed in whatever order they happened to be created in, which usually isn't where
// they land on the timeline.
function byTimecode(a: Note, b: Note): number {
  return a.t === null ? 1 : b.t === null ? -1 : a.t - b.t;
}

/**
 * The project's notes as Markdown: a title and export date, then one `##` section per stage
 * that has notes, in workflow order (script is never included -- it lives in script.json).
 * Picture notes are further grouped under a `### <Film> · <version>` heading per film and
 * version that has notes, in the project's own video/version order. A note whose video or
 * version no longer exists in the project (hand-edited away, say) is never dropped (M3): it's
 * still exported, grouped under `### <Film> · <version> (removed)`, in the order those groups
 * were first seen among the orphaned notes. Nothing is escaped (this is a file, not HTML), and
 * the same input always produces the same string.
 */
export function notesMarkdown(project: Project, notes: Note[], now: Date): string {
  const lines: string[] = [`# ${project.name} — notes`, `Exported ${localDateTime(now)}`];

  for (const stage of STAGE_ORDER) {
    const stageNotes = notes.filter((n) => n.stage === stage);
    if (stageNotes.length === 0) continue;
    lines.push("", `## ${STAGE_TITLES[stage]}`);

    if (stage === "picture") {
      const matched = new Set<Note>();
      for (const video of project.videos) {
        for (const version of video.versions) {
          const group = stageNotes
            .filter((n) => n.video === video.id && n.version === version.id)
            .sort(byTimecode);
          if (group.length === 0) continue;
          lines.push("", `### ${video.name} · ${version.id}`);
          for (const n of group) {
            lines.push(...noteLines(n));
            matched.add(n);
          }
        }
      }
      // Orphaned: video and/or version no longer resolve against the project (M3). Grouped by
      // the pair rather than just listed, so a reader can still tell which notes belonged
      // together, in the order those pairs first turn up among the orphans.
      const orphanGroups = new Map<string, { label: string; notes: Note[] }>();
      for (const n of stageNotes) {
        if (matched.has(n)) continue;
        const videoLabel = project.videos.find((v) => v.id === n.video)?.name ?? n.video ?? "Unknown film";
        const label = `${videoLabel} · ${n.version ?? "no version"}`;
        let g = orphanGroups.get(label);
        if (!g) { g = { label, notes: [] }; orphanGroups.set(label, g); }
        g.notes.push(n);
      }
      for (const g of orphanGroups.values()) {
        lines.push("", `### ${g.label} (removed)`);
        for (const n of [...g.notes].sort(byTimecode)) lines.push(...noteLines(n));
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
