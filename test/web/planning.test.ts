import { describe, expect, it } from "vitest";
import {
  LOCKED_BRIEF, LOCKED_STORYBOARD, PLAN_PAGES, briefPrompt, briefSendPrompt, briefTargetSeconds, firstView, isPlanPage, planProgress, planTarget, readyPrompt, storySendPrompt, storyboardPrompt,
} from "../../web/src/lib.js";
import type { TabState } from "../../web/src/types.js";

const tabs = (unlocked: Partial<Record<TabState["stage"], boolean>>): TabState[] =>
  (["script", "picture", "voice", "music", "sfx", "mix"] as const).map((stage) => ({ stage, unlocked: !!unlocked[stage], todo: 0 }));

describe("planning pages", () => {
  it("are Brief, Script and Storyboard, and only those are planning pages", () => {
    expect([...PLAN_PAGES]).toEqual(["brief", "script", "storyboard"]);
    for (const p of ["brief", "script", "storyboard"]) expect(isPlanPage(p)).toBe(true);
    expect(isPlanPage("picture")).toBe(false);
    expect(isPlanPage(null)).toBe(false);
  });

  it("key 1 goes to the page last used when it has something in it, else the first that does", () => {
    const open = (brief: boolean, script: boolean, storyboard: boolean) => ({ brief, script, storyboard });
    expect(planTarget("script", open(true, true, true))).toBe("script");
    expect(planTarget("storyboard", open(true, true, true))).toBe("storyboard");
    expect(planTarget("script", open(true, false, false))).toBe("brief");
    expect(planTarget("brief", open(false, true, true))).toBe("script");
    expect(planTarget("brief", open(false, false, true))).toBe("storyboard");
    // Nothing has anything in it: stay where you were, and the locked page explains.
    expect(planTarget("script", open(false, false, false))).toBe("script");
  });
});

describe("firstView", () => {
  it("opens Picture when there is a cut, else the brief, else the first unlocked tab", () => {
    expect(firstView(tabs({ picture: true, script: true }), { exists: true })).toBe("picture");
    expect(firstView(tabs({ script: true }), { exists: true })).toBe("brief");
    expect(firstView(tabs({ script: true }), { exists: false })).toBe("script");
    expect(firstView(tabs({}), { exists: false })).toBe("picture");
  });
});

describe("planProgress", () => {
  const sec = (status: "draft" | "approved" | "flagged") => ({ status });
  const board = (total: number, approved: number) => ({ total, approved });
  it("marks the brief ok only when it exists and is approved", () => {
    expect(planProgress({ exists: true, status: "approved" }, [], board(0, 0)).brief).toBe("ok");
    expect(planProgress({ exists: true, status: "draft" }, [], board(0, 0)).brief).toBe("none");
    expect(planProgress({ exists: true, status: null }, [], board(0, 0)).brief).toBe("none");
    expect(planProgress({ exists: false, status: "approved" }, [], board(0, 0)).brief).toBe("none");
  });
  it("marks the script ok when every section is approved, part when some are, else none", () => {
    const brief = { exists: true, status: "draft" as const };
    expect(planProgress(brief, [], board(0, 0)).script).toBe("none");
    expect(planProgress(brief, [sec("draft"), sec("flagged")], board(0, 0)).script).toBe("none");
    expect(planProgress(brief, [sec("approved"), sec("draft")], board(0, 0)).script).toBe("part");
    expect(planProgress(brief, [sec("approved"), sec("approved")], board(0, 0)).script).toBe("ok");
  });
  it("marks the storyboard the same way, and never ok with no shots", () => {
    const brief = { exists: true, status: "draft" as const };
    expect(planProgress(brief, [], board(0, 0)).storyboard).toBe("none");
    expect(planProgress(brief, [], board(4, 0)).storyboard).toBe("none");
    expect(planProgress(brief, [], board(4, 3)).storyboard).toBe("part");
    expect(planProgress(brief, [], board(4, 4)).storyboard).toBe("ok");
  });
});

