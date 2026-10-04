import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, mediaUrl } from "../api.js";
import { claim, release } from "../audio/bus.js";
import {
  FOLDERS, type FolderDef, type FolderId, folderItems, groupByFilm, isPreviewable, PREVIEW_FOLDER_IDS,
} from "../lib.js";
import { safeMarkdownHtml } from "../markdown.js";
import type { Asset, Video } from "../types.js";
import {
  AssetRow, AudioRow, Lightbox, PosterTile, PreviewRow, ProxyRow, ShotTile,
} from "./AssetViews.js";
import { Icon } from "./Icon.js";

export interface AssetsProps {
  assets: Asset[];
  /** To resolve a cut's film name and version note. */
  videos: Video[];
  toast(message: string): void;
  /** Called after an action (Export notes) writes a file the server's own change events won't
   *  otherwise announce quickly -- the same pattern Picture.tsx uses after a grab. */
  onChanged(): void;
}

type Sort = "newest" | "oldest" | "name";
type View = "grid" | "list";

const AUDIO_FOLDERS = new Set<FolderId>(["voiceover", "music", "sfx"]);
const GRID_POSTER_FOLDERS = new Set<FolderId>(["cut", "delivery"]);
const MAX_PREVIEW_BYTES = 1024 * 1024;

function viewKey(id: FolderId): string {
  return `rushes.assets.view.${id}`;
}

/** The remembered grid/list choice for a folder (§16.1), wrapped in try/catch: a browser with
 *  localStorage disabled, or a private window that throws on read, must never break the tab. */
function loadView(id: FolderId): View | null {
  try {
    const v = localStorage.getItem(viewKey(id));
    return v === "grid" || v === "list" ? v : null;
  } catch {
    return null;
  }
}

function saveView(id: FolderId, view: View): void {
  try {
    localStorage.setItem(viewKey(id), view);
  } catch {
    // Ignored: the choice just won't be remembered this session.
  }
}

/** The view a folder should render in: always "list" for a folder with no grid toggle (I5),
 *  whatever an older, stale localStorage value might still say -- otherwise the remembered
 *  choice, or the folder's own default. */
function viewFor(folder: FolderDef | null): View {
  if (!folder) return "grid";
  if (!folder.gridToggle) return "list";
  return loadView(folder.id) ?? folder.view;
}

/** Fetches a previewable file's text via mediaUrl(), capped at 1 MB: reads the response stream
 *  and stops (cancelling it) once the cap is reached, rather than buffering the whole file only
 *  to throw most of it away. */
