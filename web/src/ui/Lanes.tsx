// A take's waveform (§17.1): bars across the timeline where its clips sit, drawn on a canvas that redraws only when its
// peaks, its size, the timeline's length, its colour or the theme change, never per frame. The takes on a sound's tab
// (Takes) and the sound rows on the Timeline tab (SoundTracks) draw one each.
import { useEffect, useState, useRef } from "preact/hooks";
import { THEME_EVENT, tokenColor } from "../theme.js";

// Test-only: how many times any waveform has been drawn, so e2e can check playback never redraws them.
let draws = 0;
export function waveDraws(): number {
  return draws;
}

export interface WaveSegment {
  offset: number;
  duration: number;
  peaks: Float32Array | null;
}

const BAR = 3;
const BAR_WIDTH = 2;

/** A lane's waveform: bars across the timeline where its clips sit. The Timeline tab's sound rows draw one too, of the
 *  stretch on screen once zoomed: `length` seconds from `from`. */
export function Wave({ segments, length, color, from = 0 }: { segments: WaveSegment[]; length: number; color: string; from?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0, dpr: 1 });

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const measure = () => {
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      setSize((s) => (s.w === r.width && s.h === r.height && s.dpr === dpr ? s : { w: r.width, h: r.height, dpr }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  // A token's value changes with light and dark, and a canvas cannot read `var()`: redraw when the page's theme does.
  const [theme, setTheme] = useState(0);
  useEffect(() => {
    const on = () => setTheme((n) => n + 1);
    window.addEventListener(THEME_EVENT, on);
    return () => window.removeEventListener(THEME_EVENT, on);
  }, []);

  // Redraws only when the peaks, the size, the length, the colour or the theme change: never per frame.
  const deps: unknown[] = [size, length, from, color, theme];
  for (const s of segments) deps.push(s.offset, s.duration, s.peaks);
  useEffect(() => {
    const c = ref.current;
    if (!c || size.w <= 0 || size.h <= 0) return;
    draws++;
    c.width = Math.round(size.w * size.dpr);
    c.height = Math.round(size.h * size.dpr);
    const x = c.getContext("2d");
    if (!x) return;
    x.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    x.clearRect(0, 0, size.w, size.h);
    if (!(length > 0)) return;
    x.fillStyle = tokenColor(c, color);
    const bars = Math.floor(size.w / BAR);
    const secondsPerBar = (length * BAR) / size.w;
    for (let i = 0; i < bars; i++) {
      const t0 = from + i * secondsPerBar;
      const t1 = t0 + secondsPerBar;
      let amp = -1;
      for (const s of segments) {
        if (!(s.duration > 0) || t1 <= s.offset || t0 >= s.offset + s.duration) continue;
        if (!s.peaks || s.peaks.length === 0) {
          // A streamed file has no peaks: a quiet line where it plays.
          amp = Math.max(amp, 0.04);
          continue;
        }
        const n = s.peaks.length;
        const a = Math.max(0, Math.floor(((t0 - s.offset) / s.duration) * n));
        const b = Math.min(n, Math.max(a + 1, Math.ceil(((t1 - s.offset) / s.duration) * n)));
        for (let j = a; j < b; j++) amp = Math.max(amp, s.peaks[j]);
      }
      if (amp < 0) continue;
      const h = Math.max(1.5, Math.min(1, amp) * size.h * 0.92);
      x.globalAlpha = 0.9;
      x.fillRect(i * BAR, (size.h - h) / 2, BAR_WIDTH, h);
    }
  }, deps);

  return <canvas ref={ref} class="wave" aria-hidden="true" />;
}
