import { Component } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../api.js";
import {
  bringInMessage, broughtInRows, filterFound, FOUND_KIND_LABEL, FOUND_KIND_ORDER, foundDuration, foundKinds, foundRowChanged, foundSignature, foundTotal,
  formatBytes, groupFound, humanFolder, reuseItems, type BroughtInRow,
} from "../lib.js";
import type { BringInResult, FoundItem, FoundKind, HiddenItem, State } from "../types.js";
import { Icon } from "./Icon.js";

/** The most files one Bring in click sends (the server's own limit, §20.6). The rest stay ticked. */
const SEND_MAX = 60;
/** §20.5's footer line, verbatim. */
export const FOUND_FOOTER = "Up to 12 files of each kind at a time, so the tabs stay quick. Each voiceover folder becomes its own round.";

/** The kinds an audio file can be brought in as. A cut's kind is fixed: it is a video. */
const AUDIO_KINDS: readonly FoundKind[] = FOUND_KIND_ORDER.filter((k) => k !== "cut");

export interface FoundProps {
  /** The project and what the server has found: the card of what came in, the counts, and (by changing) the cue to read the list again. */
  state: State;
  /** Opens with this kind filtered (Task 6's "Review" on a locked tab). Used once, when this opens. */
  initialKind?: FoundKind | "all";
  /** The one shared player Assets owns (§16.1): what plays now, how to start or pause a path, and how to stop it. */
  playing: { path: string | null; paused: boolean };
  onPlay(path: string, name: string): void;
  onStop(): void;
  toast(message: string, ms?: number): void;
  /** Ask for the state again, after something here changed it. */
  onChanged(): void;
  /** Told what the server had found whenever this tray was open, so the header chip can stay away until that changes. */
  onSeen(signature: string): void;
}

interface Listing {
  files: FoundItem[];
  hidden: HiddenItem[];
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** "That file has gone" as a short line under a row. */
const failLine = (reason: string): string => `Couldn't be added: ${reason.replace(/\.$/, "").replace(/^(\p{Lu})(?=\p{Ll})/u, (c) => c.toLowerCase())}`;

const KIND_COLOUR: Record<FoundKind | "doc", string> = {
  voice: "var(--vo)",
  music: "var(--music)",
  sfx: "var(--sfx)",
  other: "var(--text-3)",
  cut: "var(--accent)",
  doc: "var(--text-3)",
};

function Dot({ kind }: { kind: FoundKind | "doc" | null }) {
  return <i class="kdot" style={{ background: kind ? KIND_COLOUR[kind] : "var(--text-3)" }} />;
}

function PlayButton({ path, name, playing, onPlay }: { path: string; name: string; playing: boolean; onPlay(path: string, name: string): void }) {
  return (
    <button type="button" class="fplay" aria-label={`Play ${name}`} aria-pressed={playing} data-tip={playing ? "Pause" : "Play"} onClick={() => onPlay(path, name)}>
      <Icon name={playing ? "pause" : "play"} />
    </button>
  );
}

/** A row of the "Brought in with this cut" card: already in the project, so no tick and no kind to change. */
function BroughtRow({ row, playing, onPlay }: { row: BroughtInRow; playing: boolean; onPlay(path: string, name: string): void }) {
  return (
    <div class="frow in">
      <span />
      {row.playable ? <PlayButton path={row.path} name={row.name} playing={playing} onPlay={onPlay} /> : <span />}
      <div class="fnm">
        <b class="fname" dir="auto" title={row.path}>{row.name}</b>
        {row.reasons && <small class="freasons">{row.reasons}</small>}
      </div>
      <span class="kind static" title={row.label}>
        <Dot kind={row.kind} />
        <span class="klabel">{row.label}</span>
      </span>
      <span />
      <span />
    </div>
  );
}

interface RowProps {
  item: FoundItem;
  /** What it would come in as: the user's choice, else the guess. */
  kind: FoundKind;
  ticked: boolean;
  playing: boolean;
  failure: string | undefined;
  onTick(path: string, on: boolean): void;
  onKind(path: string, kind: FoundKind): void;
  onPlay(path: string, name: string): void;
}

/**
 * One found file. It draws again only when one of its own props changed: with up to 2,000 of
 * them, ticking one row or typing in the search must not redraw the rest.
 */
class FoundRow extends Component<RowProps> {
  shouldComponentUpdate(next: RowProps): boolean {
    return foundRowChanged(this.props, next);
  }

