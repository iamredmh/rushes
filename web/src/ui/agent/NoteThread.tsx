// §28.5: a note's card with the agent. Under the note's text: its badge (what the agent is doing with it, that it needs
// you, that it is with the agent, or where it was fixed), its thread (the agent's replies and your answers, the last
// three with Show all), and the reply box while the agent can hear an answer. A note with none of these is as it was.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { answerPlaceholder, badgeText, fixGo, noteAgentBadge, noteLite, noteThread, replyBoxShows, threadParts } from "../../agent.js";
import { api } from "../../api.js";
import type { JumpTarget } from "../../changelog.js";
import type { AgentStatus, Note } from "../../types.js";
import { Icon } from "../Icon.js";

/** What the notes panel gives each card for the agent: its status (null from a server without Send to AI) and the
 *  desk's jump, which Fixed in <v> takes to the fix's version. */
export interface NotesAgent {
  status: AgentStatus | null;
  onJump(to: JumpTarget): void;
}

/** How long after Fixed in <v> is pressed its version may come on screen and still be sought. */
const JUMP_WAIT_MS = 2000;

/** The Timeline's player, whose file a jump to another version swaps. */
const player = (): HTMLVideoElement | null => document.querySelector<HTMLVideoElement>(".frame video");

/** The badge line: Needs you, what the agent is doing (spinning), With <A>, or Fixed in <v> (a button to the fix). */
export function NoteBadge({ n, agent, version, onSeek }: { n: Note; agent: NotesAgent; version: string | null; onSeek?(t: number, note: Note): void }) {
  const badge = noteAgentBadge(noteLite(n), agent.status);
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
      {badge.kind === "needsYou" && <span class="ndot" aria-hidden="true" />}
      <span dir="auto">{text}</span>
    </div>
  );
}

/** The thread: a line per reply, the agent's with the reply icon and yours with your initial, the time on the right. */
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
          {l.by === "agent" ? (
            <span class="nwho" role="img" aria-label="Agent"><Icon name="reply" /></span>
          ) : (
            <span class="nwho" role="img" aria-label="You">Y</span>
          )}
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

/** Lines the box grows to before it scrolls. */
const MAX_LINES = 4;

/** The reply box: one line, growing to four; Enter sends the answer, Shift+Enter starts a new line. */
export function ReplyBox({ n, status, toast, onChanged }: { n: Note; status: AgentStatus | null; toast(message: string): void; onChanged(): void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const shows = replyBoxShows(noteLite(n), status);
  // Grows with what is typed, up to four lines; past that it scrolls inside itself. Sized again each time the box comes
  // back (a new textarea, holding what was kept), not only as text is typed.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 20;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const max = line * MAX_LINES + pad;
    el.style.height = `${Math.min(el.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth), max)}px`;
    el.style.overflowY = el.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) > max ? "auto" : "hidden";
  }, [text, shows]);
  if (!shows) return null;
  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await api.post(`/api/notes/${n.id}/replies`, { text: value });
      setText("");
      onChanged();
    } catch (e) {
      // The server's own words; what was typed stays.
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const label = answerPlaceholder(status);
  return (
    <div class="nreply">
      <textarea
        ref={ref}
        class="input"
        rows={1}
        aria-label={label}
        placeholder={label}
        aria-busy={busy}
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            void send();
          }
          if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
        }}
      />
    </div>
  );
}
