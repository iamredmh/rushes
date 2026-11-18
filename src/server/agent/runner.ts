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
import { needsYou, noteState, recallNote, recallNotes } from "../../core/noteState.js";
import type { AgentId, AgentRules, AgentSettings, AlwaysRule, Batch, Note } from "../../core/schema.js";
import type { ChangeEvent, Store } from "../../core/store.js";
import { logBookFor } from "../logbook.js";
import { AcpConnection, type AcpPermissionOutcome, type AcpPermissionParams, type AdapterSpec, type McpServerSpec } from "./acp.js";
import { ASK_MODE, adapterSpec, rushesMcp, sessionSetup } from "./adapters.js";
import { isOwnRushesTool, noteMcpCall, type McpCalls } from "./ownTools.js";
import { PermissionBroker, addRule, allowOutcome, dropRule, toRequest, type AskChoice, type PendingAsk } from "./broker.js";
import { detectAgents, type AgentInfo } from "./detect.js";
import { agentRulesFor, type AgentRulesFile } from "./rules.js";
import { batchJob, followUpFor, type TurnJob } from "./followUp.js";

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
  /** The first-Send sheet has been answered (any setup): Send no longer opens it. */
  asked: boolean;
  /** What the agent may do without asking, from the user's own rules file (R10), for the agent menu. */
  permissions: AgentRules["permissions"];
  always: AlwaysRule[];
}

export interface RunnerOptions {
  detect?: () => Promise<AgentInfo[]>;
  spec?: (a: AgentInfo, root: string) => AdapterSpec;
  mcp?: (root: string) => McpServerSpec;
  idleMs?: number;
  /** How long the adapter may take to start (spawn, initialize, new or loaded session). Defaults to AGENT_START_MS. */
  startMs?: number;
  now?: () => Date;
}

/**
 * Why a batch was not handed over. `stopped`: the user pressed Stop. `recalled` (R12): a start began and failed,
 * timed out, or was cut short by Rushes closing, and the batch's notes went back to to do. The desk copies the
 * prompt only for a refusal with neither flag (Send to AI off, no agent, not installed, not signed in), where
 * nothing was started and the notes stay sent.
 */
export type SendResult = { handedTo: AgentId } | { handedTo: null; why: string; stopped?: true; recalled?: true };

/** A follow-up parked by R11: its note goes back to to do, and Activity names the agent to Send to. */
type Park = { name: string; batch: string };
type HandResult = SendResult | { handedTo: null; why: string; park: Park };
type Accepted = { info: AgentInfo } | { why: string; stopped?: true } | { why: string; park: Park };

/** How long the adapter stays up after its last turn (§5.2). */
export const AGENT_IDLE_MS = 600_000;
/** How long an adapter may take to start, from spawn to a ready session (a first `npx -y` fetch included). */
export const AGENT_START_MS = 120_000;
/** How long Stop waits for a cancelled turn to end before it kills the adapter. */
export const STOP_WAIT_MS = 5000;
/** Activity keeps this many lines, in memory only. */
export const AGENT_LINES_KEPT = 200;
/** Long enough for AcpConnection.kill's SIGKILL (2 s) to land. */
const EXIT_WAIT_MS = 4000;
const CANCELLED: AcpPermissionOutcome = { outcome: "cancelled" };
/** Why a send or follow-up is refused once close() has begun. */
const CLOSING = "Rushes is closing";
/** I1: Send to AI is on in the project, but the user's own rules file has no answer to the first-Send sheet. */
export const NOT_SET_UP = "Send to AI is not set up";
const OFF = "Send to AI is off";

/** Each agent by name, as Activity and the notification say it. */
export const AGENT_NAMES: Readonly<Record<AgentId, string>> = { claude: "Claude Code", codex: "Codex" };
const NAMES = AGENT_NAMES;

/** A start-up ended by Stop or close, not by a failure. */
/** The session could not be put in the mode in which the agent asks Rushes (R14, R15): the start fails with this. */
class ModeError extends Error {}

