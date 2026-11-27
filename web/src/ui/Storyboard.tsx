// §24.12, §27, §38.4: the Storyboard page. storyboard.md is the file of record. One shot at a time, large, the way
// Visuals shows a page: its still with the notes' boxes and points over it, Previous / count / Overview / Next, a strip of
// every shot, and under it what happens (text with Edit), the direction and the approve tick. Drag on the still for a
// region or click for a point; the note itself is written in the notes panel, which says which shot it is on. Overview
// swaps the frame for a grid of every shot.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { shotOfNote } from "../../../src/core/shotNotes.js";
import { mediaUrl } from "../api.js";
import { briefTargetSeconds } from "../lib.js";
import { safeMarkdownHtml } from "../markdown.js";
import type { BriefView, Note, StoryboardShotView, StoryboardView } from "../types.js";
import { shapeFromDrag, type Shape } from "../visuals.js";
import { Icon } from "./Icon.js";
import { approvedOf, EditedMark, PlanField, PlanStatus, useDebounced, type Baseline } from "./Planning.js";
import { useRecordSaves } from "./useRecordSaves.js";

const SAVE_AFTER_MS = 500;

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
const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/** §38.4: the notes drawn on this shot's still as it is now: on this shot, and drawn on this very still. */
export function marksOn(notes: Note[], shots: StoryboardShotView[], at: number): Note[] {
  const shot = shots[at];
  if (!shot) return [];
  return notes.filter((n) => n.stage === "storyboard" && (n.box || n.pin) && shotOfNote(shots, n) === at && n.still === shot.still);
}

/** How many open notes each shot has, by index. */
function openByShot(notes: Note[], shots: StoryboardShotView[]): number[] {
  const out = shots.map(() => 0);
  for (const n of notes) {
    if (n.stage !== "storyboard" || n.status !== "todo") continue;
    const at = shotOfNote(shots, n);
    if (at !== null) out[at]++;
  }
  return out;
}

/** The picture for a shot, or an empty frame that says there is none (or that it would not load). */
function Still({ shot, large, onSize }: { shot: StoryboardShotView; large?: boolean; onSize?(w: number, h: number): void }) {
  // Remember which picture failed, not just that one did: a reset effect would race an error that fires before it runs.
  const [failed, setFailed] = useState<string | null>(null);
  if (!shot.still || failed === shot.still) return <span class="nostill">{large ? "No still for this shot yet" : "No still"}</span>;
  return (
    <img
      src={mediaUrl(shot.still)}
      alt={`Still for shot ${shot.n}, ${shot.name}`}
      draggable={false}
      onLoad={(e) => onSize?.((e.target as HTMLImageElement).naturalWidth, (e.target as HTMLImageElement).naturalHeight)}
      onError={() => setFailed(shot.still)}
    />
  );
}

/** Fits a picture of this shape inside whatever room its box has. */
function useFit(ratio: { w: number; h: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const k = Math.min(r.width / ratio.w, r.height / ratio.h);
      setSize(k > 0 && Number.isFinite(k) ? { w: Math.floor(ratio.w * k), h: Math.floor(ratio.h * k) } : null);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ratio.w, ratio.h]);
  return { box, size };
}

