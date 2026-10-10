// Times written out, and the shot a time falls in. No import of any kind (test/core/timecode.test.ts
// checks): the dashboard bundles this file, so it must not pull in zod or Node.

/**
 * 72.4 -> { m: 1, s: "12.40" }: whole minutes, and the seconds to hundredths. The time is rounded
 * to hundredths first, so 59.999 is 1 minute and "00.00", not 0 minutes and "60.00". The one rule
 * behind fmt() and the screenshot file names.
 */
export function minutesAndSeconds(t: number): { m: number; s: string } {
  const cs = Math.round(Math.max(0, t) * 100);
  const m = Math.floor(cs / 6000);
  return { m, s: ((cs - m * 6000) / 100).toFixed(2).padStart(5, "0") };
}

/** 72.4 -> "1:12.40" (minutes, seconds, hundredths). */
export function fmt(t: number): string {
  const { m, s } = minutesAndSeconds(t);
  return `${m}:${s}`;
}

/** "1:12.40", "0:31.05–0:33.10" or "Whole". */
export function noteTime(t: number | null, tOut: number | null): string {
  if (t === null) return "Whole";
  return tOut !== null ? `${fmt(t)}–${fmt(tOut)}` : fmt(t);
}

/** The last shot whose start is at or before `t`, or null when `t` is before the first shot. */
export function shotAt<S extends { n: number; name: string; start: number }>(shots: readonly S[], t: number): { n: number; name: string } | null {
  let found: S | null = null;
  for (const s of shots) {
    if (s.start <= t && (!found || s.start > found.start)) found = s;
  }
  return found ? { n: found.n, name: found.name } : null;
}
