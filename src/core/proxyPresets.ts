// §36.3: the four proxy qualities. Shared by the server (the encode) and the desk (the Proxies tab, the toolbar button).
import { DEFAULT_PROXY_PRESET, PROXY_PRESETS, type Proxy, type ProxyPreset } from "./schema.js";

export { DEFAULT_PROXY_PRESET, PROXY_PRESETS, type ProxyPreset };

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

/** §36.4: a proxy's quality as shown: its preset's label, or "1080p (older)" for a §19.5 proxy made before presets. */
export function proxyQuality(proxy: Pick<Proxy, "preset">): string {
  return proxy.preset ? PRESETS[proxy.preset].label : "1080p (older)";
}

/** Whether a cut's proxy is at `preset` (a §19.5 proxy, with none, never is). */
export function proxyIsAt(proxy: Pick<Proxy, "preset"> | null | undefined, preset: ProxyPreset): boolean {
  return !!proxy && proxy.preset === preset;
}

/** The presets a measured speed (Mbit/s) plays smoothly: those whose peak fits in it. */
export function presetsThatFit(mbps: number): ProxyPreset[] {
  return PROXY_PRESETS.filter((p) => PRESETS[p].peakKbps / 1000 <= mbps);
}