describe("briefTargetSeconds", () => {
  const sections = (text: string) => ({ sections: [{ heading: "Length and formats", yours: text }] as { heading: string; yours: string }[] }) as never;
  it("reads the length the brief states", () => {
    expect(briefTargetSeconds(sections("Length: 30 seconds\nFormats: 16:9"))).toBe(30);
    expect(briefTargetSeconds(sections("length: 12.5s"))).toBe(12.5);
  });
  it("is null when the brief says nothing usable", () => {
    expect(briefTargetSeconds(sections("Length: _seconds_"))).toBeNull();
    expect(briefTargetSeconds(sections("Length: 0"))).toBeNull();
    expect(briefTargetSeconds({ sections: [{ heading: "Tone", yours: "Length: 30" }] } as never)).toBeNull();
    expect(briefTargetSeconds({ sections: [] })).toBeNull();
  });
});

describe("the pages' prompts", () => {
  it("the locked Brief page asks for a short interview and brief.md", () => {
    expect(LOCKED_BRIEF.ask).toBe("a brief");
    const p = briefPrompt("Lumen", "Launch film");
    expect(p).toContain('Rushes project "Lumen"');
    expect(p).toContain('for "Launch film"');
    expect(p).toContain("up to three questions");
    expect(p).toContain("brief.md");
    expect(briefPrompt("Lumen", null)).not.toContain(" for ");
  });
  it("the locked Storyboard page asks for storyboard.md in its format", () => {
    expect(LOCKED_STORYBOARD.ask).toBe("a storyboard");
    const p = storyboardPrompt("Lumen", "Launch film");
    expect(p).toContain("storyboard.md");
    expect(p).toContain('"## Shot 01 · Name"');
    expect(p).toContain("Status: draft");
    expect(p).toContain("storyboard/");
  });
  it("Ready to build asks for the film, named by shot, and the cut", () => {
    const p = readyPrompt("Lumen", "Launch film");
    expect(p).toContain("approved");
    expect(p).toContain("name each scene after its planned shot");
    expect(p).toContain("rushes_add_version");
  });
  it("Send to agent from Brief names what changed and says what comes next", () => {
    const sections = [{ heading: "Purpose", changed: true }, { heading: "Tone", changed: false }, { heading: "Audience", changed: true }];
    const draft = briefSendPrompt("Lumen", "Launch film", { status: "draft", sections });
    expect(draft).toContain("still a draft");
    expect(draft).toContain("these sections in brief.md: Purpose, Audience");
    expect(draft).toContain("Don't build anything until I approve it.");
    expect(briefSendPrompt("Lumen", null, { status: "draft", sections: [{ heading: "Tone", changed: true }] })).toContain("this section in brief.md: Tone");
    const done = briefSendPrompt("Lumen", null, { status: "approved", sections: [{ heading: "Tone", changed: false }] });
    expect(done).toContain("is approved");
    expect(done).not.toContain("I changed");
    expect(done).toContain("write the script with rushes_set_script");
  });
  it("Send to agent from Storyboard counts the approved shots and names the ones I changed", () => {
    const shots = [{ n: 2, name: "Drop a folder", changed: true }, { n: 4, name: "The number", changed: true }, { n: 1, name: "Cold open", changed: false }];
    const p = storySendPrompt("Lumen", "Launch film", { approved: 3, total: 6, shots });
    expect(p).toContain("3 of 6 shots in storyboard.md are approved");
    expect(p).toContain("these shots: Shot 02 · Drop a folder, Shot 04 · The number");
    expect(p).toContain("update the stills");
    expect(p).toContain("Don't build anything until I approve them all.");
    const one = storySendPrompt("Lumen", null, { approved: 1, total: 6, shots: [{ n: 1, name: "A", changed: true }] });
    expect(one).toContain("this shot: Shot 01 · A");
    expect(one).toContain("update the still if");
    const done = storySendPrompt("Lumen", null, { approved: 6, total: 6, shots: [{ n: 1, name: "A", changed: false }] });
    expect(done).not.toContain("I changed");
    expect(done).toContain("Next: build the film.");
  });
});
