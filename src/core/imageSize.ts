// §25.3: the size of a picture, read from the start of its file. Pure: it is given the bytes, so it needs no ffmpeg and
// no decoder, and it only has to be right about the four kinds of picture a browser shows inline in a post.

export interface ImageSize {
  width: number;
  height: number;
  type: "png" | "jpeg" | "gif" | "webp";
}

const ascii = (b: Uint8Array, at: number, s: string): boolean => b.length >= at + s.length && [...s].every((c, i) => b[at + i] === c.charCodeAt(0));
const u16be = (b: Uint8Array, at: number): number => (b[at] << 8) | b[at + 1];
const u16le = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8);
const u24le = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32be = (b: Uint8Array, at: number): number => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

function sized(width: number, height: number, type: ImageSize["type"]): ImageSize | null {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 ? { width, height, type } : null;
}

function png(b: Uint8Array): ImageSize | null {
  // The 8-byte signature, then the IHDR chunk: length, "IHDR", width, height.
  if (b.length < 24 || !ascii(b, 12, "IHDR")) return null;
  return sized(u32be(b, 16), u32be(b, 20), "png");
}

function gif(b: Uint8Array): ImageSize | null {
  return b.length < 10 ? null : sized(u16le(b, 6), u16le(b, 8), "gif");
}

/** The start-of-frame markers, which carry the size: every one from C0 to CF except the three that are not frames. */
const isFrame = (m: number): boolean => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/**
 * The EXIF orientation (1 to 8) in an APP1 segment whose data starts at `at` and is `len` bytes long, or 1 when there is none
 * or it cannot be read. Only IFD0's orientation tag (0x0112) is looked at, and nothing is read outside the segment.
 */
function exifOrientation(b: Uint8Array, at: number, len: number): number {
  const end = Math.min(b.length, at + len);
  if (!ascii(b, at, "Exif") || b[at + 4] !== 0 || b[at + 5] !== 0) return 1;
  const tiff = at + 6;
  const little = ascii(b, tiff, "II");
  if (!little && !ascii(b, tiff, "MM")) return 1;
  const u16 = (o: number): number => (little ? u16le(b, o) : u16be(b, o));
  const u32 = (o: number): number => (little ? (u16le(b, o) | (u16le(b, o + 2) << 16)) >>> 0 : u32be(b, o));
  if (tiff + 8 > end || u16(tiff + 2) !== 42) return 1;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = Math.min(u16(ifd), 256);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return 1;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function jpeg(b: Uint8Array): ImageSize | null {
  let at = 2;
  let orientation = 1;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (isFrame(marker)) {
      if (b.length < at + 9) return null;
      const [width, height] = [u16be(b, at + 7), u16be(b, at + 5)];
      // A browser draws a picture stored on its side turned upright, so its shape is the turned one (EXIF orientations 5 to 8).
      return orientation >= 5 ? sized(height, width, "jpeg") : sized(width, height, "jpeg");
    }
    // Another APP1 segment (XMP, say) says nothing about orientation and must not undo what the EXIF one said.
    if (marker === 0xe1) orientation = [exifOrientation(b, at + 4, u16be(b, at + 2) - 2), orientation].find((o) => o !== 1) ?? 1;
    at += 2 + u16be(b, at + 2);
  }
  return null;
}

function webp(b: Uint8Array): ImageSize | null {
  if (ascii(b, 12, "VP8 ")) return b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a ? sized(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff, "webp") : null;
  if (ascii(b, 12, "VP8L")) {
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, "webp");
  }
  if (ascii(b, 12, "VP8X")) return b.length >= 30 ? sized(u24le(b, 24) + 1, u24le(b, 27) + 1, "webp") : null;
  return null;
}

/** The size and type of a png, jpeg, gif or webp from its first bytes, or null for anything else or a file cut short. */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return png(bytes);
  if (ascii(bytes, 0, "GIF8")) return gif(bytes);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes);
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return webp(bytes);
  return null;
}
