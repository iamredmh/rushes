// §28.4: the live strip at the top of Activity. While the agent runs it says what it is doing (the chip's words) and lists
// its newest lines, each with its time; a line that names a note is a button that takes you to that note. After the run
// it folds into one line, "Show the run (n)". Every line is one line, cut with an ellipsis.
import { useState } from "preact/hooks";
import { chipText, liveLines, runLabel, stripLine, stripMode, type NoteLite } from "../../agent.js";
import { clock } from "../../changelog.js";
import type { AgentStatus } from "../../types.js";

export interface LiveStripProps {
  status: AgentStatus | null;
  notes: readonly NoteLite[];
  /** Takes the desk to the note: its card on the Notes tab. */
  onNote(id: string): void;
}

export function LiveStrip({ status, notes, onNote }: LiveStripProps) {
  const [open, setOpen] = useState(false);
  const mode = status ? stripMode(status) : null;
  if (!status || !mode) return null;
  const folded = mode === "ended" && !open;
  if (folded) {
    return (
      <div class="lstrip ended">
        <button type="button" class="lshow" aria-expanded="false" onClick={() => setOpen(true)}>{runLabel(status.lines.length)}</button>
      </div>
    );
  }
  const lines = liveLines(status, 20);
  return (
    <section class="lstrip" aria-label="The run">
      <h3 class="lhead">
        <span class="lheadtext" dir="auto">{chipText(status, notes) ?? ""}</span>
        {mode === "ended" && <button type="button" class="lhide" aria-expanded="true" onClick={() => setOpen(false)}>Hide</button>}
      </h3>
      <ul>
        {lines.map((l, i) => {
          const time = clock(new Date(l.at));
          const here = l.note !== null && notes.some((n) => n.id === l.note);
          const inner = (
            <>
              <span class="ltime">{time}</span>
              <span class="lline" dir="auto" title={stripLine(l)}>{stripLine(l)}</span>
            </>
          );
          return (
            <li key={`${l.at}-${i}`}>
              {here ? <button type="button" class="lsrow" data-note-line={l.note} onClick={() => onNote(l.note!)}>{inner}</button> : <div class="lsrow">{inner}</div>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
