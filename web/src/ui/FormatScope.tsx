import { useId } from "preact/hooks";
import { shapeBox } from "../lib.js";

export interface FormatScopeProps {
  /** The format on screen, e.g. "9:16", and its size for the glyph. */
  label: string;
  width: number;
  height: number;
  value: "this" | "all";
  onChange(value: "this" | "all"): void;
  /** Why All formats can't be chosen (a drawn box), or null. */
  lockedReason: string | null;
  /** The group's accessible name. */
  name: string;
}

const KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];

/** §21.5: This format | All formats, as a two-way radio group (the composer and the selected card). */
export function FormatScope({ label, width, height, value, onChange, lockedReason, name }: FormatScopeProps) {
  const box = shapeBox(width, height);
  const reasonId = useId();
  const options = [
    { v: "this" as const, text: "This format", disabled: false },
    { v: "all" as const, text: "All formats", disabled: lockedReason !== null },
  ];
  // A radio group's keys: the arrows move between the two (no wrap to speak of with two), Home and
  // End go to the ends. Kept here, so the frame step and Alt+arrows never see them.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.metaKey || e.ctrlKey || !KEYS.includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const to = e.key === "Home" ? "this" : e.key === "End" ? "all" : value === "this" ? "all" : "this";
    if (to === "all" && lockedReason) return;
    if (to !== value) onChange(to);
    (e.currentTarget as HTMLElement).querySelector<HTMLButtonElement>(`[data-scope="${to}"]`)?.focus();
  };
  return (
    <div class="fscope" role="radiogroup" aria-label={name} onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          data-scope={o.v}
          aria-checked={value === o.v}
          aria-disabled={o.disabled ? "true" : undefined}
          aria-describedby={o.disabled ? reasonId : undefined}
          tabIndex={value === o.v ? 0 : -1}
          aria-label={o.v === "this" ? `This format, ${label}` : "All formats"}
          class={o.disabled ? "tip-wrap tip-below tip-end" : undefined}
          data-tip={o.disabled ? lockedReason! : undefined}
          onClick={() => { if (!o.disabled && o.v !== value) onChange(o.v); }}
        >
          {o.v === "this" && <span class="shape" aria-hidden="true" style={{ width: `${box.width}px`, height: `${box.height}px` }} />}
          {o.text}
        </button>
      ))}
      {lockedReason && <span id={reasonId} hidden>{lockedReason}</span>}
    </div>
  );
}
