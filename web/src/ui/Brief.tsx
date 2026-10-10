// §24 step 2: the Brief page. brief.md is the file of record: each row shows the agent's version of one
// section beside yours, and a save writes the file. Approving sets its Status line; editing afterwards reopens it.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../api.js";
import type { BriefSectionView, BriefView, State } from "../types.js";
import { Icon } from "./Icon.js";

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
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        latest.current();
      }, ms);
    },
    flush() {
      if (timer.current === undefined) return;
      clearTimeout(timer.current);
      timer.current = undefined;
      latest.current();
    },
  };
}

interface Saver {
  section(s: BriefSectionView, text: string): void;
  status(status: "draft" | "approved"): void;
}

function Row({ section, save }: { section: BriefSectionView; save: Saver }) {
  const [text, setText] = useState(section.yours);
  const editing = useRef(false);
  const area = useRef<HTMLTextAreaElement>(null);

  // The agent changed the section, or another window did: follow it unless you're mid-edit.
  useEffect(() => {
    if (!editing.current) setText(section.yours);
  }, [section.yours]);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);

  const saveText = useDebounced(() => {
    editing.current = false;
    if (text.trim() !== section.yours.trim()) save.section(section, text);
  }, SAVE_AFTER_MS);
  const changed = text.trim() !== section.current.trim();

  return (
    <div class={`srow${changed ? " changed" : ""}`} data-section={section.heading}>
      <div class="sgrid bgrid">
        <div class="blabel">{section.heading}</div>
        <div class="cur">{section.current}</div>
        <div class="byours">
          <textarea
            ref={area}
            class="input"
            aria-label={`Your version of ${section.heading}`}
            value={text}
            onInput={(e) => {
              editing.current = true;
              setText((e.target as HTMLTextAreaElement).value);
              saveText.schedule();
            }}
            onBlur={() => saveText.flush()}
          />
          {changed && (
            <button
              class="btn ghost ib"
              data-tip="Revert to current"
              aria-label={`Revert ${section.heading}`}
              onClick={() => {
                editing.current = false;
                setText(section.current);
                save.section(section, section.current);
              }}
            >
              <Icon name="undo" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** brief.md: the agent's current text beside yours, one row per section, and an Approve at the foot. */
export function Brief({ brief, toast, onChanged }: { brief: BriefView; toast(message: string): void; onChanged(): void }) {
  // The hash of the file as this page last saw it. Every save goes through one queue and passes the newest one on,
  // so two edits in a row never fail against each other's result.
  const hash = useRef(brief.hash);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    hash.current = brief.hash;
  }, [brief.hash]);

  const put = async (path: string, body: Record<string, unknown>): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await api.put<{ brief: BriefView }>(path, { ...body, hash: hash.current });
        hash.current = r.brief.hash;
        return;
      } catch (e) {
        // The agent rewrote brief.md while you were typing: take the file's new hash and try once more.
        if (e instanceof ApiError && e.code === "brief_changed" && attempt === 0) {
          const fresh = await api.get<State>("/api/state");
          hash.current = fresh.brief.hash;
          continue;
        }
        throw e;
      }
    }
  };
  const enqueue = (what: string, run: () => Promise<void>) => {
    queue.current = queue.current
      .catch(() => undefined)
      .then(run)
      .catch((e) => toast(`Couldn't save ${what}: ${(e as Error).message}`))
      .finally(onChanged);
  };
  const save: Saver = {
    section: (s, text) => enqueue(s.heading, () => put(`/api/brief/sections/${s.index}`, { heading: s.heading, text })),
    status: (status) => enqueue("the brief's status", () => put("/api/brief/status", { status })),
  };

  const approved = brief.status === "approved";
  return (
    <div class="col">
      <div class="shead">
        <h2>Brief</h2>
        <span class="meta">
          {brief.sections.length} section{brief.sections.length === 1 ? "" : "s"} · {brief.changed} changed
        </span>
      </div>
      <div class="sgrid bgrid scols"><span /><span>Current</span><span>Yours</span></div>
      <div style={{ display: "grid", gap: "12px" }}>
        {brief.sections.map((s) => <Row key={`${s.index}:${s.heading}`} section={s} save={save} />)}
      </div>
      <div class="bfoot">
        <button class={`btn bapprove${approved ? " approved" : ""}`} aria-pressed={approved} onClick={() => save.status(approved ? "draft" : "approved")}>
          <Icon name="check" />
          {approved ? "Approved" : "Approve brief"}
        </button>
      </div>
    </div>
  );
}
