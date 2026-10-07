// The Assets library's row/tile views and their shared bits (§16): actions, the lightbox, grid
// tiles for screenshots/images/cuts/delivery, list rows for everything else including the
// inline-audio and Markdown-preview rows. Split out of Assets.tsx so that file stays focused on
// layout, state and keyboard handling.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, mediaUrl } from "../api.js";
import { extOf, formatBytes, fmt, metaLine, OPEN_SAFE_EXT, proxyMeta, VIDEO_EXT } from "../lib.js";
import type { Asset, Video } from "../types.js";
import { cutSubtitle } from "../versions.js";
import { Icon } from "./Icon.js";

export const canSaveAs = typeof window !== "undefined" && "showSaveFilePicker" in window;

/** "Show in Finder" on a Mac, "Show in Explorer" on Windows, "Open folder" everywhere else. */
export function revealLabel(): string {
  const ua = navigator.userAgent;
  if (/Mac/.test(ua)) return "Show in Finder";
  if (/Windows/.test(ua)) return "Show in Explorer";
  return "Open folder";
}

export function shortDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Download, Save as…, Show in Finder/Explorer/Open folder, Copy path and Open, shared by every
 *  row and tile (§15.3, extended by §16.3's Open). */
export function Actions({ asset, toast }: { asset: Asset; toast(message: string): void }) {
  const [saving, setSaving] = useState(false);
  // Extension read from path, not name (I2): a registered file's display name carries no
  // extension at all once it's shown under `label` instead.
  const canOpen = !asset.missing && OPEN_SAFE_EXT.has(extOf(asset.path));

  const saveAs = async () => {
    if (saving) return;
    setSaving(true);
    // Set once the writable's open, so a failure after that point can abort it rather than
    // leaving a half-written file with its handle never released.
    let writable: FileSystemWritableFileStream | undefined;
    try {
      // showSaveFilePicker() throws AbortError on a user cancel; that's silent, not a toast.
      const handle = await (window as unknown as { showSaveFilePicker(opts: { suggestedName: string }): Promise<FileSystemFileHandle> }).showSaveFilePicker({
        suggestedName: asset.name,
      });
      const res = await fetch(mediaUrl(asset.path));
      if (!res.ok || !res.body) throw new Error(`Couldn't read ${asset.name}`);
      // Streamed straight from the response into the file, rather than buffered whole into
      // memory first: a multi-gigabyte render would otherwise hold its entire contents as a
      // blob before a single byte reaches disk.
      writable = await handle.createWritable();
      await res.body.pipeTo(writable);
    } catch (e) {
      if (writable) await writable.abort().catch(() => undefined);
      if ((e as Error).name !== "AbortError") toast((e as Error).message || `Couldn't save ${asset.name}`);
    } finally {
      setSaving(false);
    }
  };

  const reveal = async () => {
    try {
      await api.post("/api/reveal", { path: asset.path });
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(asset.abs);
      toast("Path copied");
    } catch {
      toast("Couldn't reach the clipboard");
    }
  };

  const openFile = async () => {
    try {
      await api.post("/api/open", { path: asset.path });
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <div class="aact">
      {/* href always present, even when missing, so the element keeps the "link" role an <a>
          without one loses; aria-disabled plus the click guard make it inert instead. */}
      <a
        class="btn ghost ib"
        data-tip="Download"
        aria-label="Download"
        aria-disabled={asset.missing}
        tabIndex={asset.missing ? -1 : undefined}
        href={`${mediaUrl(asset.path)}&download=1`}
        download={asset.name}
        onClick={(e) => { if (asset.missing) e.preventDefault(); }}
      >
        <Icon name="download" />
      </a>
      {/* aria-disabled, not the native attribute, on all three: a native `disabled` button
          never matches :hover in any browser, so it could never show a tooltip either way
          -- the click guard below does the blocking instead. */}
      {canSaveAs && (
        <button
          class="btn ghost ib"
          data-tip="Save as…"
          aria-label="Save as…"
          aria-disabled={asset.missing || saving}
          tabIndex={asset.missing ? -1 : undefined}
          onClick={() => { if (!asset.missing) void saveAs(); }}
        >
          <Icon name="save" />
        </button>
      )}
      {canOpen && (
        <button
          class="btn ghost ib"
          data-tip="Open"
          aria-label="Open"
          onClick={() => void openFile()}
        >
          <Icon name="open" />
        </button>
      )}
      <button
        class="btn ghost ib"
        data-tip={revealLabel()}
        aria-label={revealLabel()}
        aria-disabled={asset.missing}
        tabIndex={asset.missing ? -1 : undefined}
        onClick={() => { if (!asset.missing) void reveal(); }}
      >
        <Icon name="folder" />
      </button>
      <button
        class="btn ghost ib"
        data-tip="Copy path"
        aria-label="Copy path"
        aria-disabled={asset.missing}
        tabIndex={asset.missing ? -1 : undefined}
        onClick={() => { if (!asset.missing) void copyPath(); }}
      >
        <Icon name="copy" />
      </button>
    </div>
  );
}

export function Missing({ tip = "Missing" }: { tip?: string }) {
  return <span class="amiss" data-tip={tip} aria-label={tip}>●</span>;
}

/** A cut or delivery's title and subtitle: "Film · vN" plus its short label (§22.4), when it has one
 *  and a version to find one on. */
export function cutLabel(asset: Asset, videos: Video[]): { title: string; subtitle: string | null } {
  const video = videos.find((v) => v.id === asset.video);
  const version = video?.versions.find((v) => v.id === asset.version);
  // label ?? name (I2): a registered delivery with no video match still shows its own display
  // name rather than its bare file name.
  const title = video && asset.version ? `${video.name} · ${asset.version}` : asset.label ?? asset.name;
  return { title, subtitle: cutSubtitle(version) };
}

/** A plain list row: name, folder path, size/date, actions. Used for anything without its own
 *  richer row (voiceover/music/sfx get AudioRow, previewable folders get PreviewRow). */
export function AssetRow({ asset, videos, toast }: { asset: Asset; videos: Video[]; toast(message: string): void }) {
  const cut = asset.kind === "cut" || asset.kind === "delivery" ? cutLabel(asset, videos) : null;
  // aria-disabled belongs on the controls inside (Actions), not here: a <div> isn't
  // interactive, so AT has nothing to disable at this level.
  return (
    <div class={`arow${asset.missing ? " missing" : ""}`}>
      <div class="ainfo">
        <div class="atitle">
          {cut ? cut.title : asset.label ?? asset.name}
          {asset.missing && <Missing />}
        </div>
        {cut?.subtitle && <div class="asub">{cut.subtitle}</div>}
        <div class="afolder mono">{asset.path}</div>
        {/* A missing file has no size or date to show -- just the mark above, no dangling "0 B · ". */}
        {!asset.missing && <div class="ameta">{formatBytes(asset.size ?? 0)} · {shortDate(asset.modified)}</div>}
      </div>
      <Actions asset={asset} toast={toast} />
    </div>
  );
}

/** A Proxies row (§19.5): the file's name, "size · W×H · from vN", the usual actions, and Delete
 *  proxy, which asks once more before removing the file and its record. The original is never touched. */
export function ProxyRow({ asset, toast, onChanged }: { asset: Asset; toast(message: string): void; onChanged(): void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirming) confirmRef.current?.focus(); }, [confirming]);
  const remove = async () => {
    if (busy || !asset.video || !asset.version) return;
    setBusy(true);
    try {
      await api.del(`/api/videos/${encodeURIComponent(asset.video)}/versions/${encodeURIComponent(asset.version)}/proxy`);
      onChanged();
    } catch (e) {
      toast((e as Error).message);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class={`arow${asset.missing ? " missing" : ""}`}>
      <div class="ainfo">
        <div class="atitle">{asset.name}{asset.missing && <Missing />}</div>
        <div class="afolder mono">{asset.path}</div>
        {!asset.missing && <div class="ameta">{proxyMeta(asset)}</div>}
      </div>
      <Actions asset={asset} toast={toast} />
      {confirming ? (
        <div class="aconfirm" role="group" aria-label="Delete this proxy?" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setConfirming(false); } }}>
          <button ref={confirmRef} type="button" class="btn danger" aria-disabled={busy} onClick={() => void remove()}>Delete</button>
          <button type="button" class="btn ghost" onClick={() => setConfirming(false)}>Keep</button>
        </div>
      ) : (
        <button type="button" class="btn ghost ib" data-tip="Delete proxy (the original is kept)" aria-label="Delete proxy" onClick={() => setConfirming(true)}>
          <Icon name="trash" />
        </button>
      )}
    </div>
  );
}

