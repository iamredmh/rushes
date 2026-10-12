import { constants } from "node:fs";
import { lstat, open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashText } from "../core/brief.js";
import { InvalidError, NotFoundError, RushesError } from "../core/errors.js";
import type { Store } from "../core/store.js";

// §24 steps 2 and 3: brief.md and storyboard.md are files of record. The agent writes them with its own tools; the
// dashboard writes them through a service built on this. Rushes keeps only `.rushes/<key>.json` for each: the agent's
// last text (the "Current" column) and the hash it last saw, so it can tell the dashboard's writes from anyone else's.

/** A record is a page or two. Anything bigger than this is some other file, and is not read. */
export const MAX_RECORD_BYTES = 1_000_000;

export abstract class RecordFile {
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * @param file    the file's name in the project folder's root
   * @param key     which `.rushes/*.json` holds its baseline and hash
   * @param changed the error a save gets when the file changed since the page loaded
   */
  constructor(protected readonly store: Store, protected readonly file: string, protected readonly key: "brief" | "storyboard", private readonly changed: () => RushesError) {
    this.path = join(store.root, file);
  }

  /** One operation at a time, so a save and a look at the file can never interleave. */
  protected run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(fn);
    this.queue = next;
    return next;
  }

  /**
   * The file's bytes, or null when there is none: missing, a folder, a link (never followed), or too big to be one.
   * The file is opened without following a link and read through that handle, so a link swapped in after the check
   * is refused too, not read.
   */
  private async readBytes(): Promise<Buffer | null> {
    try {
      if (!(await lstat(this.path)).isFile()) return null;
      const fh = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const st = await fh.stat();
        if (!st.isFile() || st.size > MAX_RECORD_BYTES) return null;
        return await fh.readFile();
      } finally {
        await fh.close();
      }
    } catch (e) {
      if (["ENOENT", "ENOTDIR", "EISDIR", "ELOOP", "EMLINK"].includes((e as NodeJS.ErrnoException).code ?? "")) return null;
      throw e;
    }
  }

  /** The file's text, or null when there is none (see readBytes). Bytes that are not UTF-8 are shown as replacement characters. */
  protected async readText(): Promise<string | null> {
    const bytes = await this.readBytes();
    return bytes === null ? null : bytes.toString("utf8");
  }

  /** Whether the file is valid UTF-8, so that a save cannot change bytes the user never touched. */
  private async isUtf8(): Promise<boolean> {
    const bytes = await this.readBytes();
    if (bytes === null) return true;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return true;
    } catch {
      return false;
    }
  }

  /** Notices a change made by anyone but the dashboard: that text becomes the agent's version. */
  sync(): Promise<void> {
    return this.run(async () => {
      const text = await this.readText();
      if (text === null) return;
      const hash = hashText(text);
      if ((await this.store.read(this.key)).seen === hash) return;
      await this.store.update(this.key, (d) => {
        d.baseline = text;
        d.seen = hash;
      });
    });
  }

  protected async write(prev: string, next: string): Promise<void> {
    // One more look just before the file is replaced, so a write that landed since the check is refused, not overwritten.
    const again = await this.readText();
    if (again === null || hashText(again) !== hashText(prev)) throw this.changed();
    const tmp = join(this.store.root, `.${this.file}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tmp, next, "utf8");
    await rename(tmp, this.path);
    const prevHash = hashText(prev);
    const nextHash = hashText(next);
    // If Rushes had not yet seen `prev`, it is the agent's version: keep it as the baseline before the edit lands.
    await this.store.update(this.key, (d) => {
      if (d.seen !== prevHash) d.baseline = prev;
      d.seen = nextHash;
    });
  }

  /** The file's text, once the page has proved it saw it: 404 with no file, 409 when it has changed since. */
  protected async current(expectHash: string): Promise<string> {
    const text = await this.readText();
    if (text === null) throw new NotFoundError(this.file === "brief.md" ? "Brief" : "Storyboard", this.file);
    if (hashText(text) !== expectHash) throw this.changed();
    if (!(await this.isUtf8())) throw new InvalidError(`${this.file} isn't UTF-8 text, so Rushes won't save over it. Edit it in your editor.`);
    return text;
  }

  /** Looks for changes made outside the dashboard every `pollMs`, and once at the start. Returns a stop function. */
  start(pollMs = 500): () => void {
    let stopped = false;
    let last: string | null = null;
    let timer: NodeJS.Timeout | undefined;
    const tick = async () => {
      try {
        const st = await lstat(this.path).catch(() => null);
        // Only a regular file counts as "there was a file": changes inside a folder at this path are none of our business.
        const sig = st ? `${st.isFile() ? "f" : "x"}:${st.mtimeMs}:${st.size}:${st.ino}` : "";
        if (sig !== last) {
          const hadFile = last?.startsWith("f:") ?? false;
          last = sig;
          await this.sync();
          // A file that is deleted, or becomes a folder or a link, changes nothing in `.rushes/` by itself. Forget what was
          // seen, which announces it, and which makes the same text coming back (git stash pop, say) a change to announce too.
          if (hadFile && (await this.run(() => this.readText())) === null) {
            await this.store.update(this.key, (d) => {
              d.seen = "";
            });
          }
        }
      } catch {
        // A file that cannot be read now is looked at again on the next change.
      }
      if (!stopped) {
        timer = setTimeout(() => void tick(), pollMs);
        timer.unref?.();
      }
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }
}
