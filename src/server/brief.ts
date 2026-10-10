import { BRIEF_FILE, hashText, parseBrief, setSectionBody, setStatus, type BriefStatus } from "../core/brief.js";
import { InvalidError, RushesError } from "../core/errors.js";
import type { Store } from "../core/store.js";
import { RecordFile } from "./record.js";

// §24 step 2: brief.md is the file of record. See RecordFile for how it is kept.

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

export const NO_BRIEF: BriefView = { exists: false, title: "", status: null, hash: "", sections: [], changed: 0 };

export class BriefService extends RecordFile {
  constructor(store: Store) {
    super(store, BRIEF_FILE, "brief", () => new BriefChangedError());
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
}
