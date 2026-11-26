// §36.3: the four proxy qualities. Shared by the server (the encode) and the desk (the Proxies tab, the toolbar button).
import { DEFAULT_PROXY_PRESET, DEFAULT_PROXY_PRESETS, LEGACY_PROXY, PROXY_PRESETS, ladderOrder, type Proxies, type Proxy, type ProxyPreset, type ProxySlot } from "./schema.js";

export { DEFAULT_PROXY_PRESET, DEFAULT_PROXY_PRESETS, LEGACY_PROXY, PROXY_PRESETS, ladderOrder, type ProxyPreset, type ProxySlot };

export interface PresetSpec {
  id: ProxyPreset;
  /** "1080p Low" */
  label: string;
  /** The proxy's short edge in pixels. A smaller source keeps its own size (never upscaled). */
  shortEdge: number;
  /** Average video bitrate, kbit/s (`-b:v`). */
  avgKbps: number;
  /** Peak video bitrate, kbit/s (`-maxrate`): the rate a connection must sustain to play it smoothly. */
  peakKbps: number;
  /** The Proxies tab's one line under the label. */
  hint: string;
}

/** Audio in every preset (§36.3): Red reviews mixes on proxies. */
export const PROXY_AUDIO_KBPS = 256;

export const PRESETS: Readonly<Record<ProxyPreset, PresetSpec>> = {
  "1080h": { id: "1080h", label: "1080p High", shortEdge: 1080, avgKbps: 10_000, peakKbps: 14_000, hint: "Closest to the original, for a fast connection (≈14 Mbps)" },
  "1080l": { id: "1080l", label: "1080p Low", shortEdge: 1080, avgKbps: 4_000, peakKbps: 5_000, hint: "Sharp picture, plays on a slow connection (≈5 Mbps)" },
  "720h": { id: "720h", label: "720p High", shortEdge: 720, avgKbps: 3_500, peakKbps: 4_500, hint: "Smooth motion on a slow connection (≈4.5 Mbps)" },
  "720l": { id: "720l", label: "720p Low", shortEdge: 720, avgKbps: 1_500, peakKbps: 2_000, hint: "Plays almost anywhere, softer picture (≈2 Mbps)" },
};

export const isPreset = (x: unknown): x is ProxyPreset => typeof x === "string" && (PROXY_PRESETS as readonly string[]).includes(x);

/** §37.3: a proxy slot's quality as shown: its preset's label, or "1080p (older)" for a §19.5 proxy made before presets. */
export function slotLabel(slot: ProxySlot): string {
  return slot === LEGACY_PROXY ? "1080p (older)" : PRESETS[slot].label;
}

/** §36.4: a proxy's quality as shown, from its own record. */
export function proxyQuality(proxy: Pick<Proxy, "preset">): string {
  return proxy.preset ? PRESETS[proxy.preset].label : "1080p (older)";
}

/** Every slot a version's `proxies` can hold, best first, `legacy` last. */
export const PROXY_SLOTS: readonly ProxySlot[] = [...PROXY_PRESETS, LEGACY_PROXY];

/** §37.3: a cut's proxies as a list, best first, `legacy` last. */
export function proxyList(proxies: Proxies | null | undefined): { slot: ProxySlot; proxy: Proxy }[] {
  if (!proxies) return [];
  return PROXY_SLOTS.flatMap((slot) => (proxies[slot] ? [{ slot, proxy: proxies[slot]! }] : []));
}

/** Whether a cut has any proxy at all (in use or not). */
export const hasAnyProxy = (proxies: Proxies | null | undefined): boolean => proxyList(proxies).length > 0;

/** Whether a cut has a proxy at `preset`. */
export function proxyIsAt(proxies: Proxies | null | undefined, preset: ProxyPreset): boolean {
  return !!proxies?.[preset];
}

/** §37.3: a proxy is in use when its quality is ticked. A §19.5 (`legacy`) one never is. */
export function slotInUse(slot: ProxySlot, ticked: readonly ProxyPreset[]): boolean {
  return slot !== LEGACY_PROXY && ticked.includes(slot);
}

/** §37.3: the ticked qualities a cut has ready, best first: the rungs the player can play. */
export function readyRungs(proxies: Proxies | null | undefined, ticked: readonly ProxyPreset[]): ProxyPreset[] {
  return ladderOrder(ticked).filter((p) => !!proxies?.[p]);
}

/** §37.4: the ticked qualities a cut is missing, best first. */
export function missingPresets(proxies: Proxies | null | undefined, ticked: readonly ProxyPreset[]): ProxyPreset[] {
  return ladderOrder(ticked).filter((p) => !proxies?.[p]);
}

/** "1080p Low and 720p Low", "1080p High, 1080p Low and 720p Low". */
export function presetNames(presets: readonly ProxyPreset[]): string {
  const names = presets.map((p) => PRESETS[p].label);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The presets a measured speed (Mbit/s) plays smoothly: those whose peak fits in it. */
export function presetsThatFit(mbps: number): ProxyPreset[] {
  return PROXY_PRESETS.filter((p) => PRESETS[p].peakKbps / 1000 <= mbps);
}
