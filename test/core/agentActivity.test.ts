import { describe, expect, it } from "vitest";
import { AGENT_LINES, activityLine } from "../../src/core/agentActivity.js";

const root = "/Users/someone/Work/My Project";

describe("AGENT_LINES", () => {
  it("is the exact text the runner adds after the batch prompt", () => {
    expect(AGENT_LINES).toBe(
      "Before you start on each note, call rushes_working_on with the note's id and what you are doing, in a few plain words.\n" +
        "If you are not sure what a note means, ask on the note with rushes_reply (no status) and go on to the next one. The user answers on the note.\n" +
        "Only add a new version when the picture or sound changed.\n" +
        "Wait for each command to finish before you reply on a note; do not run work as a background task.",
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

  it("never trims a sibling folder that shares the root's name as a prefix (M7)", () => {
    const line = (title: string) => activityLine({ sessionUpdate: "tool_call", title }, root);
    expect(line(`Opened ${root} 2/a.mp4`)).toBe(`Opened ${root} 2/a.mp4`);
    expect(line(`Opened ${root}2/a.mp4`)).toBe(`Opened ${root}2/a.mp4`);
    expect(line(`Opened ${root}-old/a.mp4`)).toBe(`Opened ${root}-old/a.mp4`);
    expect(line(`Copied ${root}/a.mp4 to ${root} 2/a.mp4`)).toBe(`Copied a.mp4 to ${root} 2/a.mp4`);
    // A path that only contains the root further in is not under it.
    expect(line(`Opened /Volumes/x${root}/a.mp4`)).toBe(`Opened /Volumes/x${root}/a.mp4`);
    // The root itself, at the end or before punctuation, is ".".
    expect(line(`Listed ${root}`)).toBe("Listed .");
    expect(line(`Listed "${root}", then stopped`)).toBe(`Listed ".", then stopped`);
  });

  it("a tool call title is one line and kept short", () => {
    expect(activityLine({ sessionUpdate: "tool_call", title: "Ran\nnpm test" }, root)).toBe("Ran npm test");
    const long = activityLine({ sessionUpdate: "tool_call", title: "x".repeat(500) }, root)!;
    expect(long.length).toBeLessThanOrEqual(120);
  });

  it("the agent's own Rushes tools say nothing, in Claude's and Codex's spelling", () => {
    const t = (title: string) => activityLine({ sessionUpdate: "tool_call", title }, root);
    expect(t("mcp__rushes__rushes_reply")).toBeNull();
    expect(t("mcp__rushes__rushes_working_on")).toBeNull();
    expect(t("mcp.rushes.rushes_reply")).toBeNull();
    expect(t("mcp.rushes.rushes_working_on")).toBeNull();
    // Another server's tool is not the agent's own Rushes call.
    expect(t("mcp__other__rushes_reply")).not.toBeNull();
    expect(t("mcp__rushes__other")).not.toBeNull();
  });

  it("housekeeping tools say nothing", () => {
    const t = (title: string) => activityLine({ sessionUpdate: "tool_call", title }, root);
    for (const title of ["Load skill", "ToolSearch", "Guardian Review", "Preparing file…"]) expect(t(title), title).toBeNull();
  });

  it("Terminal and Bash read as a command, with its first line when it has one", () => {
    const t = (title: string, rawInput?: unknown) => activityLine({ sessionUpdate: "tool_call", title, rawInput }, root);
    expect(t("Terminal", { command: "python3 - <<'PY'\nprint(1)\nPY" })).toBe("Ran a command: python3 - <<'PY'");
    expect(t("Bash", { command: "npm test" })).toBe("Ran a command: npm test");
    expect(t("Terminal")).toBe("Ran a command");
    expect(t("Bash", { command: 5 })).toBe("Ran a command");
    expect(t("Terminal", { command: "" })).toBe("Ran a command");
    expect(t("Terminal", { command: "\n\nls -la" })).toBe("Ran a command: ls -la");
    // The project folder is cut from a path in the command.
    expect(t("Bash", { command: `cat ${root}/notes.md` })).toBe("Ran a command: cat notes.md");
  });

  it("a command is cut to 80 characters with an ellipsis, and any line to 120", () => {
    const t = (title: string, rawInput?: unknown) => activityLine({ sessionUpdate: "tool_call", title, rawInput }, root)!;
    const cut = t("Terminal", { command: "x".repeat(300) });
    expect(cut).toBe(`Ran a command: ${"x".repeat(79)}…`);
    expect(cut.length).toBe("Ran a command: ".length + 80);
    expect(t("Terminal", { command: "y".repeat(80) })).toBe(`Ran a command: ${"y".repeat(80)}`);
    expect(t("Read file", undefined).length).toBeLessThanOrEqual(120);
    const long = activityLine({ sessionUpdate: "tool_call", title: "z".repeat(500) }, root)!;
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith("…")).toBe(true);
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
