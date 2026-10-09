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

export interface SetSectionsOptions {
  /** Make the input the whole list. By default the input is merged into the script by id. */
  replace?: boolean;
}

/**
 * Write the agent's sections into the script and return the full, sorted list.
 *
 * By default this merges: an input whose id exists updates that section's
 * start, end and current line; an input with no id or an unknown id is a new
 * section; sections left out stay as they are. With `replace: true` the input
 * becomes the whole list.
 *
 * Either way, a section that keeps its id keeps the user's proposed text,
 * direction, status and takes. A proposal the agent adopts as the current line
 * is cleared because it has landed. A section whose line the agent changed goes
 * back to draft, whatever its status: a flag has been acted on, and an approval
 * was for the words the user read, not the new ones. Re-sending the same words
 * (spacing aside) leaves the status alone.
 */
export function setSections(script: Script, input: SectionInput[], { replace = false }: SetSectionsOptions = {}): Section[] {
  const seen = new Set<string>();
  const existing = new Set(script.sections.map((s) => s.id));
  for (const s of input) {
    if (!(s.end > s.start)) throw new InvalidError(`Section at ${s.start}s must end after it starts`);
    if (s.id === undefined) continue;
    if (seen.has(s.id)) throw new InvalidError(`Section id "${s.id}" appears twice`);
    // A note's `on` reads "vo" as the read, "<section>:<take>" as a take and "<lane>/<variant>" as
    // a variant, so a new section can't take an id that would read as one of those. Only new ids
    // are checked: a script saved before this rule still loads and updates.
    if (!existing.has(s.id) && (s.id === "vo" || /[:/]/.test(s.id))) {
      throw new InvalidError(`Section id "${s.id}" can't be "vo" or contain ":" or "/"`);
    }
    seen.add(s.id);
  }

  const old = new Map(script.sections.map((s) => [s.id, s]));
  type Draft = Omit<Section, "id"> & { id: string | null };
  const kept: Draft[] = replace ? [] : script.sections.filter((s) => !seen.has(s.id));
  const incoming: Draft[] = input.map((s) => {
    const prev = s.id === undefined ? undefined : old.get(s.id);
    const landed = prev?.proposed != null && prev.proposed.trim() === s.current.trim();
    const reworked = prev !== undefined && prev.current.trim() !== s.current.trim();
    const status = !prev || landed || reworked ? "draft" : prev.status;
    return {
      id: s.id ?? null,
      start: s.start,
      end: s.end,
      current: s.current,
      proposed: landed ? null : prev?.proposed ?? null,
      direction: prev?.direction ?? "",
      status,
      takes: prev?.takes ?? [],
    };
  });

  const sorted = [...kept, ...incoming].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) throw new InvalidError(`Sections overlap at ${sorted[i].start}s`);
  }

  // New sections without an id get s<n>, starting from their position, skipping ids already taken.
  const taken = new Set(sorted.flatMap((s) => (s.id === null ? [] : [s.id])));
  const next: Section[] = sorted.map((s, i) => {
    if (s.id !== null) return s as Section;
    let n = i + 1;
    while (taken.has(`s${n}`)) n++;
    taken.add(`s${n}`);
    return { ...s, id: `s${n}` };
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
