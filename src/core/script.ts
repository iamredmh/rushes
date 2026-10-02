import type { Script, Section, Take } from "./schema.js";
import { InvalidError, NotFoundError } from "./errors.js";
import { uniqueId } from "./ids.js";

export type FitState = "ok" | "tight" | "over";

/** Does this line fit its slot at reading speed? "tight" means over 80% of the slot. */
export function fit(text: string, slotSeconds: number, wordsPerSecond: number): { words: number; seconds: number; ratio: number; state: FitState } {
  const words = (text.trim().match(/\S+/g) ?? []).length;
  const seconds = words / wordsPerSecond;
  const ratio = slotSeconds > 0 ? seconds / slotSeconds : Infinity;
  const state: FitState = ratio > 1 ? "over" : ratio > 0.8 ? "tight" : "ok";
  return { words, seconds, ratio, state };
}

/** A row counts as changed when the user's version differs from the agent's line. */
export function isChanged(s: Section): boolean {
  return s.proposed !== null && s.proposed.trim() !== s.current.trim();
}

/** A take is stale once the section's line no longer matches the text it was read from. */
export function isTakeStale(take: Take, s: Section): boolean {
  return take.forText.trim() !== s.current.trim();
}

export interface SectionInput {
  id?: string;
  start: number;
  end: number;
  current: string;
}

/**
 * Replace the script's sections. Sections that keep their id keep the user's
 * proposed text, direction, status and takes. If the agent changed `current`
 * to the user's proposal, the proposal is cleared because it has landed.
 */
export function setSections(script: Script, input: SectionInput[]): Section[] {
  const sorted = [...input].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    if (!(s.end > s.start)) throw new InvalidError(`Section at ${s.start}s must end after it starts`);
    if (i > 0 && s.start < sorted[i - 1].end) throw new InvalidError(`Sections overlap at ${s.start}s`);
  }
  const old = new Map(script.sections.map((s) => [s.id, s]));
  const ids: string[] = [];
  const next: Section[] = sorted.map((s, i) => {
    const id = s.id ?? uniqueId(`s${i + 1}`, [...ids, ...input.flatMap((x) => (x.id ? [x.id] : []))]);
    ids.push(id);
    const prev = old.get(id);
    const landed = prev?.proposed != null && prev.proposed.trim() === s.current.trim();
    return {
      id,
      start: s.start,
      end: s.end,
      current: s.current,
      proposed: landed ? null : prev?.proposed ?? null,
      direction: prev?.direction ?? "",
      status: landed ? "draft" : prev?.status ?? "draft",
      takes: prev?.takes ?? [],
    };
  });
  script.sections = next;
  return next;
}

export function findSection(script: Script, id: string): Section {
  const s = script.sections.find((x) => x.id === id);
  if (!s) throw new NotFoundError("section", id);
  return s;
}

export interface SectionEdit {
  proposed?: string | null;
  direction?: string;
  status?: Section["status"];
}

export function editSection(script: Script, id: string, edit: SectionEdit): Section {
  const s = findSection(script, id);
  if (edit.proposed !== undefined) s.proposed = edit.proposed;
  if (edit.direction !== undefined) s.direction = edit.direction;
  if (edit.status !== undefined) s.status = edit.status;
  return s;
}

export function addTake(script: Script, sectionId: string, input: { file: string; duration?: number | null }): Take {
  const s = findSection(script, sectionId);
  const take: Take = {
    id: uniqueId(`t${s.takes.length + 1}`, s.takes.map((t) => t.id)),
    file: input.file,
    duration: input.duration ?? null,
    forText: s.current,
  };
  s.takes.push(take);
  return take;
}