/** A Voiceover/Music/Sound effects row: the same info as AssetRow, plus an inline Play/Pause
 *  button driven by the single shared <audio> element Assets.tsx owns (§16.1). */
export function AudioRow({
  asset, playing, paused, onToggle, videos, toast,
}: {
  asset: Asset; playing: boolean; paused: boolean; onToggle(asset: Asset): void; videos: Video[]; toast(message: string): void;
}) {
  const isPlaying = playing && !paused;
  // The take or variant's own name (e.g. "Deep house"), not the file name -- "name" stays the
  // file's basename for Download/Save-as, so the display title reads asset.label first.
  const title = asset.label ?? asset.name;
  const secondary = metaLine(asset.laneName, asset.meta);
  return (
    <div class={`arow${asset.missing ? " missing" : ""}`}>
      <button
        type="button"
        class="btn ghost ib"
        data-tip={isPlaying ? "Pause" : "Play"}
        // A stable name, not one that swaps with the state (M4): aria-pressed is what says
        // whether it's playing right now, same as any other toggle button. Swapping the label
        // too would mean a screen reader announces "Pause" for a control that, read on its own,
        // never actually says what it's a pause button *for*.
        aria-label={`Play ${title}`}
        aria-pressed={isPlaying}
        aria-disabled={asset.missing}
        tabIndex={asset.missing ? -1 : undefined}
        onClick={() => { if (!asset.missing) onToggle(asset); }}
      >
        <Icon name={isPlaying ? "pause" : "play"} />
      </button>
      <div class="ainfo">
        <div class="atitle">{title}{asset.missing && <Missing />}</div>
        {secondary && <div class="atrackmeta">{secondary}</div>}
        <div class="afolder mono">{asset.path}</div>
        {!asset.missing && <div class="ameta">{formatBytes(asset.size ?? 0)} · {shortDate(asset.modified)}</div>}
      </div>
      <Actions asset={asset} toast={toast} />
    </div>
  );
}

