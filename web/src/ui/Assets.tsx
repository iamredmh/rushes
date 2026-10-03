import { useEffect, useRef, useState } from "preact/hooks";
import { api, mediaUrl } from "../api.js";
import { assetSections, formatBytes, fmt } from "../lib.js";
import type { Asset, Video } from "../types.js";
import { Icon } from "./Icon.js";

export interface AssetsProps {
  assets: Asset[];
  /** To resolve a cut's film name and version note. */
  videos: Video[];
  toast(message: string): void;
}

const canSaveAs = typeof window !== "undefined" && "showSaveFilePicker" in window;

/** "Show in Finder" on a Mac, "Show in Explorer" on Windows, "Open folder" everywhere else. */
function revealLabel(): string {
  const ua = navigator.userAgent;
  if (/Mac/.test(ua)) return "Show in Finder";
  if (/Windows/.test(ua)) return "Show in Explorer";
  return "Open folder";
}

function shortDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Download, Save as…, Show in Finder/Explorer/Open folder and Copy path, shared by every row and tile. */
function Actions({ asset, toast }: { asset: Asset; toast(message: string): void }) {
  const [saving, setSaving] = useState(false);

  const saveAs = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // showSaveFilePicker() throws AbortError on a user cancel; that's silent, not a toast.
      const handle = await (window as unknown as { showSaveFilePicker(opts: { suggestedName: string }): Promise<FileSystemFileHandle> }).showSaveFilePicker({
        suggestedName: asset.name,
      });
      const res = await fetch(mediaUrl(asset.path));
      if (!res.ok) throw new Error(`Couldn't read ${asset.name}`);
      const blob = await res.blob();
      const writable = await (handle as unknown as { createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }).createWritable();
      await writable.write(blob);
      await writable.close();
    } catch (e) {
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
      {canSaveAs && (
        <button class="btn ghost ib" data-tip="Save as…" aria-label="Save as…" disabled={asset.missing || saving} onClick={() => void saveAs()}>
          <Icon name="save" />
        </button>
      )}
      <button class="btn ghost ib" data-tip={revealLabel()} aria-label={revealLabel()} disabled={asset.missing} onClick={() => void reveal()}>
        <Icon name="folder" />
      </button>
      <button class="btn ghost ib" data-tip="Copy path" aria-label="Copy path" disabled={asset.missing} onClick={() => void copyPath()}>
        <Icon name="copy" />
      </button>
    </div>
  );
}

function Missing() {
  return <span class="amiss" data-tip="Missing" aria-label="Missing">●</span>;
}

/** A cut's title and subtitle: "Film · vN" plus its version note, when it has one. */
function cutLabel(asset: Asset, videos: Video[]): { title: string; subtitle: string | null } {
  const video = videos.find((v) => v.id === asset.video);
  const version = video?.versions.find((v) => v.id === asset.version);
  const title = video && asset.version ? `${video.name} · ${asset.version}` : asset.name;
  return { title, subtitle: version?.note || null };
}

function AssetRow({ asset, videos, toast }: { asset: Asset; videos: Video[]; toast(message: string): void }) {
  const cut = asset.kind === "cut" ? cutLabel(asset, videos) : null;
  return (
    <div class={`arow${asset.missing ? " missing" : ""}`} aria-disabled={asset.missing}>
      <div class="ainfo">
        <div class="atitle">
          {cut ? cut.title : asset.name}
          {asset.missing && <Missing />}
        </div>
        {cut?.subtitle && <div class="asub">{cut.subtitle}</div>}
        <div class="afolder mono">{asset.path}</div>
        <div class="ameta mono">{formatBytes(asset.size ?? 0)} · {shortDate(asset.modified)}</div>
      </div>
      <Actions asset={asset} toast={toast} />
    </div>
  );
}

function ShotTile({ asset, videos, toast, onOpen }: { asset: Asset; videos: Video[]; toast(message: string): void; onOpen(): void }) {
  const video = videos.find((v) => v.id === asset.video);
  const when = asset.t !== undefined && asset.frame !== undefined ? `${fmt(asset.t)} · f${asset.frame}` : asset.name;
  const film = video && asset.version ? `${video.name} · ${asset.version}` : null;
  return (
    <div class={`shot-tile${asset.missing ? " missing" : ""}`} aria-disabled={asset.missing}>
      <button type="button" class="shot-thumb" aria-label={`Open ${asset.name} full size`} onClick={onOpen}>
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

/** A simple modal dialog over the full-size image. Esc and a click on the backdrop both close
 *  it; both handlers live on this dialog (not on `window`), so Esc never also reaches the
 *  header's own Escape handling (closing the shortcuts popup, say). */
function Lightbox({ asset, onClose, toast }: { asset: Asset; onClose(): void; toast(message: string): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div
      class="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={asset.name}
      tabIndex={-1}
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div class="lbinner">
        <img src={mediaUrl(asset.path)} alt={asset.name} />
        <div class="lbactions">
          <Actions asset={asset} toast={toast} />
          <button class="btn ghost ib" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
      </div>
    </div>
  );
}

/** The Assets tab (§15.3): every registered file in one place, grouped by section. */
export function Assets({ assets, videos, toast }: AssetsProps) {
  const [lightbox, setLightbox] = useState<Asset | null>(null);
  const sections = assetSections(assets);

  return (
    <div class="col assets">
      {sections.map((section) => (
        <section class="asec" key={section.kind}>
          <h3>{section.title}</h3>
          {section.kind === "screenshot" ? (
            <div class="shots-grid">
              {section.items.map((a) => (
                <ShotTile asset={a} videos={videos} toast={toast} onOpen={() => setLightbox(a)} />
              ))}
            </div>
          ) : (
            <div class="arows">
              {section.items.map((a) => <AssetRow asset={a} videos={videos} toast={toast} />)}
            </div>
          )}
        </section>
      ))}
      {lightbox && <Lightbox asset={lightbox} toast={toast} onClose={() => setLightbox(null)} />}
    </div>
  );
}
