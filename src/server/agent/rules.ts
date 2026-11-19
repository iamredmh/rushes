// R10: what the agent may do without asking (permissions and Always rules) is kept per user, outside the project,
// so an agent working in the project can never grant itself a rule by editing a file there. §33: that includes the
// Auto and Bypass rows, in which the agent's own mode decides and Rushes no longer guards .rushes and .git: they are
// chosen only by the user, in the agent menu or the first-Send sheet, never from anything in the project. So are the user's answer to
// the first-Send sheet (I1, `setUp`) and the agent they chose (`agent`): a project folder from someone else, or anything
// that writes the project, can't turn Send to AI on for an agent.
//
//   <user config dir>/rushes/agent-rules/<key>.json
//   user config dir: $XDG_CONFIG_HOME when it is an absolute path, else ~/.config
//   key: the first 16 hex characters of sha256(realpath.native(project root)), the name as the volume stores it
//
// The folder is 0700 and the file 0600. Writes are serialised and atomic (tmp + rename), like the project's own files.
//
// §32: Send to AI is set up once per Mac. Beside that folder is the Mac-wide default, <user config dir>/rushes/agent-
// defaults.json: `{ agent, permissions }`, the user's last choice in the first-Send sheet, the agent menu or the switch
// turned on. A project with no rules file yet starts from it (AgentRulesFile.adopt). It is the user's own file, outside
// every project, so R10 holds: nothing inside a project can write it, or grant itself anything through it.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { AgentDefaultsSchema, AgentRulesReadSchema, AgentRulesSchema, type AgentDefaults, type AgentRules } from "../../core/schema.js";
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

/** No file yet: edits in the project unasked, no Always rules, and not set up (I1): the first Send asks. */
const DEFAULTS = (): AgentRules => ({ permissions: "project-edits", always: [], setUp: false, agent: null });
/** A file that can't be read as rules: nothing goes through unasked, and nothing is handed over, until it is written again. */
const FAIL_CLOSED = (): AgentRules => ({ permissions: "ask-all", always: [], setUp: false, agent: null });

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
      await writePrivate(this.path, checked.data);
      return { data: checked.data, result };
    });
    this.queue = run;
    return run;
  }

  /**
   * §32: a project with no rules file yet starts from the Mac-wide default: set up, the default agent (none after Copy
   * a prompt), the default permissions and no Always rules. Written in the queue and only while there is still no file,
   * so it never overwrites rules made meanwhile. Null when the file was there already, or there is no default.
   */
  adopt(defaults: AgentDefaults | null): Promise<AgentRules | null> {
    const run = this.queue.catch(() => undefined).then(async () => {
      if (!defaults || (await exists(this.path))) return null;
      // §33: Bypass is never adopted: a new project whose default is Bypass starts in Accept edits. Auto is adopted.
      const permissions = defaults.permissions === "bypass" ? "project-edits" : defaults.permissions;
      const rules = AgentRulesSchema.parse({ setUp: true, agent: defaults.agent, permissions, always: [] });
      await writePrivate(this.path, rules);
      return rules;
    });
    this.queue = run;
    return run;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** Writes JSON the user's own way: its folder 0700, the file 0600, atomically (tmp + rename). */
async function writePrivate(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = `${path}.${process.pid}.${Date.now()}.${++writes}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

/** §32: where the Mac-wide default is: <user config dir>/rushes/agent-defaults.json. */
export function defaultsPath(configDir = userConfigDir()): string {
  return join(configDir, "rushes", "agent-defaults.json");
}

/** §32: Send to AI's Mac-wide default. One per config dir, so every project's writes to it queue together. */
export class AgentDefaultsFile {
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(configDir = userConfigDir()) {
    this.path = defaultsPath(configDir);
  }

  /** The default, or null when there is none yet (the sheet asks once). A damaged file is no default: the sheet asks. */
  async read(): Promise<AgentDefaults | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Rushes: couldn't read Send to AI's default at ${this.path}: ${(e as Error).message}.`);
      return null;
    }
    try {
      const parsed = AgentDefaultsSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      /* damaged: below */
    }
    console.error(`Rushes: Send to AI's default at ${this.path} is damaged. A new project asks who gets the notes until it is saved again.`);
    return null;
  }

  /**
   * Last choice wins: writes what the user just chose (an agent, null after Copy a prompt, or the permissions) and keeps
   * the rest. With no default yet, the rest comes from `base` (the project's rules as they are now).
   */
  set(change: Partial<AgentDefaults>, base: AgentDefaults): Promise<AgentDefaults> {
    const run = this.queue.catch(() => undefined).then(async () => {
      const next = AgentDefaultsSchema.parse({ ...((await this.read()) ?? base), ...change });
      await writePrivate(this.path, next);
      return next;
    });
    this.queue = run;
    return run;
  }
}

const defaultFiles = new Map<string, AgentDefaultsFile>();

/** The Mac-wide default's file for the user config dir now (tests point XDG_CONFIG_HOME at a temp folder). */
export function agentDefaultsFile(configDir = userConfigDir()): AgentDefaultsFile {
  let f = defaultFiles.get(configDir);
  if (!f) {
    f = new AgentDefaultsFile(configDir);
    defaultFiles.set(configDir, f);
  }
  return f;
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
