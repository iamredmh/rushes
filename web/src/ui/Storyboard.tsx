// §24.12: the Storyboard page. storyboard.md is the file of record: one row per shot, the agent's description beside
// yours, a direction, and a tick to approve. It works like Script, with no notes. Changing an approved shot reopens it.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { mediaUrl } from "../api.js";
import { briefTargetSeconds } from "../lib.js";
import type { BriefView, StoryboardShotView, StoryboardView } from "../types.js";
import { Icon } from "./Icon.js";
import { useRecordSaves } from "./useRecordSaves.js";

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

/** A shot is found again by its heading and which of that heading it is, not by its position: the agent may add one above it. */
const occurrenceOf = (shots: StoryboardShotView[], at: number): number => shots.slice(0, at).filter((x) => x.heading === shots[at].heading).length;

interface Edit {
  description?: string;
  direction?: string;
  status?: "draft" | "approved";
}
interface Saver {
  shot(s: StoryboardShotView, edit: Edit): void;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The picture for a shot, or an empty frame that says there is none (or that it would not load). */
function Still({ shot, large }: { shot: StoryboardShotView; large?: boolean }) {
  // Remember which picture failed, not just that one did: a reset effect would race an error that fires before it runs.
  const [failed, setFailed] = useState<string | null>(null);
  if (!shot.still || failed === shot.still) return <span class="nostill">{large ? "No still for this shot yet" : "No still"}</span>;
  return <img src={mediaUrl(shot.still)} alt={`Still for shot ${shot.n}, ${shot.name}`} onError={() => setFailed(shot.still)} />;
}

function Row({ shot, save, onZoom }: { shot: StoryboardShotView; save: Saver; onZoom(): void }) {
  const [text, setText] = useState(shot.description);
  const [direction, setDirection] = useState(shot.direction);
  const editing = useRef(false);
  const area = useRef<HTMLTextAreaElement>(null);

  // The agent changed the shot, or another window did: follow it unless you're mid-edit.
  useEffect(() => {
    if (!editing.current) setText(shot.description);
  }, [shot.description]);
  useEffect(() => {
    if (!editing.current) setDirection(shot.direction);
  }, [shot.direction]);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);

  const saveText = useDebounced(() => {
    editing.current = false;
    if (text.trim() !== shot.description.trim()) save.shot(shot, { description: text });
  }, SAVE_AFTER_MS);
  const saveDirection = useDebounced(() => {
    editing.current = false;
    if (direction.trim() !== shot.direction.trim()) save.shot(shot, { direction });
  }, SAVE_AFTER_MS);

  const changed = text.trim() !== shot.current.trim() || direction.trim() !== shot.directionCurrent.trim();
  const approved = shot.status === "approved";
  return (
    <div class={`sbrow${changed ? " changed" : ""}`} data-shot={shot.heading}>
      <div class="sbid">
        <button class="sbstill" aria-label={`Enlarge the still for shot ${shot.n}`} data-tip="Enlarge" onClick={onZoom}>
          <Still shot={shot} />
        </button>
        <div class="sbmeta">
          <b>{pad(shot.n)}</b>
          <span>{shot.length === null ? "no length" : `${shot.length.toFixed(1)} s`}</span>
          {shot.tag && <span class="sbtag">{shot.tag}</span>}
        </div>
      </div>
      <div class="cur">
        <b class="sbname">{shot.name}</b>
        {shot.current}
      </div>
      <textarea
        ref={area}
        class="input"
        aria-label={`Your version of shot ${shot.n}`}
        value={text}
        onInput={(e) => {
          editing.current = true;
          setText((e.target as HTMLTextAreaElement).value);
          saveText.schedule();
        }}
        onBlur={() => saveText.flush()}
      />
      <div class="sblow">
        <input
          class="sbdir"
          placeholder="Direction"
          aria-label={`Direction for shot ${shot.n}`}
          value={direction}
          onInput={(e) => {
            editing.current = true;
            setDirection((e.target as HTMLInputElement).value);
            saveDirection.schedule();
          }}
          onBlur={() => saveDirection.flush()}
        />
        {changed && (
          <button
            class="btn ghost ib"
            data-tip="Revert to current"
            aria-label={`Revert shot ${shot.n}`}
            onClick={() => {
              editing.current = false;
              setText(shot.current);
              setDirection(shot.directionCurrent);
              save.shot(shot, { description: shot.current, direction: shot.directionCurrent });
            }}
          >
            <Icon name="undo" />
          </button>
        )}
        <button
          class={`btn ib okd${approved ? " on" : ""}`}
          data-tip={approved ? "Unapprove" : "Approve"}
          aria-label={`Approve shot ${shot.n}`}
          aria-pressed={approved}
          onClick={() => save.shot(shot, { status: approved ? "draft" : "approved" })}
        >
          <Icon name="check" />
        </button>
      </div>
    </div>
  );
}

