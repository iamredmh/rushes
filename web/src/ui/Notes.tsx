import type { ComponentChildren, RefObject } from "preact";
import { useRef, useState } from "preact/hooks";
import { api, mediaUrl } from "../api.js";
import { MARK_DB, type MarkKind, marksLabel, noteTime, placeNote, setMarkDb, shotLabel, toggleMark } from "../lib.js";
import type { Mark, Note } from "../types.js";
import { FormatScope } from "./FormatScope.js";
import { Icon } from "./Icon.js";

/** The list's All / To do / Done filter. */
export type Filter = "all" | "todo" | "done";

export interface NotesProps {
  /** This tab's notes (already narrowed to the video being watched, where that applies). */
  notes: Note[];
  /** The version being watched, so notes from older cuts can be placed. */
  version: string | null;
  placeholder: string;
  /** Chips shown above the note box (a box or a frame grab waiting to be attached). */
  attachments?: ComponentChildren;
  inputRef?: RefObject<HTMLTextAreaElement>;
  /** Tell the user something went wrong (a failed save, say). */
  toast(message: string): void;
  onAdd(text: string): Promise<void>;
  onSeek?(t: number, note: Note): void;
  onChanged(): void;
  /** Whether the note box has anything typed in it, so the player knows a note is pending. */
  onTextChange?(hasText: boolean): void;
  /** §27, 5.7: the target line above the box, from the selection (noteTarget). */
  target?: NoteTargetLine;
  /** Quick-start chips (a take is the target): each puts "Chip: " in the note box, and never sends anything. */
  chips?: string[];
  /** Quick marks, offered while the target is a range on a take. */
  marks?: { value: Mark[]; onChange(marks: Mark[]): void };
  /** What a listed note is on ("B · Warm keys", "Cue · Swipe"), shown beside its time. */
  onLabel?(note: Note): string | null;
  /** Times are shown as saved, never placed on another cut, and with no "from vN" (audio tabs). */
  fixedTimes?: boolean;
  /** The note last clicked (R6): its card is marked current. */
  selectedId?: string | null;
  // §21 formats. All optional: the audio tabs, and a one-format cut, pass none of them (R4, R15).
  /** §21.5: a listed note's ratio tag ("9:16", or "All"), or null for none. */
  formatTag?(n: Note): string | null;
  /** §21.5: shown under the selected card (its This format | All formats switch). */
  cardExtra?(n: Note): ComponentChildren;
  /** §21.2 (4): the composer's This format | All formats switch and its hint line. */
  formatScope?: ComposerFormat;
  /** §21.5: at the bottom of the list (the "Other formats (N)" row), for the filter in use (review M6);
   *  null when there's nothing to show. */
  listFooter?(filter: Filter): ComponentChildren;
  /** §26: a shelved film is looked at, not marked: the note box is hidden. */
  readOnly?: boolean;
}

/** §27, 5.7: what the next note is about, named on the line above the box. */
export interface NoteTargetLine {
  label: string;
  /**
   * The other thing the note could be on, as a two-item menu: "This frame" or "The whole mix" with nothing selected on
   * the Timeline tab; "This moment" or "The whole read" with a take selected on its own tab. The line hides its label
   * while it only repeats the menu's choice.
   */
  menu?: { value: string; options: { value: string; label: string }[]; onChange(value: string): void };
  /** Lets go of the selection, back to the default target (also Esc in an empty note box). */
  onClear?(): void;
}

/** §21.2 (4), §21.5: the composer's switch, for the format on screen. */
export interface ComposerFormat {
  label: string;
  width: number;
  height: number;
  value: "this" | "all";
  onChange(v: "this" | "all"): void;
  /** Why All formats can't be chosen (a drawn box: §21.2 (6)), or null. */
  lockedReason: string | null;
  /** The line under the note box: where the note will show. */
  hint: string;
}

const MARK_KINDS: { kind: MarkKind; label: string }[] = [
  { kind: "rise", label: "Rise" },
  { kind: "fall", label: "Fall" },
  { kind: "louder", label: "Louder" },
  { kind: "quieter", label: "Quieter" },
];

