// §31.3: every film has its own brief.md and storyboard.md. This keeps one service per film for each of them, made
// when first asked for, and (once started) watches every film's file for changes made outside the dashboard.
import { filmPlace, type FilmPlace } from "../core/films.js";
import type { ChangeEvent, Store } from "../core/store.js";
import { BriefService } from "./brief.js";
import type { RecordFile } from "./record.js";
import { StoryboardService } from "./storyboard.js";

export class FilmRecords<S extends RecordFile> {
  /** One service per film, keyed by its baseline's slot ("" for the first film, or the project with no film yet). */
  private services = new Map<string, S>();
  private stops = new Map<string, () => void>();
  private pollMs: number | null = null;
  private unlisten: (() => void) | null = null;

  /** `root`: the service to use for the root file (the first film's), when one is already made. */
  constructor(private readonly store: Store, private readonly make: (place: FilmPlace) => S, root?: S) {
    if (root) this.services.set("", root);
  }

  /** The service for a film's file at `place`. Watched from the moment it is made, once start() has been called. */
  at(place: FilmPlace): S {
    const key = place.slot ?? "";
    let s = this.services.get(key);
    if (!s) {
      s = this.make(place);
      this.services.set(key, s);
    }
    if (this.pollMs !== null && !this.stops.has(key)) this.stops.set(key, s.start(this.pollMs));
    return s;
  }

  /** The service for a film (an id); none named, the first film's (or, with no film yet, the project's). */
  async of(video?: string | null): Promise<S> {
    return this.at(filmPlace(await this.store.read("project"), video));
  }

  /** The first film's, or with no film yet the project's: the root file. */
  get root(): S {
    return this.at(filmPlace({ videos: [] }, null));
  }

  /** Every film's service, the first film's first. */
  async all(): Promise<S[]> {
    const project = await this.store.read("project").catch(() => null);
    const places = project && project.videos.length > 0 ? project.videos.map((v) => filmPlace(project, v.id)) : [filmPlace({ videos: [] }, null)];
    return places.map((p) => this.at(p));
  }

  /** Watches every film's file, and a film's as soon as it is made. Returns a stop function. */
  start(pollMs = 500): () => void {
    this.pollMs = pollMs;
    void this.all().catch(() => undefined);
    const onChange = (e: ChangeEvent) => {
      if (e.file === "project") void this.all().catch(() => undefined);
    };
    this.store.on("change", onChange);
    this.unlisten = () => this.store.off("change", onChange);
    return () => {
      this.pollMs = null;
      this.unlisten?.();
      this.unlisten = null;
      for (const stop of this.stops.values()) stop();
      this.stops.clear();
    };
  }
}

export const briefRecords = (store: Store, root?: BriefService) => new FilmRecords(store, (place) => new BriefService(store, place), root);
export const storyboardRecords = (store: Store, root?: StoryboardService) => new FilmRecords(store, (place) => new StoryboardService(store, place), root);
export type BriefRecords = FilmRecords<BriefService>;
export type StoryboardRecords = FilmRecords<StoryboardService>;
