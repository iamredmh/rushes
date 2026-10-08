// §23: the one player for a cue's source sample. It shares the one-player bus (bus.ts) with the
// audio engine and the Assets player: playing a sample stops whatever was playing, and anything
// that starts later stops the sample. One element for the whole page, made on first use.
import { mediaUrl } from "../api.js";
import { claim, release } from "./bus.js";

/** What the player needs from an <audio> element (a fake in unit tests). */
export interface SampleElement {
  src: string;
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: "ended", listener: () => void): void;
}

export interface SampleState {
  /** The sample last played (null: none yet). */
  path: string | null;
  playing: boolean;
}

export class SamplePlayer {
  private el: SampleElement | null = null;
  private current: SampleState = { path: null, playing: false };
  private readonly listeners = new Set<(s: SampleState) => void>();
  private readonly make: () => SampleElement;
  private readonly url: (path: string) => string;

  constructor(make: () => SampleElement, url: (path: string) => string) {
    this.make = make;
    this.url = url;
  }

  state(): SampleState {
    return this.current;
  }

  subscribe(fn: (s: SampleState) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Plays `path` from the top, or stops it when it's the one playing. Rejects when it won't play. */
  async toggle(path: string): Promise<void> {
    if (this.current.playing && this.current.path === path) return this.stop();
    const el = this.element();
    el.pause();
    if (this.current.path !== path) el.src = this.url(path);
    el.currentTime = 0;
    claim(this, () => this.stop());
    this.set({ path, playing: true });
    try {
      await el.play();
    } catch (err) {
      // A later claim pausing this one interrupts play(): only a real failure is reported.
      if (this.current.path === path && this.current.playing) {
        release(this);
        this.set({ path, playing: false });
        throw err;
      }
    }
  }

  stop(): void {
    this.el?.pause();
    release(this);
    if (this.current.playing) this.set({ ...this.current, playing: false });
  }

  private element(): SampleElement {
    if (!this.el) {
      const el = this.make();
      el.addEventListener("ended", () => {
        release(this);
        this.set({ ...this.current, playing: false });
      });
      this.el = el;
    }
    return this.el;
  }

  private set(next: SampleState): void {
    this.current = next;
    for (const fn of this.listeners) fn(next);
  }
}

/** The page's one sample player. */
export const samples = new SamplePlayer(() => new Audio(), mediaUrl);
