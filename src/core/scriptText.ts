// How a script line reads: whether it fits its slot, and whether the user changed it. No import of
// any kind (test/core/shared-with-web.test.ts checks): the dashboard bundles this file.

export type FitState = "ok" | "tight" | "over";

/** Does this line fit its slot at reading speed? "tight" means over 80% of the slot. */
export function fit(text: string, slotSeconds: number, wordsPerSecond: number): { words: number; seconds: number; ratio: number; state: FitState } {
  const words = (text.trim().match(/\S+/g) ?? []).length;
  const seconds = words / wordsPerSecond;
  const ratio = slotSeconds > 0 ? seconds / slotSeconds : Infinity;
  const state: FitState = ratio > 1 ? "over" : ratio > 0.8 ? "tight" : "ok";
  return { words, seconds, ratio, state };
}

/** A row counts as changed when the user's version differs from the agent's line. */
export function isChanged(s: { proposed: string | null; current: string }): boolean {
  return s.proposed !== null && s.proposed.trim() !== s.current.trim();
}
