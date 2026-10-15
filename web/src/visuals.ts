// §25.6: the Visuals tab's rules, pure. The component draws what these say. Imports are types and the pure words only.
import { labelOfId } from "../../src/core/formats.js";
import type { Note, Visual, VisualVersion } from "./types.js";

/** The page strip shows about this many pages at once, the active one first. */
export const STRIP_VISIBLE = 8;

/** The index of the first page the strip shows: the active page, unless that would leave the strip short at the end. */
export function stripStart(page: number, count: number, visible = STRIP_VISIBLE): number {
  return Math.min(Math.max(0, page - 1), Math.max(0, count - visible));
}

export type Pt = { x: number; y: number };
export type Shape = { box: { x: number; y: number; w: number; h: number } } | { pin: Pt };

/** Fractions are kept to four places: a tenth of a pixel on a 1080-wide picture, and no floating-point tails in the file. */
const r4 = (n: number): number => Math.round(n * 10000) / 10000;
const clamp = (n: number): number => r4(Math.max(0, Math.min(1, n)));
/** A drag thinner than this, either way, is a slip rather than a region. */
const MIN_SPAN = 0.02;

/** The mark a pointer gesture made: a region (clamped to the picture), a point for a click, or nothing for a drag too thin to count. */
export function shapeFromDrag(a: Pt, b: Pt, moved: boolean): Shape | null {
  if (!moved) return { pin: { x: clamp(a.x), y: clamp(a.y) } };
  const [x0, y0, x1, y1] = [clamp(a.x), clamp(a.y), clamp(b.x), clamp(b.y)];
  const box = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: r4(Math.abs(x1 - x0)), h: r4(Math.abs(y1 - y0)) };
  return box.w < MIN_SPAN || box.h < MIN_SPAN ? null : { box };
}

/** What one visual is showing: a page, an aspect ratio (a format id) and a version. */
export interface View {
  page: number;
  ratio: string;
  ver: string;
}

/** A note being written, tied to the visual it began on. `shape` is null for a whole-image note. */
export interface Draft extends View {
  vis: string;
  shape?: Shape | null;
  text: string;
  /** For a whole-image note on a visual with several ratios: keep it to the ratio in view. */
  justThis?: boolean;
}

export const newest = (v: Visual): VisualVersion => v.versions[v.versions.length - 1];

export function defaultView(v: Visual): View {
  const last = newest(v);
  return { page: 1, ratio: last.pages[0]?.images[0]?.ratio ?? "", ver: last.id };
}

/**
 * What a visual remembers of what you chose: its page and ratio, and an older version only as a look back. A look back is kept
 * with the newest version there was when you chose it (`since`), so it lapses the moment a newer one is registered.
 */
export type StoredView = Partial<View> & { since?: string };

/** What to remember of `view`: nothing about the version when it is the newest, else the version and what was newest then. */
export function remember(v: Visual, view: View): StoredView {
  const { ver, ...rest } = view;
  return ver === newest(v).id ? rest : { ...rest, ver, since: newest(v).id };
}

/** What a visual shows: the newest version, unless you are looking back and nothing newer has come in since you chose to. */
export function resolveView(v: Visual, stored: StoredView | undefined): View {
  const { ver, since, ...rest } = stored ?? {};
  const lookingBack = ver !== undefined && since === newest(v).id;
  return { ...defaultView(v), ...rest, ...(lookingBack ? { ver } : {}) };
}

/** Marks go on the newest version only: an older one is there to look at. */
export const canMark = (v: Visual, view: View): boolean => view.ver === newest(v).id;

/** "Launch carousel · page 3 · 4:5 · v2"; a still has no page to name. */
export function targetLabel(v: Visual, view: View): string {
  return [v.name, v.kind === "carousel" ? `page ${view.page}` : null, labelOfId(view.ratio), view.ver].filter(Boolean).join(" · ");
}

const visualOf = (n: Pick<Note, "on">): string => (n.on ?? "").slice(0, (n.on ?? "").lastIndexOf("/"));
const pageOf = (n: Pick<Note, "on">): number => Number((n.on ?? "").slice((n.on ?? "").lastIndexOf("/") + 1)) || 0;

/** A note's number among its visual's notes, in the order they were made: the number drawn on its mark. */
export function noteNo(notes: Note[], note: Note): number {
  return notes.filter((n) => n.stage === "visuals" && visualOf(n) === visualOf(note)).findIndex((n) => n.id === note.id) + 1;
}

export interface NoteGroup {
  visual: Pick<Visual, "id" | "name">;
  /** The visual is no longer registered; its notes are kept. */
  gone: boolean;
  open: number;
  pages: { page: number; notes: Note[] }[];
}

/** The notes column's groups: one per visual that has notes, in the visuals' order, then any whose visual is gone, each by page. */
export function groupNotes(visuals: Visual[], notes: Note[]): NoteGroup[] {
  const mine = notes.filter((n) => n.stage === "visuals");
  const ids = [...visuals.map((v) => v.id), ...new Set(mine.map(visualOf).filter((id) => !visuals.some((v) => v.id === id)))];
  const out: NoteGroup[] = [];
  for (const id of ids) {
    const ns = mine.filter((n) => visualOf(n) === id);
    if (ns.length === 0) continue;
    const v = visuals.find((x) => x.id === id);
    const pages = [...new Set(ns.map(pageOf))].sort((a, b) => a - b).map((page) => ({ page, notes: ns.filter((n) => pageOf(n) === page) }));
    out.push({ visual: { id, name: v?.name ?? id }, gone: !v, open: ns.filter((n) => n.status === "todo").length, pages });
  }
  return out;
}

/** The notes with a mark to draw on this visual's page, at this ratio and version. */
export function boxesOn(notes: Note[], visualId: string, view: View): Note[] {
  return notes.filter((n) => n.stage === "visuals" && visualOf(n) === visualId && pageOf(n) === view.page && n.format === view.ratio && n.version === view.ver && (n.box !== null || n.pin !== null));
}

/** Open notes per page, for the badges on the page strip (whatever version they were made on). */
export function openByPage(notes: Note[], visualId: string): Record<number, number> {
  const out: Record<number, number> = {};
  for (const n of notes) if (n.stage === "visuals" && n.status === "todo" && visualOf(n) === visualId) out[pageOf(n)] = (out[pageOf(n)] ?? 0) + 1;
  return out;
}

/** What to show for a clicked note: its page, its version, and its ratio (a note for every ratio keeps the one in view). */
export function viewForNote(_v: Visual, note: Note, current: View): View {
  return { page: pageOf(note), ratio: note.format ?? current.ratio, ver: note.version ?? current.ver };
}

/** The reason a new mark is refused, or null: a draft with words in it on another page, ratio or visual is never silently replaced. */
export function dragRefusal(draft: (View & { vis: string; text: string }) | null, here: View & { vis: string }, draftName: string): string | null {
  if (!draft || draft.text.trim() === "") return null;
  const same = draft.vis === here.vis && draft.page === here.page && draft.ratio === here.ratio && draft.ver === here.ver;
  return same ? null : `Finish or discard your draft on ${draftName} first.`;
}

export { pageOf as notePage, visualOf as noteVisual };
