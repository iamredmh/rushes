// §23: a cue's optional source file -- the sample an agent placed at that cue. Checked where it
// comes in (an audio file, at most 1024 characters, so it can never open the allow-list to
// anything else) and served by /media only because it is registered (§15.5 applies unchanged).
import { InvalidError } from "./errors.js";
import type { Project } from "./schema.js";

export const CUE_FILE_MAX = 1024;

/** The sample types a cue may name: the audio half of §15.5's outside-the-project list. */
export const CUE_FILE_EXT: ReadonlySet<string> = new Set(["wav", "mp3", "m4a", "aac", "aif", "aiff", "flac", "ogg", "opus"]);

function extOf(file: string): string {
  const base = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Whether `file` may be a cue's source: not empty, at most 1024 characters, no NUL, an audio extension. */
export function isCueFile(file: string): boolean {
  return file.length > 0 && file.length <= CUE_FILE_MAX && !file.includes("\0") && CUE_FILE_EXT.has(extOf(file));
}

/** `file` when it may be a cue's source; otherwise an InvalidError (400) naming the cue. */
export function checkCueFile(cueName: string, file: string): string {
  if (file.length > CUE_FILE_MAX) throw new InvalidError(`Cue "${cueName}": its file path is over ${CUE_FILE_MAX} characters`);
  if (!isCueFile(file)) {
    throw new InvalidError(`Cue "${cueName}": "${file}" isn't an audio file. Send a .wav, .mp3, .m4a, .aac, .aif, .aiff, .flac, .ogg or .opus.`);
  }
  return file;
}

/**
 * Every cue file the project names, once each, in manifest order. A stored one that isn't an
 * audio file (a hand edit) is left out, so it is never served.
 */
export function cueFiles(project: Pick<Project, "lanes">): string[] {
  const out = new Set<string>();
  for (const l of project.lanes) {
    for (const v of l.variants) for (const c of v.cues) if (c.file !== undefined && isCueFile(c.file)) out.add(c.file);
  }
  return [...out];
}
