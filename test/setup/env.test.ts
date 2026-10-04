import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { realSetupEnv } from "../../src/setup/env.js";

describe.runIf(process.platform !== "win32")("realSetupEnv().exec with a time limit (Minor 9)", () => {
  it("gives up on a command that doesn't finish in time, and says so", async () => {
    const started = Date.now();
    const r = await realSetupEnv().exec("sleep", ["30"], tmpdir(), { timeout: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it("gives the command no stdin, so one waiting on input finishes instead of stalling", async () => {
    const r = await realSetupEnv().exec("cat", [], tmpdir(), { timeout: 5_000 });
    expect(r).toMatchObject({ code: 0 });
    expect(r.timedOut).toBeFalsy();
  }, 10_000);
});