/** The notes column used on every tab: list, filter, done circles and the note box. */
export function Notes({
  notes, version, placeholder, attachments, inputRef, toast, onAdd, onSeek, onChanged, onTextChange, target, chips, marks, onLabel, fixedTimes, selectedId,
  formatTag, cardExtra, formatScope, listFooter, readOnly,
}: NotesProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const ownInput = useRef<HTMLTextAreaElement>(null);
  const box = inputRef ?? ownInput;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const todo = notes.filter((n) => n.status === "todo").length;
  const footer = listFooter?.(filter) ?? null;
  const placed = notes
    .map((n) => ({ n, at: fixedTimes ? { t: n.t, tOut: n.tOut, from: null } : placeNote(n, version) }))
    .filter(({ n }) => filter === "all" || n.status === filter)
    .sort((a, b) => (a.at.t ?? -1) - (b.at.t ?? -1));

  const toggle = async (n: Note) => {
    try {
      await api.patch(`/api/notes/${n.id}`, { status: n.status === "done" ? "todo" : "done" });
    } catch (e) {
      toast(`Couldn't update that note: ${(e as Error).message}`);
    }
    onChanged();
  };

  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await onAdd(value);
      setText("");
      onTextChange?.(false);
    } catch (e) {
      // Keep what was typed so nothing is lost.
      toast(`Couldn't add the note: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  /** Start a note with `value` in the box, caret at the end. A chip starts "Tempo: ". */
  const begin = (value: string) => {
    setText(value);
    onTextChange?.(true);
    const el = box.current;
    if (el) {
      el.value = value;
      el.focus();
      el.setSelectionRange(value.length, value.length);
    }
  };

  return (
    <div class="panel side notes" role="region" aria-label="Notes">
      <div class="ph">
        <div class="seg" role="group" aria-label="Filter notes">
          {(["all", "todo", "done"] as const).map((f) => (
            <button aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f === "todo" ? "To do" : "Done"}
              {f === "todo" && todo > 0 && <span class="n">{todo}</span>}
            </button>
          ))}
        </div>
      </div>
      <div class="list">
        {placed.length === 0 && <div class="none">{filter !== "all" ? "Nothing here." : footer ? "None on this format." : "No notes yet."}</div>}
        {placed.map(({ n, at }) => (
          // Keyed (review M3): a card that shows on the next format keeps its node, and its focus.
          <div key={n.id} class={`note${n.status === "done" ? " done" : ""}`} data-note={n.id} aria-current={selectedId === n.id ? "true" : undefined}>
            <button class="chk" aria-label={n.status === "done" ? "Reopen" : "Mark done"} title={n.status === "done" ? "Reopen" : "Mark done"} onClick={() => void toggle(n)}>
              <Icon name="check" />
            </button>
            <div class="nt">
              <button class="t" onClick={() => at.t !== null && onSeek?.(at.t, n)}>{noteTime(at.t, at.tOut)}</button>
              {onLabel && onLabel(n) && <span class="on">{onLabel(n)}</span>}
              {(() => {
                const tag = formatTag?.(n) ?? null;
                return tag && <span class={`ftag${tag === "All" ? " all" : ""}`}>{tag}</span>;
              })()}
              {at.from && <span class="from">from {at.from}</span>}
            </div>
            {marksLabel(n.marks) && <div class="nmarks">{marksLabel(n.marks)}</div>}
            {n.shot && <div class="shotref">Shot {shotLabel(n.shot.n)} · {n.shot.name}</div>}
            <div class="nx">{n.text}</div>
            {n.grab && (
              <div class="att">
                <img class="thumb" src={mediaUrl(n.grab)} alt="Frame grab" />
              </div>
            )}
            {n.reply && (
              <div class="rp">
                <Icon name="reply" />
                <span>{n.reply}</span>
              </div>
            )}
            {selectedId === n.id && cardExtra && <div class="nfmt">{cardExtra(n)}</div>}
          </div>
        ))}
        {footer}
      </div>
      <div class="comp" hidden={readOnly}>
        {target && (
          <div class="row ntarget" role="group" aria-label="Note target">
            {target.menu ? (
              <span class="onwrap">
                <select
                  class="sel ntsel"
                  aria-label="Aim the note at"
                  value={target.menu.value}
                  onChange={(e) => {
                    const el = e.target as HTMLSelectElement;
                    target.menu!.onChange(el.value);
                    // So the keys go back to the transport rather than the menu.
                    el.blur();
                  }}
                >
                  {target.menu.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <Icon name="chev" />
              </span>
            ) : null}
            {target.label !== target.menu?.options.find((o) => o.value === target.menu!.value)?.label && <span class="ntl tip-wrap" data-target="" data-tip={target.label}>{target.label}</span>}
            {target.onClear && (
              <button type="button" class="btn ghost ib sm ntclear" aria-label="Clear the selection · Esc" data-tip="Clear the selection · Esc" onClick={target.onClear}>
                <Icon name="x" />
              </button>
            )}
          </div>
        )}
        {/* With a range, the marks row takes the chips' place, so the composer never grows by a row. */}
        {chips && chips.length > 0 && !marks && (
          <div class="row" role="group" aria-label="Start a note">
            {chips.map((c) => <button type="button" class="chip" onClick={() => begin(`${c}: `)}>{c}</button>)}
          </div>
        )}
        {marks && (
          <div class="row" role="group" aria-label="Marks">
            {MARK_KINDS.map(({ kind, label }) => {
              const m = marks.value.find((x) => x.kind === kind);
              return (
                <span class="markc">
                  <button type="button" class="chip" aria-pressed={!!m} onClick={() => marks.onChange(toggleMark(marks.value, kind))}>{label}</button>
                  {m?.db !== undefined && (
                    <span class="onwrap">
                      <select
                        class="sel dbsel"
                        aria-label={`${label} by`}
                        value={String(m.db)}
                        onChange={(e) => {
                          const el = e.target as HTMLSelectElement;
                          marks.onChange(setMarkDb(marks.value, kind, Number(el.value)));
                          el.blur();
                        }}
                      >
                        {MARK_DB.map((d) => <option value={String(d)}>{d} dB</option>)}
                      </select>
                      <Icon name="chev" />
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        )}
        {formatScope && (
          <div class="row">
            <FormatScope
              name="This note applies to"
              label={formatScope.label}
              width={formatScope.width}
              height={formatScope.height}
              value={formatScope.value}
              onChange={formatScope.onChange}
              lockedReason={formatScope.lockedReason}
            />
          </div>
        )}
        {attachments && <div class="row">{attachments}</div>}
        <div class="cbox">
          <textarea
            ref={box}
            class="input"
            rows={2}
            aria-label="New note"
            placeholder={placeholder}
            value={text}
            onInput={(e) => {
              const value = (e.target as HTMLTextAreaElement).value;
              setText(value);
              onTextChange?.(value.trim() !== "");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
              if (e.key === "Escape") {
                // An empty box lets go of the selection too (§27, 5.7), so the next note is on this frame again.
                if (text.trim() === "") target?.onClear?.();
                (e.target as HTMLTextAreaElement).blur();
              }
            }}
          />
          <button class="btn primary ib sm send" data-tip="Add note  ↵" aria-label="Add note" onClick={() => void submit()}>
            <Icon name="send" />
          </button>
        </div>
        {formatScope && <p class="fhint">{formatScope.hint}</p>}
      </div>
    </div>
  );
}
