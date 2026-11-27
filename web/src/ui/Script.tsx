// §27: the Script page. One row per line: your version in a field, marked "Edited by you" over the current wording when
// they differ (a changed line goes with Send), with its fit, its direction, a flag and a tick.
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api.js";
import { fit, fmt, isChanged } from "../lib.js";
import type { Script as ScriptData, Section } from "../types.js";
import { sectionLineLabel } from "../../../src/core/notes.js";
import { Icon } from "./Icon.js";
import { approvedOf, Diff, EditedMark, PlanField, PlanStatus, useDebounced } from "./Planning.js";
import { useDismiss } from "./useDismiss.js";
import type { ScriptVersion } from "../../../src/core/schema.js";

const STATUS = {
  approved: { color: "var(--done)", label: "Approved" },
  flagged: { color: "var(--todo)", label: "Flagged" },
  draft: { color: "var(--text-3)", label: "Draft" },
} as const;

const SAVE_AFTER_MS = 500;

/** §27, 5.8: a script line as the notes panel names it: "S2 · The scan finds it" (the same words export and the CLI use). */
const lineLabel = sectionLineLabel;

function Row({ section, wps, video, toast, onChanged, onPick }: { section: Section; wps: number; video: string | null; toast(message: string): void; onChanged(): void; onPick?(line: { id: string; label: string }): void }) {
  const [text, setText] = useState(section.proposed ?? section.current);
  const [direction, setDirection] = useState(section.direction);
  const editing = useRef(false);

  // The agent changed the line, or another window did: follow it unless you're mid-edit.
  useEffect(() => {
    if (!editing.current) setText(section.proposed ?? section.current);
  }, [section.proposed, section.current]);
  useEffect(() => {
    if (!editing.current) setDirection(section.direction);
  }, [section.direction]);

  const patch = async (body: Record<string, unknown>) => {
    try {
      // §31.6: the line is in this film's script.
      await api.patch(`/api/script/${encodeURIComponent(section.id)}`, video ? { ...body, video } : body);
    } catch (e) {
      toast(`Couldn't save ${section.id.toUpperCase()}: ${(e as Error).message}`);
    }
    onChanged();
  };
  const saveText = useDebounced(() => {
    editing.current = false;
    void patch({ proposed: text.trim() === section.current.trim() ? null : text });
  }, SAVE_AFTER_MS);
  const saveDirection = useDebounced(() => {
    editing.current = false;
    void patch({ direction });
  }, SAVE_AFTER_MS);

  const slot = section.end - section.start;
  const f = fit(text, slot, wps);
  const changed = text.trim() !== section.current.trim();
  const status = STATUS[section.status];

  return (
    // Working in a row (a click or focus anywhere in it) makes its line the target of the next note in the notes panel.
    <div class={`srow${changed ? " changed" : ""}`} data-section={section.id} onFocusIn={() => onPick?.({ id: section.id, label: lineLabel(section) })} onClick={() => onPick?.({ id: section.id, label: lineLabel(section) })}>
      <div class="sgrid">
        <div class="when">
          <b>{section.id.toUpperCase()}</b>
          <span>{fmt(section.start).replace(/\.\d+$/, "")}–{fmt(section.end).replace(/\.\d+$/, "")}</span>
          <span class="stat" aria-label={status.label} data-tip={status.label} title={status.label}><i style={{ background: status.color }} /></span>
        </div>
        <div class="pbody">
          <PlanField
            label={`Your version of ${section.id}`}
            value={text}
            onInput={(t) => {
              editing.current = true;
              setText(t);
              saveText.schedule();
            }}
            onBlur={() => saveText.flush()}
          />
          {changed && (
            <EditedMark
              baseline={[{ text: section.current, after: text }]}
              revertLabel="Revert"
              onRevert={() => {
                editing.current = false;
                setText(section.current);
                void patch({ proposed: null });
              }}
            />
          )}
        </div>
      </div>
      <div class="sfoot">
        <div class={`fit${f.state === "ok" ? "" : ` ${f.state}`}`} title={`${f.words} words · ${f.seconds.toFixed(1)} s of ${slot.toFixed(1)} s`}>
          <i style={{ width: `${Math.min(100, f.ratio * 100)}%` }} />
        </div>
        <input
          class="dirin"
          placeholder="Direction"
          aria-label={`Direction for ${section.id}`}
          value={direction}
          onInput={(e) => {
            editing.current = true;
            setDirection((e.target as HTMLInputElement).value);
            saveDirection.schedule();
          }}
          onBlur={() => saveDirection.flush()}
        />
        <div class="sact">
          <button
            class={`btn ib flagd${section.status === "flagged" ? "" : " ghost"}`}
            data-tip={section.status === "flagged" ? "Unflag" : "Flag"}
            aria-label="Flag"
            aria-pressed={section.status === "flagged"}
            onClick={() => void patch({ status: section.status === "flagged" ? "draft" : "flagged" })}
          >
            <Icon name="flag" />
          </button>
          <button
            class="btn ib okd"
            // A toggle: its name stays "Approve" and aria-pressed says whether it is on; the tooltip is its name.
            data-tip="Approve"
            aria-label="Approve"
            aria-pressed={section.status === "approved"}
            onClick={() => void patch({ status: section.status === "approved" ? "draft" : "approved" })}
          >
            <Icon name="check" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** §38.5: when a version was kept, in words: "today 14:02", "yesterday 09:10", or "27 Nov 14:02". */
export function versionTime(at: string, now = new Date()): string {
  if (!at) return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return `today ${hm}`;
  if (diff === 1) return `yesterday ${hm}`;
  return `${d.getDate()} ${d.toLocaleDateString("en-GB", { month: "short" })} ${hm}`;
}

/** §38.5: the script version pill and its menu, newest first. */
function VersionPill({ versions, viewing, onPick }: { versions: { id: string; at: string }[]; viewing: string | null; onPick(id: string | null): void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useDismiss(open, wrap, (focus) => {
    setOpen(false);
    if (focus) button.current?.focus();
  });
  const newest = versions[versions.length - 1];
  const shown = viewing ?? newest?.id;
  if (!newest) return null;
  return (
    <div class="scrver" ref={wrap}>
      <button ref={button} class={`btn scrpill${viewing ? " old" : ""}`} aria-haspopup="menu" aria-expanded={open} aria-label={`Script ${shown}, choose a version`} onClick={() => setOpen(!open)}>
        Script {shown}
        <Icon name="chev" />
      </button>
      {open && (
        <div class="scrmenu" role="menu" aria-label="Script versions">
          {[...versions].reverse().map((v) => (
            <button
              key={v.id}
              role="menuitemradio"
              aria-checked={v.id === shown}
              onClick={() => {
                setOpen(false);
                onPick(v.id === newest.id ? null : v.id);
              }}
            >
              <b>{v.id}</b>
              <span>{[versionTime(v.at), v.id === newest.id ? "newest" : ""].filter(Boolean).join(" · ")}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** §38.5: an older version's lines, read-only, each marked against the newest, with Use this line. */
function OlderVersion({ version, newestId, sections, video, toast, onChanged, onBack }: { version: ScriptVersion; newestId: string; sections: Section[]; video: string | null; toast(m: string): void; onChanged(): void; onBack(): void }) {
  const byId = new Map(sections.map((s) => [s.id, s]));
  const added = sections.filter((s) => !version.lines.some((l) => l.id === s.id));
  const use = async (id: string, text: string) => {
    try {
      const now = byId.get(id)!;
      await api.patch(`/api/script/${encodeURIComponent(id)}`, { proposed: text.trim() === now.current.trim() ? null : text, ...(video ? { video } : {}) });
      toast(`${id.toUpperCase()} now has the ${version.id} wording as your version`);
      onChanged();
    } catch (e) {
      toast(`Couldn't use that line: ${(e as Error).message}`);
    }
  };
  return (
    <>
      <div class="scrold" role="status">
        <span>
          Viewing {version.id}, an older version. Each line is marked against {newestId}.
        </span>
        <button class="btn" onClick={onBack}>
          Back to newest
        </button>
      </div>
      <div class="prows">
        {version.lines.map((l) => {
          const now = byId.get(l.id);
          return (
            <div key={l.id} class="srow scrline" data-section={l.id}>
              <div class="sgrid">
                <div class="when">
                  <b>{l.id.toUpperCase()}</b>
                  <span>
                    {fmt(l.start).replace(/\.\d+$/, "")}–{fmt(l.end).replace(/\.\d+$/, "")}
                  </span>
                </div>
                <div class="pbody">
                  <p class="scrtext">{l.text}</p>
                  {now ? (
                    now.current.trim() === l.text.trim() ? (
                      <p class="scrsame">The same in {newestId}</p>
                    ) : (
                      <p class="scrdiff">
                        <span class="wl">{version.id} → {newestId}: </span>
                        <Diff before={l.text} after={now.current} />
                      </p>
                    )
                  ) : (
                    <p class="scrgone">Removed since</p>
                  )}
                </div>
              </div>
              <div class="sfoot">
                <button class="btn" disabled={!now || (now.proposed ?? now.current).trim() === l.text.trim()} data-tip={now ? undefined : "This line is no longer in the script"} onClick={() => void use(l.id, l.text)}>
                  <Icon name="undo" />
                  Use this line
                </button>
              </div>
            </div>
          );
        })}
        {added.map((s) => (
          <div key={s.id} class="srow scrline added" data-section={s.id}>
            <div class="sgrid">
              <div class="when">
                <b>{s.id.toUpperCase()}</b>
              </div>
              <div class="pbody">
                <p class="scrtext">{s.current}</p>
                <p class="scrnew">New in {newestId}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** The VO script: one row per line, your version over the current wording when you've changed it, and the count at the foot. */
export function Script({ script, versions = [], video = null, toast, onChanged, onPickLine }: { script: ScriptData; versions?: { id: string; at: string }[]; video?: string | null; toast(message: string): void; onChanged(): void; onPickLine?(line: { id: string; label: string }): void }) {
  const changed = script.sections.filter(isChanged).length;
  const approved = script.sections.filter((s) => s.status === "approved").length;
  const [viewing, setViewing] = useState<string | null>(null);
  const [older, setOlder] = useState<ScriptVersion | null>(null);
  const newestId = versions[versions.length - 1]?.id ?? "";
  // The agent kept a new version while an older one is open: the older one stays, now marked against the new newest.
  useEffect(() => {
    if (!viewing) return setOlder(null);
    let live = true;
    api
      .get<{ versions: ScriptVersion[] }>(`/api/script/versions${video ? `?video=${encodeURIComponent(video)}` : ""}`)
      .then((r) => {
        if (!live) return;
        const v = r.versions.find((x) => x.id === viewing) ?? null;
        if (!v) setViewing(null);
        setOlder(v);
      })
      .catch((e: unknown) => toast(`Couldn't load ${viewing}: ${(e as Error).message}`));
    return () => {
      live = false;
    };
  }, [viewing, video]);
  return (
    <div class="col ppage">
      <div class="shead">
        <h2>Script</h2>
        <VersionPill versions={versions} viewing={viewing} onPick={setViewing} />
      </div>
      {viewing && older ? (
        <OlderVersion version={older} newestId={newestId} sections={script.sections} video={video} toast={toast} onChanged={onChanged} onBack={() => setViewing(null)} />
      ) : (
        <div class="prows">
          {script.sections.map((s) => <Row key={s.id} section={s} wps={script.wordsPerSecond} video={video} toast={toast} onChanged={onChanged} onPick={onPickLine} />)}
        </div>
      )}
      <PlanStatus counts={script.sections.length > 0 ? { approved: approvedOf(approved, script.sections.length, "line"), edited: changed } : null} />
    </div>
  );
}
