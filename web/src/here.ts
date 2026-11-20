// §35.5: the here key. When Rushes opens the browser itself it adds `#here=<key>` (the server's lock token, never sent
// over HTTP), proving the desk is on the same computer as the server. The desk keeps it for this tab and takes it out
// of the address, so a copied link never carries it. A desk typed in by hand, or reached through a tunnel, has none.
const KEY = "rushes:here";

/** Takes the key out of the address into this tab's storage. Call once, before the first render. */
export function keepHereKey(loc: Pick<Location, "hash" | "pathname" | "search"> = location, store: Pick<Storage, "setItem"> | null = safeSession()): void {
  const m = loc.hash.match(/(?:^#|&)here=([^&]+)/);
  if (!m) return;
  try {
    store?.setItem(KEY, decodeURIComponent(m[1]));
  } catch {
    // No storage (a private window): the desk counts as remote, and shows the command.
  }
  const rest = loc.hash.replace(/(?:^#|&)here=[^&]+/, "").replace(/^&/, "");
  history.replaceState(history.state, "", `${loc.pathname}${loc.search}${rest ? `#${rest}` : ""}`);
}

/** The key this tab was opened with, or null. */
export function hereKey(store: Pick<Storage, "getItem"> | null = safeSession()): string | null {
  try {
    return store?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

function safeSession(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