async function fetchPreview(path: string): Promise<{ text: string; truncated: boolean }> {
  const res = await fetch(mediaUrl(path));
  if (!res.ok) throw new Error(`Couldn't load ${path}`);
  if (!res.body) return { text: await res.text(), truncated: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_PREVIEW_BYTES) {
      const allowed = value.byteLength - (bytes - MAX_PREVIEW_BYTES);
      if (allowed > 0) text += decoder.decode(value.subarray(0, allowed), { stream: true });
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  // Flushes the decoder: with { stream: true } throughout, a multi-byte character split across
  // the last two chunks (or across the 1 MB cut itself) stays buffered inside the decoder and
  // would otherwise just vanish from the end of the text instead of decoding correctly.
  text += decoder.decode();
  return { text, truncated };
}

/** The Assets library (§16): a folder sidebar, search/sort/film/grid-list controls, and a
 *  folder-specific view -- thumbnail grids, poster-frame grids, inline-audio lists or
 *  list+preview splits -- over every registered or auto-discovered project file. */
export function Assets({ assets, videos, toast, onChanged }: AssetsProps) {
  const visibleFolders = useMemo(
    () => FOLDERS.filter((f) => f.id === "export" || assets.some((a) => f.kinds.includes(a.kind))),
    [assets],
  );
  // Lazily seeded from the very first render's folders, so the first paint already shows the
  // right folder instead of a one-frame flash of "nothing selected" while an effect catches up.
  const [selectedId, setSelectedId] = useState<FolderId | null>(() => visibleFolders[0]?.id ?? null);
  // Whether selectedId was ever set by an explicit sidebar pick (click or arrow key), as opposed
  // to the default-following effect below. Until it has, the default must keep following
  // visibleFolders[0] even as the list grows -- e.g. a screenshot grabbed just before switching
  // to Assets often isn't in `assets` yet on this component's first render (Picture's onChanged()
  // after a grab is fire-and-forget, racing the keypress that opens this tab), so Cuts can be the
  // only folder visible for a beat before Screenshots (which sorts first) joins it. Without this,
  // the effect below would see its previously-picked "cut" is still present and never promote
  // Screenshots to the front, leaving the folder stuck on the wrong one for the rest of the visit.
  const pickedByHand = useRef(false);
  useEffect(() => {
    if (pickedByHand.current && selectedId && visibleFolders.some((f) => f.id === selectedId)) return;
    setSelectedId(visibleFolders[0]?.id ?? null);
  }, [visibleFolders, selectedId]);
  const selectFolder = (id: FolderId) => {
    pickedByHand.current = true;
    setSelectedId(id);
  };
  const folder: FolderDef | null = visibleFolders.find((f) => f.id === selectedId) ?? null;

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("newest");
  const [film, setFilm] = useState<string | null>(null);
  // Lazily seeded the same way selectedId is above, so the first paint already shows the right
  // view instead of a flash of the "grid" fallback while an effect catches up.
  const [view, setView] = useState<View>(() => viewFor(folder));

  // A new folder gets a clean search/film/sort and its own remembered (or default) view -- a
  // search typed into Scripts & docs must never silently narrow Music too. This runs during
  // render (the "adjust state while rendering" pattern: react.dev/learn/you-might-not-need-an-effect),
  // not in a useEffect: an effect's flush is deferred past the next paint, and a keystroke landing
  // in that gap -- easy right after opening Assets, since a screenshot grabbed a beat earlier can
  // still be arriving and only then promoting Screenshots to front (see pickedByHand above) --
  // would have its setQuery("hero") silently overwritten by this reset's setQuery(""), because an
  // effect-based reset has no way to know query also changed in the meantime. Doing the reset
  // synchronously here means both updates land in the same commit, in call order, so nothing from
  // outside this render can land in between.
  const lastFolderId = useRef<FolderId | null>(folder?.id ?? null);
  if (folder && folder.id !== lastFolderId.current) {
    lastFolderId.current = folder.id;
    setQuery("");
    setFilm(null);
    setSort("newest");
    setView(viewFor(folder));
  }

  const items = useMemo(
    () => (folder ? folderItems(assets, folder, { query, sort, film, videos }) : []),
    [assets, folder, query, sort, film, videos],
  );

  const changeView = (v: View) => {
    if (!folder || !folder.gridToggle) return;
    setView(v);
    saveView(folder.id, v);
  };

  // ---- the lightbox, for Screenshots/Images tiles ----
  const [lightbox, setLightbox] = useState<Asset | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const openLightbox = (a: Asset) => {
    opener.current = document.activeElement as HTMLElement | null;
    setLightbox(a);
  };
  const closeLightbox = () => {
    setLightbox(null);
    opener.current?.focus();
  };

  // ---- inline audio: one shared <audio>, owned here (§16.1) ----
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioState, setAudioState] = useState<{ path: string | null; paused: boolean }>({ path: null, paused: true });
  // This player's identity on the one-player bus: it and an audio tab never play together.
  const busOwner = useRef({});
  const stopAudio = () => {
    audioRef.current?.pause();
    release(busOwner.current);
    setAudioState({ path: null, paused: true });
  };
  const toggleAudio = (asset: Asset) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audioState.path === asset.path && !audioState.paused) {
      audio.pause();
      release(busOwner.current);
      setAudioState({ path: asset.path, paused: true });
      return;
    }
    if (audioState.path !== asset.path) audio.src = mediaUrl(asset.path);
    // Another player (an audio tab's engine) stops; if one claims later, this one pauses in place.
    claim(busOwner.current, () => {
      audioRef.current?.pause();
      setAudioState((s) => ({ ...s, paused: true }));
    });
    setAudioState({ path: asset.path, paused: false });
    audio.play().catch((err: unknown) => {
      // An AbortError means the play was interrupted by a pause (an audio tab claiming the bus,
      // or the user moving on), not that it failed: the interrupter has already set the state.
      if (err instanceof Error && err.name === "AbortError") return;
      // M4: a rejected play() (the browser blocking it, a bad file) must not leave the row
      // claiming to be playing when it isn't.
      release(busOwner.current);
      setAudioState({ path: asset.path, paused: true });
      toast(`Couldn't play ${asset.label ?? asset.name}`);
    });
  };
  // Stops on folder change and film-filter change; unmounting (a tab switch, since Assets is
  // only ever rendered while stage === "assets") drops the <audio> element itself, which stops
  // playback the same way.
  useEffect(() => stopAudio, [selectedId, film]);
  useEffect(() => stopAudio, []);

  // ---- I7: auto-discovered files (a *.md dropped in the project root, say) only show up on the
  // next SSE "change" event, and the watcher only watches .rushes/ -- so nothing ever tells the
  // dashboard a plain file arrived. Ask for a refresh wherever that's likely to matter: the tab
  // mounting, the folder selection changing (this fires on mount too, so it covers both at once),
  // and the tab regaining visibility after being hidden (e.g. the window was backgrounded while
  // an agent dropped a file). onChanged is a fresh function each render, same as elsewhere in
  // this file -- it's not meant to be depended on, only called.
  useEffect(() => {
    onChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") onChanged();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- the Markdown/plain-text preview, for Scripts & docs, Captions, Exports and Edit files ----
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ loading: boolean; text: string; truncated: boolean; error?: string } | null>(null);
  const isPreviewFolder = !!folder && PREVIEW_FOLDER_IDS.has(folder.id);
  useEffect(() => {
    if (!isPreviewFolder) {
      setPreviewPath(null);
      return;
    }
    if (previewPath && items.some((a) => a.path === previewPath && isPreviewable(a))) return;
    setPreviewPath(items.find(isPreviewable)?.path ?? null);
    // previewPath is read, not written, as a dependency here on purpose: this only needs to
    // re-run when the folder or its items change, not every time the selection itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPreviewFolder, items]);
  useEffect(() => {
    if (!previewPath) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreview({ loading: true, text: "", truncated: false });
    fetchPreview(previewPath)
      .then((r) => { if (!cancelled) setPreview({ loading: false, text: r.text, truncated: r.truncated }); })
      .catch((e) => { if (!cancelled) setPreview({ loading: false, text: "", truncated: false, error: (e as Error).message }); });
    return () => { cancelled = true; };
  }, [previewPath]);

  // ---- sidebar keyboard: ↑/↓ move between folders (both focus and selection) ----
  const onSidebarKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const nav = e.currentTarget as HTMLElement;
    const buttons = Array.from(nav.querySelectorAll<HTMLButtonElement>(".afolder-btn"));
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i === -1) return;
    e.preventDefault();
    const next = buttons[i + (e.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    next.focus();
    next.click();
  };

  const revealProject = async () => {
    try {
      await api.post("/api/reveal", { project: true });
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const exportNotes = async () => {
    try {
      const { path } = await api.post<{ path: string }>("/api/exports/notes");
      toast(`Saved to ${path}`);
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const countFor = (f: FolderDef) => assets.filter((a) => f.kinds.includes(a.kind)).length;

  const renderGrid = () => {
    if (!folder) return null;
    if (folder.id === "screenshot" && sort !== "name") {
      return groupByFilm(items, videos).map((g, gi) => (
        <section class="afilm-group" key={g.heading ?? `_${gi}`}>
          {g.heading && <h3 class="afilm-heading">{g.heading}</h3>}
          <div class="shots-grid">
            {g.items.map((a) => <ShotTile key={a.path} asset={a} videos={videos} toast={toast} onOpen={() => openLightbox(a)} />)}
          </div>
        </section>
      ));
    }
    if (GRID_POSTER_FOLDERS.has(folder.id)) {
      return (
        <div class="shots-grid">
          {items.map((a) => <PosterTile key={a.path} asset={a} videos={videos} toast={toast} />)}
        </div>
      );
    }
    return (
      <div class="shots-grid">
        {items.map((a) => <ShotTile key={a.path} asset={a} videos={videos} toast={toast} onOpen={() => openLightbox(a)} />)}
      </div>
    );
  };

  const renderList = () => {
    if (!folder) return null;
    if (AUDIO_FOLDERS.has(folder.id)) {
      return (
        <div class="arows">
          {items.map((a) => (
            <AudioRow
              key={a.path}
              asset={a}
              playing={audioState.path === a.path}
              paused={audioState.paused}
              onToggle={toggleAudio}
              videos={videos}
              toast={toast}
            />
          ))}
        </div>
      );
    }
    if (folder.id === "proxy") {
      return (
        <div class="arows">
          {items.map((a) => <ProxyRow key={a.path} asset={a} toast={toast} onChanged={onChanged} />)}
        </div>
      );
    }
    if (isPreviewFolder) {
      return (
        <div class="arows">
          {items.map((a) => (
            <PreviewRow key={a.path} asset={a} selected={previewPath === a.path} onSelect={() => setPreviewPath(a.path)} videos={videos} toast={toast} />
          ))}
        </div>
      );
    }
    return (
      <div class="arows">
        {items.map((a) => <AssetRow key={a.path} asset={a} videos={videos} toast={toast} />)}
      </div>
    );
  };

  const previewExt = previewPath ? (previewPath.split(".").pop() ?? "").toLowerCase() : "";
  // Memoised on the text itself (I4): re-running the renderer on every keystroke in the search
  // box, say, would otherwise re-parse a large file for no reason, since nothing about its own
  // rendered HTML depends on anything else that re-renders Assets.
  const previewHtml = useMemo(() => safeMarkdownHtml(preview?.text ?? ""), [preview?.text]);
  const renderPreview = () => {
    if (!previewPath || !preview) return <p class="aempty">Select a file to preview it here.</p>;
    if (preview.loading) return <p class="aempty">Loading…</p>;
    if (preview.error) return <p class="aempty">{preview.error}</p>;
    return (
      <>
        {previewExt === "md" ? (
          <div class="markdown" dangerouslySetInnerHTML={{ __html: previewHtml }} />
        ) : (
          <pre class="plain">{preview.text}</pre>
        )}
        {preview.truncated && <p class="atrunc">Showing the first 1 MB</p>}
      </>
    );
  };

  return (
    <div class="assets-lib">
      <nav class="asidebar" aria-label="Folders" onKeyDown={onSidebarKeyDown}>
        {visibleFolders.map((f) => (
          <button
            type="button"
            class="afolder-btn"
            key={f.id}
            aria-current={f.id === selectedId ? "true" : undefined}
            onClick={() => selectFolder(f.id)}
          >
            <span>{f.title}</span>
            <span class="count">{countFor(f)}</span>
          </button>
        ))}
        <button type="button" class="afolder-root" onClick={() => void revealProject()}>
          <Icon name="folder" />
          Project folder
        </button>
      </nav>

      {folder ? (
        <div class="amain">
          <header class="aheader">
            <h2>{folder.title} <span class="count">{items.length}</span></h2>
            <div class="acontrols">
              <label class="search-wrap">
                <Icon name="search" />
                <input
                  class="search"
                  type="search"
                  aria-label="Search"
                  placeholder="Search"
                  value={query}
                  onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
                />
              </label>
              {folder.filmFilter && (
                <select class="sel" aria-label="Film" value={film ?? ""} onChange={(e) => setFilm((e.target as HTMLSelectElement).value || null)}>
                  <option value="">All films</option>
                  {videos.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              )}
              <select class="sel" aria-label="Sort" value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as Sort)}>
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="name">Name</option>
              </select>
              {folder.gridToggle && (
                <div class="seg" role="group" aria-label="View">
                  <button type="button" aria-pressed={view === "grid"} aria-label="Grid view" data-tip="Grid" onClick={() => changeView("grid")}>
                    <Icon name="grid" />
                  </button>
                  <button type="button" aria-pressed={view === "list"} aria-label="List view" data-tip="List" onClick={() => changeView("list")}>
                    <Icon name="list" />
                  </button>
                </div>
              )}
              {folder.id === "export" && (
                <button type="button" class="btn" onClick={() => void exportNotes()}>
                  <Icon name="script" />
                  Export notes
                </button>
              )}
            </div>
          </header>
          <div class={`abody${isPreviewFolder ? " split" : ""}`}>
            <div class="alist">
              {items.length === 0 ? <p class="aempty">Nothing here yet.</p> : view === "grid" ? renderGrid() : renderList()}
            </div>
            {isPreviewFolder && <aside class="apreview">{renderPreview()}</aside>}
          </div>
        </div>
      ) : (
        <div class="empty">
          <Icon name="grid" />
          <h2>Nothing to review in Assets yet</h2>
        </div>
      )}

      {/* The one shared player every Play/Pause button in Voiceover/Music/Sound effects drives. */}
      <audio
        ref={audioRef}
        onEnded={() => {
          release(busOwner.current);
          setAudioState((s) => ({ ...s, paused: true }));
        }}
      />
      {lightbox && <Lightbox asset={lightbox} toast={toast} onClose={closeLightbox} />}
    </div>
  );
}
