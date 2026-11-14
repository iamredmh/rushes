// §27, 5.9: one line at the foot of the desk. Left, what to do next, a button when it leads somewhere on the desk;
// right, the format, frame rate, cut and lock state.
import type { DeskView } from "../../desk.js";
import { Icon } from "../Icon.js";

export interface StatusBarProps {
  next: { text: string; go: DeskView | null };
  onGo(view: DeskView): void;
  /** Null before the film has a cut. */
  cut: { format: string | null; fps: number; id: string; lockedAt: string | null } | null;
}

export function StatusBar({ next, onGo, cut }: StatusBarProps) {
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
          {cut.format && <span>{cut.format}</span>}
          <span>{cut.fps} fps</span>
          <span>{cut.lockedAt === cut.id ? `${cut.id} locked` : cut.lockedAt ? `${cut.id} · ${cut.lockedAt} locked` : cut.id}</span>
        </span>
      )}
    </footer>
  );
}
