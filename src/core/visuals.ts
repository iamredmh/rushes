// §25: a visual is one post, a still or a carousel of pages, each page a picture in each aspect ratio it comes in. These are
// pure functions over the visuals file: they register a visual or a new version of one, and check a note against one. The
// pictures' sizes are read by the caller (the server reads the files), so nothing here touches the disk.
import { RushesError } from "./errors.js";
import { labelOfId, ratioId, ratioLabel } from "./formats.js";
import { slugify, uniqueId } from "./ids.js";
import { MAX_VISUAL_PAGES, type Note, type Visual, type VisualImage, type VisualPage, type VisualVersion, type VisualsFile } from "./schema.js";

/** One picture the agent gave: where it is, and the size read from it. */
export interface PictureInput {
  file: string;
  width: number;
  height: number;
}

/** One page: its pictures, one per aspect ratio. `n` is optional when registering a visual and required for a new version. */
export interface PageInput {
  n?: number;
  files: PictureInput[];
}

const fail = (code: string, message: string, detail: Record<string, unknown> = {}): never => {
  throw new RushesError(message, 400, code, detail);
};

const norm = (s: string): string => s.trim().toLowerCase();

/** A page's pictures as images, each with the ratio its size gives it. Two pictures of one shape on one page are refused. */
function imagesOf(files: PictureInput[], page: number): VisualImage[] {
  if (files.length === 0) fail("bad_pages", `Page ${page} has no pictures.`, { page });
  const images: VisualImage[] = [];
  for (const f of files) {
    const ratio = ratioId(ratioLabel(f.width, f.height));
    const clash = images.find((i) => i.ratio === ratio);
    if (clash) fail("same_ratio", `Page ${page}: ${f.file} and ${clash.file} are both ${labelOfId(ratio)}. Give one picture per aspect ratio.`, { page, ratio, files: [clash.file, f.file] });
    images.push({ ratio, file: f.file, width: f.width, height: f.height });
  }
  return images;
}

/** The aspect ratios a version comes in, in the order its pages list them. */
export function visualRatios(version: Pick<VisualVersion, "pages">): string[] {
  return version.pages[0]?.images.map((i) => i.ratio) ?? [];
}

/** Registers a new visual with its first version (v1). Changes nothing when it throws. */
export function registerVisual(
  file: VisualsFile,
  input: { name: string; kind?: Visual["kind"]; label?: string; pages: PageInput[] },
  now = new Date(),
): { visual: Visual; version: VisualVersion } {
  const name = input.name.trim();
  if (name === "") fail("bad_name", "A visual needs a name.");
  const slug = slugify(name);
  if (file.visuals.some((v) => norm(v.name) === norm(name) || v.id === slug)) {
    fail("duplicate_name", `There is already a visual called "${name}". Register a new version of it, or give this one another name.`, { name });
  }
  if (input.pages.length === 0) fail("bad_pages", "A visual needs at least one page.");
  if (input.pages.length > MAX_VISUAL_PAGES) fail("too_many_pages", `A visual holds at most ${MAX_VISUAL_PAGES} pages; this has ${input.pages.length}.`, { pages: input.pages.length });
  const kind = input.kind ?? (input.pages.length > 1 ? "carousel" : "still");
  if (kind === "still" && input.pages.length > 1) fail("bad_pages", "A still has one page. Register several pages as a carousel.");

  const pages: VisualPage[] = input.pages.map((p, i) => {
    if (p.n !== undefined && p.n !== i + 1) fail("bad_pages", `Pages are numbered 1, 2, 3 in order: the page at position ${i + 1} is numbered ${p.n}.`, { page: p.n });
    return { n: i + 1, images: imagesOf(p.files, i + 1) };
  });
  const ratios = pages[0].images.map((i) => i.ratio).sort().join(",");
  const odd = pages.find((p) => p.images.map((i) => i.ratio).sort().join(",") !== ratios);
  if (odd) fail("ratio_set", `Every page must come in the same aspect ratios: page 1 is ${pages[0].images.map((i) => labelOfId(i.ratio)).join(", ")}, page ${odd.n} is ${odd.images.map((i) => labelOfId(i.ratio)).join(", ")}.`, { page: odd.n });

  const version: VisualVersion = { id: "v1", addedAt: now.toISOString(), label: input.label ?? "", pages };
  const visual: Visual = { id: uniqueId(slug, file.visuals.map((v) => v.id)), name, kind, addedAt: now.toISOString(), versions: [version] };
  file.visuals.push(visual);
  return { visual, version };
}

/** Finds a visual by its id, or by its name. */
export function findVisual(file: Pick<VisualsFile, "visuals">, ref: string): Visual | undefined {
  return file.visuals.find((v) => v.id === ref) ?? file.visuals.find((v) => norm(v.name) === norm(ref));
}

/**
 * Registers a new version of a visual. `pages` lists only what changed or is new; every other page, and every other
 * ratio of a listed page, is inherited from the version before. Pages can be added at the end and never removed, and
 * once inherited, every page must have a picture for every ratio. Changes nothing when it throws.
 */
