import { rename } from "node:fs/promises";

/**
 * §34: rename, tried again a few times when Windows refuses it because something has the file open for a moment (a
 * reader of the same file, antivirus, the search indexer): EPERM, EBUSY or EACCES. Anywhere else the first error is
 * thrown as it is, since those codes there mean what they say.
 */
export async function renameRetry(from: string, to: string, tries = 8, platform: NodeJS.Platform = process.platform): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const busy = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (platform !== "win32" || !busy || i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 25 * 2 ** i));
    }
  }
}
