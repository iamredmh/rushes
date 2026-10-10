import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BRIEF_FILE, hashText, parseBrief, setSectionBody, setStatus, type BriefStatus } from "../core/brief.js";
import { InvalidError, NotFoundError, RushesError } from "../core/errors.js";
import type { Store } from "../core/store.js";

// §24 step 2: brief.md is the file of record. The agent writes it with its own tools; the dashboard
// writes it here. Rushes keeps only `.rushes/brief.json`: the agent's last text (the "Current"
// column) and the hash it last saw, so it can tell the dashboard's writes from anyone else's.

export class BriefChangedError extends RushesError {
  constructor() {
    super("brief.md changed since you loaded it. Showing the file as it is now.", 409, "brief_changed");
  }
}

export interface BriefSectionView {
  /** Position in the file: the address a save uses, with `heading` as a check. */
  index: number;
  heading: string;
  /** The agent's last version of this section. */
  current: string;
  /** The section as the file has it now. */
  yours: string;
  changed: boolean;
}

export interface BriefView {
  exists: boolean;
  title: string;
  status: BriefStatus | null;
  /** The file's fingerprint: send it back with a save to prove you saw the current file. */
  hash: string;
  sections: BriefSectionView[];
  /** How many sections differ from the agent's version. */
  changed: number;
}

/** A brief is a page or two. Anything bigger than this is some other file, and is not read. */
const MAX_BRIEF_BYTES = 1_000_000;

export const NO_BRIEF: BriefView = { exists: false, title: "", status: null, hash: "", sections: [], changed: 0 };

export class BriefService {
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: Store) {
    this.path = join(store.root, BRIEF_FILE);
  }

  /** One operation at a time, so a save and a look at the file can never interleave. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(fn);
    this.queue = next;
    return next;
  }

  /** The file's text, or null when there is no brief: missing, a folder, a link (never followed), or too big to be one. */
  private async readText(): Promise<string | null> {
    try {
      const st = await lstat(this.path);
      if (!st.isFile() || st.size > MAX_BRIEF_BYTES) return null;
      return await readFile(this.path, "utf8");
    } catch (e) {
      if (["ENOENT", "ENOTDIR", "EISDIR", "ELOOP"].includes((e as NodeJS.ErrnoException).code ?? "")) return null;
      throw e;
    }
  }

  private build(text: string | null, state: { baseline: string; seen: string }): BriefView {
    if (text === null) return NO_BRIEF;
    const hash = hashText(text);
    const yours = parseBrief(text);
    // Until Rushes has looked at the file, or when it changed before the poll noticed, the file itself is the agent's version.
    const base = state.seen !== "" && state.seen === hash ? parseBrief(state.baseline) : yours;
    const seen = new Map<string, number>();
    const sections = yours.sections.map((s, index) => {
      const n = seen.get(s.heading) ?? 0;
      seen.set(s.heading, n + 1);
      const match = base.sections.filter((b) => b.heading === s.heading)[n];
      const current = match ? match.body : s.body;
      return { index, heading: s.heading, current, yours: s.body, changed: current !== s.body };
    });
    return { exists: true, title: yours.title, status: yours.status, hash, sections, changed: sections.filter((s) => s.changed).length };
  }

  view(): Promise<BriefView> {
    return this.run(async () => this.build(await this.readText(), await this.store.read("brief")));
  }

  /** Notices a change made by anyone but the dashboard: that text becomes the agent's version. */
  sync(): Promise<void> {
    return this.run(async () => {
      const text = await this.readText();
      if (text === null) return;
      const hash = hashText(text);
      if ((await this.store.read("brief")).seen === hash) return;
      await this.store.update("brief", (d) => {
        d.baseline = text;
        d.seen = hash;
      });
    });
  }

  private async write(prev: string, next: string): Promise<void> {
    const tmp = join(this.store.root, `.${BRIEF_FILE}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tmp, next, "utf8");
    await rename(tmp, this.path);
    const prevHash = hashText(prev);
    const nextHash = hashText(next);
    // If Rushes had not yet seen `prev`, it is the agent's version: keep it as the baseline before the edit lands.
    await this.store.update("brief", (d) => {
      if (d.seen !== prevHash) d.baseline = prev;
      d.seen = nextHash;
    });
  }

  private async current(expectHash: string): Promise<string> {
    const text = await this.readText();
    if (text === null) throw new NotFoundError("Brief", BRIEF_FILE);
    if (hashText(text) !== expectHash) throw new BriefChangedError();
    return text;
  }

  /** Saves one section. An edit to an approved brief reopens it: the status line goes back to draft. */
  setSection(index: number, heading: string, text: string, expectHash: string): Promise<BriefView> {
    return this.run(async () => {
      const prev = await this.current(expectHash);
      let next: string;
      try {
        next = setSectionBody(prev, index, heading, text);
      } catch (e) {
        throw new InvalidError((e as Error).message);
      }
      if (parseBrief(next).status === "approved") next = setStatus(next, "draft");
      if (next !== prev) await this.write(prev, next);
      return this.build(next, await this.store.read("brief"));
    });
  }

  /** Approves or reopens the brief by setting its status line. Only the dashboard calls this. */
  setStatus(status: BriefStatus, expectHash: string): Promise<BriefView> {
    return this.run(async () => {
      const prev = await this.current(expectHash);
      const next = setStatus(prev, status);
      if (next !== prev) await this.write(prev, next);
      return this.build(next, await this.store.read("brief"));
    });
  }

  /** Looks for changes made outside the dashboard every `pollMs`, and once at the start. Returns a stop function. */
  start(pollMs = 500): () => void {
    let stopped = false;
    let last: string | null = null;
    let timer: NodeJS.Timeout | undefined;
    const tick = async () => {
      try {
        const st = await lstat(this.path).catch(() => null);
        const sig = st ? `${st.mtimeMs}:${st.size}:${st.ino}` : "";
        if (sig !== last) {
          last = sig;
          await this.sync();
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
