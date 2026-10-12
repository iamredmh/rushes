import { describe, expect, it } from "vitest";
import { imageSize } from "../../src/core/imageSize.js";

// §25.3: the size of a picture, read from its header. Each fixture is only as much of a real file as the reader needs.
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

const png = (w: number, h: number) => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...be32(13), ...ascii("IHDR"), ...be32(w), ...be32(h), 8, 6, 0, 0, 0]);
const gif = (w: number, h: number) => new Uint8Array([...ascii("GIF89a"), ...le16(w), ...le16(h), 0, 0, 0]);
// A JPEG with an APP0 segment ahead of the frame header, as a real one has.
const jpeg = (w: number, h: number) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...be16(16), ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
const webpHead = (chunk: number[]) => new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), ...chunk]);
const webpLossy = (w: number, h: number) => webpHead([...ascii("VP8 "), 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)]);
const webpLossless = (w: number, h: number) => {
  const bits = ((w - 1) | ((h - 1) << 14)) >>> 0;
  return webpHead([...ascii("VP8L"), 0, 0, 0, 0, 0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255]);
};
const webpExtended = (w: number, h: number) => webpHead([...ascii("VP8X"), 10, 0, 0, 0, 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);

describe("imageSize", () => {
  it("reads a png", () => expect(imageSize(png(1080, 1350))).toEqual({ width: 1080, height: 1350, type: "png" }));
  it("reads a gif", () => expect(imageSize(gif(640, 480))).toEqual({ width: 640, height: 480, type: "gif" }));
  it("reads a jpeg past its APP0 segment", () => expect(imageSize(jpeg(1600, 900))).toEqual({ width: 1600, height: 900, type: "jpeg" }));
  it("reads a lossy webp", () => expect(imageSize(webpLossy(1080, 1080))).toEqual({ width: 1080, height: 1080, type: "webp" }));
  it("reads a lossless webp", () => expect(imageSize(webpLossless(1200, 630))).toEqual({ width: 1200, height: 630, type: "webp" }));
  it("reads an extended webp", () => expect(imageSize(webpExtended(2160, 2700))).toEqual({ width: 2160, height: 2700, type: "webp" }));
  it("is null for anything else, and for a file cut short", () => {
    expect(imageSize(new Uint8Array([]))).toBeNull();
    expect(imageSize(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(imageSize(png(10, 10).slice(0, 20))).toBeNull();
    expect(imageSize(jpeg(10, 10).slice(0, 12))).toBeNull();
    expect(imageSize(png(0, 10))).toBeNull();
  });
});
