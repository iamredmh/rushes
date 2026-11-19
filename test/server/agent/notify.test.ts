import { describe, expect, it } from "vitest";
import { WINDOWS_TOAST_SCRIPT, notificationScript, osNotifier } from "../../../src/server/agent/notify.js";

describe("the macOS notification (spec §5.4)", () => {
  it("is a display notification with the text escaped, on one line", () => {
    expect(notificationScript("Rushes", "Claude Code is waiting for you in My Project")).toBe(
      'display notification "Claude Code is waiting for you in My Project" with title "Rushes"',
    );
    expect(notificationScript("Rushes", 'Codex is waiting for you in Say "hi" \\ there\nnow')).toBe(
      'display notification "Codex is waiting for you in Say \\"hi\\" \\\\ there now" with title "Rushes"',
    );
  });

  it("runs osascript with that one script on macOS, and nothing when turned off", async () => {
    const ran: Array<[string, string[]]> = [];
    const run = async (file: string, args: string[]) => void ran.push([file, args]);
    await osNotifier({ platform: "darwin", env: {}, run })("Rushes", "Codex is waiting for you in A");
    expect(ran).toEqual([["osascript", ["-e", 'display notification "Codex is waiting for you in A" with title "Rushes"']]]);
    for (const platform of ["darwin", "linux", "win32"] as const) {
      await osNotifier({ platform, env: { RUSHES_NO_NOTIFY: "1" }, run, find: () => "/usr/bin/notify-send" })("Rushes", "x");
    }
    expect(ran).toHaveLength(1);
    // A failing osascript never throws.
    await osNotifier({ platform: "darwin", env: {}, run: async () => { throw new Error("no"); } })("Rushes", "x");
  });
});

describe("§34: notifications on Linux and Windows", () => {
  it("Linux: notify-send when it is installed, the text after --, on one line; nothing without it", async () => {
    const ran: Array<[string, string[]]> = [];
    const run = async (file: string, args: string[]) => void ran.push([file, args]);
    await osNotifier({ platform: "linux", env: {}, run, find: () => "/usr/bin/notify-send" })("--title", "Codex is waiting\nin A");
    expect(ran).toEqual([["/usr/bin/notify-send", ["--app-name=Rushes", "--", "--title", "Codex is waiting in A"]]]);
    await osNotifier({ platform: "linux", env: {}, run, find: () => null })("Rushes", "x");
    expect(ran).toHaveLength(1);
  });

  it("Windows: a PowerShell toast whose text comes from the environment, never the script", async () => {
    const ran: Array<[string, string[], NodeJS.ProcessEnv | undefined]> = [];
    const run = async (file: string, args: string[], env?: NodeJS.ProcessEnv) => void ran.push([file, args, env]);
    const body = "Claude Code is waiting for you in '; Remove-Item -Recurse C:\\ ; '";
    await osNotifier({ platform: "win32", env: {}, run })("Rushes", body);
    expect(ran).toHaveLength(1);
    const [file, args, env] = ran[0];
    expect(file).toBe("powershell.exe");
    expect(args.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
    expect(args[5]).toBe(WINDOWS_TOAST_SCRIPT);
    expect(args.join(" ")).not.toContain("Remove-Item");
    expect(env?.RUSHES_NOTIFY_BODY).toBe(body);
    expect(env?.RUSHES_NOTIFY_TITLE).toBe("Rushes");
  });

  it("a failure on either is silent", async () => {
    const run = async () => { throw new Error("no"); };
    await osNotifier({ platform: "linux", env: {}, run, find: () => "/usr/bin/notify-send" })("Rushes", "x");
    await osNotifier({ platform: "win32", env: {}, run })("Rushes", "x");
  });
});
