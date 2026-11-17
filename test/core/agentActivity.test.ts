import { describe, expect, it } from "vitest";
import { AGENT_LINES, activityLine } from "../../src/core/agentActivity.js";

const root = "/Users/someone/Work/My Project";

describe("AGENT_LINES", () => {
  it("is the exact text the runner adds after the batch prompt", () => {
    expect(AGENT_LINES).toBe(
      "Before you start on each note, call rushes_working_on with the note's id and what you are doing, in a few plain words.\n" +
        "If you are not sure what a note means, ask on the note with rushes_reply (no status) and go on to the next one. The user answers on the note.",
    );
  });
});

describe("activityLine", () => {
  it("a tool call is its title with the project root cut from any path", () => {
    expect(activityLine({ sessionUpdate: "tool_call", toolCallId: "t1", title: `Opened ${root}/compositions/engine-sizes.html` }, root)).toBe(
      "Opened compositions/engine-sizes.html",
    );
    expect(activityLine({ sessionUpdate: "tool_call", toolCallId: "t2", title: `Copied ${root}/a.mp4 to ${root}/exports/a.mp4` }, root)).toBe(
      "Copied a.mp4 to exports/a.mp4",
    );
    // The root itself, and a root given with a trailing slash.
    expect(activityLine({ sessionUpdate: "tool_call", title: `Listed ${root}` }, root + "/")).toBe("Listed .");
    expect(activityLine({ sessionUpdate: "tool_call", title: "Ran the render" }, root)).toBe("Ran the render");
  });

  it("a tool call title is one line and kept short", () => {
    expect(activityLine({ sessionUpdate: "tool_call", title: "Ran\nnpm test" }, root)).toBe("Ran npm test");
    const long = activityLine({ sessionUpdate: "tool_call", title: "x".repeat(500) }, root)!;
    expect(long.length).toBeLessThanOrEqual(200);
  });

  it("a tool call with no title says nothing", () => {
    expect(activityLine({ sessionUpdate: "tool_call", title: "  " }, root)).toBeNull();
    expect(activityLine({ sessionUpdate: "tool_call" }, root)).toBeNull();
  });

  it("a plan is the number of its steps", () => {
    expect(activityLine({ sessionUpdate: "plan", entries: [{}, {}, {}] }, root)).toBe("Planned 3 steps");
    expect(activityLine({ sessionUpdate: "plan", entries: [{}] }, root)).toBe("Planned 1 step");
  });

  it("message chunks and unknown kinds are left out", () => {
    expect(activityLine({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } }, root)).toBeNull();
    expect(activityLine({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }, root)).toBeNull();
    expect(activityLine({ sessionUpdate: "something_new" }, root)).toBeNull();
    expect(activityLine(null, root)).toBeNull();
    expect(activityLine("text", root)).toBeNull();
  });
});
