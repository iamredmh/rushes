import { STAGES, type NotesFile, type Project, type Script, type Stage, type VisualsFile } from "./schema.js";
import { noteInPlay } from "./project.js";
import { isChanged } from "./script.js";

export interface TabState {
  stage: Stage;
  unlocked: boolean;
  /** Open items: to-do notes, plus changed or flagged sections on the script tab. */
  todo: number;
}

function laneHasVariants(p: Project, stage: "voice" | "music" | "sfx"): boolean {
  return p.lanes.some((l) => l.stage === stage && l.variants.length > 0);
}

export function tabStates(p: Project, s: Script, n: NotesFile, v: Pick<VisualsFile, "visuals"> = { visuals: [] }): TabState[] {
  const picture = p.videos.some((v) => v.versions.length > 0);
  const voice = laneHasVariants(p, "voice");
  const music = laneHasVariants(p, "music");
  const sfx = laneHasVariants(p, "sfx");
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
    const notes = n.notes.filter((x) => x.stage === stage && x.status === "todo" && noteInPlay(x, p)).length;
    const rows = stage === "script" ? s.sections.filter((x) => isChanged(x) || x.status === "flagged").length : 0;
    return { stage, unlocked: unlocked[stage], todo: notes + rows };
  });
}
