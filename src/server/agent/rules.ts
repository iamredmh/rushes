// R10: what the agent may do without asking (permissions and Always rules) is kept per user, outside the project,
// so an agent working in the project can never grant itself a rule by editing a file there.
//
//   <user config dir>/rushes/agent-rules/<key>.json
//   user config dir: $XDG_CONFIG_HOME when it is an absolute path, else ~/.config
//   key: the first 16 hex characters of sha256(realpath.native(project root)), the name as the volume stores it
//
// The folder is 0700 and the file 0600. Writes are serialised and atomic (tmp + rename), like the project's own files.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { AgentRulesReadSchema, AgentRulesSchema, type AgentRules } from "../../core/schema.js";
import type { Store } from "../../core/store.js";
import { InvalidError } from "../../core/errors.js";

/** $XDG_CONFIG_HOME when set to an absolute path (as the XDG spec asks), else ~/.config. Tests point it at a temp folder. */
export function userConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const x = env.XDG_CONFIG_HOME;
  return x && isAbsolute(x) ? x : join(homedir(), ".config");
}

/**
 * The first 16 hex characters of sha256 of the project root's real path. The native realpath gives the name as it is
 * stored, so a case-variant path to the same folder on a case-insensitive volume names the same file.
 */
export function rulesKey(root: string): string {
  let real = root;
  try {
    real = realpathSync.native(root);
  } catch {
    /* not there (yet): its own path */
  }
  return createHash("sha256").update(real).digest("hex").slice(0, 16);
}

export function rulesPath(root: string, configDir = userConfigDir()): string {
  return join(configDir, "rushes", "agent-rules", `${rulesKey(root)}.json`);
}

/** No file yet: edits in the project unasked, no Always rules. */
const DEFAULTS = (): AgentRules => ({ permissions: "project-edits", always: [] });
/** A file that can't be read as rules: nothing goes through unasked until it is written again. */
const FAIL_CLOSED = (): AgentRules => ({ permissions: "ask-all", always: [] });

let writes = 0;

export class AgentRulesFile {
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(root: string, configDir = userConfigDir()) {
    this.path = rulesPath(root, configDir);
  }

  /** The rules now. A missing file reads as the defaults; a damaged one as ask-all with no rules. */
  async read(): Promise<AgentRules> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return DEFAULTS();
      console.error(`Rushes: couldn't read the agent's rules at ${this.path}: ${(e as Error).message}. Every action asks until they are saved again.`);
      return FAIL_CLOSED();
    }
    let parsed;
    try {
      parsed = AgentRulesReadSchema.safeParse(JSON.parse(raw));
    } catch {
      parsed = null;
    }
    if (!parsed?.success) {
      console.error(`Rushes: the agent's rules at ${this.path} are damaged. Every action asks until they are saved again.`);
      return FAIL_CLOSED();
    }
    return parsed.data;
  }

  /** Read, change and write the rules, one change at a time. `fn` mutates the draft and may return a value. */
  update<R>(fn: (draft: AgentRules) => R): Promise<{ data: AgentRules; result: R }> {
    const run = this.queue.catch(() => undefined).then(async () => {
      const draft = await this.read();
      const result = fn(draft);
      const checked = AgentRulesSchema.safeParse(draft);
      if (!checked.success) throw new InvalidError("Change to the agent's rules is invalid", checked.error.issues);
      const dir = dirname(this.path);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      const tmp = `${this.path}.${process.pid}.${Date.now()}.${++writes}.tmp`;
      await writeFile(tmp, JSON.stringify(checked.data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      await rename(tmp, this.path);
      return { data: checked.data, result };
    });
    this.queue = run;
    return run;
  }
}

const files = new WeakMap<Store, AgentRulesFile>();

/** The one rules file for `store`'s project, shared by the runner and the routes so their writes queue together. */
export function agentRulesFor(store: Store): AgentRulesFile {
  let f = files.get(store);
  if (!f) {
    f = new AgentRulesFile(store.root);
    files.set(store, f);
  }
  return f;
}
