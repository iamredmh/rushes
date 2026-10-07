import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { chipLabel, fmtColumns, shapeBox, type FormatChip } from "../lib.js";
import { Icon } from "./Icon.js";

export interface FormatToggleProps {
  chips: FormatChip[];
  versionId: string;
  /** The one-format popover's ready-made request (§21.5). */
  prompt: string;
  onSelect(id: string): void;
  toast(message: string): void;
}

/** How long the one-format popover waits before closing, so the pointer can cross from the chip into it. */
const POP_CLOSE_MS = 150;

/** §21.5: the format chips in Picture's header: a radio group in a fixed order (mockup). */
export function FormatToggle({ chips, versionId, prompt, onSelect, toast }: FormatToggleProps) {
  const group = useRef<HTMLDivElement>(null);
  const single = chips.some((c) => c.reason === "single");
  const enabled = chips.filter((c) => c.enabled);
  const selectedId = chips.find((c) => c.selected)?.id ?? null;

  // Review M7: when the selection moves while a chip has focus (Alt+arrows, say), focus moves with
  // it, so it never rests on a chip that's out of the tab order.
  useLayoutEffect(() => {
    const g = group.current;
    const active = document.activeElement;
    if (!g || !selectedId || !(active instanceof HTMLElement) || !g.contains(active)) return;
    const want = g.querySelector<HTMLElement>(`[data-format="${selectedId}"]`);
    if (want && want !== active) want.focus();
  }, [selectedId]);

  // R5 and review M3: the one-format popover opens for its own chip only -- while the pointer is on
  // that chip or the popover, or while its Copy button has focus from the keyboard. Esc closes it,
  // and pointing at another chip (a "Not in vN" one, with its own tooltip) closes it too.
  const [hover, setHover] = useState(false);
  const [keyFocus, setKeyFocus] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [otherHover, setOtherHover] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const pointerDown = useRef(false);
  const enter = () => {
    clearTimeout(closeTimer.current);
    setHover(true);
    setDismissed(false);
  };
  const leave = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setHover(false), POP_CLOSE_MS);
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const open = single && (hover || keyFocus) && !dismissed && !otherHover;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDismissed(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (chips.length === 0) return null;
  const onKeyDown = (e: KeyboardEvent) => {
    // Alt+arrows belong to the page (R1); everything else here is the radio group's own.
    if (e.altKey || e.metaKey || e.ctrlKey || enabled.length === 0) return;
    const i = Math.max(0, enabled.findIndex((c) => c.selected));
    let to: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") to = (i + 1) % enabled.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") to = (i - 1 + enabled.length) % enabled.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = enabled.length - 1;
    if (to === null) return;
    // Handled here, so Picture's ←/→ frame step never sees it.
    e.preventDefault();
    e.stopPropagation();
    onSelect(enabled[to].id);
    group.current?.querySelector<HTMLButtonElement>(`[data-format="${enabled[to].id}"]`)?.focus();
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      toast("Prompt copied");
    } catch {
      toast("Couldn't reach the clipboard. Ask your agent to register the other shapes with rushes_add_format.");
    }
  };
  return (
    <div class="fmtwrap">
      <div ref={group} class="fmts" role="radiogroup" aria-label="Format" style={{ gridTemplateColumns: fmtColumns(chips.length) }} onKeyDown={(e) => onKeyDown(e)}>
        {chips.map((c) => {
          const box = shapeBox(c.width, c.height);
          const tip = c.reason === "absent" ? `Not in ${versionId}` : c.warn ?? undefined;
          const solo = c.reason === "single";
          return (
            <button
              key={c.id}
              type="button"
              role="radio"
              data-format={c.id}
              aria-checked={c.selected}
              aria-disabled={c.enabled ? undefined : "true"}
              tabIndex={c.enabled && c.selected ? 0 : -1}
              aria-label={chipLabel(c, versionId)}
              class={tip ? "tip-below" : undefined}
              data-tip={tip}
              onMouseEnter={solo ? enter : () => setOtherHover(true)}
              onMouseLeave={solo ? leave : () => setOtherHover(false)}
              onClick={(e) => {
                if (!c.enabled) return;
                // A mouse click hands the keys back to the player; a key press keeps focus here.
                if (e.detail > 0) (e.currentTarget as HTMLElement).blur();
                onSelect(c.id);
              }}
            >
              <span class="shape" aria-hidden="true" style={{ width: `${box.width}px`, height: `${box.height}px` }} />
              {/* Review I1: the label holds the width of its bold self, so selecting a chip never widens it. */}
              <span class="lbl" data-label={c.label}>{c.label}</span>
              {c.warn && <span class="warn" aria-hidden="true">!</span>}
              {/* Review I1: the count's slot is always there (two digits wide), so a count arriving never moves a chip. */}
              {!single && <span class={`n${c.count > 0 ? "" : " none"}`} aria-hidden="true">{c.count > 0 ? c.count : ""}</span>}
            </button>
          );
        })}
      </div>
      {single && (
        // R5: the chip itself is out of the tab order; this button is always in it, and focusing it shows the popover.
        <div class={`fmtpop${open ? " open" : ""}`} onMouseEnter={enter} onMouseLeave={leave}>
          <p>One format. Your agent can add more with <code>rushes_add_format</code>.</p>
          <button
            type="button"
            class="btn ghost"
            onPointerDown={() => { pointerDown.current = true; }}
            onFocus={() => {
              // Focus from a click doesn't open it; focus from the keyboard (or a script) does.
              if (!pointerDown.current) setKeyFocus(true);
              pointerDown.current = false;
            }}
            onBlur={() => {
              setKeyFocus(false);
              setDismissed(false);
            }}
            onClick={(e) => {
              // WebKit doesn't focus a clicked button, so the pointer's mark is cleared here too.
              pointerDown.current = false;
              // A mouse click lets go of the popover once the pointer leaves it (review M3).
              if (e.detail > 0) (e.currentTarget as HTMLElement).blur();
              void copy();
            }}
          >
            <Icon name="copy" />
            Copy a prompt for your agent
          </button>
        </div>
      )}
    </div>
  );
}
