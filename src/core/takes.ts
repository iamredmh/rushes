// §27.6: what a read, bed or effects pass knows about itself, and putting one away. Pure (no Node
// imports), so the dashboard asks the same questions the server does.
import { InvalidError, NotFoundError } from "./errors.js";
import type { Project, Variant, Video } from "./schema.js";

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
