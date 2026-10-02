import type { ComponentChildren, RefObject } from "preact";
import { useState } from "preact/hooks";
import { api, mediaUrl } from "../api.js";
import { noteTime, placeNote, shotLabel } from "../lib.js";
import type { Note } from "../types.js";
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
}

/** The notes column used on every tab: list, filter, done circles and the note box. */
export function Notes({ notes, version, placeholder, attachments, inputRef, toast, onAdd, onSeek, onChanged, onTextChange }: NotesProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const todo = notes.filter((n) => n.status === "todo").length;
  const placed = notes
    .map((n) => ({ n, at: placeNote(n, version) }))
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
              {at.from && <span class="from">from {at.from}</span>}
            </div>
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
        {attachments && <div class="row">{attachments}</div>}
        <div class="cbox">
          <textarea
            ref={inputRef}
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
