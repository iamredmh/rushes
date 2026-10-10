// §24.12: is the plan approved? The brief, every script section and every storyboard shot, in that order.
// A film with no script (an instrumental one) is not waiting on one.

export type PlanPart = "brief" | "script" | "storyboard";

export interface BuildState {
  /**
   * Planning has begun: there is a brief with a Status line, or a storyboard with shots. A project that never used the
   * flow, or has a brief.md or storyboard.md in some other format, is not warned about anything.
   */
  started: boolean;
  /** Planning has begun, and nothing is waiting. */
  ready: boolean;
  waitingOn: PlanPart[];
}

export interface PlanInput {
  brief: { exists: boolean; status: "draft" | "approved" | null };
  script: { status: string }[];
  storyboard: { exists: boolean; total: number; approved: number };
}

export function buildState(i: PlanInput): BuildState {
  const waitingOn: PlanPart[] = [];
  if (!(i.brief.exists && i.brief.status === "approved")) waitingOn.push("brief");
  if (!i.script.every((s) => s.status === "approved")) waitingOn.push("script");
  if (!(i.storyboard.exists && i.storyboard.total > 0 && i.storyboard.approved === i.storyboard.total)) waitingOn.push("storyboard");
  const started = (i.brief.exists && i.brief.status !== null) || (i.storyboard.exists && i.storyboard.total > 0);
  return { started, ready: started && waitingOn.length === 0, waitingOn };
}

/** The words a cut registered before the plan is approved comes back with, or null when there is nothing to say. */
export function planWarning(b: BuildState): string | null {
  if (!b.started || b.ready) return null;
  const names = { brief: "the brief", script: "the script", storyboard: "the storyboard" } as const;
  const list = b.waitingOn.map((p) => names[p]);
  const text = list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : list[0];
  return `The plan isn't approved yet: still waiting on ${text}.`;
}
