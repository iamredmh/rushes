// §28: a note's card with the agent. Under the note's text: its badge (what the agent is doing with it, that it is with
// the agent, or where it was fixed) and its thread (the agent's replies, the last three with Show all). §35: notes go
// one way, so the thread is read-only: no reply box, no Needs you. A note with neither is as it was.
import { useEffect, useRef, useState } from "preact/hooks";
import { badgeText, fixGo, noteAgentBadge, noteLite, noteThread, threadParts } from "../../agent.js";
import type { JumpTarget } from "../../changelog.js";
import type { AgentStatus, Note } from "../../types.js";
import { Icon } from "../Icon.js";

/** What the notes panel gives each card for the agent: its status (null from a server without Send to AI) and the
 *  desk's jump, which Fixed in <v> takes to the fix's version. */
export interface NotesAgent {
  status: AgentStatus | null;
  onJump(to: JumpTarget): void;
  /** §35.7: by batch id, the status line of a batch the agent's turn ended without answering. */
  unfinished?: Readonly<Record<string, string>>;
}

/** How long after Fixed in <v> is pressed its version may come on screen and still be sought. */
const JUMP_WAIT_MS = 2000;

/** The Timeline's player, whose file a jump to another version swaps; never an audio tab's preview (`.spreview`, I2). */
const player = (): HTMLVideoElement | null => document.querySelector<HTMLVideoElement>(".monitor:not(.spreview) .frame video");

/** The badge line: what the agent is doing (spinning), With <A>, Not finished (§35.7), or Fixed in <v> (a button to the fix). */
export function NoteBadge({ n, agent, version, onSeek }: { n: Note; agent: NotesAgent; version: string | null; onSeek?(t: number, note: Note): void }) {
  const badge = noteAgentBadge(noteLite(n), agent.status, (n.batch !== null && agent.unfinished?.[n.batch]) || null);
  // After a jump to the fix's version, its time is sought once that version is on screen and its file has loaded: a
  // seek made while the player is still swapping files is lost (the browser starts the new file from the top). A jump
  // the desk refused (a note half written) leaves nothing behind to seek on a later, unrelated switch.
  const seekOn = useRef<{ version: string; t: number; from: string; at: number } | null>(null);
  const seekNow = useRef(onSeek);
  seekNow.current = onSeek;
  useEffect(() => {
    const p = seekOn.current;
    if (!p || p.version !== version) return;
    seekOn.current = null;
    if (Date.now() - p.at > JUMP_WAIT_MS) return;
    const go = () => seekNow.current?.(p.t, n);
    const v = player();
    if (!v || (v.readyState >= 1 && v.currentSrc !== p.from)) return go();
    v.addEventListener("loadedmetadata", go, { once: true });
    return () => v.removeEventListener("loadedmetadata", go);
  }, [version]);
  if (!badge) return null;
  // The agent's own parts (what it is doing, the version it names) with hidden characters spelled out, isolated.
  const text = badgeText(badge);
  if (badge.kind === "fixed") {
    const go = fixGo(n, version);
    const press = () => {
      if (go?.kind === "seek") onSeek?.(go.t, n);
      else if (go?.kind === "jump") {
        seekOn.current = go.t !== null ? { version: go.to.version!, t: go.t, from: player()?.currentSrc ?? "", at: Date.now() } : null;
        agent.onJump(go.to);
      }
    };
    return (
      <div class="nbadge fixed">
        <Icon name="check" />
        {go ? <button type="button" class="nfix" dir="auto" onClick={press}>{text}</button> : <span dir="auto">{text}</span>}
      </div>
    );
  }
  return (
    <div class={`nbadge ${badge.kind}`}>
      {badge.kind === "working" && <Icon name="spin" class="nspin" />}
      {badge.kind === "unfinished" && <Icon name="pause" />}
      <span dir="auto">{text}</span>
    </div>
  );
}

/** The thread: a line per agent reply, with the reply icon, the time on the right. Read-only (§35). */
export function NoteThread({ n }: { n: Note }) {
  const [all, setAll] = useState(false);
  const { lines, more } = noteThread(n, all);
  if (lines.length === 0) return null;
  return (
    <div class="nthread">
      {more && (
        <button type="button" class="nmore" onClick={() => setAll(true)}>{more}</button>
      )}
      {lines.map((l, i) => (
        <div key={i} class={`nline ${l.by}`}>
          <span class="nwho" role="img" aria-label="Agent"><Icon name="reply" /></span>
          {/* The reply as written, its hidden characters spelled out (as an ask card's command), line by line. */}
          <span class="ntext" dir="auto">
            {threadParts(l.text).map((parts, j) => (
              <>
                {j > 0 && "\n"}
                {parts.map((p) => ("text" in p ? p.text : <span class="nhid">{p.hidden}</span>))}
              </>
            ))}
          </span>
          {l.time && <span class="ntime">{l.time}</span>}
        </div>
      ))}
    </div>
  );
}
