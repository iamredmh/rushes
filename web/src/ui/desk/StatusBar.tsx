// §27, 5.9: one line at the foot of the desk. Left, what to do next, a button when it leads somewhere on the desk;
// right, the format, frame rate, cut and lock state.
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { DeskView } from "../../desk.js";
import { FormatPrompt } from "../FormatToggle.js";
import { Icon } from "../Icon.js";
import { useDismiss } from "../useDismiss.js";

export interface StatusBarProps {
  next: { text: string; go: DeskView | null };
  onGo(view: DeskView): void;
  /** Null before the film has a cut. */
  cut: { format: string | null; fps: number; id: string; lockedAt: string | null } | null;
  /**
   * A cut with one format (no switch on the monitor): its shape is a button that opens the request for the other shapes
   * (§21.5, R5). Null when the monitor's switch is the place.
   */
  shapes?: { prompt: string; toast(message: string): void } | null;
}

/** The status bar's shape on a one-format cut, and the popover above it with the Copy prompt. */
function ShapeButton({ label, prompt, toast }: { label: string; prompt: string; toast(message: string): void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const copy = useRef<HTMLButtonElement>(null);
  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };
  useDismiss(open, wrap, close);
  // Opened, the Copy button has focus, so Enter copies straight away.
  useLayoutEffect(() => {
    if (open) copy.current?.focus();
  }, [open]);
  const name = `${label} · other shapes`;
  return (
    <span class="sshape" ref={wrap}>
      <button
        ref={button}
        type="button"
        class="sfmt"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={name}
        data-tip={name}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open && (
        <div class="fmtpop open spop" role="dialog" aria-label="Other shapes"
          // Space and Enter press its button; nothing behind it plays or steps.
          onKeyDown={(e) => { if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation(); }}>
          <FormatPrompt prompt={prompt} toast={toast} copyRef={copy} onClick={() => close(true)} />
        </div>
      )}
    </span>
  );
}

export function StatusBar({ next, onGo, cut, shapes = null }: StatusBarProps) {
  const go = next.go;
  return (
    <footer class="status">
      <Icon name="send" />
      <span class="next">
        Next:{" "}
        {go ? (
          <button type="button" class="nextgo" onClick={() => onGo(go)}>
            {next.text}
          </button>
        ) : (
          <b>{next.text}</b>
        )}
      </span>
      <span class="sp" />
      {cut && (
        <span class="smeta mono">
          {cut.format && (shapes ? <ShapeButton label={cut.format} prompt={shapes.prompt} toast={shapes.toast} /> : <span>{cut.format}</span>)}
          <span>{cut.fps} fps</span>
          <span>{cut.lockedAt === cut.id ? `${cut.id} locked` : cut.lockedAt ? `${cut.id} · ${cut.lockedAt} locked` : cut.id}</span>
        </span>
      )}
    </footer>
  );
}
