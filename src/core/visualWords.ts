// §25.5: where a mark on a picture is, in words, for an agent that cannot see it and for the dashboard's tooltips. Pure, with no
// imports, because the dashboard bundles this file (test/core/visuals.test.ts checks it).

type Thirds = [boolean, boolean, boolean];

/** The thirds of an axis a span covers: those it overlaps by at least 40% of a third; if none, the one its middle is in. */
function covered(start: number, size: number): Thirds {
  const t = [0, 1, 2].map((i) => Math.max(0, Math.min(start + size, (i + 1) / 3) - Math.max(start, i / 3)) * 3 >= 0.4) as Thirds;
  if (t.some(Boolean)) return t;
  const mid = Math.min(2, Math.max(0, Math.floor((start + size / 2) * 3)));
  return [mid === 0, mid === 1, mid === 2];
}
const key = (t: Thirds): string => t.map((x) => (x ? "1" : "0")).join("");
const COLUMN: Record<string, string> = { "100": "left third", "010": "centre", "001": "right third", "110": "left two thirds", "011": "right two thirds", "111": "full width", "101": "full width" };
const ROW: Record<string, string> = { "100": "top third", "010": "middle", "001": "bottom third", "110": "top two thirds", "011": "bottom two thirds", "111": "full height", "101": "full height" };

/** "left third, top third", "the centre", "the whole picture": where a region is, for an agent that cannot see the mark. */
export function regionWords(box: { x: number; y: number; w: number; h: number }): string {
  const c = key(covered(box.x, box.w));
  const r = key(covered(box.y, box.h));
  if (c === "111" && r === "111") return "the whole picture";
  if (c === "010" && r === "010") return "the centre";
  return `${COLUMN[c]}, ${ROW[r]}`;
}

/** "left, bottom", "the centre": where a point is. */
export function pinWords(pin: { x: number; y: number }): string {
  const col = Math.min(2, Math.max(0, Math.floor(pin.x * 3)));
  const row = Math.min(2, Math.max(0, Math.floor(pin.y * 3)));
  if (col === 1 && row === 1) return "the centre";
  return `${["left", "centre", "right"][col]}, ${["top", "middle", "bottom"][row]}`;
}
