import { describe, expect, it } from "vitest";
import { LOCKED_BRIEF, PLAN_PAGES, briefPrompt, briefSendPrompt, firstView, isPlanPage, planProgress, planTarget } from "../../web/src/lib.js";
import type { TabState } from "../../web/src/types.js";

const tabs = (unlocked: Partial<Record<TabState["stage"], boolean>>): TabState[] =>
  (["script", "picture", "voice", "music", "sfx", "mix"] as const).map((stage) => ({ stage, unlocked: !!unlocked[stage], todo: 0 }));

describe("planning pages", () => {
  it("are Brief then Script, and only those are planning pages", () => {
    expect([...PLAN_PAGES]).toEqual(["brief", "script"]);
    expect(isPlanPage("brief")).toBe(true);
    expect(isPlanPage("script")).toBe(true);
    expect(isPlanPage("picture")).toBe(false);
    expect(isPlanPage(null)).toBe(false);
  });

  it("key 1 goes to the page last used when it has something in it, else the first that does", () => {
    expect(planTarget("script", { brief: true, script: true })).toBe("script");
    expect(planTarget("brief", { brief: true, script: true })).toBe("brief");
    expect(planTarget("script", { brief: true, script: false })).toBe("brief");
    expect(planTarget("brief", { brief: false, script: true })).toBe("script");
    // Nothing has anything in it: stay where you were, and the locked page explains.
    expect(planTarget("script", { brief: false, script: false })).toBe("script");
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
  it("marks the brief ok only when it exists and is approved", () => {
    expect(planProgress({ exists: true, status: "approved" }, []).brief).toBe("ok");
    expect(planProgress({ exists: true, status: "draft" }, []).brief).toBe("none");
    expect(planProgress({ exists: true, status: null }, []).brief).toBe("none");
    expect(planProgress({ exists: false, status: "approved" }, []).brief).toBe("none");
  });
  it("marks the script ok when every section is approved, part when some are, else none", () => {
    const brief = { exists: true, status: "draft" as const };
    expect(planProgress(brief, []).script).toBe("none");
    expect(planProgress(brief, [sec("draft"), sec("flagged")]).script).toBe("none");
    expect(planProgress(brief, [sec("approved"), sec("draft")]).script).toBe("part");
    expect(planProgress(brief, [sec("approved"), sec("approved")]).script).toBe("ok");
  });
});

describe("the Brief page's prompts", () => {
  it("the locked page asks for a short interview and brief.md", () => {
    expect(LOCKED_BRIEF.ask).toBe("a brief");
    const p = briefPrompt("Lumen", "Launch film");
    expect(p).toContain('Rushes project "Lumen"');
    expect(p).toContain('for "Launch film"');
    expect(p).toContain("up to three questions");
    expect(p).toContain("brief.md");
    expect(briefPrompt("Lumen", null)).not.toContain(" for ");
  });
  it("Send to agent names what changed and says what comes next", () => {
    const sections = [
      { heading: "Purpose", changed: true },
      { heading: "Tone", changed: false },
      { heading: "Audience", changed: true },
    ];
    const draft = briefSendPrompt("Lumen", "Launch film", { status: "draft", sections });
    expect(draft).toContain("still a draft");
    expect(draft).toContain("these sections in brief.md: Purpose, Audience");
    expect(draft).toContain("Don't build anything until I approve it.");
    const one = briefSendPrompt("Lumen", null, { status: "draft", sections: [{ heading: "Tone", changed: true }] });
    expect(one).toContain("this section in brief.md: Tone");
    const done = briefSendPrompt("Lumen", null, { status: "approved", sections: [{ heading: "Tone", changed: false }] });
    expect(done).toContain("is approved");
    expect(done).not.toContain("I changed");
    expect(done).toContain("write the script with rushes_set_script");
  });
});
