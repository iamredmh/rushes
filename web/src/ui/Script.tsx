// §27: the Script page. One row per line: your version in a field, marked "Edited by you" over the current wording when
// they differ (a changed line goes with Send), with its fit, its direction, a flag and a tick.
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api.js";
import { fit, fmt, isChanged } from "../lib.js";
import type { Script as ScriptData, Section } from "../types.js";
import { sectionLineLabel } from "../../../src/core/notes.js";
import { Icon } from "./Icon.js";
import { approvedOf, EditedMark, PlanField, PlanStatus, useDebounced } from "./Planning.js";

const STATUS = {
  approved: { color: "var(--done)", label: "Approved" },
  flagged: { color: "var(--todo)", label: "Flagged" },
  draft: { color: "var(--text-3)", label: "Draft" },
} as const;

const SAVE_AFTER_MS = 500;

/** §27, 5.8: a script line as the notes panel names it: "S2 · The scan finds it" (the same words export and the CLI use). */
const lineLabel = sectionLineLabel;

function Row({ section, wps, toast, onChanged, onPick }: { section: Section; wps: number; toast(message: string): void; onChanged(): void; onPick?(line: { id: string; label: string }): void }) {
  const [text, setText] = useState(section.proposed ?? section.current);
  const [direction, setDirection] = useState(section.direction);
  const editing = useRef(false);

  // The agent changed the line, or another window did: follow it unless you're mid-edit.
  useEffect(() => {
    if (!editing.current) setText(section.proposed ?? section.current);
  }, [section.proposed, section.current]);
  useEffect(() => {
    if (!editing.current) setDirection(section.direction);
  }, [section.direction]);

  const patch = async (body: Record<string, unknown>) => {
    try {
      await api.patch(`/api/script/${encodeURIComponent(section.id)}`, body);
    } catch (e) {
      toast(`Couldn't save ${section.id.toUpperCase()}: ${(e as Error).message}`);
    }
    onChanged();
  };
  const saveText = useDebounced(() => {
    editing.current = false;
    void patch({ proposed: text.trim() === section.current.trim() ? null : text });
  }, SAVE_AFTER_MS);
  const saveDirection = useDebounced(() => {
    editing.current = false;
    void patch({ direction });
  }, SAVE_AFTER_MS);

  const slot = section.end - section.start;
  const f = fit(text, slot, wps);
  const changed = text.trim() !== section.current.trim();
  const status = STATUS[section.status];

  return (
    // Working in a row (a click or focus anywhere in it) makes its line the target of the next note in the notes panel.
    <div class={`srow${changed ? " changed" : ""}`} data-section={section.id} onFocusIn={() => onPick?.({ id: section.id, label: lineLabel(section) })} onClick={() => onPick?.({ id: section.id, label: lineLabel(section) })}>
      <div class="sgrid">
        <div class="when">
          <b>{section.id.toUpperCase()}</b>
          <span>{fmt(section.start).replace(/\.\d+$/, "")}–{fmt(section.end).replace(/\.\d+$/, "")}</span>
          <span class="stat" aria-label={status.label} data-tip={status.label} title={status.label}><i style={{ background: status.color }} /></span>
        </div>
        <div class="pbody">
          <PlanField
            label={`Your version of ${section.id}`}
            value={text}
            onInput={(t) => {
              editing.current = true;
              setText(t);
              saveText.schedule();
            }}
            onBlur={() => saveText.flush()}
          />
          {changed && (
            <EditedMark
              baseline={[{ text: section.current }]}
              revertLabel="Revert"
              onRevert={() => {
                editing.current = false;
                setText(section.current);
                void patch({ proposed: null });
              }}
            />
          )}
        </div>
      </div>
      <div class="sfoot">
        <div class={`fit${f.state === "ok" ? "" : ` ${f.state}`}`} title={`${f.words} words · ${f.seconds.toFixed(1)} s of ${slot.toFixed(1)} s`}>
          <i style={{ width: `${Math.min(100, f.ratio * 100)}%` }} />
        </div>
        <input
          class="dirin"
          placeholder="Direction"
          aria-label={`Direction for ${section.id}`}
          value={direction}
          onInput={(e) => {
            editing.current = true;
            setDirection((e.target as HTMLInputElement).value);
            saveDirection.schedule();
          }}
          onBlur={() => saveDirection.flush()}
        />
        <div class="sact">
          <button
            class={`btn ib flagd${section.status === "flagged" ? "" : " ghost"}`}
            data-tip={section.status === "flagged" ? "Unflag" : "Flag"}
            aria-label="Flag"
            aria-pressed={section.status === "flagged"}
            onClick={() => void patch({ status: section.status === "flagged" ? "draft" : "flagged" })}
          >
            <Icon name="flag" />
          </button>
          <button
            class="btn ib okd"
            data-tip={section.status === "approved" ? "Unapprove" : "Approve"}
            aria-label="Approve"
            aria-pressed={section.status === "approved"}
            onClick={() => void patch({ status: section.status === "approved" ? "draft" : "approved" })}
          >
            <Icon name="check" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** The VO script: one row per line, your version over the current wording when you've changed it, and the count at the foot. */
export function Script({ script, toast, onChanged, onPickLine }: { script: ScriptData; toast(message: string): void; onChanged(): void; onPickLine?(line: { id: string; label: string }): void }) {
  const changed = script.sections.filter(isChanged).length;
  const approved = script.sections.filter((s) => s.status === "approved").length;
  return (
    <div class="col ppage">
      <div class="shead">
        <h2>Script</h2>
      </div>
      <div class="prows">
        {script.sections.map((s) => <Row key={s.id} section={s} wps={script.wordsPerSecond} toast={toast} onChanged={onChanged} onPick={onPickLine} />)}
      </div>
      <PlanStatus counts={script.sections.length > 0 ? { approved: approvedOf(approved, script.sections.length, "line"), edited: changed } : null} />
    </div>
  );
}
