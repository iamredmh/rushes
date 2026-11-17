// §28, Send to AI in the browser: a server whose agent is the fake (test/helpers/fake-acp.mjs) playing a scenario, through
// the RUSHES_TEST_AGENT hook (src/server/start.ts). No test here ever starts a real adapter or model.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openRushes, test as base, type OpenRushes, type Rushes } from "./fixture.js";

export * from "./fixture.js";

const FAKE = fileURLToPath(new URL("../test/helpers/fake-acp.mjs", import.meta.url));

export type AgentRushes = Rushes & {
  /** The fake's log (FAKE_ACP_LOG): every message it received, one JSON object per line. Poll it with readAgentLog. */
  agentLog: string;
};

/** A port free right now, so the fake's `http` steps can be told the server's address before it starts. */
function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });
}

/** What the fake has received so far, oldest first (an empty list before it has written anything). */
export async function readAgentLog(path: string): Promise<any[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export const test = base.extend<{ startWithAgent: (scenario: object) => Promise<AgentRushes> }>({
  /**
   * Starts a server whose agent is the fake playing `scenario` (see fake-acp.mjs for its shape). Both agents are installed
   * and signed in, and the fake offers each agent's ask mode unless the scenario names its own `modes`. Send to AI is not
   * turned on: a test does that (POST /api/agent/setup) or goes through the desk. `http` steps reach this server.
   */
  startWithAgent: async ({ noFfmpeg, browserName }, use) => {
    const opened: OpenRushes[] = [];
    const dirs: string[] = [];
    await use(async (scenario) => {
      const dir = await mkdtemp(join(tmpdir(), "rushes agent "));
      dirs.push(dir);
      const file = join(dir, "scenario.json");
      const log = join(dir, "fake-log.jsonl");
      await writeFile(file, JSON.stringify({ modes: ["default", "read-only"], ...scenario }));
      const port = await freePort();
      const hook = {
        command: process.execPath,
        args: [FAKE],
        env: { FAKE_ACP_SCENARIO: file, FAKE_ACP_LOG: log, FAKE_ACP_BASE: `http://127.0.0.1:${port}` },
      };
      const o = await openRushes({ noFfmpeg, browserName, port, env: { RUSHES_TEST_AGENT: JSON.stringify(hook), RUSHES_E2E: "1" } });
      opened.push(o);
      // Onto the handle itself, so its url, base and root stay live (swapProject).
      return Object.assign(o.rushes, { agentLog: log });
    });
    for (const o of opened) await o.close();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  },
});
