// §28, Send to AI in the browser: a server whose agent is the fake (test/helpers/fake-acp.mjs) playing a scenario, through
// the RUSHES_TEST_AGENT hook (src/server/start.ts). No test here ever starts a real adapter or model.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openRushes, test as base, type OpenRushes, type Rushes } from "./fixture.js";
import { readJsonl } from "../test/helpers/jsonl.js";

export * from "./fixture.js";

const FAKE = fileURLToPath(new URL("../test/helpers/fake-acp.mjs", import.meta.url));

export type AgentRushes = Rushes & {
  /** The fake's log (FAKE_ACP_LOG): every message it received, one JSON object per line. Poll it with readAgentLog. */
  agentLog: string;
  /** The server's XDG_CONFIG_HOME, a temp folder: the user's rules file (src/server/agent/rules.ts rulesPath) lives
   *  under it, never in the real ~/.config. */
  configDir: string;
  /** Replaces the scenario. The fake reads it as it starts, at the first Send, so a test whose steps name a note (an
   *  `http` step's body) adds the note, then sets the scenario, then sends. */
  setScenario(scenario: object): Promise<void>;
  /** Replaces what detection answers from now on, as if the user signed an agent in or out while Rushes runs. */
  setAgents(agents: TestAgents): Promise<void>;
};

/** What detection answers, as RUSHES_TEST_AGENT's `agents` (src/server/start.ts): an agent left out is not installed. */
export type TestAgents = { id: "claude" | "codex"; installed: boolean; signedIn: boolean }[];

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
  return readJsonl(text);
}

export const test = base.extend<{ startWithAgent: (scenario: object, opts?: { agents?: TestAgents }) => Promise<AgentRushes> }>({
  /**
   * Starts a server whose agent is the fake playing `scenario` (see fake-acp.mjs for its shape). Both agents are installed
   * and signed in, and the fake offers each agent's ask mode unless the scenario names its own `modes`. Send to AI is not
   * turned on: a test does that (POST /api/agent/setup) or goes through the desk. `http` steps reach this server.
   * `opts.agents` stands in for detection (installed, signed in). The server's XDG_CONFIG_HOME is a temp folder.
   */
  startWithAgent: async ({ noFfmpeg, browserName }, use) => {
    const opened: OpenRushes[] = [];
    const dirs: string[] = [];
    await use(async (scenario, opts = {}) => {
      const dir = await mkdtemp(join(tmpdir(), "rushes agent "));
      dirs.push(dir);
      const file = join(dir, "scenario.json");
      const log = join(dir, "fake-log.jsonl");
      const write = (s: object) => writeFile(file, JSON.stringify({ modes: ["default", "read-only"], ...s }));
      await write(scenario);
      const configDir = join(dir, "config");
      const port = await freePort();
      // Detection reads this file each time (RUSHES_TEST_AGENT `agentsFile`), so setAgents takes effect at once.
      const agentsFile = join(dir, "agents.json");
      const setAgents = (agents: TestAgents) => writeFile(agentsFile, JSON.stringify(agents));
      await setAgents(opts.agents ?? [{ id: "claude", installed: true, signedIn: true }, { id: "codex", installed: true, signedIn: true }]);
      const hook = {
        command: process.execPath,
        args: [FAKE],
        env: { FAKE_ACP_SCENARIO: file, FAKE_ACP_LOG: log, FAKE_ACP_BASE: `http://127.0.0.1:${port}` },
        agentsFile,
      };
      const env = { RUSHES_TEST_AGENT: JSON.stringify(hook), RUSHES_E2E: "1", XDG_CONFIG_HOME: configDir };
      const o = await openRushes({ noFfmpeg, browserName, port, env });
      opened.push(o);
      // Onto the handle itself, so its url, base and root stay live (swapProject).
      return Object.assign(o.rushes, { agentLog: log, configDir, setScenario: write, setAgents });
    });
    for (const o of opened) await o.close();
    for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  },
});
