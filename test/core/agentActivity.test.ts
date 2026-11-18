import { describe, expect, it } from "vitest";
import { AGENT_LINES, ActivityTracker, activityLine } from "../../src/core/agentActivity.js";

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

describe("activityLine masks secrets in a command (M3)", () => {
  const cmd = (command: string) => activityLine({ sessionUpdate: "tool_call", title: "Bash", rawInput: { command } }, root);
  const title = (t: string) => activityLine({ sessionUpdate: "tool_call", title: t }, root);

  it("a bearer token", () => {
    expect(cmd("curl -H 'X: Bearer sk-abc123' https://api.example.com")).toBe("Ran a command: curl -H 'X: Bearer •••' https://api.example.com");
  });

  it("an Authorization header, whatever its scheme", () => {
    expect(cmd(`curl -H "Authorization: Basic dXNlcjpwYXNz" https://x.test`)).toBe(`Ran a command: curl -H "Authorization: •••" https://x.test`);
    expect(cmd(`curl -H "authorization:abc123" https://x.test`)).toBe(`Ran a command: curl -H "authorization:•••" https://x.test`);
    expect(cmd(`curl -H "Authorization: Bearer abc123" https://x.test`)).toBe(`Ran a command: curl -H "Authorization: •••" https://x.test`);
  });

  it("--token and --password, with a space or an equals sign, quoted or not", () => {
    expect(cmd("gh auth login --token ghp_abc123 --hostname x")).toBe("Ran a command: gh auth login --token ••• --hostname x");
    expect(cmd("tool --token=ghp_abc123 run")).toBe("Ran a command: tool --token=••• run");
    expect(cmd(`mysql --password "hunter 2" -u me`)).toBe("Ran a command: mysql --password ••• -u me");
    expect(cmd("mysql --password=hunter2 -u me")).toBe("Ran a command: mysql --password=••• -u me");
  });

  it("password=, token=, api_key= and apikey= anywhere, a URL's query included", () => {
    expect(cmd("curl 'https://x.test/a?token=abc123&page=2'")).toBe("Ran a command: curl 'https://x.test/a?token=•••&page=2'");
    expect(cmd("login password=hunter2 user=me")).toBe("Ran a command: login password=••• user=me");
    expect(cmd("curl https://x.test/?api_key=abc123")).toBe("Ran a command: curl https://x.test/?api_key=•••");
    expect(cmd("curl https://x.test/?apikey=abc123")).toBe("Ran a command: curl https://x.test/?apikey=•••");
    expect(cmd("curl https://x.test/?APIKEY=abc123")).toBe("Ran a command: curl https://x.test/?APIKEY=•••");
  });

  it("an environment variable named _KEY, _TOKEN or _SECRET", () => {
    expect(cmd("OPENAI_API_KEY=sk-abc123 node run.js")).toBe("Ran a command: OPENAI_API_KEY=••• node run.js");
    expect(cmd("GITHUB_TOKEN=ghp_abc123 gh pr list")).toBe("Ran a command: GITHUB_TOKEN=••• gh pr list");
    expect(cmd(`export AWS_SECRET="abc 123"; aws s3 ls`)).toBe("Ran a command: export AWS_SECRET=•••; aws s3 ls");
  });

  it("in a tool's title too, and before the line is cut, so no part of a secret is left", () => {
    expect(title("Run curl -H 'Authorization: Bearer abc123' https://x.test")).toBe("Run curl -H 'Authorization: •••' https://x.test");
    const long = cmd(`${"x".repeat(70)} --token abcdefghijklmnopqrstuvwxyz0123456789`)!;
    expect(long).not.toMatch(/abcdef/);
  });

  it("leaves a command with no secret as it is", () => {
    for (const c of ["npm test", "git commit -m 'add token support'", "ls --tokens-dir out", "echo password reset", "MONKEY=1 node a.js", "ffprobe -v error a.mp4"]) {
      expect(cmd(c)).toBe(`Ran a command: ${c}`);
    }
  });
});

