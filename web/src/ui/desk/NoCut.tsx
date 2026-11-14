// §27, 5.6: the Timeline tab before there is a cut, when takes are in use or the mix has notes. What the Mix tab did
// with no cut: the takes play together with the audio engine as the clock (there is no picture to follow), with the
// same rows, mute, solo, levels and loudness as the Timeline tab (`useMix`, `SoundTracks`), and notes on the mix.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api } from "../../api.js";
import { noteTarget, type Selection } from "../../desk.js";
import { AUDIO_CHIPS, copyShortcut, LOCKED_TAB, MIX_STAGE, snap, spacePressesButton, stepFrame } from "../../lib.js";
import type { Asset, Note, State, Video } from "../../types.js";
import { Icon } from "../Icon.js";
import { NotesPanel } from "./NotesPanel.js";
import { Ruler } from "./Ruler.js";
import { LoudnessReadout, type SoundTab, SoundTracks, takeOn, useMix } from "./SoundTracks.js";
import { Transport } from "./Transport.js";

const NO_PLAYER = { current: null };
const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

export interface NoCutProps {
  state: State;
  assets: Asset[];
  video: Video | null;
  /** The notes on the mix for this film. */
  notes: Note[];
  /** What to ask your agent for, to get a cut. */
  prompt: string;
  readOnly?: boolean;
  toast(message: string): void;
  onChanged(): void;
  onPendingChange?(pending: boolean): void;
  onOpenTab?(tab: SoundTab): void;
}

/** The Timeline tab with no cut: a slate where the picture would be, then the transport, the ruler and the sound rows. */
export function NoCutTimeline({ state, assets, video, notes, prompt, readOnly = false, toast, onChanged, onPendingChange, onOpenTab }: NoCutProps) {
  const [sound, setSound] = useState({ level: 1, muted: false });
  const mix = useMix({ state, assets, video, version: null, player: NO_PLAYER, duration: 0, monitor: sound, toast, onChanged });
  const { engine, length } = mix;
  const fps = state.project.fps || 30;
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => engine.subscribe((now) => setT(now)), [engine]);
  useEffect(() => engine.onChange(() => setPlaying(engine.playing)), [engine]);
  const input = useRef<HTMLTextAreaElement>(null);
  const [hasText, setHasText] = useState(false);
  // §27, 5.7: a take picked on its row is the note's target; otherwise the mix at the playhead (there is no frame).
  const [takeSel, setTakeSel] = useState<Extract<Selection, { kind: "take" }> | null>(null);
  const takeGone = takeSel !== null && !mix.rows.some((r) => r.take && takeOn(r.take) === takeSel.on);
  useEffect(() => {
    if (takeGone) setTakeSel(null);
  }, [takeGone]);
  const takeNotes = state.notes.notes.filter((n) => (n.stage === "voice" || n.stage === "music" || n.stage === "sfx") && (!n.video || n.video === video?.id) && mix.noteRow(n) !== null);
  const targetAt = (at: number) => noteTarget(takeSel ?? { kind: "mix", t: at }, null, fps);
  const target = targetAt(snap(t, fps));
  useLayoutEffect(() => onPendingChange?.(hasText), [hasText]);
  useEffect(() => () => onPendingChange?.(false), []);

  const toggle = () => (engine.playing ? engine.pause() : engine.play());
  const step = (n: number) => {
    engine.pause();
    engine.seek(stepFrame(engine.time, fps, n, length));
  };
  const onKey = useRef<(e: KeyboardEvent) => void>(() => undefined);
  onKey.current = (e) => {
    if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === " ") {
      if (spacePressesButton(e.target)) return;
      e.preventDefault();
      toggle();
    } else if (e.key === "ArrowLeft") { e.preventDefault(); step(e.shiftKey ? -10 : -1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(e.shiftKey ? 10 : 1); }
    else if (e.key.toLowerCase() === "n" && !readOnly) { e.preventDefault(); input.current?.focus(); }
    else if (e.key.toLowerCase() === "v" || e.key === "Escape") setTakeSel(null);
  };
  useLayoutEffect(() => {
    const k = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const add = async (text: string) => {
    const at = targetAt(snap(engine.time, fps));
    await api.post("/api/notes", { stage: at.stage, video: video?.id ?? null, version: null, on: at.on, scope: at.scope, t: at.t, tOut: at.tOut, text, marks: [] });
    onChanged();
  };
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      toast("Prompt copied");
    } catch {
      toast(`Couldn't reach the clipboard: press ${copyShortcut(navigator.platform)} in the prompt instead`);
    }
  };

  return (
    <div class="split">
      <div class="tl">
        <div class="monitor">
          <div class="noslate">
            <Icon name="film" />
            <h3>No cut yet</h3>
            <p>{LOCKED_TAB.picture.unlocks} Until then the takes in use play here together.</p>
            <button type="button" class="btn sm" onClick={() => void copyPrompt()}><Icon name="copy" />Copy prompt for your agent</button>
          </div>
        </div>
        <Transport
          t={t}
          duration={length}
          playing={playing}
          onToggle={toggle}
          onStep={step}
          rangeLabel={null}
          onClearRange={() => undefined}
          volume={sound.level}
          muted={sound.muted}
          onVolume={(level) => setSound({ level, muted: level === 0 ? sound.muted : false })}
          onMute={() => setSound({ ...sound, muted: !sound.muted })}
          loudness={mix.inUse ? <LoudnessReadout loudness={mix.loudness} /> : null}
        />
        <div class="tlpanel">
          <div class="trow rrow">
            <div class="thead" />
            <Ruler duration={length} t={t} marks={[]} live={null} onSeek={(to) => engine.seek(to)} onMark={() => undefined} />
          </div>
          <SoundTracks
            mix={mix}
            duration={length}
            t={t}
            onSeek={(to) => engine.seek(to)}
            onOpenTab={onOpenTab}
            selected={takeSel ? (mix.rows.find((r) => r.take && takeOn(r.take) === takeSel.on)?.lane ?? null) : null}
            notes={[...notes, ...takeNotes]}
            onPick={readOnly ? undefined : (row, at) => {
              const to = at === null ? null : snap(at, fps);
              setTakeSel({ kind: "take", stage: MIX_STAGE[row.lane], on: takeOn(row.take!), name: row.take!.variant.name, t: to });
              if (to !== null) {
                engine.pause();
                engine.seek(to);
              }
            }}
          />
        </div>
      </div>
      <NotesPanel
        readOnly={readOnly}
        notes={[...notes, ...takeNotes]}
        version={null}
        placeholder={`Note on ${target.label}`}
        inputRef={input}
        toast={toast}
        onAdd={add}
        onChanged={onChanged}
        onTextChange={setHasText}
        onLabel={mix.noteLabel}
        fixedTimes
        onSeek={(to) => engine.seek(to)}
        target={{ label: target.label, onClear: takeSel ? () => setTakeSel(null) : undefined }}
        chips={takeSel ? AUDIO_CHIPS[takeSel.stage] : undefined}
      />
    </div>
  );
}
