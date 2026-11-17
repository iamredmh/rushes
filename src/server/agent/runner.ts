// §28.2, §28.3: one run of the user's own agent per project. The runner owns the adapter process, the
// conversation, the turn queue, progress, permission asks (§28.4), answers on notes (§28.5) and Stop.
//
// How it moves:
//   idle/finished/question/failed --send--> starting (adapter up, initialize, load or new session)
//   starting --ready--> working (one session/prompt per turn: batches and follow-ups, in order of arrival)
//   starting --fails--> failed (notes of every waiting batch recalled; send says why)
//   working --an ask the rules don't allow--> waiting (until the user answers; never by time) --> working
//   working --turn ends, more queued--> working;  --turn ends, none--> question | finished (idle timer armed)
//   working --adapter exits--> failed (notes recalled);  any busy phase --stop--> idle (notes recalled)
//   Stop, close and an adapter exit answer every pending ask cancelled.
//
// `gen` counts stops and closes. Anything that awaited (a start, a turn's end) checks it afterwards, so
// work begun before a Stop never changes the state after it.
import { ACTIVITY_LINE_MAX, activityLine } from "../../core/agentActivity.js";
import { alwaysLabel, decide } from "../../core/agentRules.js";
import { NotFoundError, RushesError } from "../../core/errors.js";
import { oneLine } from "../../core/labels.js";
import { lineEvent } from "../../core/logEvents.js";
import { needsYou, noteState, recallNotes } from "../../core/noteState.js";
import type { AgentId, AgentSettings, AlwaysRule, Batch } from "../../core/schema.js";
import type { ChangeEvent, Store } from "../../core/store.js";
import { logBookFor } from "../logbook.js";
import { AcpConnection, type AcpPermissionOutcome, type AcpPermissionParams, type AdapterSpec, type McpServerSpec } from "./acp.js";
import { adapterSpec, rushesMcp } from "./adapters.js";
import { PermissionBroker, addRule, allowOutcome, dropRule, toRequest, type AskChoice, type PendingAsk } from "./broker.js";
import { detectAgents, type AgentInfo } from "./detect.js";
import { CarriedBatches, batchJob, followUpFor, type TurnJob } from "./followUp.js";

export type AgentPhase = "off" | "idle" | "starting" | "working" | "waiting" | "question" | "finished" | "failed";

export interface ActivityLine { at: string; text: string; note: string | null }

export interface AgentStatus {
  on: boolean;
  agent: AgentId | null;
  phase: AgentPhase;
  /** The batch being worked on, then the ones queued behind it, by id. */
  batches: string[];
  current: { note: string | null; doing: string | null };
  asks: PendingAsk[];
  lines: ActivityLine[];
  error: string | null;
  session: string | null;
}

export interface RunnerOptions {
  detect?: () => Promise<AgentInfo[]>;
  spec?: (a: AgentInfo, root: string) => AdapterSpec;
  mcp?: (root: string) => McpServerSpec;
  idleMs?: number;
  now?: () => Date;
}

/** `stopped` is set when the batch was not handed over because the user pressed Stop: the desk then doesn't copy the prompt. */
export type SendResult = { handedTo: AgentId } | { handedTo: null; why: string; stopped?: true };

/** How long the adapter stays up after its last turn (§5.2). */
export const AGENT_IDLE_MS = 600_000;
/** How long Stop waits for a cancelled turn to end before it kills the adapter. */
export const STOP_WAIT_MS = 5000;
/** Activity keeps this many lines, in memory only. */
export const AGENT_LINES_KEPT = 200;
/** Long enough for AcpConnection.kill's SIGKILL (2 s) to land. */
const EXIT_WAIT_MS = 4000;
const CANCELLED: AcpPermissionOutcome = { outcome: "cancelled" };

const NAMES: Record<AgentId, string> = { claude: "Claude Code", codex: "Codex" };

