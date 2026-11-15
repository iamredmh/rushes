// §27, 5.7: the notes on the takes in use, shared by the Timeline tab with and without a cut. They are listed with the
// tab's own notes and marked on their rows. A note on the Timeline is on the film (Red, round 2): a take is noted on its
// own tab, so the rows here are never picked as a note's target.
import type { Note, Video } from "../../types.js";
import type { Mix } from "./useMix.js";

/** The notes on the takes in use on this film. */
export function takeNotesOf(mix: Mix, notes: Note[], video: Pick<Video, "id"> | null): Note[] {
  return notes.filter((n) => (n.stage === "voice" || n.stage === "music" || n.stage === "sfx") && (!n.video || n.video === video?.id) && mix.noteRow(n) !== null);
}
