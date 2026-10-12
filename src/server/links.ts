import { lstat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Whether `rel` (a project-relative path), or any folder on the way to it, is a link. The project's own files are never
 * followed out of it: a still the storyboard names, a picture a visual is made of. A part that is missing is not a link.
 */
export async function viaLink(root: string, rel: string): Promise<boolean> {
  let at = root;
  for (const seg of rel.split("/")) {
    at = join(at, seg);
    try {
      if ((await lstat(at)).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}