/** A start-up ended by Stop or close, not by a failure. */
class Halted extends Error {
  constructor() {
    super("Stopped before the agent started");
  }
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The last line of a stderr tail with anything in it, as one short line. */
function lastLine(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => oneLine(l, ACTIVITY_LINE_MAX)).filter((l) => l !== "" && l !== "…");
  return lines.at(-1) ?? "";
}

/** Resolves when `c` has exited, or after `ms` (kill's SIGKILL has landed by then). */
function exited(c: AcpConnection, ms = EXIT_WAIT_MS): Promise<void> {
  if (c.hasExited) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
    c.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** Waits for `p` or `ms`, whichever comes first, and clears the timer when `p` wins. */
async function within(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref();
  });
  try {
    await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class AgentRunner {
  private readonly detect: () => Promise<AgentInfo[]>;
  private readonly specFor: (a: AgentInfo, root: string) => AdapterSpec;
  private readonly mcp: (root: string) => McpServerSpec;
  private readonly idleMs: number;
  private readonly now: () => Date;

  private settings: AgentSettings | null = null;
  /** agent.json reads started, and the newest one applied (a write counts as one). */
  private reads = 0;
  private applied = 0;
  private phase: Exclude<AgentPhase, "off"> = "idle";
  private error: string | null = null;
  private lines: ActivityLine[] = [];
  private current: { note: string | null; doing: string | null } = { note: null, doing: null };

  /** Batches and follow-ups waiting for their turn, in the order they came in. */
  private queue: TurnJob[] = [];
  /** The job whose session/prompt is in flight; `done` settles when that prompt does. */
  private turn: { job: TurnJob; done: Promise<void> } | null = null;
  /** Permission asks waiting for the user. */
  private readonly broker: PermissionBroker;
  /** Batches handed to the agent in this process: only their notes' answers become follow-ups (R3). */
  private readonly carried = new CarriedBatches();
  /** The latest Always rule write; a permission ask waits for it before reading the rules. */
  private ruleWrite: Promise<void> = Promise.resolve();
  /** A turn has ended and the runner is reading the notes to choose question or finished. */
  private ending = false;

  private conn: AcpConnection | null = null;
  private sessionId: string | null = null;
  /** The agent and permission level the running adapter was started with. */
  private info: AgentInfo | null = null;
  private connPermissions: AgentSettings["permissions"] | null = null;
  private exits = new WeakMap<AcpConnection, { code: number | null; stderr: string }>();
  /** Every adapter process not yet seen to exit, so close() leaves none behind. */
  private live = new Set<AcpConnection>();

  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private gen = 0;
  private closed = false;
  private closing: Promise<void> | null = null;
  /** Sends are checked and queued one at a time, so two at once keep their order. */
  private sendLock: Promise<unknown> = Promise.resolve();
  /** Writes started from event handlers (recalls, Change Log lines, settings reads); close() waits for them. */
  private pending = new Set<Promise<unknown>>();
  private readonly onChange = (e: ChangeEvent) => {
    if (e.file === "agent" && !this.closed) this.track(this.loadSettings());
  };
  /** The user answered on a note: a follow-up turn when R3 allows one (followUp.ts). */
  private readonly onUserReply = (e: { note: string; text: string }) => {
    if (!this.closed) this.track(this.hand(() => followUpFor(this.store, this.carried, e)));
  };

  constructor(private readonly store: Store, opts: RunnerOptions = {}) {
    this.detect = opts.detect ?? (() => detectAgents());
    this.specFor = opts.spec ?? adapterSpec;
    this.mcp = opts.mcp ?? rushesMcp;
    this.idleMs = opts.idleMs ?? AGENT_IDLE_MS;
    this.now = opts.now ?? (() => new Date());
    this.broker = new PermissionBroker(store.root, { now: this.now, onChange: () => this.asksChanged() });
    store.on("change", this.onChange);
    store.on("user-reply", this.onUserReply);
    this.track(this.loadSettings());
  }

  status(): AgentStatus {
    const on = this.settings?.on ?? false;
    const jobs = [...(this.turn ? [this.turn.job] : []), ...this.queue];
    return {
      on,
      agent: this.settings?.agent ?? null,
      phase: !on && !this.busy() ? "off" : this.broker.size > 0 ? "waiting" : this.phase,
      batches: jobs.filter((j) => j.kind === "batch").map((j) => j.batchId),
      current: { ...this.current },
      asks: this.broker.pending(),
      lines: this.lines.slice(),
      error: this.error,
      session: this.settings?.session?.id ?? null,
    };
  }

  /** From the first send until the queue is empty and no ask is waiting. */
  busy(): boolean {
    return this.starting !== null || this.stopping !== null || this.turn !== null || this.ending || this.queue.length > 0 || this.broker.size > 0;
  }

  /**
   * Hands a filed batch to the agent: it starts the adapter if none is up, or queues behind the turn in
   * flight. Never rejects: when the batch can't be handed over it says why, so the desk can copy the prompt.
   */
  async send(batch: Batch): Promise<SendResult> {
    return (await this.hand(async () => batchJob(batch)))!;
  }

  /** Queues the job `make` gives (none: nothing to do, null back), then starts the adapter or pumps the queue. */
  private async hand(make: () => Promise<TurnJob | null>): Promise<SendResult | null> {
    const accepting = this.sendLock.then(async () => {
      // A follow-up is dropped if a Stop lands after its note was read: the Stop may have taken the note back.
      const gen = this.gen;
      const job = await make();
      return job ? this.accept(job, job.kind === "followUp" ? gen : null) : null;
    });
    this.sendLock = accepting.catch(() => undefined);
    let accepted: { info: AgentInfo } | { why: string } | null;
    try {
      accepted = await accepting;
    } catch (e) {
      return { handedTo: null, why: messageOf(e) };
    }
    if (accepted === null) return null;
    if ("why" in accepted) return { handedTo: null, why: accepted.why };
    try {
      await this.ensureStarted();
    } catch (e) {
      // Halted by the user's Stop (not by close): flagged, so the desk doesn't fall back to copying the prompt.
      if (e instanceof Halted && !this.closed) return { handedTo: null, why: e.message, stopped: true };
      return { handedTo: null, why: messageOf(e) };
    }
    this.pump();
    return { handedTo: accepted.info.id };
  }

  /** Checks the switch, the agent and its sign-in, then queues the job. Runs one at a time. */
  private async accept(job: TurnJob, sinceGen: number | null): Promise<{ info: AgentInfo } | { why: string }> {
    while (this.stopping) await this.stopping;
    if (this.closed) return { why: "Rushes is closing" };
    const settings = await this.loadSettings();
    if (!settings.on) return { why: "Send to AI is off" };
    if (!settings.agent) return { why: "No agent chosen" };
    const info = (await this.detect()).find((a) => a.id === settings.agent);
    if (!info?.installed) return { why: `${info?.name ?? NAMES[settings.agent]} is not installed` };
    if (!info.signedIn) return { why: `${info.name} is not signed in` };
    // A Stop or close may have begun while this send was checking.
    while (this.stopping) await this.stopping;
    if (this.closed) return { why: "Rushes is closing" };
    if (sinceGen !== null && sinceGen !== this.gen) return { why: "Stopped" };
    const queued = this.busy();
    if (!queued && this.conn) {
      // An idle adapter for another agent, another conversation or another permission level is replaced.
      const kept = settings.session?.id ?? null;
      if (this.info?.id !== info.id || this.sessionId !== kept || this.connPermissions !== settings.permissions) this.dropConn();
    }
    if (!queued) this.info = info;
    this.clearIdle();
    this.queue.push(job);
    // Queued behind a run: say so now. Otherwise the start or the turn about to begin says it.
    if (queued) this.announce();
    return { info };
  }

  /** One start at a time: a second caller waits on the first one's promise. */
  private ensureStarted(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.closed) return Promise.reject(new Error("Rushes is closing"));
    if (this.conn && this.sessionId && !this.conn.hasExited) return Promise.resolve();
    const info = this.info;
    if (!info) return Promise.reject(new Error("No agent chosen"));
    const p: Promise<void> = this.start(info).finally(() => {
      if (this.starting === p) this.starting = null;
    });
    this.starting = p;
    return p;
  }

  private async start(info: AgentInfo): Promise<void> {
    const gen = this.gen;
    const root = this.store.root;
    this.clearIdle();
    this.phase = "starting";
    this.error = null;
    this.current = { note: null, doing: null };
    this.announce();
    let conn: AcpConnection | null = null;
    try {
      conn = AcpConnection.start(this.specFor(info, root));
      this.attach(conn);
      const c = conn;
      const check = () => {
        if (gen !== this.gen || this.conn !== c) throw new Halted();
      };
      const { loadSession } = await c.initialize();
      check();
      const settings = await this.loadSettings();
      check();
      const mcp = [this.mcp(root)];
      const kept = settings.session;
      let sessionId: string | null = null;
      let modes: string[] = [];
      if (kept && kept.agent === info.id && loadSession) {
        try {
          ({ modes } = await c.loadSession(kept.id, root, mcp));
          sessionId = kept.id;
        } catch (e) {
          // An agent prunes old conversations. With the adapter still up, start a new one rather than fail
          // this Send and every one after it.
          if (c.hasExited) throw e;
          check();
          this.addLine("Started a new conversation (the last one could not be loaded)", null);
        }
      }
      if (sessionId === null) {
        let made: string;
        ({ sessionId: made, modes } = await c.newSession(root, mcp));
        sessionId = made;
        check();
        const startedAt = this.now().toISOString();
        const { data } = await this.store.update("agent", (f) => {
          f.session = { id: made, agent: info.id, startedAt };
        });
        this.applySettings(data);
      }
      check();
      if (settings.permissions === "project-edits" && modes.includes("acceptEdits")) {
        await c.setMode(sessionId, "acceptEdits");
        check();
      }
      if (c.hasExited) throw new Error("the adapter exited as it started");
      this.sessionId = sessionId;
      this.connPermissions = settings.permissions;
    } catch (e) {
      if (e instanceof Halted || gen !== this.gen) throw e instanceof Halted ? e : new Halted();
      if (conn && this.conn === conn) this.dropConn();
      const tail = conn ? lastLine(this.exits.get(conn)?.stderr ?? "") : "";
      const why = `${info.name} could not start: ${tail || messageOf(e)}`;
      await this.failRun(why);
      throw new Error(why);
    }
  }

  /** Makes `conn` the runner's adapter and listens to it. */
  private attach(conn: AcpConnection): void {
    this.conn = conn;
    this.sessionId = null;
    this.live.add(conn);
    conn.on("update", (u: unknown) => this.onUpdate(conn, u));
    conn.on("exit", (e: { code: number | null; stderr: string }) => this.onExit(conn, e));
    conn.onPermission((p) => this.onPermission(conn, p));
  }

  /** Lets go of the adapter and asks it to exit. Its exit event is then ignored, and its asks are cancelled. */
  private dropConn(): AcpConnection | null {
    const c = this.conn;
    this.conn = null;
    this.sessionId = null;
    this.connPermissions = null;
    this.broker.cancelAll();
    c?.kill();
    return c;
  }

  /**
   * The agent asks to do something. Allowed by the project's rules: yes at once, no ask shown. Otherwise the
   * ask waits in the broker for the user. Asks from an adapter that is going (Stop, close, replaced) get "cancelled".
   */
  private async onPermission(conn: AcpConnection, p: AcpPermissionParams): Promise<AcpPermissionOutcome> {
    const live = () => !this.closed && !this.stopping && conn === this.conn && !conn.hasExited;
    if (!live()) return CANCELLED;
    // The adapter hears "yes" before an Always rule is written: wait for that write, then read the rules.
    await this.ruleWrite;
    const settings = await this.loadSettings();
    if (!live()) return CANCELLED;
    if (decide(toRequest(p, this.store.root), settings, this.store.root) === "allow") return allowOutcome(p.options);
    return this.broker.ask(p);
  }

  private asksChanged(): void {
    this.announce();
    // The last ask answered with nothing else going on: the adapter's idle time starts again.
    if (!this.busy() && !this.closed) this.armIdle();
  }

  /** The user's answer to a pending ask. "always" also keeps the rule in agent.json. */
  async answer(askId: string, choice: AskChoice): Promise<void> {
    const rule = this.broker.answer(askId, choice);
    if (!rule) return;
    const writing = this.keepRule(rule);
    this.ruleWrite = writing.catch(() => undefined);
    await writing;
  }

  /** Takes an Always rule out of agent.json by its index there. */
  async removeRule(index: number): Promise<void> {
    const { data } = await this.store.update("agent", (f) => dropRule(f.always, index));
    this.applySettings(data);
    this.announce();
  }

  /** Keeps the rule in agent.json (once; the oldest goes at the cap) and says so in Activity and the Change Log. */
  private async keepRule(rule: AlwaysRule): Promise<void> {
    const { data, result: added } = await this.store.update("agent", (f) => addRule(f.always, rule));
    this.applySettings(data);
    if (added) {
      const text = `Always allowed: ${alwaysLabel(rule)}`;
      this.addLine(text, null);
      await this.writeMilestone(text);
    }
    this.announce();
  }

  /** Starts the next queued batch when nothing else is in flight. */
  private pump(): void {
    if (this.closed || this.turn || this.ending || this.starting || this.stopping || this.queue.length === 0) return;
    const conn = this.conn;
    const sessionId = this.sessionId;
    if (!conn || !sessionId || conn.hasExited) {
      // The adapter went away between turns: start a fresh one (it loads the session), then come back.
      this.ensureStarted().then(() => this.pump(), () => undefined);
      return;
    }
    const job = this.queue.shift()!;
    const gen = this.gen;
    const name = this.info?.name ?? "The agent";
    if (job.kind === "batch") this.carried.add(job.batchId);
    this.clearIdle();
    let done!: () => void;
    this.turn = { job, done: new Promise<void>((r) => (done = r)) };
    this.phase = "working";
    this.error = null;
    this.current = { note: null, doing: null };
    this.milestone(`${name} started on ${job.label}`);
    this.announce();
    this.track(
      conn.prompt(sessionId, job.prompt).then(
        (r) => {
          done();
          return this.turnEnded(gen, job, r.stopReason);
        },
        (err: unknown) => {
          done();
          this.turnFailed(gen, conn, job, err);
        },
      ),
    );
  }

  private async turnEnded(gen: number, job: TurnJob, stopReason: string): Promise<void> {
    // Stopped, closed or failed meanwhile: whoever did that has already settled this job.
    if (gen !== this.gen || this.turn?.job !== job) return;
    const name = this.info?.name ?? "The agent";
    this.turn = null;
    this.ending = true;
    this.milestone(stopReason === "end_turn" ? `${name} finished ${job.label}` : `${name} ended ${job.label} (${stopReason})`);
    this.announce();
    // Still busy while the notes are read, so a send now queues and is picked up below. The phase follows
    // the batch this turn worked on: a question on one of its notes makes it "question".
    let question = false;
    try {
      const notes = await this.store.read("notes");
      question = notes.notes.some((n) => n.batch === job.batchId && needsYou(n));
    } catch (e) {
      console.error(`Rushes: couldn't read the notes after a turn: ${messageOf(e)}`);
    }
    if (gen !== this.gen) return;
    this.ending = false;
    if (this.queue.length) return this.pump();
    this.phase = question ? "question" : "finished";
    this.current = { note: null, doing: null };
    this.announce();
    this.armIdle();
  }

  /** The prompt failed while the adapter stayed up (an RPC error): the run fails and the adapter is replaced. */
  private turnFailed(gen: number, conn: AcpConnection, job: TurnJob, err: unknown): void {
    if (gen !== this.gen || this.turn?.job !== job) return;
    if (this.conn === conn) this.dropConn();
    const name = this.info?.name ?? "The agent";
    this.track(this.failRun(`${name} could not finish ${job.label}: ${messageOf(err)}`));
  }

  private onUpdate(conn: AcpConnection, update: unknown): void {
    if (conn !== this.conn || this.closed) return;
    const text = activityLine(update, this.store.root);
    if (!text) return;
    this.addLine(text, this.current.note);
    this.announce();
  }

  private onExit(conn: AcpConnection, e: { code: number | null; stderr: string }): void {
    this.live.delete(conn);
    this.exits.set(conn, e);
    if (conn !== this.conn || this.closed) return;
    // A Stop is under way (an adapter may exit on session/cancel): halt() settles everything, and Stop is never a failure.
    if (this.stopping) return;
    // While starting, the request in flight rejects and start() reports the failure with this stderr.
    if (this.starting && !this.sessionId) return;
    this.conn = null;
    this.sessionId = null;
    this.connPermissions = null;
    this.clearIdle();
    this.broker.cancelAll();
    if (!this.turn) return; // it went between turns; the next send starts a fresh one
    const line = lastLine(e.stderr);
    const name = this.info?.name ?? "The agent";
    this.track(this.failRun(`${name} stopped unexpectedly${line ? `: ${line}` : ""}`));
  }

  /** The run failed: every batch in flight or waiting gives its notes back. The state changes at once; the writes follow. */
  private failRun(why: string): Promise<void> {
    const ids = this.batchIds();
    this.broker.cancelAll();
    this.turn = null;
    this.ending = false;
    this.queue = [];
    this.phase = "failed";
    this.error = why;
    this.current = { note: null, doing: null };
    this.addLine(why, null);
    this.announce();
    return this.recall(ids).then(async () => {
      await this.writeMilestone(why);
    });
  }

  /**
   * Stop: cancels the turn, waits up to 5 s for it to end, kills the adapter and gives the unfinished notes
   * of the current and queued batches back. With nothing running it changes nothing. Two at once share one.
   */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.busy() || this.closed) return Promise.resolve();
    const p: Promise<void> = this.halt().finally(() => {
      if (this.stopping === p) this.stopping = null;
    });
    this.stopping = p;
    return p;
  }

  private async halt(): Promise<void> {
    this.gen += 1;
    this.clearIdle();
    // First, and let the cancelled answers reach the adapter's stdin before session/cancel does.
    if (this.broker.size > 0) {
      this.broker.cancelAll();
      await new Promise((r) => setImmediate(r));
    }
    const name = this.info?.name ?? "the agent";
    const turn = this.turn;
    // Follow-ups in flight or queued are dropped; only batches give notes back.
    const ids = this.batchIds();
    this.queue = [];
    const conn = this.conn;
    const sessionId = this.sessionId;
    if (turn && conn && sessionId && !conn.hasExited) {
      conn.cancel(sessionId);
      await within(turn.done, STOP_WAIT_MS);
    }
    // While starting, the adapter being started is `conn` too: killing it ends the start.
    const dropped = this.dropConn();
    if (dropped) await exited(dropped);
    if (this.starting) await this.starting.catch(() => undefined);
    this.turn = null;
    this.ending = false;
    await this.recall(ids);
    this.phase = "idle";
    this.error = null;
    this.current = { note: null, doing: null };
    const text = `Stopped ${name}`;
    this.addLine(text, null);
    await this.writeMilestone(text);
    this.announce();
  }

  /**
   * rushes_working_on: the agent says which note it is on and what it is doing. Refused for a note that isn't
   * with the agent (sent), as the store has it now.
   */
  async workingOn(note: string, doing: string): Promise<void> {
    const file = await this.store.read("notes");
    const n = file.notes.find((x) => x.id === note);
    if (!n) throw new NotFoundError("note", note);
    if (noteState(n) !== "sent") throw new RushesError(`Note "${note}" is not with the agent`, 409, "note_not_sent", { id: note });
    const text = oneLine(doing, ACTIVITY_LINE_MAX);
    const line = text === "" || text === "…" ? "Working on a note" : text;
    this.current = { note, doing: line };
    this.addLine(line, note);
    this.announce();
  }

  /** Server shutdown: cancels, kills the adapter and clears the timers. Notes stay as they are. */
  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    this.closed = true;
    this.gen += 1;
    this.store.off("change", this.onChange);
    this.store.off("user-reply", this.onUserReply);
    this.clearIdle();
    this.broker.cancelAll();
    const conn = this.conn;
    if (this.turn && conn && this.sessionId && !conn.hasExited) conn.cancel(this.sessionId);
    this.dropConn();
    this.queue = [];
    this.turn = null;
    this.ending = false;
    const all = [...this.live];
    for (const c of all) c.kill();
    await Promise.all(all.map((c) => exited(c)));
    if (this.starting) await this.starting.catch(() => undefined);
    if (this.stopping) await this.stopping.catch(() => undefined);
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private armIdle(): void {
    this.clearIdle();
    if (!this.conn) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // A send that came in meanwhile keeps the adapter; the session stays in agent.json either way.
      if (this.busy() || this.closed) return;
      this.dropConn();
    }, this.idleMs);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Reads agent.json into the cache, announcing when what the status shows from it changed. */
  private async loadSettings(): Promise<AgentSettings> {
    const seq = ++this.reads;
    const next = await this.store.read("agent");
    // Reads can finish out of order: an older one never replaces what a newer one (or a write) put in.
    if (seq < this.applied) return next;
    this.applySettings(next, seq);
    return next;
  }

  private applySettings(next: AgentSettings, seq = ++this.reads): void {
    const key = (s: AgentSettings | null) => JSON.stringify(s ? [s.on, s.agent, s.session?.id ?? null] : null);
    const changed = key(next) !== key(this.settings);
    this.settings = next;
    this.applied = seq;
    if (changed) this.announce();
  }

  /** The batches in flight and queued, by id: the ones whose notes go back on Stop or failure. */
  private batchIds(): string[] {
    const jobs = [...(this.turn ? [this.turn.job] : []), ...this.queue];
    return jobs.filter((j) => j.kind === "batch").map((j) => j.batchId);
  }

  private recall(ids: string[]): Promise<void> {
    if (!ids.length) return Promise.resolve();
    return this.store
      .update("notes", (f) => recallNotes(f.notes, ids))
      .then(
        () => undefined,
        (e: unknown) => console.error(`Rushes: couldn't give back the notes of ${ids.join(", ")}: ${messageOf(e)}`),
      );
  }

  /** An Activity line and a Change Log line, for a run starting, finishing, stopping or failing. */
  private milestone(text: string): void {
    this.addLine(text, null);
    this.track(this.writeMilestone(text));
  }

  private writeMilestone(text: string): Promise<unknown> {
    // LogBook.add never throws: a line it can't write is reported and counted.
    return logBookFor(this.store).add(lineEvent(text, "notes"), "rushes", this.now());
  }

  private addLine(text: string, note: string | null): void {
    this.lines.push({ at: this.now().toISOString(), text, note });
    if (this.lines.length > AGENT_LINES_KEPT) this.lines.splice(0, this.lines.length - AGENT_LINES_KEPT);
  }

  private announce(): void {
    if (this.closed) return;
    this.store.emit("agent", this.status());
  }

  private track(p: Promise<unknown>): void {
    const tracked = p.catch((e: unknown) => console.error(`Rushes: the agent runner hit an error: ${messageOf(e)}`));
    this.pending.add(tracked);
    void tracked.finally(() => this.pending.delete(tracked));
  }
}
