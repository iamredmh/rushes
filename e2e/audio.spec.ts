// Audio tab tests. The engine's own logic is unit-tested (test/web/timeline.test.ts and
// engine.test.ts); the full in-browser engine checks arrive with the Music tab (Task 3).
import { makeWav } from "./fixtures/wav.js";
import { expect, test } from "./fixture.js";

test("the generated WAV fixture decodes in Chromium to the tone it describes", async ({ page }) => {
  const wav = makeWav({ seconds: 1.5, freq: 440 }).toString("base64");
  const decoded = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const ctx = new OfflineAudioContext(1, 22050, 22050);
    const buf = await ctx.decodeAudioData(bytes.buffer);
    const data = buf.getChannelData(0);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v));
    return { duration: buf.duration, channels: buf.numberOfChannels, sampleRate: buf.sampleRate, peak };
  }, wav);
  expect(decoded.duration).toBeCloseTo(1.5, 2);
  expect(decoded.channels).toBe(1);
  expect(decoded.sampleRate).toBe(22050);
  expect(decoded.peak).toBeGreaterThan(0.49);
  expect(decoded.peak).toBeLessThanOrEqual(0.51);
});
