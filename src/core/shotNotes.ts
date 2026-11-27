// §38.4: notes on storyboard shots. Pure, with no Node imports, so the dashboard uses it too.
//
// A storyboard note's `on` is "shot/<n>", the shot's number when the note was made, and `shot` keeps that number and the
// shot's name. The agent may renumber or rename shots in storyboard.md afterwards, so a note finds its shot again by both.
import { pinWords, regionWords } from "./visualWords.js";

type Box = { x: number; y: number; w: number; h: number };
type Pin = { x: number; y: number };

const pad = (n: number) => String(n).padStart(2, "0");

/** The shot number a note was made on: its `shot`, else the number in its `on`, else 0. */
export function shotNumberOf(note: { on: string | null; shot: { n: number } | null }): number {
  if (note.shot) return note.shot.n;
  const m = /^shot\/(\d+)$/.exec(note.on ?? "");
  return m ? Number(m[1]) : 0;
}

/** "Shot 03 · Offline", with "· region" or "· point" when one is drawn. */
export function shotNoteLabel(note: { on: string | null; shot: { n: number; name: string } | null; box: Box | null; pin: Pin | null }): string {
  const base = `Shot ${pad(shotNumberOf(note))}${note.shot?.name ? ` · ${note.shot.name}` : ""}`;
  return note.box ? `${base} · region` : note.pin ? `${base} · point` : base;
}

/** Where on the still, for the agent: "region (…)", "point (…)" or "the whole shot". */
export function shotNoteWhere(note: { box: Box | null; pin: Pin | null }): string {
  return note.box ? `region (${regionWords(note.box)})` : note.pin ? `point (${pinWords(note.pin)})` : "the whole shot";
}

/**
 * The index of a note's shot among `shots` as they are now: the shot with the same number and name; else the only shot
 * with that name (the agent renumbered); else, for a note that kept no name, the shot with that number. Null when the
 * shot has gone or was renamed under the same number (it may be a different shot now).
 */
export function shotOfNote(shots: readonly { n: number; name: string }[], note: { on: string | null; shot: { n: number; name: string } | null }): number | null {
  const n = shotNumberOf(note);
  if (!note.shot) {
    const at = shots.findIndex((s) => s.n === n);
    return at >= 0 ? at : null;
  }
  const exact = shots.findIndex((s) => s.n === n && s.name === note.shot!.name);
  if (exact >= 0) return exact;
  const named = shots.map((s, i) => (s.name === note.shot!.name ? i : -1)).filter((i) => i >= 0);
  return named.length === 1 ? named[0] : null;
}
