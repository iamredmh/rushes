import { describe, expect, it } from "vitest";
import { notificationScript, osNotifier } from "../../../src/server/agent/notify.js";

describe("the macOS notification (spec §5.4)", () => {
  it("is a display notification with the text escaped, on one line", () => {
    expect(notificationScript("Rushes", "Claude Code is waiting for you in My Project")).toBe(
      'display notification "Claude Code is waiting for you in My Project" with title "Rushes"',
    );
    expect(notificationScript("Rushes", 'Codex is waiting for you in Say "hi" \\ there\nnow')).toBe(
      'display notification "Codex is waiting for you in Say \\"hi\\" \\\\ there now" with title "Rushes"',
    );
  });

  it("runs osascript with that one script on macOS, and nothing elsewhere or when turned off", async () => {
    const ran: Array<[string, string[]]> = [];
    const run = async (file: string, args: string[]) => void ran.push([file, args]);
    await osNotifier({ platform: "darwin", env: {}, run })("Rushes", "Codex is waiting for you in A");
    expect(ran).toEqual([["osascript", ["-e", 'display notification "Codex is waiting for you in A" with title "Rushes"']]]);
    await osNotifier({ platform: "linux", env: {}, run })("Rushes", "x");
    await osNotifier({ platform: "win32", env: {}, run })("Rushes", "x");
    await osNotifier({ platform: "darwin", env: { RUSHES_NO_NOTIFY: "1" }, run })("Rushes", "x");
    expect(ran).toHaveLength(1);
    // A failing osascript never throws.
    await osNotifier({ platform: "darwin", env: {}, run: async () => { throw new Error("no"); } })("Rushes", "x");
  });
});
