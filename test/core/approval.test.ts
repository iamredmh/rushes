import { describe, expect, it } from "vitest";
import { statusAfterEdit } from "../../src/core/approval.js";

describe("the plan's approval rule", () => {
  it("a change to the words of an approved item reopens it", () => {
    expect(statusAfterEdit("approved", { wordsChanged: true })).toBe("draft");
  });
  it("unless the same edit sets the status", () => {
    expect(statusAfterEdit("approved", { wordsChanged: true, status: "approved" })).toBe("approved");
    expect(statusAfterEdit("approved", { wordsChanged: true, status: "flagged" })).toBe("flagged");
  });
  it("a save that changes no words keeps the approval, and an item that isn't approved keeps its status", () => {
    expect(statusAfterEdit("approved", { wordsChanged: false })).toBe("approved");
    expect(statusAfterEdit("flagged", { wordsChanged: true })).toBe("flagged");
    expect(statusAfterEdit("draft", { wordsChanged: true })).toBe("draft");
    expect(statusAfterEdit("draft", { wordsChanged: false, status: "approved" })).toBe("approved");
  });
});
