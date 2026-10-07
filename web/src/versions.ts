// §22.4 and §22.8: the version list's helpers. Pure, so they're unit-tested in Node. shortLabel comes
// from src/core/labels.ts, which has no imports at all, so nothing from the server reaches the bundle.
import { shortLabel, type Labelled } from "../../src/core/labels.js";
export { LABEL_MAX, shortLabel, type Labelled } from "../../src/core/labels.js";

/** Assets › Cuts (§22.4): a cut's subtitle is its short label. A cut with no label and no note has none, because its file name is already shown. */
export function cutSubtitle(v: Labelled | undefined): string | null {
  if (!v || !((v.label ?? "").trim() || v.note.trim())) return null;
  return shortLabel(v);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** R22: "just now", "12 min ago", "2 h ago", "yesterday", "3 days ago", then "5 Oct" (and the year when it isn't this one). */
export function ago(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (now.getTime() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86_400) return "yesterday";
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)} days ago`;
  const d = new Date(t);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`}`;
}

/** §22.8's type-ahead on the version number: the exact number first, then the newest whose number starts with what was typed. */
export function typeAhead(ids: readonly string[], typed: string): string | null {
  const num = (id: string) => id.replace(/^v/i, "");
  return ids.find((id) => num(id) === typed) ?? ids.find((id) => num(id).startsWith(typed)) ?? null;
}

/** Where a key moves the active item in a list of `count` (§22.8): arrows wrap, Home and End jump. Left and right count only when `horizontal`. Null for any other key. */
export function moveActive(key: string, index: number, count: number, horizontal = false): number | null {
  if (count <= 0) return null;
  const next = key === "ArrowDown" || (horizontal && key === "ArrowRight");
  const prev = key === "ArrowUp" || (horizontal && key === "ArrowLeft");
  if (next) return index < 0 ? 0 : (index + 1) % count;
  if (prev) return index < 0 ? count - 1 : (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/** The detail panel's last line (§22.8): "39.7 s · 11 shots · 2 h ago". */
export function versionMeta(v: { duration: number | null; shots: readonly unknown[]; addedAt: string }, now: Date): string {
  const parts: string[] = [];
  if (v.duration !== null) parts.push(`${v.duration.toFixed(1)} s`);
  parts.push(v.shots.length === 0 ? "no shots" : `${v.shots.length} shot${v.shots.length === 1 ? "" : "s"}`);
  const when = ago(v.addedAt, now);
  if (when) parts.push(when);
  return parts.join(" · ");
}
