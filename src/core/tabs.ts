import { STAGES, lanesForVideo, type NotesFile, type Project, type Script, type Stage, type VisualsFile } from "./schema.js";
import { noteOnFilm } from "./films.js";
import { noteInPlay } from "./project.js";
import { noteState } from "./noteState.js";
import { isChanged } from "./script.js";

export interface TabState {
  stage: Stage;
  unlocked: boolean;
  /** Open items: to-do notes, plus changed or flagged sections on the script tab. */
  todo: number;
  /** Of those notes, how many a Send has already given the agent (noteState.ts: "sent"). */
  sent: number;
}

function laneHasVariants(p: Pick<Project, "lanes">, stage: "voice" | "music" | "sfx"): boolean {
  return p.lanes.some((l) => l.stage === stage && l.variants.length > 0);
}

/**
 * Each tab: unlocked or not, and its open items. §31.5: with a film, that film's (its cuts, the takes on it, its
 * script, its notes and the shared visuals' notes); with none, the whole project's (a project with no film yet). `s`
 * is the script that goes with it: that film's.
 */
export function tabStates(p: Project, s: Pick<Script, "sections">, n: NotesFile, v: Pick<VisualsFile, "visuals"> = { visuals: [] }, film?: string | null): TabState[] {
  const own = film ? p.videos.find((x) => x.id === film) : undefined;
  const picture = own ? own.versions.length > 0 : p.videos.some((v) => v.versions.length > 0);
  const heard = { lanes: lanesForVideo(p.lanes, own?.id, p.videos) };
  const voice = laneHasVariants(heard, "voice");
  const music = laneHasVariants(heard, "music");
  const sfx = laneHasVariants(heard, "sfx");
  const unlocked: Record<Stage, boolean> = {
    script: s.sections.length > 0,
    picture,
    voice,
    music,
    sfx,
    mix: picture && (voice || music || sfx),
    // §25.7: Visuals unlocks when one is registered.
    visuals: v.visuals.length > 0,
  };
  return STAGES.map((stage) => {
    // §26: a shelved film's open notes are kept but do not count.
    const open = n.notes.filter((x) => x.stage === stage && x.status === "todo" && noteInPlay(x, p) && noteOnFilm(x, own?.id, p.videos));
    const rows = stage === "script" ? s.sections.filter((x) => isChanged(x) || x.status === "flagged").length : 0;
    return { stage, unlocked: unlocked[stage], todo: open.length + rows, sent: open.filter((x) => noteState(x) === "sent").length };
  });
}
