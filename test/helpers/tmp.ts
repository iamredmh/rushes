import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { Store } from "../../src/core/store.js";

const made: string[] = [];

afterEach(async () => {
  while (made.length) await rm(made.pop()!, { recursive: true, force: true });
});

/**
 * A fresh project folder whose path contains a space, like real project folders.
 * The path is canonical (macOS's tmpdir is behind a symlink), matching the root
 * the server reports.
 */
export async function tmpProject(name = "demo"): Promise<{ root: string; store: Store }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "rushes test ")));
  made.push(base);
  const root = join(base, "My Project");
  const store = new Store(root);
  await store.init(name);
  return { root, store };
}
