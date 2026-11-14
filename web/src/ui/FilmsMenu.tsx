// The Films button on a read, bed or pass: which films it is on. Ticking a film puts it there and
// unticking takes it off (dropping that film's pick of it), saved at once. One bed is often on
// several films. Every film's tab keeps the ones not on it folded under "Not on this film" (Takes).
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { api } from "../api.js";
import { Icon } from "./Icon.js";
import type { Video } from "../types.js";
import { useDismiss } from "./useDismiss.js";

export interface FilmsControl {
  /** Film ids it is on. */
  on: string[];
  /** Every film, those in play first, the one you are on marked `here`. */
  films: { id: string; name: string; shelved: boolean; here: boolean }[];
  /** Save the new set of films. */
  onChange(ids: string[]): void;
  readOnly?: boolean;
}

export function FilmsMenu({ name, control }: { name: string; control: FilmsControl }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };
  useDismiss(open, wrap, close);
  useLayoutEffect(() => {
    if (open) first.current?.focus();
  }, [open]);
  const { on, films } = control;
  const names = films.filter((f) => on.includes(f.id)).map((f) => f.name);
  const label = on.length === 0 ? "No film" : on.length === 1 ? "1 film" : `${on.length} films`;
  const toggle = (id: string) => control.onChange(on.includes(id) ? on.filter((x) => x !== id) : films.filter((f) => f.id === id || on.includes(f.id)).map((f) => f.id));

  return (
    <span class="fmwrap films" ref={wrap} onClick={(e) => e.stopPropagation()}>
      <button
        ref={button}
        type="button"
        class={`btn ghost sm filmsbtn${on.length === 0 ? " none" : ""}`}
        data-tip={names.length ? `On ${names.join(", ")}` : "On no film"}
        aria-label={`Films for ${name}: ${names.length ? names.join(", ") : "none"}`}
        aria-haspopup="true"
        aria-expanded={open}
        disabled={control.readOnly}
        onClick={() => setOpen(!open)}
      >
        <Icon name="film" />
        {label}
      </button>
      {open && (
        <div class="fmenu filmsmenu" role="group" aria-label={`Films for ${name}`}>
          <div class="fmtitle">
            Films it is on
            <b dir="auto">{name}</b>
          </div>
          {films.map((f, i) => (
            <label class="fmitem" key={f.id}>
              <input ref={i === 0 ? first : undefined} type="checkbox" checked={on.includes(f.id)} onChange={() => toggle(f.id)} />
              <span dir="auto">{f.name}</span>
              {f.here ? <kbd>this film</kbd> : f.shelved ? <kbd>shelved</kbd> : null}
            </label>
          ))}
        </div>
      )}
    </span>
  );
}

/** The Films control for one read, bed or pass on the tab of `video` (null: no film open). */
export function filmsControl(
  row: { lane: string; variant: string; films: string[] },
  videos: Pick<Video, "id" | "name" | "shelved">[],
  video: Pick<Video, "id" | "shelved"> | null,
  toast: (message: string) => void,
  onChanged: () => void,
): FilmsControl {
  return {
    on: row.films,
    films: [...videos.filter((v) => !v.shelved), ...videos.filter((v) => v.shelved)].map((v) => ({ id: v.id, name: v.name, shelved: !!v.shelved, here: v.id === video?.id })),
    readOnly: !!video?.shelved,
    onChange: async (ids) => {
      try {
        await api.put(`/api/variants/${encodeURIComponent(row.lane)}/${encodeURIComponent(row.variant)}/films`, { videos: ids });
      } catch (e) {
        toast(`Couldn't change its films: ${(e as Error).message}`);
      }
      onChanged();
    },
  };
}
