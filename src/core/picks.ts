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

function same(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/**
 * The take in use for each sound.
 * 1. The stored one stands while its take exists and the sound's per-lane picks are as it last saw them.
 * 2. Otherwise (nothing stored, the take gone, or an older Rushes changed a pick underneath) the
 *    newest lane of that sound with a pick that exists: the rule from before `use`. Its `at` is "".
 * 3. Otherwise nothing.
 */
export function inUse(project: Lanes, picks: { lanes: Record<string, string>; use?: InUse }): InUse {
  const out: InUse = {};
  for (const stage of STAGES) {
    const stored = picks.use?.[stage];
    if (stored) {
      const lane = project.lanes.find((l) => l.id === stored.lane && l.stage === stage);
      if (lane?.variants.some((v) => v.id === stored.variant) && same(stagePicks(project.lanes, picks.lanes, stage), stored.seen ?? {})) {
        out[stage] = stored;
        continue;
      }
    }
    for (let i = project.lanes.length - 1; i >= 0; i--) {
      const lane = project.lanes[i];
      if (lane.stage !== stage) continue;
      const picked = picks.lanes[lane.id];
      if (picked !== undefined && lane.variants.some((v) => v.id === picked)) {
        out[stage] = { lane: lane.id, variant: picked, at: "", seen: {} };
        break;
      }
    }
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
