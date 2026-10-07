import { useState } from "preact/hooks";
import { labelOfId, noteTime, otherFormatAction, placeNote, type FormatView } from "../lib.js";
import type { Note } from "../types.js";

export interface OtherFormatsProps {
  /** The notes that don't show on the format on screen. */
  notes: Note[];
  /** The version on screen, so notes from older cuts are placed on it. */
  version: string;
  /** The shapes of the version on screen. */
  viewsHere: FormatView[];
  /** The shapes of a note's own version. */
  ownViews(n: Note): FormatView[];
  /** Switch to a format (refused, with a toast, while a box is drawn: R7). */
  onShow(id: string): void;
  /** R17: widen a note whose format has gone from its own cut. */
  onRestore(n: Note): void;
}

/** §21.5: a quiet "Other formats (N)" row; opened, its notes read only, with a way to their format. */
export function OtherFormats({ notes, version, viewsHere, ownViews, onShow, onRestore }: OtherFormatsProps) {
  const [open, setOpen] = useState(false);
  if (notes.length === 0) return null;
  return (
    <div class="otherfmts">
      <button type="button" class="otherrow" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>Other formats ({notes.length})</span>
        <span class="sp" />
        <span class="act" aria-hidden="true">{open ? "Hide" : "Show"}</span>
      </button>
      {open && notes.map((n) => {
        const at = placeNote(n, version);
        const act = otherFormatAction(n, viewsHere, ownViews(n));
        return (
          <div key={n.id} class={`note ro${n.status === "done" ? " done" : ""}`} data-note={n.id}>
            <span aria-hidden="true" />
            <div class="nt">
              <span class="t mono">{noteTime(at.t, at.tOut)}</span>
              <span class="ftag">{n.format ? labelOfId(n.format) : "All"}</span>
              {at.from && <span class="from">from {at.from}</span>}
            </div>
            <div class="nx">{n.text}</div>
            {act?.kind === "show" && <div class="nact"><button type="button" class="flink" onClick={() => onShow(act.id)}>Show on {act.label}</button></div>}
            {act?.kind === "restore" && <div class="nact"><button type="button" class="flink" onClick={() => onRestore(n)}>Restore to all formats</button></div>}
          </div>
        );
      })}
    </div>
  );
}