/** A row in a previewable folder (Scripts & docs, Captions, Exports, Edit files). The title
 *  itself is the select control (I3): the row is a plain, non-interactive wrapper, so Download,
 *  Save as…, Open and Copy path -- all plain buttons/links inside it -- keep their own normal
 *  keyboard and screen-reader behaviour instead of being nested inside another `role="button"`. */
export function PreviewRow({
  asset, selected, onSelect, videos, toast,
}: {
  asset: Asset; selected: boolean; onSelect(): void; videos: Video[]; toast(message: string): void;
}) {
  return (
    <div class={`arow previewable${asset.missing ? " missing" : ""}${selected ? " selected" : ""}`}>
      <div class="ainfo">
        <button type="button" class="aselect atitle" aria-pressed={selected} onClick={onSelect}>
          {asset.label ?? asset.name}{asset.missing && <Missing />}
        </button>
        {asset.note && <div class="asub">{asset.note}</div>}
        <div class="afolder mono">{asset.path}</div>
        {!asset.missing && <div class="ameta">{formatBytes(asset.size ?? 0)} · {shortDate(asset.modified)}</div>}
      </div>
      <Actions asset={asset} toast={toast} />
    </div>
  );
}

/** A Screenshots/Images grid tile. */
export function ShotTile({ asset, videos, toast, onOpen }: { asset: Asset; videos: Video[]; toast(message: string): void; onOpen(from: HTMLElement): void }) {
  const video = videos.find((v) => v.id === asset.video);
  const when = asset.t !== undefined && asset.frame !== undefined ? `${fmt(asset.t)} · f${asset.frame}` : asset.label ?? asset.name;
  const film = video && asset.version ? `${video.name} · ${asset.version}` : null;
  // Same as AssetRow: the controls carry aria-disabled, not this wrapper.
  return (
    <div class={`shot-tile${asset.missing ? " missing" : ""}`}>
      <button type="button" class="shot-thumb" aria-label={`Open ${asset.name} full size`} onClick={(e) => onOpen(e.currentTarget as HTMLElement)}>
        <img src={mediaUrl(asset.path)} alt={asset.name} loading="lazy" />
      </button>
      <div class="shot-meta">
        <div class="mono">{when}{asset.missing && <Missing />}</div>
        {film && <div class="asub">{film}</div>}
      </div>
      <Actions asset={asset} toast={toast} />
    </div>
  );
}

