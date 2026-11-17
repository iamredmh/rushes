// An Always rule as the user reads it ("Always for npx hyperframes here"): on the ask card, in Activity and in the desk's
// agent menu. Pure, with no node imports, so the desk can bundle it (agentRules.ts re-exports it for the server).
import type { AlwaysRule } from "./schema.js";

const WORDS: Record<string, string> = { read: "reads", edit: "edits", delete: "deletes", move: "moves", search: "searches" };

export function alwaysLabel(rule: AlwaysRule): string {
  if (rule.kind === "execute") return `Always for ${rule.command ?? "commands"} here`;
  if (rule.kind === "fetch") return "Always for web requests here";
  return `Always for ${WORDS[rule.kind] ?? "this"} here`;
}