describe("ActivityTracker: a command's line comes once it runs, and names it (Task 10, 3)", () => {
  const feed = (t: ActivityTracker, ...updates: object[]) => updates.map((u) => t.line(u));

  it("Claude: the call starts pending with no input, gets its command, waits on an ask, then completes: one line, at completion", () => {
    const t = new ActivityTracker(root);
    expect(feed(t,
      { sessionUpdate: "tool_call", toolCallId: "b1", title: "Terminal", kind: "execute", status: "pending", rawInput: {} },
      { sessionUpdate: "tool_call_update", toolCallId: "b1", rawInput: { command: "for f in renders/*.mp4; do ffprobe -v error \"$f\"; done" } },
    )).toEqual([null, null]);
    expect(t.line({ sessionUpdate: "tool_call_update", toolCallId: "b1", status: "completed" })).toBe('Ran a command: for f in renders/*.mp4; do ffprobe -v error "$f"; done');
    expect(t.line({ sessionUpdate: "tool_call_update", toolCallId: "b1", status: "completed" })).toBeNull();
  });

  it("Codex: a command starts in_progress (codex-acp sends no pending), may then wait on an ask, then completes: one line, at completion", () => {
    const t = new ActivityTracker(root);
    // item/started: toToolStatus gives in_progress; an ask for this started command can follow.
    expect(t.line({ sessionUpdate: "tool_call", toolCallId: "c1", title: "ffprobe -v error a.mp4", kind: "execute", status: "in_progress", rawInput: { command: ["ffprobe", "-v", "error", `${root}/a.mp4`] } })).toBeNull();
    expect(t.line({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" })).toBeNull();
    expect(t.line({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" })).toBe("Ran a command: ffprobe -v error a.mp4");
    expect(t.line({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" })).toBeNull();
  });

  it("a Codex command declined at its ask ends failed (declined maps to failed) and never says it ran", () => {
    const t = new ActivityTracker(root);
    t.line({ sessionUpdate: "tool_call", toolCallId: "d1", title: "rm -rf build", kind: "execute", status: "in_progress", rawInput: { command: "rm -rf build" } });
    expect(t.line({ sessionUpdate: "tool_call_update", toolCallId: "d1", status: "failed" })).toBe("A command failed or was not run: rm -rf build");
  });

  it("a command refused at its ask, or that fails, never says it ran", () => {
    const t = new ActivityTracker(root);
    t.line({ sessionUpdate: "tool_call", toolCallId: "x", title: "Terminal", kind: "execute", status: "pending", rawInput: { command: "rm -rf build" } });
    expect(t.line({ sessionUpdate: "tool_call_update", toolCallId: "x", status: "failed" })).toBe("A command failed or was not run: rm -rf build");
  });

  it("the command is its first line, clipped, with secrets masked and the project folder cut", () => {
    const t = new ActivityTracker(root);
    t.line({ sessionUpdate: "tool_call", toolCallId: "h", kind: "execute", title: "Terminal", rawInput: { command: `GITHUB_TOKEN=ghp_abc123 node ${root}/run.js\nsecond line` } });
    expect(t.line({ sessionUpdate: "tool_call_update", toolCallId: "h", status: "completed" })).toBe("Ran a command: GITHUB_TOKEN=••• node run.js");
    t.line({ sessionUpdate: "tool_call", toolCallId: "l", kind: "execute", title: "Terminal", rawInput: { command: "echo " + "x".repeat(300) } });
    const long = t.line({ sessionUpdate: "tool_call_update", toolCallId: "l", status: "completed" })!;
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith("…")).toBe(true);
  });

  it("a command with no text in its input is named by its title when that is not a generic shell title", () => {
    const t = new ActivityTracker(root);
    t.line({ sessionUpdate: "tool_call", toolCallId: "n", kind: "execute", title: "npm test" });
    expect(t.line({ sessionUpdate: "tool_call_update", toolCallId: "n", status: "completed" })).toBe("Ran a command: npm test");
    t.line({ sessionUpdate: "tool_call", toolCallId: "m", kind: "execute", title: "Terminal" });
    expect(t.line({ sessionUpdate: "tool_call_update", toolCallId: "m", status: "completed" })).toBe("Ran a command");
  });

  it("other tool calls say their title at once, as before; own Rushes tools and MCP calls are not commands", () => {
    const t = new ActivityTracker(root);
    expect(t.line({ sessionUpdate: "tool_call", toolCallId: "r", title: `Opened ${root}/a.html`, kind: "read" })).toBe("Opened a.html");
    expect(t.line({ sessionUpdate: "tool_call", toolCallId: "o", title: "mcp.rushes.rushes_reply", kind: "execute", rawInput: { server: "rushes", tool: "rushes_reply" } })).toBeNull();
    expect(t.line({ sessionUpdate: "tool_call_update", toolCallId: "o", status: "completed" })).toBeNull();
    expect(t.line({ sessionUpdate: "plan", entries: [1, 2] })).toBe("Planned 2 steps");
  });
});
