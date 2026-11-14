// §27.6: which read, bed and effects pass is in use. One per sound, per film. Pure (no Node imports):
// the server decides with it and the dashboard reads the same answer.
import type { InUse, Lane, LaneStage, Use, Variant } from "./schema.js";

const STAGES: readonly LaneStage[] = ["voice", "music", "sfx"];

type Lanes = { lanes: Pick<Lane, "id" | "stage" | "variants">[] };

/** A sound's per-lane picks, as `lanes` has them now. */
function stagePicks(lanes: Pick<Lane, "id" | "stage">[], picks: Record<string, string>, stage: LaneStage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lanes) if (l.stage === stage && picks[l.id] !== undefined) out[l.id] = picks[l.id];
  return out;
}

/**
 * The take in use for each sound, among the takes `project.lanes` holds: hand it the lanes ONE FILM
 * hears (lanesForVideo), with that film's picks, and a take that is not on the film is never in use.
 *
 * 1. Nothing stored, or the stored take is gone from these lanes: the newest lane of that sound with
 *    a pick that exists (the rule from before `use`). Its `at` is "".
 * 2. Stored, and since it last saw them a pick in one of these lanes was set to another take that
 *    exists: an older Rushes did that (it knows only `lanes`), and the pick it made is the one in use.
 *    Of several, the newest lane's.
 * 3. Stored, and its own lane still picks it: it stands, whatever was unpicked elsewhere.
 * 4. Otherwise (its own lane's pick was cleared underneath it): rule 1.
 */
export function inUse(project: Lanes, picks: { lanes: Record<string, string>; use?: InUse }): InUse {
  const out: InUse = {};
  for (const stage of STAGES) {
    const lanes = project.lanes.filter((l) => l.stage === stage);
    const exists = (laneId: string, variantId: string | undefined) =>
      variantId !== undefined && lanes.some((l) => l.id === laneId && l.variants.some((v) => v.id === variantId));
    const newest = (wanted: (lane: (typeof lanes)[number]) => boolean): Use | undefined => {
      for (let i = lanes.length - 1; i >= 0; i--) {
        const picked = picks.lanes[lanes[i].id];
        if (exists(lanes[i].id, picked) && wanted(lanes[i])) return { lane: lanes[i].id, variant: picked, at: "", seen: {} };
      }
      return undefined;
    };
    const stored = picks.use?.[stage];
    let use: Use | undefined;
    // One with no time was only worked out (rule 1), never picked here: work it out again.
    if (stored && stored.at !== "" && exists(stored.lane, stored.variant)) {
      const seen = stored.seen ?? {};
      use =
        newest((l) => picks.lanes[l.id] !== seen[l.id] && !(l.id === stored.lane && picks.lanes[l.id] === stored.variant)) ??
        (picks.lanes[stored.lane] === stored.variant ? stored : undefined);
    }
    use ??= newest(() => true);
    if (use) out[stage] = use;
  }
  return out;
}

/**
 * Pick a take (or, with null, unpick its lane) in one film's picks. A take becomes the one in use for
 * its sound; the lane's own pick is kept in step, which is all an older Rushes reads. Unpicking the
 * lane in use clears it. Either way what stays in use re-records the picks it has seen, so an unpick
 * in another round is never mistaken for an older Rushes at work.
 */
export function setInUse(
  own: { lanes: Record<string, string>; use?: InUse },
  lanes: Pick<Lane, "id" | "stage">[],
  lane: Pick<Lane, "id" | "stage">,
  variantId: string | null,
  now: Date,
): void {
  const use = (own.use ??= {});
  if (variantId === null) {
    delete own.lanes[lane.id];
    if (use[lane.stage]?.lane === lane.id) delete use[lane.stage];
  } else {
    own.lanes[lane.id] = variantId;
    use[lane.stage] = { lane: lane.id, variant: variantId, at: now.toISOString(), seen: {} };
  }
  const kept: Use | undefined = use[lane.stage];
  if (kept) kept.seen = stagePicks(lanes, own.lanes, lane.stage);
}

/** The lane and take in use for a sound, or null when there is none. */
export function inUseVariant<L extends Pick<Lane, "id" | "stage" | "variants">>(
  project: { lanes: L[] },
  use: InUse,
  stage: LaneStage,
): { lane: L; variant: Variant } | null {
  const u = use[stage];
  if (!u) return null;
  const lane = project.lanes.find((l) => l.id === u.lane && l.stage === stage);
  const variant = lane?.variants.find((v) => v.id === u.variant);
  return lane && variant ? { lane, variant } : null;
}
