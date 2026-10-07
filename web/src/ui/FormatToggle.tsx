import { useRef } from "preact/hooks";
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

/** §21.5: the format chips in Picture's header: a radio group in a fixed order (mockup). */
export function FormatToggle({ chips, versionId, prompt, onSelect, toast }: FormatToggleProps) {
  const group = useRef<HTMLDivElement>(null);
  if (chips.length === 0) return null;
  const single = chips.some((c) => c.reason === "single");
  const enabled = chips.filter((c) => c.enabled);
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
          return (
            <button
              type="button"
              role="radio"
              data-format={c.id}
              aria-checked={c.selected}
              aria-disabled={c.enabled ? undefined : "true"}
              tabIndex={c.enabled && c.selected ? 0 : -1}
              aria-label={chipLabel(c, versionId)}
              class={tip ? "tip-below" : undefined}
              data-tip={tip}
              onClick={(e) => {
                if (!c.enabled) return;
                // A mouse click hands the keys back to the player; a key press keeps focus here.
                if (e.detail > 0) (e.currentTarget as HTMLElement).blur();
                onSelect(c.id);
              }}
            >
              <span class="shape" aria-hidden="true" style={{ width: `${box.width}px`, height: `${box.height}px` }} />
              <span>{c.label}</span>
              {c.warn && <span class="warn" aria-hidden="true">!</span>}
              {c.count > 0 && <span class="n" aria-hidden="true">{c.count}</span>}
            </button>
          );
        })}
      </div>
      {single && (
        // R5: the chip itself is out of the tab order; this button is always in it, and focusing it shows the popover.
        <div class="fmtpop">
          <p>One format. Your agent can add more with <code>rushes_add_format</code>.</p>
          <button type="button" class="btn ghost" onClick={() => void copy()}>
            <Icon name="copy" />
            Copy a prompt for your agent
          </button>
        </div>
      )}
    </div>
  );
}
