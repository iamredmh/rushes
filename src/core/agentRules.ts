import { realpathSync } from "node:fs";
import { basename, dirname, resolve, sep, relative, isAbsolute } from "node:path";
import type { AgentRules, AlwaysRule } from "./schema.js";

export type PermissionRequest = { kind: string | null; title: string; command: string | null; paths: string[] };

/** Resolve a path through symlinks. A path not there yet is judged by its longest existing ancestor, plus the rest. */
function real(p: string): string {
  const abs = resolve(p);
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      const r = realpathSync(cur);
      return rest.length ? resolve(r, ...rest.reverse()) : r;
    } catch {
      const up = dirname(cur);
      if (up === cur) return abs;
      rest.push(cur.slice(up.length + (up.endsWith(sep) ? 0 : 1)));
      cur = up;
    }
  }
}

/** True only for `root` itself or a path under it, after symlinks are resolved. */
export function inside(root: string, path: string): boolean {
  const r = real(root);
  const p = real(path);
  if (p === r) return true;
  const rel = relative(r, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && p.startsWith(r.endsWith(sep) ? r : r + sep);
}

const PROJECT_KINDS = new Set(["read", "edit", "search", "move", "delete"]);

/**
 * R10: folders and files in the project that hold the agent's and the editor's own settings, hooks or tokens.
 * A read, edit, delete, move or search of one never goes through on its own, under project-edits or any Always
 * rule: it always asks. Matched by name, case-insensitively, as any part of the path under the root (a nested
 * repo's `.git/hooks` too).
 */
export const PROTECTED_PATHS: readonly string[] = [".rushes", ".git", ".claude", ".codex", ".mcp.json", ".vscode", ".idea"];
const PROTECTED = new Set(PROTECTED_PATHS);

/**
 * A name as a case-insensitive volume compares it, for the security checks here: NFKC, then lower-cased. APFS opens
 * `.ruſhes` (U+017F, the long s) as `.rushes`, which `toLowerCase` alone would miss; NFKC maps ſ to s (and
 * full-width letters to plain ones, which only makes the checks stricter).
 */
export const fold = (s: string): string => s.normalize("NFKC").toLowerCase();

/** True when `path`, under `root`, is or is inside a protected folder or file (after symlinks are resolved). */
export function isProtected(root: string, path: string): boolean {
  const rel = relative(real(root), real(path));
  return rel.split(sep).some((part) => PROTECTED.has(fold(part)));
}

/** Kinds that change where a path is: never for the project folder itself (M5). */
const ROOT_CHANGES = new Set(["delete", "move"]);

/**
 * Every path is inside the project and none is protected; a delete or move must also not be the project folder
 * itself. With no path at all, false.
 */
function inProject(req: PermissionRequest, root: string): boolean {
  const notRoot = req.kind !== null && ROOT_CHANGES.has(req.kind);
  return (
    req.paths.length > 0 &&
    req.paths.every((p) => inside(root, p) && !isProtected(root, p) && !(notRoot && real(p) === real(root)))
  );
}

/** Kinds an Always rule is never offered or honoured for: "other" (an untyped tool call) and a switch of the agent's mode. */
const NEVER_ALWAYS = new Set(["other", "switch_mode"]);

/**
 * A plain command: letters, digits, space, tab, `_ . / : = @ % + , -` and quotes. Anything else may make a shell
 * run more than the named command (chaining, pipes, redirects, substitution, zsh's `=(…)` and glob qualifiers,
 * globs, `~`, `$`), so a command with it always asks, whatever Always rules there are.
 */
export const SAFE_COMMAND = /^[A-Za-z0-9 \t_.\/:=@%+,'"-]*$/;

/** Shells (and env): any of them runs whatever script follows it. broker.ts unwraps `[shell, -c|-lc, script]` by this list. */
export const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "rbash", "mksh", "pwsh", "env"]);
/** Programs that run another program given after them, so the program and subcommand would be the next words. */
export const WRAPPERS: ReadonlySet<string> = new Set([
  "exec", "command", "builtin", "nohup", "time", "nice", "timeout", "xargs", "sudo", "doas", "caffeinate", "arch", "eval", "source",
  "noglob", "nocorrect", "coproc", "repeat", "trap", "watch", "stdbuf", "unbuffer", "chroot", "taskpolicy", "sandbox-exec", "corepack",
  "open", "osascript",
]);

/** Subcommands that run any package or program named after them (`npm x`, `npm exec`, `npm exe`, `pnpm dlx`), whatever the program. */
export const RUNNER_SUBCOMMANDS: ReadonlySet<string> = new Set(["x", "exe", "exec", "dlx"]);
/** Programs whose `run` runs any program or package named after it (`uv run perl`), not a project script. */
export const RUN_ANY_PROGRAM: ReadonlySet<string> = new Set(["uv", "pipx", "poetry", "pdm", "hatch", "conda", "docker", "podman", "mise", "deno", "nix"]);
/** Programs that run the package named as their subcommand (`npx hyperframes`), so that package is the real program. */
export const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(["npx", "bunx", "pnpx", "yarn", "uvx"]);
/** Package runners and managers: run by a PACKAGE_RUNNER, their own subcommand (`npx npm exec x`) would go unchecked. */
export const RUNNER_PROGRAMS: ReadonlySet<string> = new Set([
  "npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx", "uv", "uvx", "pipx", "deno", "corepack", "poetry", "hatch", "pdm", "yarnpkg",
]);
/** A program and subcommand that is itself a runner of anything (`uv tool run perl`, `docker container run img`). */
export const RUNNER_PAIRS: ReadonlyMap<string, string> = new Map([["uv", "tool"], ["docker", "container"], ["podman", "container"]]);