  render({ item: f, kind, ticked, playing, failure, onTick, onKind, onPlay }: RowProps) {
    const name = baseName(f.path);
    const isCut = f.kind === "cut";
    return (
      <div class={`frow${ticked ? " on" : ""}`} data-path={f.path}>
        <input type="checkbox" aria-label={`Tick ${name}`} checked={ticked} onChange={(e) => onTick(f.path, (e.target as HTMLInputElement).checked)} />
        {isCut ? <span /> : <PlayButton path={f.path} name={name} playing={playing} onPlay={onPlay} />}
        <div class="fnm">
          <b class="fname" dir="auto" title={f.path}>{name}</b>
          {f.reasons.length > 0 && <small class="freasons">{f.reasons.join(" · ")}</small>}
          {failure && <small class="ffail">{failLine(failure)}</small>}
        </div>
        {isCut ? (
          <span class="kind static">
            <Dot kind="cut" />
            {FOUND_KIND_LABEL.cut}
          </span>
        ) : (
          <label class="kind">
            <Dot kind={kind} />
            <select aria-label={`Kind of ${name}`} value={kind} onChange={(e) => onKind(f.path, (e.target as HTMLSelectElement).value as FoundKind)}>
              {AUDIO_KINDS.map((k) => <option value={k}>{FOUND_KIND_LABEL[k]}</option>)}
            </select>
            <Icon name="chev" class="kchev" />
          </label>
        )}
        <span class="fdur mono">{foundDuration(f.duration)}</span>
        <span class="fsize mono">{formatBytes(f.size)}</span>
      </div>
    );
  }
}

/** The row to land on when `gone` leave `order`: the first one still there after the first that left, else the last one before it, else nothing. */
function landingAfter(order: string[], gone: ReadonlySet<string>): string | null {
  const at = order.findIndex((p) => gone.has(p));
  if (at === -1) return null;
  for (let i = at + 1; i < order.length; i++) if (!gone.has(order[i])) return order[i];
  for (let i = at - 1; i >= 0; i--) if (!gone.has(order[i])) return order[i];
  return null;
}

/** Where focus goes once the page has drawn what an action changed: a row's tick box, a Restore button, or the search box. */
type Landing = { row: string } | { restore: string } | "search";

/**
 * Assets › Found (§20.5): the project's other files, grouped by folder, each with why Rushes
 * thought it belonged. Tick what you want and Bring in; Not these hides it for good; a file plays
 * from /media before it is brought in. The list is read from the server when this opens and again
 * whenever the state changes while it is open (the scan, a probe landing, a bring-in anywhere).
 */
export function Found({ state, initialKind = "all", playing, onPlay, onStop, toast, onChanged, onSeen }: FoundProps) {
  const summary = state.found;
  const [list, setList] = useState<Listing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  // A kind the user chose for a row, over the one Rushes guessed.
  const [kinds, setKinds] = useState<Readonly<Record<string, FoundKind>>>({});
  // Why a file didn't come in, shown under it until something about it changes.
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<FoundKind | "all">(initialKind);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [cardOpen, setCardOpen] = useState(true);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [looking, setLooking] = useState(false);
  // Paths just brought in here, which the card has not been told about yet.
  const [justIn, setJustIn] = useState<readonly string[]>([]);

  const root = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  // The same guard as `busy`, but readable the instant a second press arrives, before the page has drawn.
  const acting = useRef(false);
  const landing = useRef<Landing | null>(null);
  // The latest of the parent's callbacks, so the handlers rows hold never change.
  const latest = useRef({ onPlay, onStop });
  latest.current = { onPlay, onStop };
  const play = useCallback((path: string, name: string) => latest.current.onPlay(path, name), []);

  // Number each read so a slow one that lands after a newer one can't overwrite it.
  const seq = useRef(0);
  const applied = useRef(0);
  const load = async () => {
    const id = ++seq.current;
    try {
      const r = await api.get<Partial<Listing>>("/api/found");
      if (id < applied.current) return;
      applied.current = id;
      setList((old) => {
        const files = reuseItems(old?.files ?? [], r.files ?? []);
        const hidden = r.hidden ?? [];
        // Nothing differs: keep the very same state, so nothing draws again.
        if (old && files === old.files && JSON.stringify(old.hidden) === JSON.stringify(hidden)) return old;
        return { files, hidden };
      });
      setLoadError(null);
    } catch (e) {
      if (id >= applied.current) setLoadError((e as Error).message);
    }
  };
  // On open, and whenever the state is read again while this is open: the server's `change` event
  // (a scan landing, lengths arriving, a bring-in from anywhere) reaches here as a new `state`.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const signature = foundSignature(summary);
  useEffect(() => onSeen(signature), [signature]);

  const files = list?.files ?? [];
  const hidden = list?.hidden ?? [];
  // Each file with the kind it would come in as, for filtering and grouping; rows are given the original file and the kind apart.
  const effective = useMemo(() => files.map((f) => ({ ...f, kind: kinds[f.path] ?? f.kind, raw: f })), [files, kinds]);
  const visible = useMemo(() => filterFound(effective, kindFilter, query), [effective, kindFilter, query]);
  const groups = useMemo(() => groupFound(visible), [visible]);
  // The filter bar counts every file, so a search doesn't change what the kinds say.
  const kindCounts = useMemo(() => foundKinds(effective), [effective]);
  // A filter on a kind that has run out (everything of it was brought in) would show nothing for good. While the
  // folder is still being looked through it waits instead: the files of that kind may be on their way.
  useEffect(() => {
    if (kindFilter !== "all" && list && !summary.scanning && !kindCounts.some(([k]) => k === kindFilter)) setKindFilter("all");
  }, [kindCounts, list, summary.scanning]);
  const broughtIn = useMemo(() => broughtInRows(state.project, summary.broughtIn), [state.project, summary.broughtIn]);

  // The rows on screen, in order: the open groups' rows that pass the search and the kind filter.
  const order = useMemo(() => groups.filter((g) => !collapsed.has(g.key)).flatMap((g) => g.files.map((f) => f.path)), [groups, collapsed]);
  const onScreen = useMemo(() => new Set(order), [order]);
  const chosen = files.filter((f) => ticked.has(f.path));
  const n = chosen.length;
  // Not these is about what you can see: ticked rows out of sight (searched away, in a collapsed group) are left alone.
  const chosenVisible = chosen.filter((f) => onScreen.has(f.path));
  const nVisible = chosenVisible.length;

  // A file that is playing but no longer on screen (hidden, searched away, its group or the card folded) stops.
  const cardPaths = useMemo(() => new Set([...broughtIn.map((r) => r.path), ...justIn]), [broughtIn, justIn]);
  useEffect(() => {
    if (!list || !playing.path || playing.paused) return;
    if (onScreen.has(playing.path) || (cardOpen && cardPaths.has(playing.path))) return;
    latest.current.onStop();
  }, [list, playing.path, playing.paused, onScreen, cardOpen, cardPaths]);

  // After something here changed the list, put focus back in it: a row's tick box, a Restore button, or the search box.
  useEffect(() => {
    const want = landing.current;
    if (!want) return;
    let target: HTMLElement | null = null;
    if (want === "search") target = search.current;
    else if ("row" in want) target = root.current?.querySelector<HTMLElement>(`.frow[data-path="${CSS.escape(want.row)}"] input[type="checkbox"]`) ?? null;
    else target = root.current?.querySelector<HTMLElement>(`.fhrow[data-path="${CSS.escape(want.restore)}"] button`) ?? null;
    if (target) {
      target.focus();
      landing.current = null;
    }
  });

  const tick = useCallback((path: string, on: boolean) => {
    setTicked((t) => {
      const next = new Set(t);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
    if (!on) forget(path);
  }, []);
  const forget = (path: string) =>
    setFailures((f) => {
      if (!(path in f)) return f;
      const { [path]: _gone, ...rest } = f;
      return rest;
    });
  const setKind = useCallback((path: string, kind: FoundKind) => {
    setKinds((k) => ({ ...k, [path]: kind }));
    forget(path);
  }, []);
  const toggleGroup = (key: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  /**
   * Takes finished files out of the list at once, and puts focus on the next row. A read that was
   * already on its way was asked before this and may know better than nothing: it is marked out of
   * date, so it can't bring them back.
   */
  const leave = (paths: string[]) => {
    const gone = new Set(paths);
    const next = landingAfter(order, gone);
    landing.current = next === null ? "search" : { row: next };
    applied.current = ++seq.current;
    setList((l) => (l ? { ...l, files: l.files.filter((f) => !gone.has(f.path)) } : l));
    setTicked((t) => new Set([...t].filter((p) => !gone.has(p))));
  };

  const bringIn = async () => {
    if (acting.current || n === 0) return;
    acting.current = true;
    setBusy(true);
    const batch = chosen.slice(0, SEND_MAX);
    try {
      const res = await api.post<BringInResult>("/api/found/bring-in", {
        files: batch.map((f) => {
          const kind = kinds[f.path] ?? f.kind;
          // An "other audio" file has no kind of its own to send: the server says to choose one.
          return kind === "other" ? { path: f.path } : { path: f.path, kind };
        }),
      });
      // A file the server says is already in the project is as good as in: it leaves the list too.
      leave([...res.added.map((a) => a.path), ...res.failed.filter((f) => f.code === "already").map((f) => f.path)]);
      setJustIn((j) => [...j, ...res.added.map((a) => a.path)]);
      setFailures((old) => {
        const next = { ...old };
        for (const f of res.added) delete next[f.path];
        for (const f of res.failed) if (f.code !== "already") next[f.path] = f.reason;
        return next;
      });
      const left = chosen.length - batch.length;
      const message = bringInMessage(res.added.length, res.failed) + (left > 0 ? ` ${left} more ${left === 1 ? "is" : "are"} still ticked.` : "");
      toast(message, message.length > 48 ? 6500 : undefined);
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      acting.current = false;
      setBusy(false);
    }
  };

  const dismiss = async () => {
    if (acting.current || nVisible === 0) return;
    acting.current = true;
    setBusy(true);
    const paths = chosenVisible.map((f) => f.path);
    try {
      await api.post("/api/found/dismiss", { paths });
      leave(paths);
      toast(`Hid ${paths.length} ${paths.length === 1 ? "file" : "files"}`);
      onChanged();
      void load();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      acting.current = false;
      setBusy(false);
    }
  };

  const restore = async (path: string) => {
    const paths = hidden.map((h) => h.path);
    const at = paths.indexOf(path);
    // The next Restore button, else the one before; with none left, the restored file's own tick box once it is back in the list.
    const near = paths[at + 1] ?? paths[at - 1];
    try {
      await api.post("/api/found/restore", { paths: [path] });
      landing.current = near === undefined ? { row: path } : { restore: near };
      if (hidden.length <= 1) setHiddenOpen(false);
      onChanged();
      void load();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const lookAgain = async () => {
    if (looking) return;
    setLooking(true);
    try {
      await api.post("/api/found/scan", {});
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setLooking(false);
    }
  };

  const isPlaying = (path: string) => playing.path === path && !playing.paused;
  const total = foundTotal(summary.counts);
  const scanning = summary.scanning;

  return (
    <section class="amain found" aria-label="Found files" ref={root}>
      <header class="aheader">
        <h2>Found <span class="count">{total}</span></h2>
        <div class="acontrols">
          <label class="search-wrap">
            <Icon name="search" />
            <input
              ref={search}
              class="search"
              type="search"
              aria-label="Search found files"
              placeholder="Search found files"
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            />
          </label>
          {kindCounts.length > 0 && (
            <div class="seg" role="group" aria-label="Kind">
              <button type="button" aria-pressed={kindFilter === "all"} onClick={() => setKindFilter("all")}>All <span class="n">{files.length}</span></button>
              {kindCounts.map(([k, c]) => (
                <button type="button" key={k} aria-pressed={kindFilter === k} onClick={() => setKindFilter(k)}>
                  {FOUND_KIND_LABEL[k]} <span class="n">{c}</span>
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            class="btn ib"
            aria-label="Look again"
            aria-busy={scanning || looking}
            data-tip="Look through the project folder again"
            onClick={() => void lookAgain()}
          >
            <Icon name="refresh" />
          </button>
          <button type="button" class="btn" disabled={nVisible === 0 || busy} data-tip="Hide the ticked files for good. You can restore them from Hidden." onClick={() => void dismiss()}>
            Not these
          </button>
          <button type="button" class="btn primary" disabled={n === 0 || busy} onClick={() => void bringIn()}>
            {n > 0 ? `Bring in ${n}` : "Bring in"}
          </button>
        </div>
      </header>

      {scanning && (
        <p class="fscan" aria-live="polite">
          <span class="fspin" />
          Looking through the folder…
        </p>
      )}
      {loadError && !list && <p class="aempty">{loadError}</p>}

      {broughtIn.length > 0 && (
        <div class="fcard in">
          <button type="button" class="gh" aria-expanded={cardOpen} onClick={() => setCardOpen((o) => !o)}>
            <Icon name="chev" class="chev" />
            <b>Brought in with this cut</b>
            <small>{broughtIn.length}</small>
            <span class="fdone"><Icon name="check" />in the project</span>
          </button>
          {cardOpen && broughtIn.map((r) => <BroughtRow key={r.path} row={r} playing={isPlaying(r.path)} onPlay={play} />)}
        </div>
      )}

      {list === null ? (
        !loadError && <p class="aempty">Loading…</p>
      ) : files.length === 0 ? (
        !scanning && <p class="aempty">Nothing else found in this folder.</p>
      ) : visible.length === 0 ? (
        <p class="aempty">Nothing matches.</p>
      ) : (
        groups.map((g) => {
          const open = !collapsed.has(g.key);
          return (
            <div class="fcard fgroup" key={g.key}>
              <button type="button" class="gh" aria-expanded={open} onClick={() => toggleGroup(g.key)} title={g.folder ?? undefined}>
                <Icon name="chev" class="chev" />
                <b>{g.title}</b>
                <small>{g.files.length}</small>
              </button>
              {open &&
                g.files.map((f) => (
                  <FoundRow
                    key={f.path}
                    item={f.raw}
                    kind={f.kind}
                    ticked={ticked.has(f.path)}
                    playing={isPlaying(f.path)}
                    failure={failures[f.path]}
                    onTick={tick}
                    onKind={setKind}
                    onPlay={play}
                  />
                ))}
            </div>
          );
        })
      )}

      {hiddenOpen && hidden.length > 0 && (
        <div class="fcard fhidden">
          <p class="fhead"><b>Hidden</b><small>{hidden.length}</small></p>
          {hidden.map((h) => {
            const name = baseName(h.path);
            return (
              <div class="fhrow" key={h.path} data-path={h.path}>
                <div class="fnm">
                  <b class="fname" dir="auto" title={h.path}>{name}</b>
                  <small class="freasons">{humanFolder(h.folder)}</small>
                </div>
                <button type="button" class="btn" aria-label={`Restore ${name}`} onClick={() => void restore(h.path)}>
                  <Icon name="undo" />
                  Restore
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div class="ffoot">
        <p class="foot">{FOUND_FOOTER}</p>
        {hidden.length > 0 && (
          <button type="button" class="flink" aria-expanded={hiddenOpen} onClick={() => setHiddenOpen((o) => !o)}>
            Hidden ({hidden.length})
          </button>
        )}
      </div>
    </section>
  );
}
