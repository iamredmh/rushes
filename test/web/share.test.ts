import { afterEach, describe, expect, it } from "vitest";
import { PREVIEW_MAX, PREVIEW_MIN, readShare } from "../../web/src/ui/desk/share.js";

const store = new Map<string, string>();
const fake = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

function withStorage(storage: unknown) {
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
}

afterEach(() => {
  store.clear();
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("readShare (the preview's and the timeline's remembered size)", () => {
  it("is null until a size has been kept", () => {
    withStorage(fake);
    expect(readShare("rushes:preview", PREVIEW_MIN, PREVIEW_MAX)).toBeNull();
  });
  it("reads a kept size", () => {
    withStorage(fake);
    store.set("rushes:preview", "0.4");
    expect(readShare("rushes:preview", PREVIEW_MIN, PREVIEW_MAX)).toBe(0.4);
  });
  it("holds a kept size between the bounds", () => {
    withStorage(fake);
    store.set("rushes:preview", "2");
    expect(readShare("rushes:preview", PREVIEW_MIN, PREVIEW_MAX)).toBe(PREVIEW_MAX);
    store.set("rushes:preview", "-1");
    expect(readShare("rushes:preview", PREVIEW_MIN, PREVIEW_MAX)).toBe(PREVIEW_MIN);
  });
  it("ignores an empty or broken value rather than reading it as the smallest size", () => {
    withStorage(fake);
    for (const bad of ["", "  ", "big", "NaN"]) {
      store.set("rushes:preview", bad);
      expect(readShare("rushes:preview", PREVIEW_MIN, PREVIEW_MAX)).toBeNull();
    }
  });
  it("is null when storage is refused (a private window)", () => {
    withStorage({ getItem: () => { throw new Error("denied"); } });
    expect(readShare("rushes:preview", PREVIEW_MIN, PREVIEW_MAX)).toBeNull();
  });
});
