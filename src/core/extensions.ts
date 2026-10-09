// No import of any kind (test/core/shared-with-web.test.ts checks): the dashboard decides where to
// show the Open button from this same list, so it bundles this file.

/**
 * §16.3: the only extensions Open will act on, lower-case and without the dot. Anything else is
 * refused with 415 `unsafe_type` before any stat or spawn happens -- Rushes never opens a script,
 * app or archive, since on macOS opening those can run code.
 */
// svg is deliberately excluded: on macOS an SVG often opens in a browser and can carry script.
export const OPEN_SAFE_EXT: ReadonlySet<string> = new Set([
  "md", "txt", "pdf", "srt", "vtt",
  "png", "jpg", "jpeg", "gif", "webp",
  "mp4", "mov", "m4v", "webm", "mkv",
  "wav", "mp3", "m4a", "aac", "flac", "ogg",
  "prproj", "drp",
]);
