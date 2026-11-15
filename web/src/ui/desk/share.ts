// A size the desk remembers per browser as a share of its column: the Timeline's divider, and on a sound's tab the
// preview's divider. Kept apart from frame.tsx so it can be tested without a renderer.

/** On a sound's tab: the preview's height as a share of the right column once its divider has been dragged, remembered
 *  per browser and shared by Voice, Music and Effects. */
export const PREVIEW_KEY = "rushes:preview";
export const PREVIEW_MIN = 0.12;
export const PREVIEW_MAX = 0.75;

/** A remembered share, held between `min` and `max`; null when none is kept, it is not a number, or storage is refused. */
export function readShare(key: string, min: number, max: number): number | null {
  try {
    const raw = localStorage.getItem(key);
    const n = Number(raw);
    return raw !== null && raw.trim() !== "" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
  } catch {
    return null;
  }
}
