// §28.4: permission asks the agent makes that Rushes's rules didn't allow on their own. Each one waits for
// the user's answer in the desk. Nothing here has a timer: an ask is answered by the user, or cancelled by
// Stop, close or the adapter going away (cancelAll), never by time passing.
import { isAbsolute, resolve } from "node:path";
import { NotFoundError } from "../../core/errors.js";
import { alwaysLabel, ruleFor, type PermissionRequest } from "../../core/agentRules.js";
import type { AlwaysRule } from "../../core/schema.js";
import type { AcpPermissionOutcome, AcpPermissionParams } from "./acp.js";

/** A permission ask waiting for the user's answer, as the desk shows it (§28.4). */
export interface PendingAsk {
  id: string;
  title: string;
  kind: string | null;
  command: string | null;
  always: string;
  at: string;
}

export type AskChoice = "once" | "always" | "no";

const CANCELLED: AcpPermissionOutcome = { outcome: "cancelled" };

/** The request in Rushes's terms. Relative locations are read against the project root, as the agent means them. */
export function toRequest(p: AcpPermissionParams, root: string): PermissionRequest {
  const tc = p.toolCall;
  const raw = (tc.rawInput ?? null) as { command?: unknown } | null;
  const cmd = raw && typeof raw === "object" ? raw.command : undefined;
  const command = typeof cmd === "string" ? cmd : Array.isArray(cmd) ? cmd.map(String).join(" ") : null;
  const paths = (tc.locations ?? []).filter((l) => typeof l?.path === "string").map((l) => (isAbsolute(l.path) ? l.path : resolve(root, l.path)));
  return { kind: tc.kind ?? null, title: tc.title ?? "", command, paths };
}

function pick(options: AcpPermissionParams["options"], first: string, fallback: string): AcpPermissionOutcome {
  const o = options.find((x) => x.kind === first) ?? options.find((x) => x.kind === fallback);
  return o ? { outcome: "selected", optionId: o.optionId } : CANCELLED;
}

/**
 * Yes to the adapter: its allow_once option, or allow_always only when that is the one allow it offers.
 * "Always" is Rushes's own rule, so the adapter is never told to remember anything itself.
 */
export const allowOutcome = (options: AcpPermissionParams["options"]) => pick(options, "allow_once", "allow_always");
const rejectOutcome = (options: AcpPermissionParams["options"]) => pick(options, "reject_once", "reject_always");

/** agent.json keeps at most this many Always rules (the schema's cap). */
export const ALWAYS_KEPT = 50;

/** Adds the rule to agent.json's list unless the same kind and command is there; at the cap the oldest goes. True when added. */
export function addRule(always: AlwaysRule[], rule: AlwaysRule): boolean {
  if (always.some((r) => r.kind === rule.kind && r.command === rule.command)) return false;
  always.push({ kind: rule.kind, command: rule.command });
  if (always.length > ALWAYS_KEPT) always.splice(0, always.length - ALWAYS_KEPT);
  return true;
}

/** Takes the rule at `index` out of the list; one that isn't there is not found. */
export function dropRule(always: AlwaysRule[], index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= always.length) throw new NotFoundError("rule", String(index));
  always.splice(index, 1);
}

interface Open {
  ask: PendingAsk;
  params: AcpPermissionParams;
  req: PermissionRequest;
  settle: (o: AcpPermissionOutcome) => void;
}

export class PermissionBroker {
  private open = new Map<string, Open>();
  private count = 0;
  private readonly now: () => Date;
  private readonly onChange: () => void;

  constructor(private readonly root: string, opts: { now?: () => Date; onChange?: () => void } = {}) {
    this.now = opts.now ?? (() => new Date());
    this.onChange = opts.onChange ?? (() => undefined);
  }

  /** Holds the ask until answer() or cancelAll(). */
  ask(p: AcpPermissionParams): Promise<AcpPermissionOutcome> {
    const req = toRequest(p, this.root);
    const id = `ask_${++this.count}`;
    const ask: PendingAsk = { id, title: req.title, kind: req.kind, command: req.command, always: alwaysLabel(ruleFor(req)), at: this.now().toISOString() };
    const outcome = new Promise<AcpPermissionOutcome>((settle) => this.open.set(id, { ask, params: p, req, settle }));
    this.onChange();
    return outcome;
  }

  /** Answers the agent. Returns the rule to keep for "always", else null. An unknown or answered id is not found. */
  answer(id: string, choice: AskChoice): AlwaysRule | null {
    const o = this.open.get(id);
    if (!o) throw new NotFoundError("ask", id);
    this.open.delete(id);
    o.settle(choice === "no" ? rejectOutcome(o.params.options) : allowOutcome(o.params.options));
    this.onChange();
    return choice === "always" ? ruleFor(o.req) : null;
  }

  /** Stop, close or the adapter gone: every ask still open is answered cancelled. */
  cancelAll(): void {
    if (this.open.size === 0) return;
    const all = [...this.open.values()];
    this.open.clear();
    for (const o of all) o.settle(CANCELLED);
    this.onChange();
  }

  pending(): PendingAsk[] {
    return [...this.open.values()].map((o) => ({ ...o.ask }));
  }

  get size(): number {
    return this.open.size;
  }
}