class Halted extends Error {
  constructor() {
    super("Stopped before the agent started");
  }
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 120000 -> "2 minutes", 1500 -> "1.5 seconds". */
function spell(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return ms === 60_000 ? "1 minute" : `${ms / 60_000} minutes`;
  return ms === 1000 ? "1 second" : `${ms / 1000} seconds`;
}

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
  /**
   * Per adapter: which agent it runs, (Codex only) its MCP calls by tool call id (R16), and its session's mode as
   * last reported (round 2, item 3).
   */
  private readonly adapters = new WeakMap<AcpConnection, { agent: AgentId; calls: McpCalls; mode: string | null; modeReported: boolean }>();
  private readonly mcp: (root: string) => McpServerSpec;
  private readonly idleMs: number;
  private readonly startMs: number;
  private readonly now: () => Date;

  private settings: AgentSettings | null = null;
  /** The user's rules for this project, kept outside it (R10). `rules` is the last read, for the status. */
  private readonly rulesFile: AgentRulesFile;
  private rules: AgentRules = { permissions: "project-edits", always: [], setUp: false, agent: null };
  /** I3: batches whose hand-over was refused while Send to AI was on (not signed in, not set up…); resend takes each once. */
  private readonly refused = new Set<string>();
  private ruleReads = 0;
  private rulesApplied = 0;
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
  /** The latest Always rule write; a permission ask waits for it before reading the rules. */
  private ruleWrite: Promise<void> = Promise.resolve();
  /** R13: per note, the follow-ups being handed (from the user's answer until hand() returns). */
  private readonly answering = new Map<string, number>();
  /** A turn has ended and the runner is reading the notes to choose question or finished. */
  private ending = false;

  private conn: AcpConnection | null = null;
  private sessionId: string | null = null;
  /** The agent the running adapter was started for. */
  private info: AgentInfo | null = null;
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
  /** The user answered on a note: a follow-up turn when R11 allows one (followUp.ts). */
  private readonly onUserReply = (e: { note: string; text: string }) => {
    if (!this.closed) this.track(this.followUp(e));
  };

  constructor(private readonly store: Store, opts: RunnerOptions = {}) {
    this.detect = opts.detect ?? (() => detectAgents());
    this.specFor = opts.spec ?? adapterSpec;
    this.mcp = opts.mcp ?? rushesMcp;
    this.idleMs = opts.idleMs ?? AGENT_IDLE_MS;
    this.startMs = opts.startMs ?? AGENT_START_MS;
    this.now = opts.now ?? (() => new Date());
    this.broker = new PermissionBroker(store.root, { now: this.now, onChange: () => this.asksChanged() });
    this.rulesFile = agentRulesFor(store);
    store.on("change", this.onChange);
    store.on("user-reply", this.onUserReply);
    this.track(this.loadSettings());
    this.track(this.loadRules());
  }

  /** Consent fix: on only when the project's switch is on for the agent the user chose, in their own rules file. */
  private switchedOn(settings: AgentSettings | null, rules: AgentRules): boolean {
    return !!settings?.on && rules.agent !== null && rules.agent === settings.agent;
  }

