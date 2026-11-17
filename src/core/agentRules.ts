import { realpathSync } from "node:fs";
import { basename, dirname, resolve, sep, relative, isAbsolute } from "node:path";
import type { AgentSettings, AlwaysRule } from "./schema.js";

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

function inProject(req: PermissionRequest, root: string): boolean {
  return req.paths.length > 0 && req.paths.every((p) => inside(root, p));
}

/**
 * A plain command: letters, digits, space, tab, `_ . / : = @ % + , -` and quotes. Anything else may make a shell
 * run more than the named command (chaining, pipes, redirects, substitution, zsh's `=(…)` and glob qualifiers,
 * globs, `~`, `$`), so a command with it always asks, whatever Always rules there are.
 */
export const SAFE_COMMAND = /^[A-Za-z0-9 \t_.\/:=@%+,'"-]*$/;

/** Shells (and env): any of them runs whatever script follows it. broker.ts unwraps `[shell, -c|-lc, script]` by this list. */
export const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "rbash", "mksh", "pwsh", "env"]);
/** Programs that run another program given after them. */
export const WRAPPERS: ReadonlySet<string> = new Set([
  "exec", "command", "builtin", "nohup", "time", "nice", "timeout", "xargs", "sudo", "doas", "caffeinate", "arch", "eval", "source",
]);

const bare = (word: string) => basename(word.replace(/['"]/g, ""));

/**
 * R6: a command an Always rule may be offered for, stored from and honoured on: a plain program and subcommand.
 * Refused when the command isn't plain (SAFE_COMMAND), when any word is a shell or a wrapper (quotes stripped,
 * by basename), when the first word is an environment assignment, or when either of the rule's two words
 * (the first two) is a flag: `npx -y` would allow any package.
 */
export function plainCommand(command: string): boolean {
  const c = command.trim();
  if (c === "" || !SAFE_COMMAND.test(c)) return false;
  const words = c.split(/\s+/);
  if (words[0].includes("=")) return false;
  if (words.some((w) => SHELLS.has(bare(w)) || WRAPPERS.has(bare(w)))) return false;
  return !words.slice(0, 2).some((w) => w.replace(/['"]/g, "").startsWith("-"));
}

function matches(rule: AlwaysRule, req: PermissionRequest, root: string): boolean {
  // "other" (an untyped tool call) would cover every future one: never kept, and never honoured in an old file.
  if (rule.kind === "other" || rule.kind !== (req.kind ?? "other")) return false;
  if (PROJECT_KINDS.has(rule.kind)) return inProject(req, root);
  if (rule.kind !== "execute") return true;
  if (rule.command === null || req.command === null) return false;
  // The stored rule and the request both: an old file's rule for a shell or wrapper is never honoured.
  if (!plainCommand(rule.command) || !plainCommand(req.command)) return false;
  return req.command === rule.command || req.command.startsWith(rule.command + " ");
}

/**
 * Whether an "Always" can be offered for this request: not for an untyped tool call, and not for a command that
 * isn't a plain program and subcommand (plainCommand).
 */
export function canAlways(req: PermissionRequest): boolean {
  const kind = req.kind ?? "other";
  if (kind === "other") return false;
  return kind !== "execute" || plainCommand(req.command ?? "");
}

export function decide(req: PermissionRequest, s: Pick<AgentSettings, "permissions" | "always">, root: string): "allow" | "ask" {
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
