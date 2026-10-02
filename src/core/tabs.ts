import { STAGES, type NotesFile, type Project, type Script, type Stage } from "./schema.js";
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

export function tabStates(p: Project, s: Script, n: NotesFile): TabState[] {
  const picture = p.videos.some((v) => v.versions.length > 0);
  const voice = s.sections.some((x) => x.takes.length > 0) || laneHasVariants(p, "voice");
  const music = laneHasVariants(p, "music");
  const sfx = laneHasVariants(p, "sfx");
  const unlocked: Record<Stage, boolean> = {
    script: s.sections.length > 0,
    picture,
    voice,
    music,
    sfx,
    mix: picture && (voice || music || sfx),
  };
  return STAGES.map((stage) => {
    const notes = n.notes.filter((x) => x.stage === stage && x.status === "todo").length;
    const rows = stage === "script" ? s.sections.filter((x) => isChanged(x) || x.status === "flagged").length : 0;
    return { stage, unlocked: unlocked[stage], todo: notes + rows };
  });
}
