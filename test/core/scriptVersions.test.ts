// §38.5: the script's own versions, kept each time the agent writes it with words that changed.
import { describe, expect, it } from "vitest";
import { MAX_SCRIPT_VERSIONS, recordVersion, snapshotOf, filmKey } from "../../src/core/scriptVersions.js";
import { ScriptVersionsFileSchema } from "../../src/core/schema.js";

const sec = (id: string, current: string, start = 0, end = 3) => ({ id, start, end, current, proposed: null, direction: "", status: "draft" as const, takes: [] });
const AT = "2026-11-27T12:00:00.000Z";

describe("recordVersion", () => {
  it("keeps the first script as v1", () => {
    const list = recordVersion([], [sec("s1", "Hello.")], AT);
    expect(list).toEqual([{ id: "v1", at: AT, lines: [{ id: "s1", start: 0, end: 3, text: "Hello." }] }]);
  });

  it("keeps what was there before as v1 when the first write it sees is a change", () => {
    const list = recordVersion([], [sec("s1", "New.")], AT, [sec("s1", "Old.")]);
    expect(list.map((v) => [v.id, v.lines[0].text])).toEqual([["v1", "Old."], ["v2", "New."]]);
  });

  it("makes no version when only the timings changed", () => {
    const one = recordVersion([], [sec("s1", "Hello.")], AT);
    expect(recordVersion(one, [sec("s1", "Hello.", 1, 4)], AT)).toBe(one);
  });

  it("makes a version when a word changed, a line came or a line went", () => {
    let list = recordVersion([], [sec("s1", "Hello.")], AT);
    list = recordVersion(list, [sec("s1", "Hello there.")], AT);
    list = recordVersion(list, [sec("s1", "Hello there."), sec("s2", "Bye.")], AT);
    list = recordVersion(list, [sec("s2", "Bye.")], AT);
    expect(list.map((v) => v.id)).toEqual(["v1", "v2", "v3", "v4"]);
  });

  it(`keeps ${MAX_SCRIPT_VERSIONS} versions, the oldest going first, and never hands out a number twice`, () => {
    let list = recordVersion([], [sec("s1", "w0")], AT);
    for (let i = 1; i <= MAX_SCRIPT_VERSIONS; i++) list = recordVersion(list, [sec("s1", `w${i}`)], AT);
    expect(list).toHaveLength(MAX_SCRIPT_VERSIONS);
    expect(list[0].id).toBe("v2");
    expect(list.at(-1)!.id).toBe(`v${MAX_SCRIPT_VERSIONS + 1}`);
  });

  it("a script with no lines is no version", () => {
    expect(recordVersion([], [], AT)).toEqual([]);
  });
});

describe("snapshotOf and filmKey", () => {
  it("keeps the agent's wording, never the user's proposal", () => {
    const withProposal = { id: "s1", start: 0, end: 3, current: "Agent.", proposed: "Mine." };
    expect(snapshotOf([withProposal])).toEqual([{ id: "s1", start: 0, end: 3, text: "Agent." }]);
  });
  it("files a script on no film under _", () => {
    expect(filmKey(null)).toBe("_");
    expect(filmKey("hero")).toBe("hero");
  });
});

describe("script-versions.json", () => {
  it("reads as no versions when empty", () => {
    expect(ScriptVersionsFileSchema.parse({ schema: 1, rev: 0 }).films).toEqual({});
  });
});
