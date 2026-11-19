// §34: the adapters are fetched once, ahead of time, into the cache folder: never at Send time, never with npx.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADAPTERS, cacheDir, connectorDir, connectorEntry, connectorStatus, ensureConnector, prepareConnectors, resetConnectors, type NpmRunner,
} from "../../../src/server/agent/connectors.js";

let base: string;
beforeEach(async () => {
  resetConnectors();
  base = await mkdtemp(join(tmpdir(), "rushes-connectors-"));
});
afterEach(async () => rm(base, { recursive: true, force: true }));

/** A fake npm that installs the package the way npm would: node_modules/<pkg>/package.json with a bin. */
function fakeNpm(o: { fail?: string; delayMs?: number } = {}): NpmRunner & { calls: { args: string[]; cwd: string }[] } {
  const calls: { args: string[]; cwd: string }[] = [];
  const npm = (async (args: string[], cwd: string) => {
    calls.push({ args, cwd });
    if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
    if (o.fail) return { code: 1, out: `npm error code ENOTFOUND\nnpm error ${o.fail}\n` };
    const prefix = args[args.indexOf("--prefix") + 1];
    const spec = args.at(-1)!;
    const pkg = spec.slice(0, spec.lastIndexOf("@"));
    const dir = join(prefix, "node_modules", ...pkg.split("/"));
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: pkg, bin: { x: "dist/index.js" } }));
    await writeFile(join(dir, "dist", "index.js"), "");
    return { code: 0, out: "" };
  }) as NpmRunner & { calls: { args: string[]; cwd: string }[] };
  npm.calls = calls;
  return npm;
}

describe("cacheDir", () => {
  it("XDG_CACHE_HOME first, then each OS's own cache folder", () => {
    expect(cacheDir({ XDG_CACHE_HOME: "/x" }, "darwin", "/Users/r")).toBe(join("/x", "rushes"));
    expect(cacheDir({}, "darwin", "/Users/r")).toBe(join("/Users/r", "Library", "Caches", "rushes"));
    expect(cacheDir({}, "linux", "/home/r")).toBe(join("/home/r", ".cache", "rushes"));
    expect(cacheDir({ LOCALAPPDATA: "C:/L" }, "win32", "C:/U")).toBe(join("C:/L", "rushes", "Cache"));
    expect(cacheDir({ XDG_CACHE_HOME: "relative" }, "linux", "/home/r")).toBe(join("/home/r", ".cache", "rushes"));
  });
});

describe("ensureConnector", () => {
  it("installs the pinned adapter without its bundled agent, from the cache folder, and returns its start file", async () => {
    const npm = fakeNpm();
    const entry = await ensureConnector("claude", { base, npm });
    expect(entry).toBe(join(connectorDir("claude", base), "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js"));
    const { args, cwd } = npm.calls[0];
    expect(args).toContain("--omit=optional");
    expect(args).toContain("--ignore-scripts");
    expect(args.at(-1)).toBe(`${ADAPTERS.claude.pkg}@${ADAPTERS.claude.version}`);
    // Never npx, and never run from a project: a project's .npmrc can't redirect it.
    expect(args).not.toContain("-y");
    expect(cwd.startsWith(join(base, "connectors"))).toBe(true);
    expect(connectorStatus("claude", base)).toEqual({ state: "ready" });
  });

  it("downloads once: a second call while the first runs waits for it, and later calls don't run npm", async () => {
    const npm = fakeNpm({ delayMs: 50 });
    const a = ensureConnector("codex", { base, npm });
    expect(connectorStatus("codex", base)).toEqual({ state: "fetching" });
    const b = ensureConnector("codex", { base, npm });
    expect(await a).toBe(await b);
    await ensureConnector("codex", { base, npm });
    expect(npm.calls).toHaveLength(1);
  });

  it("a failure says why in plain words, leaves nothing half-done, and the next call tries again", async () => {
    await expect(ensureConnector("claude", { base, npm: fakeNpm({ fail: "getaddrinfo ENOTFOUND registry.npmjs.org" }) })).rejects.toThrow(
      /Couldn't download the Claude Code connector: .*ENOTFOUND/,
    );
    expect(connectorStatus("claude", base).state).toBe("failed");
    expect(connectorEntry("claude", base)).toBeNull();
    expect(await ensureConnector("claude", { base, npm: fakeNpm() })).toContain("claude-agent-acp");
  });

  it("a folder without its ready mark is never used", async () => {
    const dir = join(connectorDir("claude", base), "node_modules", "@agentclientprotocol", "claude-agent-acp");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ bin: "dist/index.js" }));
    expect(connectorEntry("claude", base)).toBeNull();
    expect(connectorStatus("claude", base)).toEqual({ state: "missing" });
  });
});

describe("prepareConnectors", () => {
  it("fetches for each installed agent only, and never under the test runner unless asked", async () => {
    const got: string[] = [];
    const ensure = async (a: "claude" | "codex") => void got.push(a) as unknown as string;
    const detect = async () => [{ id: "claude" as const, installed: true }, { id: "codex" as const, installed: false }];
    await prepareConnectors(detect, { env: { NODE_ENV: "test" }, ensure });
    expect(got).toEqual([]);
    await prepareConnectors(detect, { env: { NODE_ENV: "test", RUSHES_FETCH_CONNECTORS: "1" }, ensure });
    expect(got).toEqual(["claude"]);
  });

  it("a failed fetch is logged, never thrown", async () => {
    const lines: string[] = [];
    await prepareConnectors(async () => [{ id: "codex" as const, installed: true }], {
      env: {}, ensure: async () => { throw new Error("Couldn't download the Codex connector: offline"); }, log: (l) => lines.push(l),
    });
    expect(lines[0]).toContain("offline");
  });
});