export function addVisualVersion(
  file: VisualsFile,
  input: { visual: string; label?: string; pages: PageInput[] },
  now = new Date(),
): { visual: Visual; version: VisualVersion } {
  const visual = findVisual(file, input.visual);
  if (!visual) return fail("no_such_visual", `No visual "${input.visual}". Register it with a name first.`, { visual: input.visual });
  const prev = visual.versions[visual.versions.length - 1];

  const listed = new Map<number, VisualImage[]>();
  for (const p of input.pages) {
    if (p.n === undefined || !Number.isInteger(p.n) || p.n < 1) fail("bad_pages", "Each page of a new version needs its page number, from 1.", { page: p.n });
    if (listed.has(p.n!)) fail("bad_pages", `Page ${p.n} is listed twice.`, { page: p.n });
    listed.set(p.n!, imagesOf(p.files, p.n!));
  }
  if (listed.size === 0) fail("bad_pages", "A new version needs at least one page.");
  const total = Math.max(prev.pages.length, ...listed.keys());
  for (let n = prev.pages.length + 1; n <= total; n++) {
    if (!listed.has(n)) fail("bad_pages", `Page ${n} is missing: new pages are added at the end with no gap (the version before has ${prev.pages.length}).`, { page: n });
  }
  if (total > MAX_VISUAL_PAGES) fail("too_many_pages", `A visual holds at most ${MAX_VISUAL_PAGES} pages; this would have ${total}.`, { pages: total });
  if (visual.kind === "still" && total > 1) fail("bad_pages", "A still has one page. Register several pages as a carousel.");

  // The ratios: the version before's, then any new ones in the order they first appear.
  const ratios = [...visualRatios(prev)];
  for (const images of listed.values()) for (const i of images) if (!ratios.includes(i.ratio)) ratios.push(i.ratio);

  const pages: VisualPage[] = [];
  for (let n = 1; n <= total; n++) {
    const before = prev.pages[n - 1]?.images ?? [];
    const sent = listed.get(n) ?? [];
    const images: VisualImage[] = [];
    for (const ratio of ratios) {
      const image = sent.find((i) => i.ratio === ratio) ?? before.find((i) => i.ratio === ratio);
      if (!image) return fail("grid_incomplete", `Page ${n} has no ${labelOfId(ratio)} picture. Every page needs one for every aspect ratio.`, { page: n, ratio });
      images.push(image);
    }
    pages.push({ n, images });
  }

  const version: VisualVersion = { id: `v${visual.versions.length + 1}`, addedAt: now.toISOString(), label: input.label ?? "", pages };
  visual.versions.push(version);
  return { visual, version };
}

/**
 * §25.4, checked when a note on a visual is written: the visual, its version and the page must be there, a ratio must be one
 * of the version's, and a region or a point needs a ratio (a place on one shape is not the place on another).
 */
export function checkVisualNote(next: Pick<Note, "stage" | "on" | "version" | "format" | "box" | "pin">, file: Pick<VisualsFile, "visuals">): void {
  if (next.stage !== "visuals") return;
  const on = next.on ?? "";
  const slash = on.lastIndexOf("/");
  const id = slash === -1 ? on : on.slice(0, slash);
  const visual = file.visuals.find((v) => v.id === id);
  if (!visual) fail("no_such_visual", `No visual "${id}".`, { visual: id });
  const version = visual!.versions.find((v) => v.id === next.version);
  if (!version) fail("no_such_version", `${visual!.name} has no version ${next.version ?? "(none)"}.`, { visual: id, version: next.version });
  const n = slash === -1 ? NaN : Number(on.slice(slash + 1));
  if (!Number.isInteger(n) || !version!.pages.some((p) => p.n === n)) fail("no_such_page", `${visual!.name} ${next.version} has no page ${slash === -1 ? "(none)" : on.slice(slash + 1)}.`, { visual: id, page: on.slice(slash + 1) });
  if (next.format !== null && !visualRatios(version!).includes(next.format)) fail("unknown_format", `${visual!.name} ${next.version} has no ${labelOfId(next.format)} picture.`, { format: next.format });
  if ((next.box || next.pin) && next.format === null) fail("shape_needs_format", "A region or a point is drawn on one aspect ratio, so the note needs one.");
}

import { pinWords, regionWords } from "./visualWords.js";
export { pinWords, regionWords };

/** A note on a visual as an agent needs it: what it is on, where, and the exact picture to open. */
export interface VisualNoteView {
  visual: { id: string; name: string };
  version: string;
  page: number;
  /** The ratio as a label ("4:5"), or null for a note that is for every ratio. */
  ratio: string | null;
  shape: "region" | "pin" | "image";
  region: { x: number; y: number; w: number; h: number } | null;
  pin: { x: number; y: number } | null;
  words: string | null;
  /** The picture of that page in that ratio, or null when the note is for every ratio. */
  file: string | null;
}

export function visualNoteView(note: Pick<Note, "stage" | "on" | "version" | "format" | "box" | "pin">, file: Pick<VisualsFile, "visuals">): VisualNoteView | null {
  if (note.stage !== "visuals" || note.on === null) return null;
  const slash = note.on.lastIndexOf("/");
  const visual = file.visuals.find((v) => v.id === note.on!.slice(0, slash));
  const page = Number(note.on.slice(slash + 1));
  if (!visual || slash === -1 || !Number.isInteger(page)) return null;
  const version = visual.versions.find((v) => v.id === note.version);
  const image = version?.pages.find((p) => p.n === page)?.images.find((i) => i.ratio === note.format);
  const box = note.box ? { x: note.box.x, y: note.box.y, w: note.box.w, h: note.box.h } : null;
  const pin = note.pin ? { x: note.pin.x, y: note.pin.y } : null;
  return {
    visual: { id: visual.id, name: visual.name },
    version: note.version ?? "",
    page,
    ratio: note.format === null ? null : labelOfId(note.format),
    shape: box ? "region" : pin ? "pin" : "image",
    region: box,
    pin,
    words: box ? regionWords(box) : pin ? pinWords(pin) : null,
    file: image?.file ?? null,
  };
}
