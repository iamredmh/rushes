import { hashText } from "../core/brief.js";
import { InvalidError, RushesError } from "../core/errors.js";
import { STORYBOARD_FILE, cutShots, editShot, parseStoryboard, type Shot, type ShotEdit } from "../core/storyboard.js";
import type { Store } from "../core/store.js";
import { viaLink } from "./links.js";
import { RecordFile } from "./record.js";

// §24.12: storyboard.md is the file of record for the shots. See RecordFile for how it is kept.

export class StoryboardChangedError extends RushesError {
  constructor() {
    super("storyboard.md changed since you loaded it. Showing the file as it is now.", 409, "storyboard_changed");
  }
}

export interface StoryboardShotView extends Shot {
  /** The agent's last description of this shot. `description` is the file as it is now. */
  current: string;
  /** The agent's last direction. `direction` is the file as it is now. */
  directionCurrent: string;
  /** Whether the description or the direction differs from the agent's version. */
  changed: boolean;
}

export interface StoryboardView {
  exists: boolean;
  title: string;
  /** The file's fingerprint: send it back with a save to prove you saw the current file. */
  hash: string;
  shots: StoryboardShotView[];
  /** How many shots differ from the agent's version. */
  changed: number;
  approved: number;
  total: number;
  /** The shots' planned lengths added up, in seconds (a shot with no Length counts as nothing here). */
  plannedLength: number;
}

export const NO_STORYBOARD: StoryboardView = { exists: false, title: "", hash: "", shots: [], changed: 0, approved: 0, total: 0, plannedLength: 0 };

export class StoryboardService extends RecordFile {
  constructor(store: Store) {
    super(store, STORYBOARD_FILE, "storyboard", () => new StoryboardChangedError());
  }

  private build(text: string | null, state: { baseline: string; seen: string }): StoryboardView {
    if (text === null) return NO_STORYBOARD;
    const hash = hashText(text);
    const yours = parseStoryboard(text);
    // Until Rushes has looked at the file, or when it changed before the poll noticed, the file itself is the agent's version.
    const base = state.seen !== "" && state.seen === hash ? parseStoryboard(state.baseline) : yours;
    const seen = new Map<string, number>();
    const shots = yours.shots.map((s) => {
      const n = seen.get(s.heading) ?? 0;
      seen.set(s.heading, n + 1);
      const match = base.shots.filter((b) => b.heading === s.heading)[n];
      const current = match ? match.description : s.description;
      const directionCurrent = match ? match.direction : s.direction;
      return { ...s, current, directionCurrent, changed: current !== s.description || directionCurrent !== s.direction };
    });
    return {
      exists: true,
      title: yours.title,
      hash,
      shots,
      changed: shots.filter((s) => s.changed).length,
      approved: shots.filter((s) => s.status === "approved").length,
      total: shots.length,
      plannedLength: Math.round(shots.reduce((a, s) => a + (s.length ?? 0), 0) * 1000) / 1000,
    };
  }

  /** The view with every still that goes through a link taken out: it is no still. */
  private async safe(v: StoryboardView): Promise<StoryboardView> {
    const shots = await Promise.all(v.shots.map(async (s) => (s.still && (await viaLink(this.store.root, s.still)) ? { ...s, still: null } : s)));
    return { ...v, shots };
  }

  view(): Promise<StoryboardView> {
    return this.run(async () => this.safe(this.build(await this.readText(), await this.store.read("storyboard"))));
  }

  /**
   * Saves a change to one shot. Changing an approved shot's description or direction reopens it (its status goes
   * back to draft) unless the same edit sets the status.
   */
  setShot(index: number, heading: string, edit: ShotEdit, expectHash: string): Promise<StoryboardView> {
    return this.run(async () => {
      const prev = await this.current(expectHash);
      const was = parseStoryboard(prev).shots.find((s) => s.index === index);
      const changesWords = was && ((edit.description !== undefined && edit.description.trim() !== was.description) || (edit.direction !== undefined && edit.direction.replace(/\s*\r?\n\s*/g, " ").trim() !== was.direction));
      const full: ShotEdit = was?.status === "approved" && changesWords && edit.status === undefined ? { ...edit, status: "draft" } : edit;
      let next: string;
      try {
        next = editShot(prev, index, heading, full);
      } catch (e) {
        throw new InvalidError((e as Error).message);
      }
      if (next !== prev) await this.write(prev, next);
      return this.safe(this.build(next, await this.store.read("storyboard")));
    });
  }

  /** The pictures the storyboard names, for the media route: only safe, project-relative image paths. */
  stills(): Promise<Set<string>> {
    return this.run(async () => {
      const text = await this.readText();
      const named = text === null ? [] : parseStoryboard(text).shots.flatMap((s) => (s.still ? [s.still] : []));
      const safe: string[] = [];
      for (const still of named) if (!(await viaLink(this.store.root, still))) safe.push(still);
      return new Set(safe);
    });
  }

  /** The shots as a new cut's shot list (each start the running total of the lengths), or none without a storyboard. */
  cutShots(): Promise<{ name: string; start: number; tag: string }[]> {
    return this.run(async () => {
      const text = await this.readText();
      return text === null ? [] : cutShots(parseStoryboard(text).shots);
    });
  }
}