/** A word a rule may be made of: no quotes, no `=`, nothing a shell reads as more than the word itself. */
const RULE_WORD = /^[A-Za-z0-9_.\/@:+-]+$/;

/** A word's basename for the lists, folded: macOS volumes are case-insensitive, so `NOHUP` and `ſudo` run nohup and sudo. */
const name = (word: string) => fold(basename(word));

/**
 * The names the lists know a subcommand word by (R8). Run by a package runner it is a package spec, so a leading
 * `@scope/` and a trailing `@version` are cut, and the scope counts too: `pnpm@9` is pnpm, `@pnpm/exe` is exe and pnpm.
 */
function names(word: string): string[] {
  const lower = fold(word);
  const scoped = /^@([^/]+)\/(.+)$/.exec(lower);
  const bare = name(scoped ? scoped[2] : lower).replace(/(.)@[^@]*$/, "$1");
  return scoped ? [scoped[1], bare] : [bare];
}

function ruleWord(word: string, ids: string[]): boolean {
  if (!RULE_WORD.test(word) || word.startsWith("-") || word.split("/").includes("..")) return false;
  return !ids.some((n) => SHELLS.has(n) || WRAPPERS.has(n));
}

/**
 * R7: the words an Always rule names, the program and its subcommand (the command's first two whitespace-separated
 * words), or null when they are not an exact identity of one program and subcommand: a word that is quoted, holds
 * `=`, climbs a `..` path, is a flag, a shell or a wrapper, or a subcommand that runs any package or program.
 * The shell reads quote-free words exactly as split here, so these are the program and subcommand it runs.
 */
export function alwaysWords(command: string): string[] | null {
  const words = command.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  // `.` as the program is the shell's source; as the subcommand (`find .`) it is a path.
  if (words.length === 0 || words[0] === ".") return null;
  const program = name(words[0]);
  if (!ruleWord(words[0], [program])) return null;
  if (words.length === 2) {
    const sub = names(words[1]);
    if (!ruleWord(words[1], sub)) return null;
    if (sub.some((n) => RUNNER_SUBCOMMANDS.has(n))) return null;
    if (sub.includes("run") && RUN_ANY_PROGRAM.has(program)) return null;
    if (PACKAGE_RUNNERS.has(program) && sub.some((n) => RUNNER_PROGRAMS.has(n))) return null;
    if (sub.includes(RUNNER_PAIRS.get(program) ?? "\0")) return null;
  }
  return words;
}

/**
 * A command an Always rule may be offered for and honoured on: plain (SAFE_COMMAND) as a whole, with its first two
 * words an exact program and subcommand (alwaysWords). Later words are that program's arguments.
 */
export function plainCommand(command: string): boolean {
  return command.trim() !== "" && SAFE_COMMAND.test(command) && alwaysWords(command) !== null;
}

function matches(rule: AlwaysRule, req: PermissionRequest, root: string): boolean {
  // "other" (an untyped tool call) would cover every future one, and switch_mode the agent's own mode: never kept,
  // and never honoured in an old file.
  if (NEVER_ALWAYS.has(rule.kind) || rule.kind !== (req.kind ?? "other")) return false;
  if (PROJECT_KINDS.has(rule.kind)) return inProject(req, root);
  if (rule.kind !== "execute") return true;
  if (rule.command === null || req.command === null) return false;
  // The stored rule as well as the request: an old file's rule of a shape R7 refuses is never honoured.
  if (rule.command.trim().split(/\s+/).length > 2) return false;
  const want = alwaysWords(rule.command);
  const got = plainCommand(req.command) ? alwaysWords(req.command) : null;
  return want !== null && got !== null && want.length === got.length && want.every((w, i) => w === got[i]);
}

/**
 * Whether an "Always" can be offered for this request: not for an untyped tool call or switch_mode, not for a
 * command that isn't a plain program and subcommand (plainCommand), and not for a path request with any path
 * outside the project or protected (M4), which such a rule could never allow.
 */
export function canAlways(req: PermissionRequest, root: string): boolean {
  const kind = req.kind ?? "other";
  if (NEVER_ALWAYS.has(kind)) return false;
  if (PROJECT_KINDS.has(kind)) return inProject(req, root);
  return kind !== "execute" || plainCommand(req.command ?? "");
}

export function decide(req: PermissionRequest, s: AgentRules, root: string): "allow" | "ask" {
  if (s.permissions === "ask-all") return "ask";
  if (s.always.some((r) => matches(r, req, root))) return "allow";
  if (req.kind && PROJECT_KINDS.has(req.kind) && inProject(req, root)) return "allow";
  return "ask";
}

export function ruleFor(req: PermissionRequest): AlwaysRule {
  const kind = req.kind ?? "other";
  if (kind !== "execute") return { kind, command: null };
  const words = (req.command ?? "").trim().split(/\s+/).filter(Boolean);
  return { kind, command: words.length ? words.slice(0, 2).join(" ") : null };
}

const WORDS: Record<string, string> = { read: "reads", edit: "edits", delete: "deletes", move: "moves", search: "searches" };

export function alwaysLabel(rule: AlwaysRule): string {
  if (rule.kind === "execute") return `Always for ${rule.command ?? "commands"} here`;
  if (rule.kind === "fetch") return "Always for web requests here";
  return `Always for ${WORDS[rule.kind] ?? "this"} here`;
}
