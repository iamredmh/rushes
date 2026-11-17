import { realpathSync } from "node:fs";
import { dirname, resolve, sep, relative, isAbsolute } from "node:path";
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

function matches(rule: AlwaysRule, req: PermissionRequest, root: string): boolean {
  if (rule.kind !== (req.kind ?? "other")) return false;
  if (PROJECT_KINDS.has(rule.kind)) return inProject(req, root);
  if (rule.kind !== "execute") return true;
  if (rule.command === null || req.command === null) return false;
  return req.command === rule.command || req.command.startsWith(rule.command + " ");
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