/** The still, large, with what happens under it. Click anywhere, or press Escape, to close; focus goes in and comes back. */
function Lightbox({ shot, onClose }: { shot: StoryboardShotView; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null);
  // A layout effect: focus is in the dialog the moment it is on screen, so Escape is heard from the first frame.
  useLayoutEffect(() => {
    box.current?.focus();
  }, []);
  return (
    <div
      class="sblight"
      role="dialog"
      aria-modal="true"
      aria-label={`Shot ${shot.n}, ${shot.name}`}
      tabIndex={-1}
      ref={box}
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (e.key === "Tab") {
          // Nothing inside to reach: keep focus here rather than behind the picture.
          e.preventDefault();
        }
      }}
    >
      <div class="sblbx">
        <div class="sbbig">
          <Still shot={shot} large />
        </div>
        <div class="sblcap">
          <b>
            {pad(shot.n)} · {shot.name}
          </b>{" "}
          {shot.tag && <span class="sbtag">{shot.tag}</span>}
          <p>{shot.description}</p>
        </div>
      </div>
    </div>
  );
}

/** storyboard.md: one row per shot, and the planned length against what the brief says. */
export function Storyboard({
  board,
  brief,
  toast,
  onChanged,
  settle,
}: {
  board: StoryboardView;
  brief: BriefView;
  toast(message: string): void;
  onChanged(): void;
  settle: { current: (() => Promise<unknown>) | null };
}) {
  const { latest, enqueue } = useRecordSaves("storyboard", board, { toast, onChanged, settle });
  const [zoom, setZoom] = useState<string | null>(null);
  // The button that opened the still, so closing it puts focus back there.
  const opener = useRef<HTMLElement | null>(null);
  const save: Saver = {
    shot: (s, edit) => {
      const nth = occurrenceOf(latest.current.shots, latest.current.shots.findIndex((x) => x.index === s.index));
      enqueue(`shot ${s.n}`, (b) => {
        const at = b.shots.filter((x) => x.heading === s.heading)[nth];
        return at ? { path: `/api/storyboard/shots/${at.index}`, body: { heading: s.heading, ...edit } } : null;
      });
    },
  };

  const target = briefTargetSeconds(brief);
  const zoomed = board.shots.find((s) => s.heading === zoom);
  return (
    <div class="col">
      <div class="shead">
        <h2>Storyboard</h2>
        <span class="meta">
          {board.total} shot{board.total === 1 ? "" : "s"} · {board.changed} changed
        </span>
      </div>
      <div class="sbtotal mono" aria-label="Planned length">
        <span>{target ? `${board.plannedLength.toFixed(1)} / ${target} s planned` : `${board.plannedLength.toFixed(1)} s planned`}</span>
        {target && (
          <span class="bar">
            <i style={{ width: `${Math.min(100, (board.plannedLength / target) * 100)}%` }} />
          </span>
        )}
      </div>
      <div class="sbhead"><span /><span>Current</span><span>Yours</span></div>
      <div style={{ display: "grid", gap: "12px" }}>
        {board.shots.map((s, i) => (
          <Row key={`${s.heading}#${occurrenceOf(board.shots, i)}`} shot={s} save={save} onZoom={() => {
              opener.current = document.activeElement as HTMLElement | null;
              setZoom(s.heading);
            }} />
        ))}
      </div>
      {zoomed && (
        <Lightbox
          shot={zoomed}
          onClose={() => {
            setZoom(null);
            opener.current?.focus();
          }}
        />
      )}
    </div>
  );
}
