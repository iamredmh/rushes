import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api } from "../api.js";
import { fit, fmt, isChanged } from "../lib.js";
import type { Script as ScriptData, Section } from "../types.js";
import { Icon } from "./Icon.js";

const STATUS = {
  approved: { color: "var(--done)", label: "Approved" },
  flagged: { color: "var(--todo)", label: "Flagged" },
  draft: { color: "var(--text-3)", label: "Draft" },
} as const;

const SAVE_AFTER_MS = 500;

/** Run `fn` once input has paused for `ms`; flush() runs it now. A pending run is flushed, not dropped, on unmount. */
function useDebounced(fn: () => void, ms: number) {
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(
    () => () => {
      if (timer.current === undefined) return;
      clearTimeout(timer.current);
      latest.current();
    },
    [],
  );
  return {
    schedule() {
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => latest.current(), ms);
    },
    flush() {
      if (timer.current === undefined) return;
      clearTimeout(timer.current);
      timer.current = undefined;
      latest.current();
    },
  };
}

function Row({ section, wps, toast, onChanged }: { section: Section; wps: number; toast(message: string): void; onChanged(): void }) {
  const [text, setText] = useState(section.proposed ?? section.current);
  const [direction, setDirection] = useState(section.direction);
  const editing = useRef(false);
  const area = useRef<HTMLTextAreaElement>(null);

  // The agent changed the line, or another window did: follow it unless you're mid-edit.
  useEffect(() => {
    if (!editing.current) setText(section.proposed ?? section.current);
  }, [section.proposed, section.current]);
  useEffect(() => {
    if (!editing.current) setDirection(section.direction);
  }, [section.direction]);

  // Grow the box to fit its text.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);

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
    <div class={`srow${changed ? " changed" : ""}`} data-section={section.id}>
      <div class="sgrid">
        <div class="when">
          <b>{section.id.toUpperCase()}</b>
          <span>{fmt(section.start).replace(/\.\d+$/, "")}–{fmt(section.end).replace(/\.\d+$/, "")}</span>
          <span class="stat"><i style={{ background: status.color }} />{status.label}</span>
        </div>
        <div class="cur">{section.current}</div>
        <textarea
          ref={area}
          class="input"
          aria-label={`Your version of ${section.id}`}
          value={text}
          onInput={(e) => {
            editing.current = true;
            setText((e.target as HTMLTextAreaElement).value);
            saveText.schedule();
          }}
          onBlur={() => saveText.flush()}
        />
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
          {changed && (
            <button
              class="btn ghost ib"
              data-tip="Revert to current"
              aria-label="Revert"
              onClick={() => {
                setText(section.current);
                void patch({ proposed: null });
              }}
            >
              <Icon name="undo" />
            </button>
          )}
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

/** The VO script: the agent's current line beside your version, one row per section. */
export function Script({ script, toast, onChanged }: { script: ScriptData; toast(message: string): void; onChanged(): void }) {
  const changed = script.sections.filter(isChanged).length;
  return (
    <div class="col">
      <div class="shead">
        <h2>Script</h2>
        <span class="meta">
          {script.sections.length} section{script.sections.length === 1 ? "" : "s"} · {changed} changed
        </span>
      </div>
      <div class="sgrid scols"><span /><span>Current</span><span>Yours</span></div>
      <div style={{ display: "grid", gap: "12px" }}>
        {script.sections.map((s) => <Row key={s.id} section={s} wps={script.wordsPerSecond} toast={toast} onChanged={onChanged} />)}
      </div>
    </div>
  );
}
