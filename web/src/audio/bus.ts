// The one-player bus: only one thing plays at a time across the dashboard (spec §17, data safety).
// Whoever starts playing claims it; that stops the previous owner. The Assets inline player and the
// audio engine both go through here.

type Owner = unknown;
let current: { owner: Owner; stop: () => void } | null = null;

/**
 * Claim the bus for `owner`, stopping whoever held it. `stop` is how a later claim stops this owner.
 * Returns a release that only takes effect while this claim is still the current one.
 */
export function claim(owner: Owner, stop: () => void): () => void {
  const prev = current;
  const mine = { owner, stop };
  current = mine;
  if (prev && prev.owner !== owner) {
    try {
      prev.stop();
    } catch {
      // A failing stop must never block the new player.
    }
  }
  return () => {
    if (current === mine) current = null;
  };
}

/** Let go of the bus if `owner` holds it (after pausing on its own, say). */
export function release(owner: Owner): void {
  if (current && current.owner === owner) current = null;
}

/** Who holds the bus, or null. */
export function owner(): Owner | null {
  return current ? current.owner : null;
}