/** The big frame: the still fitted, its notes' marks numbered over it, and the region or point being drawn. */
function Frame({ shot, marks, all, shape, selected, onShape, onSelect }: { shot: StoryboardShotView; marks: Note[]; all: Note[]; shape: Shape | null; selected: string | null; onShape(s: Shape | null): void; onSelect(id: string): void }) {
  const [ratio, setRatio] = useState({ w: 16, h: 9 });
  const { box, size } = useFit(ratio);
  const [live, setLive] = useState<Shape | null>(null);
  const no = (n: Note) => all.filter((x) => x.stage === "storyboard" && x.createdAt <= n.createdAt && shotOfNoteSame(x, n)).length;
  const start = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const frame = e.currentTarget as HTMLElement;
    if ((e.target as HTMLElement).closest("[data-note]")) return;
    e.preventDefault();
    const r = frame.getBoundingClientRect();
    const at = (x: number, y: number) => ({ x: (x - r.left) / r.width, y: (y - r.top) / r.height });
    const a = at(e.clientX, e.clientY);
    const [px, py] = [e.clientX, e.clientY];
    let moved = false;
    const hold = frame.setPointerCapture ? (frame.setPointerCapture(e.pointerId), true) : false;
    const preview = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - px, ev.clientY - py) > 5) moved = true;
      if (moved) setLive(shapeFromDrag(a, at(ev.clientX, ev.clientY), true) ?? { box: { x: a.x, y: a.y, w: 0, h: 0 } });
    };
    const stop = () => {
      frame.removeEventListener("pointermove", preview);
      frame.removeEventListener("pointerup", done);
      frame.removeEventListener("pointercancel", stop);
      if (hold) frame.releasePointerCapture?.(e.pointerId);
      setLive(null);
    };
    const done = (ev: PointerEvent) => {
      const s = shapeFromDrag(a, at(ev.clientX, ev.clientY), moved);
      stop();
      if (s) onShape(s);
    };
    frame.addEventListener("pointermove", preview);
    frame.addEventListener("pointerup", done);
    frame.addEventListener("pointercancel", stop);
  };
  const drawn = live ?? shape;
  const next = all.filter((x) => x.stage === "storyboard" && x.shot?.n === shot.n && x.shot?.name === shot.name).length + 1;
  return (
    <div class="sbfwrap" ref={box}>
      <div
        class="sbframe"
        role="img"
        aria-label={`Still for shot ${shot.n}, ${shot.name}. Drag for a region or click for a point, then write the note.`}
        style={size ? { width: `${size.w}px`, height: `${size.h}px` } : { visibility: "hidden" }}
        onPointerDown={(e) => start(e as unknown as PointerEvent)}
      >
        <Still shot={shot} large onSize={(w, h) => w > 0 && h > 0 && (w !== ratio.w || h !== ratio.h) && setRatio({ w, h })} />
        {marks.map((n) => {
          const cls = `${n.status === "done" ? " done" : ""}${selected === n.id ? " sel" : ""}`;
          const label = `Note ${no(n)}: ${n.text}`;
          return n.pin ? (
            <button key={n.id} type="button" class={`vzpin${cls}`} data-note={n.id} aria-label={label} style={{ left: `${n.pin.x * 100}%`, top: `${n.pin.y * 100}%` }} onClick={() => onSelect(n.id)}>
              <span class="no">{no(n)}</span>
            </button>
          ) : n.box ? (
            <button key={n.id} type="button" class={`vzbox${cls}`} data-note={n.id} aria-label={label} style={{ left: `${n.box.x * 100}%`, top: `${n.box.y * 100}%`, width: `${n.box.w * 100}%`, height: `${n.box.h * 100}%` }} onClick={() => onSelect(n.id)}>
              <span class="no">{no(n)}</span>
            </button>
          ) : null;
        })}
        {drawn && "pin" in drawn && (
          <div class="vzpin draft" style={{ left: `${drawn.pin.x * 100}%`, top: `${drawn.pin.y * 100}%` }}>
            <span class="no">{next}</span>
          </div>
        )}
        {drawn && "box" in drawn && (
          <div class="vzbox draft" style={{ left: `${drawn.box.x * 100}%`, top: `${drawn.box.y * 100}%`, width: `${drawn.box.w * 100}%`, height: `${drawn.box.h * 100}%` }}>
            <span class="no">{next}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Two notes are on the same shot as it was when they were made: same number and name. */
const shotOfNoteSame = (a: Note, b: Note) => a.shot?.n === b.shot?.n && a.shot?.name === b.shot?.name;

/** Under the frame: what happens (text, with Edit), the direction, the word diff when you changed them, and the approve tick. */
function Details({ shot, save }: { shot: StoryboardShotView; save: Saver }) {
  const [text, setText] = useState(shot.description);
  const [direction, setDirection] = useState(shot.direction);
  const [open, setOpen] = useState(false);
  const editing = useRef(false);

  // The agent changed the shot, or another window did: follow it unless you're mid-edit.
  useEffect(() => {
    if (!editing.current) setText(shot.description);
  }, [shot.description]);
  useEffect(() => {
    if (!editing.current) setDirection(shot.direction);
  }, [shot.direction]);
  const saveAll = () => {
    const edit: { description?: string; direction?: string } = {};
    if (text.trim() !== shot.description.trim()) edit.description = text;
    if (direction.trim() !== shot.direction.trim()) edit.direction = direction;
    if (edit.description !== undefined || edit.direction !== undefined) save.shot(shot, edit);
  };
  const saveText = useDebounced(() => {
    editing.current = false;
    // Whatever else here is unsaved goes with it: a save refused earlier is not lost behind this one.
    saveAll();
  }, SAVE_AFTER_MS);
  const saveDirection = useDebounced(() => {
    editing.current = false;
    saveAll();
  }, SAVE_AFTER_MS);
  const close = () => {
    saveText.flush();
    setOpen(false);
  };
  const html = useMemo(() => safeMarkdownHtml(text), [text]);

  // What your edits replaced, marked word by word under the text: the description, then the direction, whichever differ.
  const baseline: Baseline[] = [];
  if (text.trim() !== shot.current.trim()) baseline.push({ text: shot.current, after: text });
  if (direction.trim() !== shot.directionCurrent.trim()) baseline.push({ label: "Direction", text: shot.directionCurrent, after: direction });
  const changed = baseline.length > 0;
  return (
    <div class={`sbdetail${changed ? " changed" : ""}`} data-shot={shot.heading}>
      <div class="sbdhead">
        <h3>What happens</h3>
        {open ? (
          <button class="btn bedit" onMouseDown={(e) => e.preventDefault()} onClick={close}>
            <Icon name="check" />
            Done
          </button>
        ) : (
          <button class="btn bedit" aria-label={`Edit shot ${shot.n}`} onClick={() => setOpen(true)}>
            <Icon name="pencil" />
            Edit
          </button>
        )}
      </div>
      {open ? (
        <PlanField
          label={`Your version of shot ${shot.n}`}
          value={text}
          autoFocus
          onInput={(t) => {
            editing.current = true;
            setText(t);
            saveText.schedule();
          }}
          onBlur={close}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        />
      ) : (
        <div class="bread">
          <div class="markdown" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      )}
      <input
        class="dirin sbdir"
        placeholder="Direction: how it should feel, in a line"
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
        <EditedMark
          baseline={baseline}
          revertLabel={`Revert shot ${shot.n}`}
          onRevert={() => {
            editing.current = false;
            setText(shot.current);
            setDirection(shot.directionCurrent);
            setOpen(false);
            save.shot(shot, { description: shot.current, direction: shot.directionCurrent });
          }}
        />
      )}
    </div>
  );
}

/** Every shot in a grid: still, number, name, length, tag, approved, open notes. A click opens it in the frame. */
function Overview({ board, open, onOpen }: { board: StoryboardView; open: number[]; onOpen(i: number): void }) {
  return (
    <div class="sbgrid" role="list" aria-label="Every shot">
      {board.shots.map((s, i) => (
        <button key={`${s.heading}#${occurrenceOf(board.shots, i)}`} class={`sbcell${s.status === "approved" ? " ok" : ""}`} role="listitem" aria-label={`Shot ${s.n}, ${s.name}`} onClick={() => onOpen(i)}>
          <span class="sbthumb">
            <Still shot={s} />
            {open[i] > 0 && <span class="sbbadge" aria-label={`${open[i]} open notes`}>{open[i]}</span>}
          </span>
          <span class="sbcap">
            <b>{pad(s.n)}</b> {s.name}
          </span>
          <span class="sbsub mono">
            {s.length === null ? "no length" : `${s.length.toFixed(1)} s`}
            {s.tag && <span class="sbtag">{s.tag}</span>}
            {s.status === "approved" && <Icon name="check" />}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Overview is remembered for this browser, per project (§38.4); a refused storage leaves it off. */
const overviewKey = (project: string) => `rushes:sb-overview:${project}`;
function readOverview(project: string): boolean {
  try {
    return localStorage.getItem(overviewKey(project)) === "1";
  } catch {
    return false;
  }
}
function writeOverview(project: string, on: boolean) {
  try {
    localStorage.setItem(overviewKey(project), on ? "1" : "0");
  } catch {
    /* private window: not remembered */
  }
}

/** storyboard.md: one shot at a time, or every shot in Overview, and the planned length against what the brief says. */
export function Storyboard({
  board,
  brief,
  video = null,
  projectId = "",
  notes = [],
  at = 0,
  onAt = () => undefined,
  shape = null,
  onShape = () => undefined,
  selected = null,
  onSelect = () => undefined,
  toast,
  onChanged,
  settle,
}: {
  board: StoryboardView;
  brief: BriefView;
  video?: string | null;
  projectId?: string;
  /** The film's storyboard notes. */
  notes?: Note[];
  /** Which shot is in the frame, by index; the desk keeps it so the notes panel knows. */
  at?: number;
  onAt?(i: number): void;
  /** The region or point drawn on the still and not yet written up. */
  shape?: Shape | null;
  onShape?(s: Shape | null): void;
  selected?: string | null;
  onSelect?(id: string): void;
  toast(message: string): void;
  onChanged(): void;
  settle: { current: (() => Promise<unknown>) | null };
}) {
  const { latest, enqueue } = useRecordSaves("storyboard", board, { toast, onChanged, settle, video });
  const [overview, setOverview] = useState(() => readOverview(projectId));
  const save: Saver = {
    shot: (s, edit) => {
      const was = latest.current.shots.findIndex((x) => x.index === s.index);
      const nth = was < 0 ? 0 : occurrenceOf(latest.current.shots, was);
      // Approving is only for the words you saw: if the agent has rewritten the shot since, the tick is not carried over to the new words.
      const approving = edit.status === "approved" && edit.description === undefined && edit.direction === undefined;
      enqueue(`shot ${s.n}`, (b, fresh) => {
        let found = b.shots.filter((x) => x.heading === s.heading)[nth];
        // The agent numbered the shots again: "Shot 02 · Drop a folder" is now "Shot 03 · Drop a folder". The name finds it, when it is the only one.
        if (!found) {
          const named = b.shots.filter((x) => x.name === s.name);
          if (named.length === 1) found = named[0];
        }
        if (found && fresh && approving && (found.description !== s.description || found.direction !== s.direction)) {
          return { refuse: "the agent changed this shot while you were looking at it. Read it again, then approve." };
        }
        return found ? { path: `/api/storyboard/shots/${found.index}`, body: { heading: found.heading, ...edit } } : null;
      });
    },
  };

  const count = board.shots.length;
  const follow = useRef<{ name: string | null; shots: StoryboardShotView[] } | null>(null);
  let i = Math.min(Math.max(0, at), Math.max(0, count - 1));
  const before = follow.current;
  if (before && before.shots !== board.shots && before.name !== null && board.shots[i]?.name !== before.name) {
    const named = board.shots.map((s, n) => (s.name === before.name ? n : -1)).filter((n) => n >= 0);
    if (named.length === 1) i = named[0];
  }
  const shot = board.shots[i];
  const open = openByShot(notes, board.shots);
  const go = (n: number) => {
    if (n < 0 || n >= count || n === i) return;
    onShape(null);
    onAt(n);
  };
  const setView = (on: boolean) => {
    setOverview(on);
    writeOverview(projectId, on);
  };

  // §38.4: the agent may add, remove or renumber shots while one is on show: stay on the same shot, found by its name,
  // in this very render (a frame of the wrong shot would close the field being typed in). Only a change to the file
  // does this; Previous, Next and the strip change `at` themselves.
  useLayoutEffect(() => {
    follow.current = { name: shot?.name ?? null, shots: board.shots };
    if (i !== at) onAt(i);
  });

  // Left and right move between shots, and Escape lets go of a drawn region, when no field has focus. One listener reads
  // the latest shot from a ref, so a second key pressed before the page has drawn the first still counts from the right shot.
  const keys = useRef({ i, overview, shape, go, onShape });
  keys.current = { i, overview, shape, go, onShape };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      // Not from a field, and not from a tab row (the Plan switch has arrows of its own).
      if (typing(e.target) || (e.target instanceof Element && e.target.closest("[role=tablist]")) || e.metaKey || e.ctrlKey || e.altKey || k.overview) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        k.go(k.i - 1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        k.go(k.i + 1);
      } else if (e.key === "Escape" && k.shape) k.onShape(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The strip keeps the current shot in view.
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>("[aria-current='true']")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [i, overview]);

  const target = briefTargetSeconds(brief);
  const total = (
    <div class="sbtotal mono" aria-label="Planned length">
      <span>{target ? `${board.plannedLength.toFixed(1)} / ${target} s planned` : `${board.plannedLength.toFixed(1)} s planned`}</span>
      {target && (
        <span class="bar">
          <i style={{ width: `${Math.min(100, (board.plannedLength / target) * 100)}%` }} />
        </span>
      )}
    </div>
  );
  const approved = shot?.status === "approved";
  return (
    <div class="col ppage sbpage">
      <div class="shead">
        <h2>Storyboard</h2>
        {count > 0 && (
          <span class="meta">
            {count} shot{count === 1 ? "" : "s"} · {board.plannedLength.toFixed(1)} s
          </span>
        )}
        {count > 0 && (
          <button class={`btn sbview${overview ? " on" : ""}`} aria-pressed={overview} onClick={() => setView(!overview)}>
            <Icon name="grid" />
            Overview
          </button>
        )}
      </div>
      {count === 0 && <p class="sbnone">storyboard.md has no shots yet. Your agent adds them as `## Shot 01 · Name` sections.</p>}
      {count > 0 && overview && (
        <>
          {total}
          <Overview
            board={board}
            open={open}
            onOpen={(n) => {
              onShape(null);
              onAt(n);
              setView(false);
            }}
          />
        </>
      )}
      {shot && !overview && (
        <div class="sbone">
          <div class="sbhead">
            <b class="sbnum mono">{pad(shot.n)}</b>
            <span class="sbname">{shot.name}</span>
            {shot.tag && <span class="sbtag">{shot.tag}</span>}
            <span class="sblen mono">{shot.length === null ? "no length" : `${shot.length.toFixed(1)} s`}</span>
            <span class={`sbstate${approved ? " ok" : ""}`}>{approved ? "Approved" : "Draft"}</span>
            <button
              class={`btn ib okd${approved ? " on" : ""}`}
              // A toggle: its name stays and aria-pressed says whether it is on; the tooltip is its name.
              data-tip={`Approve shot ${shot.n}`}
              aria-label={`Approve shot ${shot.n}`}
              aria-pressed={approved}
              onClick={() => save.shot(shot, { status: approved ? "draft" : "approved" })}
            >
              <Icon name="check" />
            </button>
          </div>
          <Frame shot={shot} marks={marksOn(notes, board.shots, i)} all={notes} shape={shape} selected={selected} onShape={onShape} onSelect={onSelect} />
          <div class="sbnav">
            <button class="btn vzpill" aria-label="Previous shot" disabled={i === 0} onClick={() => go(i - 1)}>
              Previous
            </button>
            <span class="vzcount mono" aria-label={`Shot ${i + 1} of ${count}`}>
              {pad(i + 1)} / {pad(count)}
            </span>
            <button class="btn vzpill" onClick={() => setView(true)}>
              Overview
            </button>
            <button class="btn vzpill primary" aria-label="Next shot" disabled={i >= count - 1} onClick={() => go(i + 1)}>
              Next
            </button>
          </div>
          <div class="sbstrip" ref={strip} role="list" aria-label="Shots">
            {board.shots.map((s, n) => (
              <button
                key={`${s.heading}#${occurrenceOf(board.shots, n)}`}
                class={`sbchipshot${s.status === "approved" ? " ok" : ""}`}
                role="listitem"
                aria-current={n === i ? "true" : undefined}
                aria-label={`Shot ${s.n}, ${s.name}`}
                data-tip={`${pad(s.n)} · ${s.name}`}
                onClick={() => go(n)}
              >
                <Still shot={s} />
                <span class="sbno mono">{pad(s.n)}</span>
                {open[n] > 0 && <span class="sbbadge" aria-label={`${open[n]} open notes`}>{open[n]}</span>}
              </button>
            ))}
          </div>
          <Details key={`${shot.heading}#${occurrenceOf(board.shots, i)}`} shot={shot} save={save} />
        </div>
      )}
      <PlanStatus counts={board.total > 0 ? { approved: approvedOf(board.approved, board.total, "shot"), edited: board.changed } : null} />
    </div>
  );
}
