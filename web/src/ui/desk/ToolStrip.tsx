import type { Tool } from "../../desk.js";
import { Icon } from "../Icon.js";

export interface ToolStripProps {
  /** The tool in use: Select, unless a note is being typed, a range marked or a box drawn. */
  active: Tool;
  /** §26: a shelved film is looked at, not marked: only Select works. */
  readOnly: boolean;
  /** A grab is being made from the original (ffmpeg): Grab shows it's busy. */
  grabbing: boolean;
  onSelect(): void;
  onNote(): void;
  onRange(): void;
  onBox(): void;
  onGrab(): void;
  /** The tools this view offers (a sound's tab has no Box or Grab). Defaults to all five. */
  tools?: Tool[];
}

const TOOLS: { tool: Tool; icon: string; tip: string; marks: boolean }[] = [
  { tool: "select", icon: "pointer", tip: "Select · V", marks: false },
  { tool: "note", icon: "note", tip: "Note at the playhead · N", marks: true },
  { tool: "range", icon: "range", tip: "Mark a range · I and O", marks: true },
  { tool: "box", icon: "box", tip: "Box on the picture · B", marks: true },
  { tool: "grab", icon: "camera", tip: "Grab this frame · G", marks: true },
];

/** §27, 5.4: the monitor's tools, down its left edge. Each runs the player's own handler for its key. */
export function ToolStrip({ active, readOnly, grabbing, onSelect, onNote, onRange, onBox, onGrab, tools }: ToolStripProps) {
  const run: Record<Tool, () => void> = { select: onSelect, note: onNote, range: onRange, box: onBox, grab: onGrab };
  return (
    <div class="tools" role="toolbar" aria-label="Tools" aria-orientation="vertical">
      {TOOLS.filter(({ tool }) => !tools || tools.includes(tool)).map(({ tool, icon, tip, marks }) => (
        <button
          key={tool}
          type="button"
          class="tool"
          data-tip={tip}
          aria-label={tip}
          aria-pressed={active === tool}
          aria-busy={tool === "grab" ? grabbing : undefined}
          disabled={readOnly && marks}
          // A mouse click hands the keys back to the player (a key press keeps focus here); Note moves focus itself.
          onClick={(e) => {
            if (tool !== "note" && e.detail > 0) (e.currentTarget as HTMLElement).blur();
            run[tool]();
          }}
        >
          <Icon name={icon} />
        </button>
      ))}
    </div>
  );
}