  status(): AgentStatus {
    const on = this.switchedOn(this.settings, this.rules);
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
      // I1: from the user's own rules file, never the project's agent.json.
      asked: this.rules.setUp,
      permissions: this.rules.permissions,
      always: this.rules.always.map((r) => ({ ...r })),
    };
  }

  /** Reads agent.json and the rules now and gives the status from them: for a route that has just changed either. */
  async reload(): Promise<AgentStatus> {
    await Promise.all([this.loadSettings(), this.loadRules()]);
    return this.status();
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
    const r = (await this.hand(async () => batchJob(batch)))!;
    // A batch is never parked (only a follow-up is).
    return this.noteRefusal(batch.id, "park" in r ? { handedTo: null, why: r.why } : r);
  }

  /**
   * I3: hands over a batch whose hand-over was refused, once (the copy dialog's Set up, through the setup route). The id
   * is taken from the refused set under the send lock, so two at once hand it over once. Null when it wasn't refused, or
   * has gone already.
   */
  async resend(batch: Batch): Promise<SendResult | null> {
    const r = await this.hand(async () => (this.refused.delete(batch.id) ? batchJob(batch) : null));
    if (r === null) return null;
    return this.noteRefusal(batch.id, "park" in r ? { handedTo: null, why: r.why } : r);
  }

  /** Records a batch refused while Send to AI was on and nothing started (its notes still wait with it), for resend. */
  private noteRefusal(id: string, r: SendResult): SendResult {
    if (r.handedTo === null && !r.stopped && !r.recalled && r.why !== OFF && r.why !== CLOSING) this.refused.add(id);
    return r;
  }

  /**
   * Hands the answer on as a follow-up (R11). With Send to AI on but no kept session, or the agent not signed in,
   * the note goes back to to do and Activity says so. One that can't be sent for another reason says why, unless
   * Send to AI is off.
   */
  private async followUp(e: { note: string; text: string }): Promise<void> {
    // R13: held from before hand() until it returns (the job is queued or running by then, or refused), so a turn
    // ending meanwhile leaves this note to the follow-up.
    this.answering.set(e.note, (this.answering.get(e.note) ?? 0) + 1);
    try {
      await this.followUpHanded(e);
    } finally {
      const left = (this.answering.get(e.note) ?? 1) - 1;
      if (left > 0) this.answering.set(e.note, left);
      else this.answering.delete(e.note);
    }
  }

  private async followUpHanded(e: { note: string; text: string }): Promise<void> {
    let job: TurnJob | null = null;
    const r = await this.hand(async () => {
      job = await followUpFor(this.store, e).catch((err: unknown) => {
        console.error(`Rushes: couldn't read note ${e.note} to pass on its answer: ${messageOf(err)}`);
        throw err;
      });
      return job;
    });
    if (!r) return;
    if ("park" in r) {
      await this.recall({ batches: [], notes: [{ id: e.note, batch: r.park.batch }] });
      if (this.closed) return;
      this.addLine(`Your answer on ${e.note} is saved. Press Send to hand it to ${r.park.name}.`, e.note);
      this.announce();
      return;
    }
    if (this.closed) {
      // Refused because Rushes is closing, before it was queued: its note goes back too (I3), as a queued job's does.
      const j = job as TurnJob | null;
      if (j?.note && r.handedTo === null && r.why === CLOSING) await this.recall({ batches: [], notes: [{ id: j.note, batch: j.batchId }] });
      return;
    }
    // Quiet when Send to AI is off, and when the user's own Stop cut it short.
    if (r.handedTo !== null || r.stopped || r.why === "Send to AI is off") return;
    this.addLine(`Your answer on ${e.note} was not sent: ${r.why}`, e.note);
    this.announce();
  }

  /** Queues the job `make` gives (none: nothing to do, null back), then starts the adapter or pumps the queue. */
  private async hand(make: () => Promise<TurnJob | null>): Promise<HandResult | null> {
    const accepting = this.sendLock.then(async () => {
      // A follow-up is dropped if a Stop lands after its note was read: the Stop may have taken the note back.
      const gen = this.gen;
      const job = await make();
      return job ? this.accept(job, job.kind === "followUp" ? gen : null) : null;
    });
    this.sendLock = accepting.catch(() => undefined);
    let accepted: Accepted | null;
    try {
      accepted = await accepting;
    } catch (e) {
      return { handedTo: null, why: messageOf(e) };
    }
    if (accepted === null) return null;
    if ("park" in accepted) return { handedTo: null, why: accepted.why, park: accepted.park };
    if ("why" in accepted) return accepted.stopped ? { handedTo: null, why: accepted.why, stopped: true } : { handedTo: null, why: accepted.why };
    try {
      await this.ensureStarted();
    } catch (e) {
      // Halted by the user's Stop (not by close): flagged, so the desk doesn't fall back to copying the prompt.
      if (e instanceof Halted && !this.closed) return { handedTo: null, why: e.message, stopped: true };
      // The job was queued before the start: the failure (failRun) or the close (shutdown) gave its notes back.
      return { handedTo: null, why: messageOf(e), recalled: true };
    }
    this.pump();
    return { handedTo: accepted.info.id };
  }

  /**
   * Checks the switch, the agent and its sign-in, then queues the job. Runs one at a time. A follow-up that can't
   * go now for want of a kept session or a signed-in agent is parked: its note goes back to to do (R11).
   */
  private async accept(job: TurnJob, sinceGen: number | null): Promise<Accepted | null> {
    while (this.stopping) await this.stopping;
    if (this.closed) return { why: CLOSING };
    const [settings, rules] = await Promise.all([this.loadSettings(), this.loadRules()]);
    if (!settings.on) return { why: OFF };
    const agent = settings.agent;
    const park = (why: string, name: string): Accepted =>
      job.kind === "followUp" ? { why, park: { name, batch: job.batchId } } : { why };
    // I1 and the consent fix: the switch and the agent in the project's agent.json are not the user's consent; the agent
    // they chose, in their own rules file, is. Unless the two name the same agent nothing is handed over and nothing
    // starts: the desk shows Send to AI off and copies the prompt, or opens the first-Send sheet.
    if (agent && !this.switchedOn(settings, rules)) return park(NOT_SET_UP, NAMES[agent]);
    if (job.kind === "followUp" && (!agent || settings.session?.agent !== agent)) {
      return park("No conversation to carry on", agent ? NAMES[agent] : "your agent");
    }
    if (!agent) return { why: "No agent chosen" };
    const info = (await this.detect()).find((a) => a.id === agent);
    if (!info?.installed) return park(`${info?.name ?? NAMES[agent]} is not installed`, info?.name ?? NAMES[agent]);
    if (!info.signedIn) return park(`${info.name} is not signed in`, info.name);
    // A follow-up's note may have left the agent while this was checking (recalled, done): then there is nothing to
    // follow up, and it is dropped quietly, with no line and no turn.
    if (job.kind === "followUp" && !(await this.stillSent(job))) return null;
    // A Stop or close may have begun while this send was checking.
    while (this.stopping) await this.stopping;
    if (this.closed) return { why: CLOSING };
    if (sinceGen !== null && sinceGen !== this.gen) return { why: "Stopped", stopped: true };
    const queued = this.busy();
    if (!queued && this.conn) {
      // An idle adapter for another agent or another conversation is replaced.
      const kept = settings.session?.id ?? null;
      if (this.info?.id !== info.id || this.sessionId !== kept) this.dropConn();
    }
    if (!queued) this.info = info;
    this.clearIdle();
    this.queue.push(job);
    // Queued behind a run: say so now. Otherwise the start or the turn about to begin says it.
    if (queued) this.announce();
    return { info };
  }

  /** The follow-up's note is still with the agent, in the batch the follow-up was made for. */
  private async stillSent(job: TurnJob): Promise<boolean> {
    const n = (await this.store.read("notes")).notes.find((x) => x.id === job.note);
    return n !== undefined && noteState(n) === "sent" && n.batch === job.batchId;
  }

  /** One start at a time: a second caller waits on the first one's promise. */
  private ensureStarted(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.closed) return Promise.reject(new Error(CLOSING));
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
    // A start that outlives startMs (a slow first fetch, an adapter that stalls) fails like any other start.
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      conn = AcpConnection.start(this.specFor(info, root));
      this.attach(conn, info.id);
      const c = conn;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error("timed out"));
        }, this.startMs);
        timer.unref();
      });
      const opening = this.open(c, info, gen, root);
      // Left behind on a timeout: the adapter is killed below, and what it then throws is not news.
      opening.catch(() => undefined);
      await Promise.race([opening, deadline]);
    } catch (e) {
      if (e instanceof Halted || gen !== this.gen) throw e instanceof Halted ? e : new Halted();
      if (conn && this.conn === conn) this.dropConn();
      const tail = conn && !timedOut ? lastLine(this.exits.get(conn)?.stderr ?? "") : "";
      const why = timedOut
        ? `${info.name} did not start within ${spell(this.startMs)}`
        : e instanceof ModeError
          ? e.message
          : `${info.name} could not start: ${tail || messageOf(e)}`;
      await this.failRun(why);
      throw new Error(why);
    } finally {
      clearTimeout(timer);
    }
  }

  /** From initialize to a ready session on `c`. Throws Halted when a Stop or close, or another adapter, came first. */
  private async open(c: AcpConnection, info: AgentInfo, gen: number, root: string): Promise<void> {
    const check = () => {
      if (gen !== this.gen || this.conn !== c) throw new Halted();
    };
    const { loadSession } = await c.initialize();
    check();
    const settings = await this.loadSettings();
    check();
    const mcp = [this.mcp(root)];
    const setup = sessionSetup(info.id);
    const kept = settings.session;
    let sessionId: string | null = null;
    let modes: string[] = [];
    let current: string | null = null;
    if (kept && kept.agent === info.id && loadSession) {
      try {
        ({ modes, current } = await c.loadSession(kept.id, root, mcp, setup));
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
      const opened = await c.newSession(root, mcp, setup);
      const made = opened.sessionId;
      sessionId = made;
      ({ modes, current } = opened);
      check();
      const startedAt = this.now().toISOString();
      const { data } = await this.store.update("agent", (f) => {
        f.session = { id: made, agent: info.id, startedAt };
      });
      this.applySettings(data);
    }
    check();
    await this.askMode(c, info, sessionId, modes, current);
    check();
    if (c.hasExited) throw new Error("the adapter exited as it started");
    this.sessionId = sessionId;
  }

  /**
   * R14/R15: every opened or loaded session goes into the mode in which the agent asks Rushes before it acts
   * (ASK_MODE), before the first prompt. Fails closed (round 2, item 3): the start fails with a ModeError, and its
   * notes go back, when the mode isn't offered (or no modes are reported), when set_mode throws, or when the
   * session's mode isn't the ask mode afterwards. That mode is the setup response's currentModeId, then the
   * ask mode once set_mode succeeds, unless a current_mode_update during set_mode reports another one (as
   * claude-agent-acp's setSessionMode does when it falls back).
   */
  private async askMode(c: AcpConnection, info: AgentInfo, sessionId: string, modes: string[], current: string | null): Promise<void> {
    const want = ASK_MODE[info.id];
    const refused = new ModeError(`${info.name} could not be put in a mode where Rushes approves actions`);
    const adapter = this.adapters.get(c);
    if (!adapter || !modes.includes(want)) throw refused;
    adapter.mode = current;
    adapter.modeReported = false;
    try {
      await c.setMode(sessionId, want);
    } catch (e) {
      if (c.hasExited) throw e;
      throw refused;
    }
    if (!adapter.modeReported) adapter.mode = want;
    if (adapter.mode !== want) throw refused;
  }

  /** Makes `conn` the runner's adapter and listens to it. */
  private attach(conn: AcpConnection, agent: AgentId): void {
    this.conn = conn;
    this.sessionId = null;
    this.live.add(conn);
    // R16: Codex names an MCP call's server and tool only in its tool_call update, before the approval comes.
    const calls: McpCalls = new Map();
    const adapter = { agent, calls, mode: null as string | null, modeReported: false };
    this.adapters.set(conn, adapter);
    conn.on("update", (u: unknown) => {
      if (agent === "codex") noteMcpCall(calls, u);
      const m = u as { sessionUpdate?: unknown; currentModeId?: unknown } | null;
      if (m?.sessionUpdate === "current_mode_update" && typeof m.currentModeId === "string") {
        adapter.mode = m.currentModeId;
        adapter.modeReported = true;
      }
      this.onUpdate(conn, u);
    });
    conn.on("exit", (e: { code: number | null; stderr: string }) => this.onExit(conn, e));
    conn.onPermission((p) => this.onPermission(conn, p));
  }

  /** Lets go of the adapter and asks it to exit. Its exit event is then ignored, and its asks are cancelled. */
  private dropConn(): AcpConnection | null {
    const c = this.conn;
    this.conn = null;
    this.sessionId = null;
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
    // R16: Rushes's own MCP tools never ask, under any permission level.
    const adapter = this.adapters.get(conn);
    if (adapter && isOwnRushesTool(adapter.agent, this.store.root, p, adapter.calls)) return allowOutcome(p.options);
    // The adapter hears "yes" before an Always rule is written: wait for that write, then read the rules.
    await this.ruleWrite;
    const rules = await this.loadRules();
    if (!live()) return CANCELLED;
    if (decide(toRequest(p, this.store.root), rules, this.store.root) === "allow") return allowOutcome(p.options);
    return this.broker.ask(p);
  }

  private asksChanged(): void {
    this.announce();
    // The last ask answered with nothing else going on: the adapter's idle time starts again.
    if (!this.busy() && !this.closed) this.armIdle();
  }

  /** The user's answer to a pending ask. "always" also keeps the rule in the user's rules file. */
  async answer(askId: string, choice: AskChoice): Promise<void> {
    const rule = this.broker.answer(askId, choice);
    if (rule) await this.ruleWriting(this.keepRule(rule));
  }

  /** Takes an Always rule out of the user's rules file by its kind and command (T6). One not there is not found. */
  async removeRule(rule: { kind: string; command: string | null }): Promise<void> {
    await this.ruleWriting(
      this.rulesFile.update((f) => dropRule(f.always, { kind: rule.kind, command: rule.command })).then(({ data }) => {
        this.applyRules(data);
      }),
    );
  }

  /** A change to the Always rules: an ask arriving meanwhile waits for it before reading them. */
  private ruleWriting(writing: Promise<void>): Promise<void> {
    this.ruleWrite = writing.catch(() => undefined);
    return writing;
  }

  /** Keeps the rule in the user's rules file (once; the oldest goes at the cap) and says so in Activity and the Change Log. */
  private async keepRule(rule: AlwaysRule): Promise<void> {
    const { data, result: added } = await this.rulesFile.update((f) => addRule(f.always, rule));
    this.applyRules(data);
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
    this.clearIdle();
    let done!: () => void;
    this.turn = { job, done: new Promise<void>((r) => (done = r)) };
    this.phase = "working";
    this.error = null;
    this.current = { note: null, doing: null };
    this.milestone(job.kind === "batch" ? `${name} started on ${job.label}` : `${name} picked up ${job.label}`);
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
    let back = 0;
    try {
      const notes = await this.store.read("notes");
      question = notes.notes.some((n) => n.batch === job.batchId && needsYou(n));
      // M3: what the turn left untouched (still sent, no question waiting) goes back to to do.
      if (notes.notes.some((n) => this.leftOver(job, n))) {
        const { result } = await this.store.update("notes", (f) => {
          const left = f.notes.filter((n) => this.leftOver(job, n));
          for (const n of left) recallNote(f.notes, n.id, job.batchId);
          return left.length;
        });
        back = result;
      }
    } catch (e) {
      console.error(`Rushes: couldn't read the notes after a turn: ${messageOf(e)}`);
    }
    if (gen !== this.gen) return;
    if (back > 0) this.addLine(back === 1 ? "1 note was not picked up and is back in to do" : `${back} notes were not picked up and are back in to do`, null);
    this.ending = false;
    if (this.queue.length) return this.pump();
    this.phase = question ? "question" : "finished";
    this.current = { note: null, doing: null };
    this.announce();
    this.armIdle();
  }

  /**
   * M3: a note the ended turn left with the agent: still sent in the turn's batch, no question waiting on it, and no
   * other follow-up for it in flight. A follow-up turn answers for its own note only.
   *
   * R13: a follow-up in flight is one being handed (`answering`: read, accepted, started) or queued. The turn ending
   * now has already left `this.turn`, so a follow-up turn that leaves its own note untouched gives it back unless
   * another answer on it is still on its way.
   */
  private leftOver(job: TurnJob, n: Note): boolean {
    if (n.batch !== job.batchId || noteState(n) !== "sent" || needsYou(n)) return false;
    if (job.kind === "followUp" && n.id !== job.note) return false;
    return !this.followUpInFlight(n.id);
  }

  private followUpInFlight(note: string): boolean {
    return (this.answering.get(note) ?? 0) > 0 || this.queue.some((q) => q.kind === "followUp" && q.note === note);
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
    this.clearIdle();
    this.broker.cancelAll();
    if (!this.turn) return; // it went between turns; the next send starts a fresh one
    const line = lastLine(e.stderr);
    const name = this.info?.name ?? "The agent";
    this.track(this.failRun(`${name} stopped unexpectedly${line ? `: ${line}` : ""}`));
  }

  /** The run failed: every job in flight or waiting gives its notes back. The state changes at once; the writes follow. */
  private failRun(why: string): Promise<void> {
    const back = this.unfinished();
    this.broker.cancelAll();
    this.turn = null;
    this.ending = false;
    this.queue = [];
    this.phase = "failed";
    this.error = why;
    this.current = { note: null, doing: null };
    this.addLine(why, null);
    this.announce();
    return this.recall(back).then(async () => {
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
    // Batches and follow-ups in flight or queued are dropped, and give their notes back.
    const back = this.unfinished();
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
    await this.recall(back);
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
   * with the agent (sent), as the store has it now. Shown only while a turn is in flight (M2): an agent the
   * user pasted the prompt into, or a call after its turn, changes nothing.
   */
  async workingOn(note: string, doing: string): Promise<void> {
    const file = await this.store.read("notes");
    const n = file.notes.find((x) => x.id === note);
    if (!n) throw new NotFoundError("note", note);
    if (noteState(n) !== "sent") throw new RushesError(`Note "${note}" is not with the agent`, 409, "note_not_sent", { id: note });
    if (!this.turn || this.closed) return;
    const text = oneLine(doing, ACTIVITY_LINE_MAX);
    const line = text === "" || text === "…" ? "Working on a note" : text;
    this.current = { note, doing: line };
    this.addLine(line, note);
    this.announce();
  }

  /**
   * Server shutdown: cancels, kills the adapter and clears the timers. The notes of the batches and follow-ups in
   * flight or queued go back to to do (I3), so none is left with an agent that is gone.
   */
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
    const back = this.unfinished();
    const conn = this.conn;
    if (this.turn && conn && this.sessionId && !conn.hasExited) conn.cancel(this.sessionId);
    this.dropConn();
    this.queue = [];
    this.track(this.recall(back));
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

  /** Reads the user's rules into the cache, announcing when they changed. */
  private async loadRules(): Promise<AgentRules> {
    const seq = ++this.ruleReads;
    const next = await this.rulesFile.read();
    // As with agent.json: an older read never replaces what a newer one (or a write) put in.
    if (seq >= this.rulesApplied) this.applyRules(next, seq);
    return next;
  }

  private applyRules(next: AgentRules, seq = ++this.ruleReads): void {
    const changed = JSON.stringify(next) !== JSON.stringify(this.rules);
    this.rules = next;
    this.rulesApplied = seq;
    if (changed) this.announce();
  }

  private applySettings(next: AgentSettings, seq = ++this.reads): void {
    const key = (s: AgentSettings | null) => JSON.stringify(s ? [s.on, s.agent, s.session?.id ?? null] : null);
    const changed = key(next) !== key(this.settings);
    this.settings = next;
    this.applied = seq;
    if (changed) this.announce();
  }

  /**
   * What goes back on Stop or failure, from the jobs in flight and queued: a batch's unfinished notes, and a
   * follow-up's own note (not the rest of its batch, whose turn has already ended).
   */
  private unfinished(): { batches: string[]; notes: { id: string; batch: string }[] } {
    const jobs = [...(this.turn ? [this.turn.job] : []), ...this.queue];
    return {
      batches: jobs.filter((j) => j.kind === "batch").map((j) => j.batchId),
      notes: jobs.flatMap((j) => (j.kind === "followUp" && j.note ? [{ id: j.note, batch: j.batchId }] : [])),
    };
  }

  private recall(back: { batches: string[]; notes: { id: string; batch: string }[] }): Promise<void> {
    if (!back.batches.length && !back.notes.length) return Promise.resolve();
    return this.store
      .update("notes", (f) => {
        recallNotes(f.notes, back.batches);
        // Only while the note is still in the batch the follow-up was for.
        for (const n of back.notes) recallNote(f.notes, n.id, n.batch);
      })
      .then(
        () => undefined,
        (e: unknown) => console.error(`Rushes: couldn't give back the notes of ${[...back.batches, ...back.notes.map((n) => n.id)].join(", ")}: ${messageOf(e)}`),
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
