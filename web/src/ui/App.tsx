import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../api.js";
import { BUILT, STAGE_NAMES, UNLOCK_HINT, firstTab, latest } from "../lib.js";
import type { Batch, Stage } from "../types.js";
import { useRushes } from "../useRushes.js";
import { Icon, STAGE_ICONS } from "./Icon.js";
import { Picture } from "./Picture.js";
import { Script } from "./Script.js";

const ORDER: Stage[] = ["script", "picture", "voice", "music", "sfx", "mix"];
const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

function Empty({ stage, unlocked }: { stage: Stage; unlocked: boolean }) {
  return (
    <div class="empty">
      <Icon name={unlocked ? STAGE_ICONS[stage] : "lock"} />
      <h2>{unlocked ? `${STAGE_NAMES[stage]} is coming` : `Nothing to review in ${STAGE_NAMES[stage]} yet`}</h2>
      <p>{unlocked ? "This tab arrives in the next release of Rushes. Your agent can already read and reply to notes for it." : UNLOCK_HINT[stage]}</p>
    </div>
  );
}

export function App() {
  const { state, problem, refresh } = useRushes();
  const [stage, setStage] = useState<Stage | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [toastText, setToastText] = useState<string | null>(null);
  const [sent, setSent] = useState<Batch | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const toastTimer = useRef<number | undefined>(undefined);

  const toast = (message: string) => {
    setToastText(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastText(null), 2400);
  };

  // First load: pick a tab and a video.
  useEffect(() => {
    if (!state) return;
    if (stage === null) setStage(firstTab(state.tabs));
    if (videoId === null && state.project.videos[0]) setVideoId(state.project.videos[0].id);
  }, [state]);

  // Follow the newest cut unless you've chosen an older one.
  const video = state?.project.videos.find((v) => v.id === videoId) ?? state?.project.videos[0];
  const newest = latest(video);
  const version = video?.versions.find((v) => v.id === versionId) ?? newest;

  const tabs = state?.tabs ?? [];
  const tab = (s: Stage) => tabs.find((t) => t.stage === s);
  const show = (s: Stage) => {
    if (!tab(s)?.unlocked) return toast(`Nothing to review in ${STAGE_NAMES[s]} yet`);
    setStage(s);
    setSent(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 6) show(ORDER[n - 1]);
      if (e.key === "?") setKeysOpen((o) => !o);
      if (e.key === "Escape") {
        setKeysOpen(false);
        setSent(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const send = async () => {
    if (!stage) return;
    setKeysOpen(false);
    try {
      const { batch } = await api.post<{ batch: Batch }>("/api/batches", { stage });
      setSent(batch);
      setCopied(false);
      void refresh();
    } catch (e) {
      toast(e instanceof ApiError && e.code === "empty_batch" ? `Nothing open on ${STAGE_NAMES[stage]} to send` : (e as Error).message);
    }
  };
  const copy = async () => {
    if (!sent) return;
    try {
      await navigator.clipboard.writeText(sent.prompt);
      setCopied(true);
    } catch {
      toast("Couldn't reach the clipboard. Select the text and copy it.");
    }
  };

  if (!state || !stage) {
    return (
      <div class="shell">
        {problem ? <div class="banner"><Icon name="alert" />{problem}</div> : <div class="empty"><p>Loading…</p></div>}
      </div>
    );
  }

  const fps = version?.fps ?? state.project.fps;
  const pictureNotes = state.notes.notes.filter((n) => n.stage === "picture" && (!n.video || n.video === video?.id));
  const unlocked = tab(stage)?.unlocked ?? false;
  const open = tab(stage)?.todo ?? 0;

  return (
    <div class="shell">
      <header class="head">
        <span class="logo"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg></span>
        <nav class="crumb" aria-label="Project">
          <span>{state.project.name}</span>
          {video && (
            <>
              <span class="slash">/</span>
              {state.project.videos.length > 1 ? (
                <select class="sel" aria-label="Video" value={video.id} onChange={(e) => { setVideoId((e.target as HTMLSelectElement).value); setVersionId(null); }}>
                  {state.project.videos.map((v) => <option value={v.id}>{v.name}</option>)}
                </select>
              ) : (
                <span class="sel">{video.name}</span>
              )}
              {version && (
                <select
                  class="sel mono"
                  aria-label="Version"
                  value={version.id}
                  onChange={(e) => {
                    const id = (e.target as HTMLSelectElement).value;
                    setVersionId(id === newest?.id ? null : id);
                  }}
                >
                  {[...video.versions].reverse().map((v) => <option value={v.id}>{v.id}{v.note ? ` · ${v.note}` : ""}</option>)}
                </select>
              )}
            </>
          )}
        </nav>
        <span class="sp" />
        <button class="btn ghost ib tip-below" data-tip="Shortcuts  ?" aria-label="Keyboard shortcuts" onClick={() => { setSent(null); setKeysOpen(!keysOpen); }}>
          <Icon name="kbd" />
        </button>
        <button class="btn primary" onClick={() => void send()}>
          Send to agent{open > 0 && <span class="count">{open}</span>}
        </button>
      </header>

      {sent && (
        <div class="pop" role="dialog" aria-label="Sent to agent">
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <h3>Batch {sent.id} is ready</h3>
            <span class="sp" />
            <button class="btn ghost ib sm" aria-label="Close" onClick={() => setSent(null)}><Icon name="x" /></button>
          </div>
          <pre>{sent.prompt}</pre>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button class="btn primary" onClick={() => void copy()}><Icon name="copy" />{copied ? "Copied" : "Copy prompt"}</button>
          </div>
        </div>
      )}
      {keysOpen && (
        <div class="pop" role="dialog" aria-label="Keyboard shortcuts" style={{ width: "300px" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <h3>Shortcuts</h3>
            <span class="sp" />
            <button class="btn ghost ib sm" aria-label="Close" onClick={() => setKeysOpen(false)}><Icon name="x" /></button>
          </div>
          <div class="keys">
            <span><kbd>Space</kbd></span><span>Play or pause</span>
            <span><kbd>←</kbd> <kbd>→</kbd></span><span>Step one frame (Shift: ten)</span>
            <span><kbd>I</kbd> <kbd>O</kbd></span><span>Set in and out</span>
            <span><kbd>B</kbd></span><span>Draw a box</span>
            <span><kbd>G</kbd></span><span>Grab frame</span>
            <span><kbd>N</kbd></span><span>New note</span>
            <span><kbd>1</kbd>–<kbd>6</kbd></span><span>Switch tab</span>
          </div>
        </div>
      )}
      {toastText && <div class="toast" role="status">{toastText}</div>}

      <nav class="tabs" role="tablist" aria-label="Stages">
        {ORDER.map((s) => {
          const t = tab(s);
          return (
            <button class="tab" role="tab" aria-selected={stage === s} aria-disabled={!t?.unlocked} onClick={() => show(s)}>
              <Icon name={STAGE_ICONS[s]} />
              {STAGE_NAMES[s]}
              {t?.unlocked ? (t.todo > 0 && <span class="dot" title={`${t.todo} open`} />) : <Icon name="lock" class="lk" />}
            </button>
          );
        })}
      </nav>
      {problem && <div class="banner"><Icon name="alert" />{problem}</div>}

      <main class="body">
        {!unlocked || !BUILT[stage] ? (
          <Empty stage={stage} unlocked={unlocked} />
        ) : stage === "picture" && video && version ? (
          <Picture video={video} version={version} fps={fps} notes={pictureNotes} toast={toast} onChanged={() => void refresh()} />
        ) : stage === "script" ? (
          <Script script={state.script} onChanged={() => void refresh()} />
        ) : (
          <Empty stage={stage} unlocked={unlocked} />
        )}
      </main>
    </div>
  );
}
