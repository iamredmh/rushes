import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// vitest.config.ts sets RUSHES_NO_REVEAL=1 so no test ever opens Finder, which also means the branch
// that really spawns a program never runs. Here it does, with child_process mocked: what is checked
// is the command and arguments each platform gets, since a lost `-R` or a wrong `/select,` form would
// break "Show in Finder" and "Open" on one OS and nothing else would notice.
const spawned = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: string[]; opts: unknown }[],
  child: null as unknown as { on: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> },
  throws: false,
}));
vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[], opts: unknown) => {
    if (spawned.throws) throw new Error("spawn exploded");
    spawned.calls.push({ cmd, args, opts });
    return spawned.child;
  },
}));

const { osOpener, osRevealer } = await import("../../src/server/reveal.js");

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: p, configurable: true });

// What each platform runs, for a file and for a folder.
const RUNS = {
  darwin: { revealFile: (f: string) => ["open", ["-R", f]], revealDir: (d: string) => ["open", [d]], open: (f: string) => ["open", [f]] },
  win32: { revealFile: (f: string) => ["explorer.exe", ["/select," + f]], revealDir: (d: string) => ["explorer.exe", [d]], open: (f: string) => ["explorer.exe", [f]] },
  linux: { revealFile: (f: string) => ["xdg-open", [dirname(f)]], revealDir: (d: string) => ["xdg-open", [d]], open: (f: string) => ["xdg-open", [f]] },
} as const;

let dir: string;
let file: string;
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.stubEnv("RUSHES_NO_REVEAL", "0");
  spawned.calls.length = 0;
  spawned.throws = false;
  spawned.child = { on: vi.fn(), unref: vi.fn() };
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  dir = await mkdtemp(join(tmpdir(), "rushes reveal "));
  file = join(dir, "a cut.mp4"); // a space in the path, as a real one often has
  await writeFile(file, "x");
});
afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.each(["darwin", "win32", "linux"] as const)("on %s", (platform) => {
  beforeEach(() => setPlatform(platform));

  it("reveals a file with the platform's file manager, selecting or opening its folder", async () => {
    await osRevealer(file);
    expect(spawned.calls.map((c) => [c.cmd, c.args])).toEqual([RUNS[platform].revealFile(file)]);
  });

  it("opens a folder directly rather than selecting it inside its parent", async () => {
    await osRevealer(dir);
    expect(spawned.calls.map((c) => [c.cmd, c.args])).toEqual([RUNS[platform].revealDir(dir)]);
  });

  it("opens a file in its default application", async () => {
    await osOpener(file);
    expect(spawned.calls.map((c) => [c.cmd, c.args])).toEqual([RUNS[platform].open(file)]);
  });

  it("spawns detached, with no shell and its own stdio ignored, and lets go of the child", async () => {
    await osRevealer(file);
    await osOpener(file);
    expect(spawned.calls.map((c) => c.opts)).toEqual([{ detached: true, stdio: "ignore" }, { detached: true, stdio: "ignore" }]);
    expect(spawned.child.unref).toHaveBeenCalledTimes(2);
  });
});

describe("when it goes wrong", () => {
  it("logs rather than throws if spawn itself fails", async () => {
    spawned.throws = true;
    await expect(osRevealer(file)).resolves.toBeUndefined();
    await expect(osOpener(file)).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith(`Couldn't reveal ${file}: spawn exploded`);
    expect(errors).toHaveBeenCalledWith(`Couldn't open ${file}: spawn exploded`);
  });

  it("logs rather than throws if the program can't be started", async () => {
    await osRevealer(file);
    await osOpener(file);
    const [revealChild, openChild] = [spawned.child.on.mock.calls[0], spawned.child.on.mock.calls[1]];
    expect(revealChild[0]).toBe("error");
    (revealChild[1] as (e: Error) => void)(new Error("ENOENT"));
    (openChild[1] as (e: Error) => void)(new Error("ENOENT"));
    expect(errors).toHaveBeenCalledWith(`Couldn't reveal ${file}: ENOENT`);
    expect(errors).toHaveBeenCalledWith(`Couldn't open ${file}: ENOENT`);
  });

  it("spawns nothing and only says so when RUSHES_NO_REVEAL=1, as every other test relies on", async () => {
    vi.stubEnv("RUSHES_NO_REVEAL", "1");
    await osRevealer(file);
    await osOpener(file);
    expect(spawned.calls).toEqual([]);
    expect(errors).toHaveBeenCalledWith(`reveal ${file}`);
    expect(errors).toHaveBeenCalledWith(`open ${file}`);
  });
});
