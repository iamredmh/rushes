import { afterEach, describe, expect, it } from "vitest";
import { claim, owner, release } from "../../web/src/audio/bus.js";
import { SamplePlayer, type SampleElement, type SampleState } from "../../web/src/audio/sample.js";

class FakeAudio implements SampleElement {
  src = "";
  currentTime = 0;
  paused = true;
  fail = false;
  private readonly onEnded: (() => void)[] = [];
  async play(): Promise<void> {
    if (this.fail) throw new Error("NotSupportedError");
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
  addEventListener(_type: "ended", fn: () => void): void {
    this.onEnded.push(fn);
  }
  end(): void {
    this.paused = true;
    for (const fn of this.onEnded) fn();
  }
}

const THUD = "audio/sfx/samples/thud_low_03.wav";
const POP = "audio/sfx/samples/pop_bubble_05.wav";
let made: SamplePlayer[] = [];

function setup() {
  const el = new FakeAudio();
  let elements = 0;
  const player = new SamplePlayer(() => (elements++, el), (p) => `/media?path=${encodeURIComponent(p)}`);
  made.push(player);
  return { el, player, elements: () => elements };
}

afterEach(() => {
  for (const p of made) p.stop();
  made = [];
  const o = owner();
  if (o !== null) release(o);
});

describe("SamplePlayer: a cue's sample on the one-player bus (§23, ruling R9)", () => {
  it("makes its one element only when first asked to play", async () => {
    const { player, elements } = setup();
    expect(elements()).toBe(0);
    await player.toggle(THUD);
    await player.toggle(POP);
    expect(elements()).toBe(1);
  });

  it("plays from the top and stops whoever held the bus", async () => {
    const { el, player } = setup();
    let engineStops = 0;
    claim("engine", () => engineStops++);
    el.currentTime = 2.5;
    await player.toggle(THUD);
    expect(engineStops).toBe(1);
    expect(owner()).toBe(player);
    expect(el.src).toBe("/media?path=audio%2Fsfx%2Fsamples%2Fthud_low_03.wav");
    expect(el.currentTime).toBe(0);
    expect(el.paused).toBe(false);
    expect(player.state()).toEqual({ path: THUD, playing: true });
  });

  it("a second press on the playing sample stops it and lets the bus go; another sample swaps in", async () => {
    const { el, player } = setup();
    await player.toggle(THUD);
    await player.toggle(THUD);
    expect(player.state()).toEqual({ path: THUD, playing: false });
    expect(el.paused).toBe(true);
    expect(owner()).toBeNull();
    await player.toggle(POP);
    expect(player.state()).toEqual({ path: POP, playing: true });
    expect(el.src).toContain("pop_bubble_05.wav");
  });

  it("stops when anything else claims the bus (Play on the tab)", async () => {
    const { el, player } = setup();
    await player.toggle(THUD);
    claim("engine", () => undefined);
    expect(el.paused).toBe(true);
    expect(player.state().playing).toBe(false);
    expect(owner()).toBe("engine");
  });

  it("lets the bus go when the sample ends", async () => {
    const { el, player } = setup();
    await player.toggle(THUD);
    el.end();
    expect(player.state()).toEqual({ path: THUD, playing: false });
    expect(owner()).toBeNull();
  });

  it("a sample that won't play rejects, and isn't left marked as playing (Review Focus 5)", async () => {
    const { el, player } = setup();
    el.fail = true;
    await expect(player.toggle(THUD)).rejects.toThrow(/NotSupportedError/);
    expect(player.state()).toEqual({ path: THUD, playing: false });
    expect(owner()).toBeNull();
  });

  it("tells its subscribers about each change, until they unsubscribe", async () => {
    const { el, player } = setup();
    const seen: SampleState[] = [];
    const off = player.subscribe((s) => seen.push(s));
    await player.toggle(THUD);
    el.end();
    off();
    await player.toggle(POP);
    expect(seen).toEqual([{ path: THUD, playing: true }, { path: THUD, playing: false }]);
  });
});
