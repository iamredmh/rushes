// §24.12, §27: the Storyboard page. storyboard.md is the file of record: one row per shot, its still, your description in
// a field (marked "Edited by you" over the agent's when they differ), a direction, and a tick to approve. It works like
// Script. Changing an approved shot reopens it.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { mediaUrl } from "../api.js";
import { briefTargetSeconds } from "../lib.js";
import type { BriefView, StoryboardShotView, StoryboardView } from "../types.js";
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
    // Whatever else in this row is unsaved goes with it: a save refused earlier is not lost behind this one.
    saveAll();
  }, SAVE_AFTER_MS);
  const saveDirection = useDebounced(() => {
    editing.current = false;
    saveAll();
  }, SAVE_AFTER_MS);

  // What your edits replaced, struck through under the field: the description, then the direction, whichever differ.
  const baseline: Baseline[] = [];
  if (text.trim() !== shot.current.trim()) baseline.push({ text: shot.current });
  if (direction.trim() !== shot.directionCurrent.trim()) baseline.push({ label: "Direction", text: shot.directionCurrent });
  const changed = baseline.length > 0;
  const approved = shot.status === "approved";
  return (
    <div class={`sbrow${changed ? " changed" : ""}`} data-shot={shot.heading}>
      <div class="sbid">
        <button class="sbstill" aria-label={`Enlarge the still for shot ${shot.n}`} data-tip={`Enlarge the still for shot ${shot.n}`} onClick={onZoom}>
          <Still shot={shot} />
        </button>
        <div class="sbmeta">
          <b>{pad(shot.n)}</b>
          <span>{shot.length === null ? "no length" : `${shot.length.toFixed(1)} s`}</span>
          {shot.tag && <span class="sbtag">{shot.tag}</span>}
        </div>
      </div>
      <div class="pbody">
        <b class="sbname">{shot.name}</b>
        <PlanField
          label={`Your version of shot ${shot.n}`}
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
            baseline={baseline}
            revertLabel={`Revert shot ${shot.n}`}
            onRevert={() => {
              editing.current = false;
              setText(shot.current);
              setDirection(shot.directionCurrent);
              save.shot(shot, { description: shot.current, direction: shot.directionCurrent });
            }}
          />
        )}
      </div>
      <div class="sblow">
        <input
          class="dirin sbdir"
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
      const was = latest.current.shots.findIndex((x) => x.index === s.index);
      const nth = was < 0 ? 0 : occurrenceOf(latest.current.shots, was);
      // Approving is only for the words you saw: if the agent has rewritten the shot since, the tick is not carried over to the new words.
      const approving = edit.status === "approved" && edit.description === undefined && edit.direction === undefined;
      enqueue(`shot ${s.n}`, (b, fresh) => {
        let at = b.shots.filter((x) => x.heading === s.heading)[nth];
        // The agent numbered the shots again: "Shot 02 · Drop a folder" is now "Shot 03 · Drop a folder". The name finds it, when it is the only one.
        if (!at) {
          const named = b.shots.filter((x) => x.name === s.name);
          if (named.length === 1) at = named[0];
        }
        if (at && fresh && approving && (at.description !== s.description || at.direction !== s.direction)) {
          return { refuse: "the agent changed this shot while you were looking at it. Read it again, then approve." };
        }
        return at ? { path: `/api/storyboard/shots/${at.index}`, body: { heading: at.heading, ...edit } } : null;
      });
    },
  };

  const target = briefTargetSeconds(brief);
  const zoomed = board.shots.find((s) => s.heading === zoom);
  return (
    <div class="col ppage">
      <div class="shead">
        <h2>Storyboard</h2>
      </div>
      <div class="sbtotal mono" aria-label="Planned length">
        <span>{target ? `${board.plannedLength.toFixed(1)} / ${target} s planned` : `${board.plannedLength.toFixed(1)} s planned`}</span>
        {target && (
          <span class="bar">
            <i style={{ width: `${Math.min(100, (board.plannedLength / target) * 100)}%` }} />
          </span>
        )}
      </div>
      {board.total === 0 && <p class="sbnone">storyboard.md has no shots yet. Your agent adds them as `## Shot 01 · Name` sections.</p>}
      <div class="prows">
        {board.shots.map((s, i) => (
          <Row key={`${s.heading}#${occurrenceOf(board.shots, i)}`} shot={s} save={save} onZoom={() => {
              opener.current = document.activeElement as HTMLElement | null;
              setZoom(s.heading);
            }} />
        ))}
      </div>
      <PlanStatus counts={board.total > 0 ? { approved: approvedOf(board.approved, board.total, "shot"), edited: board.changed } : null} />
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
