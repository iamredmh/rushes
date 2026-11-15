// §27, 5.9: one line at the foot of the desk: the format, frame rate, cut and lock state, on the right. (Red, round 2:
// the "Next:" line on the left is gone; what to do next is yours to know.) On a page with no notes panel (Visuals,
// Assets) it keeps a Send on the left while anything waits, since Send lives in the panel.
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { FormatPrompt } from "../FormatToggle.js";
import { Icon } from "../Icon.js";
import { useDismiss } from "../useDismiss.js";

export interface StatusBarProps {
  /** "Send 2 notes", on a page with no notes panel while anything waits; null elsewhere. */
  send?: { text: string; onGo(): void } | null;
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

export function StatusBar({ send = null, cut, shapes = null }: StatusBarProps) {
  return (
    <footer class="status">
      {send && (
        <button type="button" class="ssend" onClick={send.onGo}>
          <Icon name="send" />
          {send.text}
        </button>
      )}
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