/** A poster frame's `<video>`, lazy (I6): the element mounts straight away -- so a folder's tile
 *  count never depends on scroll position -- but `src` is set only once the tile comes within
 *  200px of the viewport, via IntersectionObserver. Without this, a Cuts or Delivery folder with
 *  hundreds of items would ask the browser to open and buffer metadata for every one of them at
 *  once, which §16.1 rules out and which can starve the browser's connection pool. */
function PosterVideo({ asset }: { asset: Asset }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true); // no observer available (e.g. an older test environment): just show it
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <video ref={ref} muted preload="metadata" src={inView ? `${mediaUrl(asset.path)}#t=0.5` : undefined} aria-label={`${asset.name} poster frame`} />
  );
}

/** A Cuts/Delivery grid tile: a muted, metadata-only poster frame at the 0.5s mark (§16.1),
 *  never autoplaying -- or, for a non-video file such as a PDF delivery, a plain file tile
 *  showing its extension instead of a black box holding a <video> that can't play it (I5). Only
 *  a video extension ever gets a poster (I6). */
export function PosterTile({ asset, videos, toast }: { asset: Asset; videos: Video[]; toast(message: string): void }) {
  const { title, subtitle } = cutLabel(asset, videos);
  const isVideo = VIDEO_EXT.has(extOf(asset.path));
  return (
    <div class={`shot-tile${asset.missing ? " missing" : ""}`}>
      <div class="shot-thumb poster">
        {!asset.missing && (isVideo ? <PosterVideo asset={asset} /> : (
          <div class="file-tile"><span class="file-ext mono">{extOf(asset.path) || "file"}</span></div>
        ))}
      </div>
      <div class="shot-meta">
        <div class="atitle">{title}{asset.missing && <Missing />}</div>
        {subtitle && <div class="asub">{subtitle}</div>}
        <div class="afolder mono">{asset.path}</div>
      </div>
      <Actions asset={asset} toast={toast} />
    </div>
  );
}

/** Every element inside `container` that's actually in the Tab order right now -- links and
 *  buttons, minus anything disabled or pulled out of the order with `tabIndex={-1}` (a missing
 *  asset's actions, say). */
function tabbable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("a[href], button, [tabindex]")).filter((el) => {
    if ((el as HTMLButtonElement).disabled) return false;
    const ti = el.getAttribute("tabindex");
    return ti === null || Number(ti) >= 0;
  });
}

/** A simple modal dialog over the full-size image. Esc and a click on the backdrop both close
 *  it; both handlers live on this dialog (not on `window`), so Esc never also reaches the
 *  header's own Escape handling (closing the shortcuts popup, say). Opening moves focus to the
 *  close button and traps Tab inside; closing is the caller's job to send it back to whatever
 *  opened this. */
export function Lightbox({ asset, onClose, toast }: { asset: Asset; onClose(): void; toast(message: string): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, []);
  return (
    <div
      class="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={asset.name}
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
          return;
        }
        if (e.key !== "Tab" || !ref.current) return;
        const chain = tabbable(ref.current);
        if (chain.length === 0) return;
        const first = chain[0];
        const last = chain[chain.length - 1];
        // Only the two ends need handling: Tab and Shift+Tab between everything in the middle
        // already behaves the way the browser's own order would, untouched.
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div class="lbinner">
        <img src={mediaUrl(asset.path)} alt={asset.name} />
        <div class="lbactions">
          <Actions asset={asset} toast={toast} />
          <button ref={closeRef} class="btn ghost ib" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
      </div>
    </div>
  );
}
