import { afterEach, describe, expect, it, vi } from "vitest";
import { claim, owner, release } from "../../web/src/audio/bus.js";

describe("the one-player bus", () => {
  afterEach(() => {
    release(owner());
  });

  it("stops the previous owner when a new one claims", () => {
    const stopAssets = vi.fn();
    const stopEngine = vi.fn();
    claim("assets", stopAssets);
    expect(owner()).toBe("assets");
    claim("engine", stopEngine);
    expect(stopAssets).toHaveBeenCalledTimes(1);
    expect(stopEngine).not.toHaveBeenCalled();
    expect(owner()).toBe("engine");
    claim("assets", stopAssets);
    expect(stopEngine).toHaveBeenCalledTimes(1);
  });

  it("doesn't stop an owner that claims again", () => {
    const stop = vi.fn();
    claim("engine", stop);
    claim("engine", stop);
    expect(stop).not.toHaveBeenCalled();
  });

  it("releases only for the current owner", () => {
    const stopA = vi.fn();
    claim("a", stopA);
    release("b");
    expect(owner()).toBe("a");
    const done = claim("b", vi.fn());
    expect(stopA).toHaveBeenCalledTimes(1);
    done();
    expect(owner()).toBeNull();
    // A stale release from an earlier claim doesn't drop a newer owner.
    const stale = claim("c", vi.fn());
    claim("d", vi.fn());
    stale();
    expect(owner()).toBe("d");
  });

  it("hands over even when the previous owner's stop throws", () => {
    claim("a", () => {
      throw new Error("boom");
    });
    expect(() => claim("b", vi.fn())).not.toThrow();
    expect(owner()).toBe("b");
  });

  it("uses object identity, so two engines are two owners", () => {
    const one = {};
    const two = {};
    const stopOne = vi.fn();
    claim(one, stopOne);
    claim(two, vi.fn());
    expect(stopOne).toHaveBeenCalledTimes(1);
  });
});
