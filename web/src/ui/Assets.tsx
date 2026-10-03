import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, mediaUrl } from "../api.js";
import {
  FOLDERS, type FolderDef, type FolderId, folderItems, groupByFilm, isPreviewable, PREVIEW_FOLDER_IDS,
} from "../lib.js";
import { safeMarkdownHtml } from "../markdown.js";
import type { Asset, Video } from "../types.js";
import {
  AssetRow, AudioRow, Lightbox, PosterTile, PreviewRow, ShotTile,
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
  useEffect(() => {
    if (selectedId && visibleFolders.some((f) => f.id === selectedId)) return;
    setSelectedId(visibleFolders[0]?.id ?? null);
  }, [visibleFolders, selectedId]);
  const folder: FolderDef | null = visibleFolders.find((f) => f.id === selectedId) ?? null;

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("newest");
  const [film, setFilm] = useState<string | null>(null);
  const [view, setView] = useState<View>("grid");

  // A new folder gets a clean search/film/sort and its own remembered (or default) view --
  // a search typed into Scripts & docs must never silently narrow Music too.
  useEffect(() => {
    if (!folder) return;
    setQuery("");
    setFilm(null);
    setSort("newest");
    setView(loadView(folder.id) ?? folder.view);
  }, [folder?.id]);

  const items = useMemo(
    () => (folder ? folderItems(assets, folder, { query, sort, film, videos }) : []),
    [assets, folder, query, sort, film, videos],
  );

  const changeView = (v: View) => {
    if (!folder) return;
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
  const stopAudio = () => {
    audioRef.current?.pause();
    setAudioState({ path: null, paused: true });
  };
  const toggleAudio = (asset: Asset) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audioState.path === asset.path && !audioState.paused) {
      audio.pause();
      setAudioState({ path: asset.path, paused: true });
      return;
    }
    if (audioState.path !== asset.path) audio.src = mediaUrl(asset.path);
    void audio.play().catch(() => undefined);
    setAudioState({ path: asset.path, paused: false });
  };
  // Stops on folder change and film-filter change; unmounting (a tab switch, since Assets is
  // only ever rendered while stage === "assets") drops the <audio> element itself, which stops
  // playback the same way.
  useEffect(() => stopAudio, [selectedId, film]);
  useEffect(() => stopAudio, []);

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
  const renderPreview = () => {
    if (!previewPath || !preview) return <p class="aempty">Select a file to preview it here.</p>;
    if (preview.loading) return <p class="aempty">Loading…</p>;
    if (preview.error) return <p class="aempty">{preview.error}</p>;
    return (
      <>
        {previewExt === "md" ? (
          <div class="markdown" dangerouslySetInnerHTML={{ __html: safeMarkdownHtml(preview.text) }} />
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
            onClick={() => setSelectedId(f.id)}
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
              <div class="seg" role="group" aria-label="View">
                <button type="button" aria-pressed={view === "grid"} aria-label="Grid view" data-tip="Grid" onClick={() => changeView("grid")}>
                  <Icon name="grid" />
                </button>
                <button type="button" aria-pressed={view === "list"} aria-label="List view" data-tip="List" onClick={() => changeView("list")}>
                  <Icon name="list" />
                </button>
              </div>
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
      <audio ref={audioRef} onEnded={() => setAudioState((s) => ({ ...s, paused: true }))} />
      {lightbox && <Lightbox asset={lightbox} toast={toast} onClose={closeLightbox} />}
    </div>
  );
}
