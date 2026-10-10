import { describe, expect, it } from "vitest";
import { buildState, planWarning } from "../../src/core/plan.js";

const sec = (status: string) => ({ status });
const none = { exists: false, status: null } as const;
const noBoard = { exists: false, total: 0, approved: 0 };

describe("buildState", () => {
  it("is not started, and never ready, when there is no brief and no storyboard", () => {
    const b = buildState({ brief: none, script: [sec("approved")], storyboard: noBoard });
    expect(b).toMatchObject({ started: false, ready: false });
  });
  it("is ready only when the brief, every script section and every shot are approved", () => {
    const approved = { exists: true, status: "approved" } as const;
    expect(buildState({ brief: approved, script: [sec("approved"), sec("approved")], storyboard: { exists: true, total: 3, approved: 3 } })).toEqual({ started: true, ready: true, waitingOn: [] });
  });
  it("lists what it is waiting on, in order", () => {
    const draft = { exists: true, status: "draft" } as const;
    expect(buildState({ brief: draft, script: [sec("approved"), sec("draft")], storyboard: { exists: true, total: 3, approved: 2 } }).waitingOn).toEqual(["brief", "script", "storyboard"]);
    expect(buildState({ brief: { exists: true, status: "approved" }, script: [], storyboard: noBoard }).waitingOn).toEqual(["script", "storyboard"]);
  });
  it("does not count a storyboard with no shots as approved", () => {
    expect(buildState({ brief: { exists: true, status: "approved" }, script: [sec("approved")], storyboard: { exists: true, total: 0, approved: 0 } }).waitingOn).toEqual(["storyboard"]);
  });
  it("a flagged script section is not approved", () => {
    expect(buildState({ brief: { exists: true, status: "approved" }, script: [sec("flagged")], storyboard: { exists: true, total: 1, approved: 1 } }).waitingOn).toEqual(["script"]);
  });
});

describe("planWarning", () => {
  it("says what is outstanding, and nothing when ready or when planning never began", () => {
    expect(planWarning({ started: true, ready: false, waitingOn: ["brief"] })).toBe("The plan isn't approved yet: still waiting on the brief.");
    expect(planWarning({ started: true, ready: false, waitingOn: ["script", "storyboard"] })).toBe("The plan isn't approved yet: still waiting on the script and the storyboard.");
    expect(planWarning({ started: true, ready: false, waitingOn: ["brief", "script", "storyboard"] })).toBe("The plan isn't approved yet: still waiting on the brief, the script and the storyboard.");
    expect(planWarning({ started: true, ready: true, waitingOn: [] })).toBeNull();
    expect(planWarning({ started: false, ready: false, waitingOn: ["brief", "script", "storyboard"] })).toBeNull();
  });
});
