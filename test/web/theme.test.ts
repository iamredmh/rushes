import { describe, expect, it } from "vitest";
import { nextTheme, readTheme, resolveTheme } from "../../web/src/theme.js";

describe("theme", () => {
  it("defaults to dark", () => {
    expect(readTheme({ getItem: () => null })).toBe("dark");
    expect(readTheme(null)).toBe("dark");
  });
  it("reads a saved setting and ignores junk", () => {
    expect(readTheme({ getItem: () => "light" })).toBe("light");
    expect(readTheme({ getItem: () => "system" })).toBe("system");
    expect(readTheme({ getItem: () => "purple" })).toBe("dark");
  });
  it("opens dark when storage throws", () => {
    expect(readTheme({ getItem: () => { throw new Error("blocked"); } })).toBe("dark");
  });
  it("resolves system from the machine", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
  it("cycles dark, light, system", () => {
    expect(nextTheme("dark")).toBe("light");
    expect(nextTheme("light")).toBe("system");
    expect(nextTheme("system")).toBe("dark");
  });
});
