// §27.6: what a read, bed or effects pass knows about itself, and putting one away. Pure (no Node
// imports), so the dashboard asks the same questions the server does.
import { InvalidError, NotFoundError } from "./errors.js";
import { inUse } from "./picks.js";
import { lanesForVideo, picksForVideo, type LaneStage, type Picks, type Project, type Use, type Variant, type Video } from "./schema.js";

/** Made for an earlier cut of this film than the one it has now. False for a take that recorded none. */
export function madeForStale(variant: Pick<Variant, "madeFor">, video: Pick<Video, "id" | "versions">): boolean {
  const made = variant.madeFor?.[video.id];
  if (made === undefined) return false;
  const latest = video.versions[video.versions.length - 1];
  return latest !== undefined && latest.id !== made;
}

/**
 * Waiting to be chosen: it arrived after this sound's take in use was picked, or nothing is in use
 * yet. A take in use that was only worked out (`at` "", from before picks recorded a time) counts as
 * picked before anything dated. Never one that was put away, or one from before takes recorded a date.
 */
export function isNewTake(variant: Pick<Variant, "addedAt" | "putAway">, use: { at: string } | undefined): boolean {
  if (variant.addedAt === undefined || variant.putAway !== undefined) return false;
  return use === undefined || variant.addedAt > use.at;
}

/**
 * Put a take away (hidden from the lists, never deleted) or bring it back. `usedOn` names the films
 * it is the take in use on: one in use cannot be put away. Bringing back is never refused.
 */
export function putAway(p: Project, laneId: string, variantId: string, away: boolean, usedOn: string[], now = new Date()): Variant {
  const variant = p.lanes.find((l) => l.id === laneId)?.variants.find((v) => v.id === variantId);
  if (!variant) throw new NotFoundError("variant", `${laneId}/${variantId}`);
  if (!away) {
    delete variant.putAway;
    return variant;
  }
  if (usedOn.length > 0) throw new InvalidError(`This one is in use on ${usedOn.join(", ")}. Choose another first.`);
  variant.putAway = now.toISOString();
  return variant;
}

/**
 * Where a take stands for one sound on one film. One answer, in this order: the take in use; one put away (hidden,
 * never deleted); one that arrived after the take in use was picked (or with nothing in use), waiting to be chosen;
 * everything else, earlier. The desk groups its lists by it and an agent reads it from rushes_get_picks.
 */
export type TakeState = "in-use" | "new" | "earlier" | "put-away";
export function takeState(variant: Pick<Variant, "id" | "addedAt" | "putAway">, lane: string, use: Use | undefined): TakeState {
  if (use !== undefined && use.lane === lane && use.variant === variant.id) return "in-use";
  if (variant.putAway !== undefined) return "put-away";
  return isNewTake(variant, use) ? "new" : "earlier";
}

/** One take as an agent reads it. */
export interface TakeView {
  lane: string;
  variant: string;
  name: string;
  /** Its round: its lane's name. */
  round: string;
  state: TakeState;
  /** The cut it was made for on this film, when it recorded one, and whether the film has a later cut since. */
  madeFor: string | null;
  stale: boolean;
}

const SOUNDS: readonly LaneStage[] = ["voice", "music", "sfx"];

/** Every take one film hears (no film: the whole project), per sound, newest round first, with its state. */
export function filmTakes(project: Pick<Project, "lanes" | "videos">, picks: Picks, videoId: string | undefined): Record<LaneStage, TakeView[]> {
  const lanes = lanesForVideo(project.lanes, videoId, project.videos.length);
  const use = inUse({ lanes }, picksForVideo(picks, videoId));
  const video = videoId ? project.videos.find((v) => v.id === videoId) : undefined;
  const out = { voice: [], music: [], sfx: [] } as Record<LaneStage, TakeView[]>;
  for (const stage of SOUNDS) {
    for (const l of [...lanes].reverse()) {
      if (l.stage !== stage) continue;
      for (const v of l.variants) {
        out[stage].push({
          lane: l.id,
          variant: v.id,
          name: v.name,
          round: l.name,
          state: takeState(v, l.id, use[stage]),
          madeFor: (video && v.madeFor?.[video.id]) ?? null,
          stale: video ? madeForStale(v, video) : false,
        });
      }
    }
  }
  return out;
}
