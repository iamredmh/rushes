// §35.5: the desk keeps the here key Rushes put in the address, and takes it out of the address.
import { describe, expect, it, vi } from "vitest";
import { hereKey, keepHereKey } from "../../web/src/here.js";

describe("the desk's here key", () => {
  it("keeps #here=<key> for the tab and takes it out of the address", () => {
    const store = new Map<string, string>();
    const s = { setItem: (k: string, v: string) => void store.set(k, v), getItem: (k: string) => store.get(k) ?? null };
    const replace = vi.fn();
    vi.stubGlobal("history", { state: null, replaceState: replace });
    keepHereKey({ hash: "#here=tok%2D1", pathname: "/p/abcdefgh/", search: "?film=v_b" }, s);
    expect(hereKey(s)).toBe("tok-1");
    expect(replace).toHaveBeenCalledWith(null, "", "/p/abcdefgh/?film=v_b");
    replace.mockClear();
    keepHereKey({ hash: "", pathname: "/p/abcdefgh/", search: "" }, s);
    expect(replace).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("no key, or no storage: none", () => {
    expect(hereKey({ getItem: () => null })).toBeNull();
    expect(hereKey(null)).toBeNull();
  });
});
