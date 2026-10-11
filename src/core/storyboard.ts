import { parseBrief, setSectionBody } from "./brief.js";

// §24.12: storyboard.md is the file of record for the shots, as brief.md is for the brief. One section per
// shot ("## Shot 02 · Drop a folder"). Its facts are the lines above the first blank line (Tag, Length, Still,
// Status, Direction); what follows is what happens. These are pure functions over the text: everything the
// page does not touch (the title, other sections, the user's formatting) is left exactly as it was.

/** The storyboard's file name, in the project folder's root. */
export const STORYBOARD_FILE = "storyboard.md";

export type ShotStatus = "draft" | "approved";

export interface Shot {
  /** Position among the file's `## ` sections: the address an edit uses, with `heading` as a check. */
  index: number;
  /** The heading text after "## ". */
  heading: string;
  /** The number in the heading ("Shot 02" is 2). */
  n: number;
  name: string;
  tag: string;
  /** Planned seconds, or null when the line is missing or not a positive number. */
  length: number | null;
  /** A project-relative path to an image, or null when there is none or it is not a safe one. */
  still: string | null;
  status: ShotStatus;
  direction: string;
  description: string;
}

export interface ParsedStoryboard {
  /** The "# ..." title without a leading "Storyboard:", or "". */
  title: string;
  shots: Shot[];
}

const HEADING = /^Shot\s+(\d+)\s*[·:–—-]\s*(.+?)\s*$/i;
const META = /^(Tag|Length|Still|Status|Direction):[ \t]*(.*?)[ \t]*$/i;
/** What a still may be: pictures a browser shows inline. */
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

/** A still's path as the page may use it: relative, inside the project, a picture. Anything else is no still. */
export function stillPath(raw: string): string | null {
  const p = raw.trim().replace(/^\.\//, "");
  if (!p || p.startsWith("/") || p.startsWith("~") || /^[a-z]:/i.test(p) || p.includes("\\") || p.includes("\0")) return null;
  if (p.split("/").some((seg) => seg === ".." || seg === "" || seg === ".")) return null;
  return IMAGE.test(p) ? p : null;
}

interface Split {
  /** The fact lines, as written. */
  meta: string[];
  description: string;
}

/** A shot section's body split into its fact lines and what happens. */
function split(body: string): Split {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && META.test(lines[i])) i++;
  const meta = lines.slice(0, i);
  if (i < lines.length && lines[i].trim() === "") i++;
  return { meta, description: lines.slice(i).join("\n").replace(/\s+$/, "") };
}

const metaOf = (meta: string[], key: string): string | undefined => {
  for (const l of meta) {
    const m = META.exec(l);
    if (m && m[1].toLowerCase() === key.toLowerCase()) return m[2];
  }
  return undefined;
};

export function parseStoryboard(text: string): ParsedStoryboard {
  const brief = parseBrief(text);
  const shots: Shot[] = [];
  brief.sections.forEach((s, index) => {
    const h = HEADING.exec(s.heading);
    if (!h) return;
    const { meta, description } = split(s.body);
    const length = Number(metaOf(meta, "Length"));
    shots.push({
      index,
      heading: s.heading,
      n: Number(h[1]),
      name: h[2],
      tag: metaOf(meta, "Tag") ?? "",
      length: Number.isFinite(length) && length > 0 ? length : null,
      still: stillPath(metaOf(meta, "Still") ?? ""),
      status: (metaOf(meta, "Status") ?? "").toLowerCase() === "approved" ? "approved" : "draft",
      direction: metaOf(meta, "Direction") ?? "",
      description,
    });
  });
  return { title: brief.title.replace(/^Storyboard:[ \t]*/i, ""), shots };
}

/** The section's body rebuilt from its fact lines and its description. */
function join(meta: string[], description: string): string {
  const d = description.replace(/\r\n/g, "\n").replace(/^\s*\n+/, "").replace(/\s+$/, "");
  return d ? [...meta, "", d].join("\n") : meta.join("\n");
}

function withMeta(meta: string[], key: string, value: string): string[] {
  const at = meta.findIndex((l) => META.exec(l)?.[1].toLowerCase() === key.toLowerCase());
  if (at >= 0) {
    const name = META.exec(meta[at])![1];
    return meta.map((l, i) => (i === at ? `${name}: ${value}`.trimEnd() : l));
  }
  return [...meta, `${key}: ${value}`.trimEnd()];
}

export interface ShotEdit {
  description?: string;
  /** One line: a line break in it is a space. */
  direction?: string;
  status?: ShotStatus;
}

/**
 * `text` with one shot changed. `heading` must be the heading at `index` (a file that was reordered under you
 * is refused, not edited in the wrong place). Only the fields given change; a missing fact line is added.
 */
export function editShot(text: string, index: number, heading: string, edit: ShotEdit): string {
  const section = parseBrief(text).sections[index];
  if (!section || section.heading !== heading || !HEADING.test(heading)) throw new Error(`No shot "${heading}" at position ${index + 1}`);
  const parts = split(section.body);
  let meta = parts.meta;
  if (edit.direction !== undefined) meta = withMeta(meta, "Direction", edit.direction.replace(/\s*\r?\n\s*/g, " ").trim());
  if (edit.status !== undefined) meta = withMeta(meta, "Status", edit.status);
  const description = edit.description !== undefined ? edit.description : parts.description;
  return setSectionBody(text, index, heading, join(meta, description));
}

/**
 * The shots as a cut's shot list: each `start` is the running total of the lengths before it. A shot with
 * no usable Length counts as one second, so two shots never start together.
 */
export function cutShots(shots: Pick<Shot, "name" | "tag" | "length">[]): { name: string; start: number; tag: string }[] {
  let start = 0;
  let last = -1;
  // A shot list holds at most 200 shots, and no two may start together: lengths too small to tell apart still step by a millisecond.
  return shots.slice(0, 200).map((s) => {
    const at = Math.max(Math.round(start * 1000) / 1000, last + 0.001);
    const out = { name: s.name.slice(0, 80), start: Math.round(at * 1000) / 1000, tag: s.tag.slice(0, 24) };
    last = out.start;
    start += s.length ?? 1;
    return out;
  });
}
