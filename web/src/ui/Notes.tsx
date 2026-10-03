import type { ComponentChildren, RefObject } from "preact";
import { type MutableRef, useRef, useState } from "preact/hooks";
import { api, mediaUrl } from "../api.js";
import { MARK_DB, type MarkKind, marksLabel, noteTime, type OnOption, placeNote, type Scope, scopeOptions, setMarkDb, shotLabel, toggleMark } from "../lib.js";
import type { Mark, Note } from "../types.js";
import { Icon } from "./Icon.js";

type Filter = "all" | "todo" | "done";

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
  // The audio tabs' extras (§17.1). All optional: Picture passes none of them and is unchanged.
  /** The On menu: what the next note is about. */
  on?: { options: OnOption[]; value: string | null; onChange(value: string): void };
  /** The Point / Range / Whole switch. */
  scope?: { value: Scope; onChange(scope: Scope): void; options?: Scope[] };
  /** Quick-start chips: each puts "Chip: " in the note box, and never sends anything. */
  chips?: string[];
  /** Quick marks, offered only while the scope is Range. */
  marks?: { value: Mark[]; onChange(marks: Mark[]): void };
  /** What a listed note is on ("B · Warm keys", "Cue · Swipe"), shown beside its time. */
  onLabel?(note: Note): string | null;
  /** Times are shown as saved, never placed on another cut, and with no "from vN" (audio tabs). */
  fixedTimes?: boolean;
  /** Set to a function that starts a note with the given text (caret at the end), as a chip does. */
  starter?: MutableRef<((text: string) => void) | null>;
}

const MARK_KINDS: { kind: MarkKind; label: string }[] = [
  { kind: "rise", label: "Rise" },
  { kind: "fall", label: "Fall" },
  { kind: "louder", label: "Louder" },
  { kind: "quieter", label: "Quieter" },
];
const onFull = (on: NonNullable<NotesProps["on"]>): string | undefined => on.options.find((o) => o.value === on.value)?.full;

/** The notes column used on every tab: list, filter, done circles and the note box. */
export function Notes({
  notes, version, placeholder, attachments, inputRef, toast, onAdd, onSeek, onChanged, onTextChange, on, scope, chips, marks, onLabel, fixedTimes, starter,
}: NotesProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const ownInput = useRef<HTMLTextAreaElement>(null);
  const box = inputRef ?? ownInput;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const todo = notes.filter((n) => n.status === "todo").length;
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
  if (starter) starter.current = begin;

  return (
    <aside class="panel side" aria-label="Notes">
      <div class="ph">
        <h3>Notes</h3>
        <span class="sp" />
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
        {placed.length === 0 && <div class="none">{filter === "all" ? "No notes yet." : "Nothing here."}</div>}
        {placed.map(({ n, at }) => (
          <div class={`note${n.status === "done" ? " done" : ""}`} data-note={n.id}>
            <button class="chk" aria-label={n.status === "done" ? "Reopen" : "Mark done"} title={n.status === "done" ? "Reopen" : "Mark done"} onClick={() => void toggle(n)}>
              <Icon name="check" />
            </button>
            <div class="nt">
              <button class="t" onClick={() => at.t !== null && onSeek?.(at.t, n)}>{noteTime(at.t, at.tOut)}</button>
              {onLabel && onLabel(n) && <span class="on">{onLabel(n)}</span>}
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
          </div>
        ))}
      </div>
      <div class="comp">
        {(on || scope) && (
          <div class="row">
            {on && (
              // The selected entry's full name (its round, on Voiceover) as the tooltip. A <select>
              // draws no ::after, so the wrapper shows it; the select carries it too, for reading.
              <span class="onwrap" data-tip={onFull(on)}>
                <select
                  class="sel onsel"
                  aria-label="Note on"
                  data-tip={onFull(on)}
                  value={on.value ?? ""}
                  onChange={(e) => {
                    const el = e.target as HTMLSelectElement;
                    on.onChange(el.value);
                    // So the keys go back to the transport rather than the menu.
                    el.blur();
                  }}
                >
                  {on.options.map((o) => <option value={o.value}>{o.label}</option>)}
                </select>
                <Icon name="chev" />
              </span>
            )}
            <span class="sp" />
            {scope && (
              <div class="seg" role="group" aria-label="Scope">
                {scopeOptions(scope.options).map((s) => (
                  <button type="button" aria-pressed={scope.value === s.value} onClick={() => scope.onChange(s.value)}>{s.label}</button>
                ))}
              </div>
            )}
          </div>
        )}
        {/* In Range, the marks row takes the chips' place, so the composer never grows by a row. */}
        {chips && chips.length > 0 && !(marks && scope?.value === "range") && (
          <div class="row" role="group" aria-label="Start a note">
            {chips.map((c) => <button type="button" class="chip" onClick={() => begin(`${c}: `)}>{c}</button>)}
          </div>
        )}
        {marks && scope?.value === "range" && (
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
              if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
            }}
          />
          <button class="btn primary ib sm send" data-tip="Add note  ↵" aria-label="Add note" onClick={() => void submit()}>
            <Icon name="send" />
          </button>
        </div>
      </div>
    </aside>
  );
}
