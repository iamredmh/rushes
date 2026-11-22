// §28.2, §28.3: one run of the user's own agent per project. The runner owns the adapter process, the
// conversation, the turn queue, progress, permission asks (§28.4) and Stop. §35: notes go one way; there is no
// follow-up turn and no question phase.
//
// How it moves:
//   idle/finished/failed --send--> starting (adapter up, initialize, load or new session)
//   starting --ready--> working (one session/prompt per turn: one batch each, in order of arrival)
//   starting --fails--> failed (notes of every waiting batch recalled; send says why)
//   working --an ask the rules don't allow--> waiting (until the user answers; never by time) --> working
//   working --turn ends, more queued--> working;  --turn ends, none--> finished (idle timer armed; of the notes left
//   with the agent, ones it replied on go back to to do, §35, and ones it never answered stay sent, their batch
//   marked unfinished with the agent's last words, §35.7)
//   working --adapter exits--> failed (notes recalled);  any busy phase --stop--> idle (notes recalled)
//   Stop, close and an adapter exit answer every pending ask cancelled.
//
// `gen` counts stops and closes. Anything that awaited (a start, a turn's end) checks it afterwards, so
// work begun before a Stop never changes the state after it.
import { ACTIVITY_LINE_MAX, ActivityTracker, maskSecrets } from "../../core/agentActivity.js";
import { alwaysLabel, decide } from "../../core/agentRules.js";
import { NotFoundError, RushesError } from "../../core/errors.js";
import { oneLine } from "../../core/labels.js";
import { lineEvent } from "../../core/logEvents.js";
import { byFilm } from "../../core/notes.js";
import { noteState, recallNote, recallNotes } from "../../core/noteState.js";
import type { AgentId, AgentPermissions, AgentRules, AgentSettings, AlwaysRule, Batch, Note } from "../../core/schema.js";
import type { ChangeEvent, Store } from "../../core/store.js";
import { logBookFor } from "../logbook.js";
import { AcpConnection, type AcpPermissionOutcome, type AcpPermissionParams, type AdapterSpec, type McpServerSpec } from "./acp.js";
import { AUTO_FALLBACK, adapterSpec, clientMeta, modeFor, rushesMcp, sessionSetup } from "./adapters.js";
import { noteToolCall, withSeen, type SeenCalls } from "./seenCalls.js";
import { isOwnRushesTool, noteMcpCall, type McpCalls } from "./ownTools.js";
import { PermissionBroker, addRule, allowOutcome, dropRule, toRequest, type AskChoice, type PendingAsk } from "./broker.js";
import { detectAgents, type AgentInfo } from "./detect.js";
import { connectorEntry, ensureConnector } from "./connectors.js";
import { agentRulesFor, type AgentRulesFile } from "./rules.js";
import { batchJob, batchLabel, type TurnJob } from "./turns.js";

export type AgentPhase = "off" | "idle" | "starting" | "working" | "waiting" | "finished" | "failed";

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
  /** `entry` is the adapter's start file from `connector`. */
  spec?: (a: AgentInfo, root: string, level: AgentPermissions, entry: string) => AdapterSpec;
  /**
   * §34: the adapter's start file, fetched ahead of time (connectors.ts). Waited for before the start timeout begins.
   * Defaults to ensureConnector; with a `spec` injected (tests), to nothing.
   */
  connector?: { ready: (agent: AgentId) => boolean; ensure: (agent: AgentId) => Promise<string> };
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
export type SendResult = { handedTo: AgentId } | { handedTo: null; why: string; stopped?: true; recalled?: true; busy?: true };

type Accepted = { info: AgentInfo } | { why: string; stopped?: true };

/** How long the adapter stays up after its last turn (§5.2). */
export const AGENT_IDLE_MS = 600_000;
/** How long an adapter may take to start, from spawn to a ready session. A connector fetch (§34) is not counted. */
export const AGENT_START_MS = 120_000;
/** How long Stop waits for a cancelled turn to end before it kills the adapter. */
export const STOP_WAIT_MS = 5000;
/** §35.7: what the agent last said in a turn is kept to this many characters, and its first line to SAID_MAX. */
const SAID_KEPT = 2000;
const SAID_MAX = 160;
/** Activity keeps this many lines, in memory only. */
export const AGENT_LINES_KEPT = 200;
/** Long enough for AcpConnection.kill's SIGKILL (2 s) to land. */
const EXIT_WAIT_MS = 4000;
const CANCELLED: AcpPermissionOutcome = { outcome: "cancelled" };
/** Why a send or follow-up is refused once close() has begun. */
const CLOSING = "Rushes is closing";
/** A turn's failure in the adapter's words is kept to this many characters (the chip's tooltip). */
const ERROR_MAX = 200;
/** I1: Send to AI is on in the project, but the user's own rules file has no answer to the first-Send sheet. */
export const NOT_SET_UP = "Send to AI is not set up";
const OFF = "Send to AI is off";

/** Each agent by name, as Activity and the notification say it. */
export const AGENT_NAMES: Readonly<Record<AgentId, string>> = { claude: "Claude Code", codex: "Codex" };
const NAMES = AGENT_NAMES;

/** A start-up ended by Stop or close, not by a failure. */
/** The session could not be put in the mode in which the agent asks Rushes (R14, R15): the start fails with this. */
class ModeError extends Error {}
/** §34: the connector couldn't be fetched; its message says why in plain words. */
class ConnectorError extends Error {}

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

/** §30: a turn's share of notes on one film, and how its Change Log line names them ("2 notes"). */
interface FilmPart { film: string | null; label: string; ids: readonly string[] }

/** §35.7: the agent replied on the note since `ms` (when its batch was sent). */
const repliedSince = (n: Note, ms: number): boolean => n.replies.some((r) => r.by === "agent" && Date.parse(r.at) >= ms);

/**
 * §35.7: how a turn's end reads, by how many of its `total` notes were answered (replied on or done): "finished 3
 * notes", "finished 1 of 3 notes", "ended without answering 3 notes". A turn on script lines alone (no notes) finished.
 */
export function endedText(name: string, label: string, total: number, answered: number, stopReason: string): string {
  const why = stopReason === "end_turn" ? "" : ` (${stopReason})`;
  if (answered >= total) return stopReason === "end_turn" ? `${name} finished ${label}` : `${name} ended ${label}${why}`;
  if (answered === 0) return `${name} ended without answering ${label}${why}`;
  return `${name} finished ${answered} of ${label}${why}`;
}

export class AgentRunner {
  private readonly detect: () => Promise<AgentInfo[]>;
  private readonly specFor: (a: AgentInfo, root: string, level: AgentPermissions, entry: string) => AdapterSpec;
  private readonly connector: NonNullable<RunnerOptions["connector"]>;
  /**
   * Per adapter: which agent it runs, (Codex only) its MCP calls by tool call id (R16), and its session's mode as
   * last reported (round 2, item 3).
   */
  private readonly adapters = new WeakMap<AcpConnection, { agent: AgentId; level: AgentPermissions; calls: McpCalls; seen: SeenCalls; mode: string | null; modeReported: boolean; activity: ActivityTracker }>();
  /** §33: the row the last batch was sent under. */
  private lastLevel: AgentPermissions | null = null;
  private readonly mcp: (root: string) => McpServerSpec;
  private readonly idleMs: number;
  private readonly startMs: number;
  private readonly now: () => Date;

  private settings: AgentSettings | null = null;
  /** The user's rules for this project, kept outside it (R10). `rules` is the last read, for the status. */
  private readonly rulesFile: AgentRulesFile;
  private rules: AgentRules = { permissions: "project-edits", always: [], setUp: false, agent: null };
  private ruleReads = 0;
  private rulesApplied = 0;
  /** agent.json reads started, and the newest one applied (a write counts as one). */
  private reads = 0;
  private applied = 0;
  private phase: Exclude<AgentPhase, "off"> = "idle";
  private error: string | null = null;
  private lines: ActivityLine[] = [];
  private current: { note: string | null; doing: string | null } = { note: null, doing: null };

  /** Batches waiting for their turn, in the order they came in. */
  private queue: TurnJob[] = [];
  /** The job whose session/prompt is in flight; `done` settles when that prompt does. */
  private turn: { job: TurnJob; done: Promise<void> } | null = null;
  /** Permission asks waiting for the user. */
  private readonly broker: PermissionBroker;
  /** The latest Always rule write; a permission ask waits for it before reading the rules. */
  private ruleWrite: Promise<void> = Promise.resolve();
  /** A turn has ended and the runner is giving back the notes it left. */
  private ending = false;
  /** §35.7: the agent's last message in the turn in flight (the text after its last tool call), from its message chunks. */
  private said = "";

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

  constructor(private readonly store: Store, opts: RunnerOptions = {}) {
    this.detect = opts.detect ?? (() => detectAgents());
    this.specFor = opts.spec ?? adapterSpec;
    this.connector =
      opts.connector ??
      (opts.spec
        ? { ready: () => true, ensure: async () => "" }
        : { ready: (a) => connectorEntry(a) !== null, ensure: (a) => ensureConnector(a) });
    this.mcp = opts.mcp ?? rushesMcp;
    this.idleMs = opts.idleMs ?? AGENT_IDLE_MS;
    this.startMs = opts.startMs ?? AGENT_START_MS;
    this.now = opts.now ?? (() => new Date());
    this.broker = new PermissionBroker(store.root, { now: this.now, onChange: () => this.asksChanged() });
    this.rulesFile = agentRulesFor(store);
    store.on("change", this.onChange);
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
      batches: jobs.map((j) => j.batchId),
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
    return this.noteRefusal(batch.id, r);
  }

  /**
   * I3: hands over a batch whose hand-over was refused, once (Send again, or the copy dialog's Set up through the setup
   * route). The mark is taken off the batch in batches.json under the send lock, so two at once hand it over once, and a
   * restart in between loses nothing. Null when it wasn't refused, or has gone already. §35.7: with `unfinished` (Send
   * again), a batch whose turn ended with notes unanswered goes too, once no run is on its film.
   */
  async resend(batch: Batch, opts: { unfinished?: boolean } = {}): Promise<SendResult | null> {
    let busy: string | null = null;
    const r = await this.hand(async () => {
      // §35.7: an unfinished batch goes again only from Send again (`unfinished`), never from the setup sheet's hand-over.
      if (!batch.undelivered && !opts.unfinished) return null;
      // §35.7: a batch whose turn ended unfinished goes again only once nothing is running on its film, so a Send again
      // pressed while the agent is still on that film's work never starts a second run on it.
      busy = await this.busyOnFilm(batch);
      if (busy !== null) return null;
      const { result: took } = await this.store.update("batches", (f) => {
        const b = f.batches.find((x) => x.id === batch.id);
        if (!b?.undelivered && !(opts.unfinished && b?.unfinished)) return false;
        b.undelivered = null;
        b.unfinished = null;
        return true;
      });
      return took ? batchJob(batch) : null;
    });
    if (busy !== null) return { handedTo: null, why: busy, busy: true };
    if (r === null) return null;
    return this.noteRefusal(batch.id, r);
  }

  /**
   * §35.7: why `batch` can't go again now, when a turn in flight or queued is on a film its notes are on ("Claude Code is
   * still working on EU only"); null when none is. A project with one film (or notes on none) counts as one film.
   */
  private async busyOnFilm(batch: Batch): Promise<string | null> {
    const jobs = [...(this.turn ? [this.turn.job] : []), ...this.queue].filter((j) => j.batchId !== batch.id);
    if (jobs.length === 0 && !this.starting) return null;
    const [notes, batches, project] = await Promise.all([this.store.read("notes"), this.store.read("batches"), this.store.read("project")]);
    const filmOf = new Map(notes.notes.map((n) => [n.id, n.video ?? null]));
    const films = (b: Pick<Batch, "noteIds" | "video">): Set<string | null> => {
      const s = new Set<string | null>(b.noteIds.map((id) => filmOf.get(id) ?? null));
      if (s.size === 0) s.add(b.video ?? null);
      return s;
    };
    const mine = films(batch);
    for (const j of jobs) {
      const b = batches.batches.find((x) => x.id === j.batchId);
      const shared = b ? [...films(b)].find((f) => mine.has(f)) : undefined;
      if (shared === undefined) continue;
      const name = this.info?.name ?? (this.settings?.agent ? NAMES[this.settings.agent] : "The agent");
      const film = shared === null ? null : project.videos.find((v) => v.id === shared)?.name ?? null;
      return film ? `${name} is still working on ${film}` : `${name} is still working on this film`;
    }
    return null;
  }

  /**
   * Marks a batch refused while Send to AI really was on (the user's agent, switched on) and nothing started, its notes
   * still waiting with it (not signed in, not installed), for Send again. Not one refused because it only looked on (not
   * set up, no agent chosen) or was off: the desk offers no Set up for those, and the user may have copied the prompt.
   * The mark is written to batches.json, so it outlives this server. A failed write is logged, not thrown: the answer to
   * the desk still says why the batch didn't go.
   */
  private async noteRefusal(id: string, r: SendResult): Promise<SendResult> {
    if (r.handedTo === null && !r.stopped && !r.recalled && !r.busy && r.why !== CLOSING && this.switchedOn(this.settings, this.rules)) {
      const at = this.now().toISOString();
      await this.store
        .update("batches", (f) => {
          const b = f.batches.find((x) => x.id === id);
          if (b) b.undelivered = { at, why: r.why };
        })
        .catch((e: unknown) => console.error(`Rushes: couldn't mark batch ${id} for Send again: ${messageOf(e)}`));
    }
    return r;
  }

  /** Queues the job `make` gives (none: nothing to do, null back), then starts the adapter or pumps the queue. */
  private async hand(make: () => Promise<TurnJob | null>): Promise<SendResult | null> {
    const accepting = this.sendLock.then(async () => {
      const job = await make();
      return job ? this.accept(job) : null;
    });
    this.sendLock = accepting.catch(() => undefined);
    let accepted: Accepted | null;
    try {
      accepted = await accepting;
    } catch (e) {
      return { handedTo: null, why: messageOf(e) };
    }
    if (accepted === null) return null;
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
   * Checks the switch, the agent and its sign-in, then queues the job. Runs one at a time.
   */
  private async accept(job: TurnJob): Promise<Accepted | null> {
    while (this.stopping) await this.stopping;
    if (this.closed) return { why: CLOSING };
    const [settings, rules] = await Promise.all([this.loadSettings(), this.loadRules()]);
    if (!settings.on) return { why: OFF };
    const agent = settings.agent;
    // I1 and the consent fix: the switch and the agent in the project's agent.json are not the user's consent; the agent
    // they chose, in their own rules file, is. Unless the two name the same agent nothing is handed over and nothing
    // starts: the desk shows Send to AI off and copies the prompt, or opens the first-Send sheet.
    if (agent && !this.switchedOn(settings, rules)) return { why: NOT_SET_UP };
    if (!agent) return { why: "No agent chosen" };
    // §33: a Send runs in the row chosen when it was sent. One already running keeps its own.
    job.level = rules.permissions;
    const info = (await this.detect()).find((a) => a.id === agent);
    if (!info?.installed) return { why: `${info?.name ?? NAMES[agent]} is not installed` };
    if (info.outdated) return { why: `${info.name} ${info.version} is too old for Send to AI: update it` };
    if (!info.signedIn) return { why: `${info.name} is not signed in` };
    // A Stop or close may have begun while this send was checking.
    while (this.stopping) await this.stopping;
    if (this.closed) return { why: CLOSING };
    const queued = this.busy();
    if (!queued && this.conn) {
      // An idle adapter for another agent or another conversation is replaced.
      const kept = settings.session?.id ?? null;
      if (this.info?.id !== info.id || this.sessionId !== kept || this.levelChanged(this.conn, job)) this.dropConn();
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
      // §34: the connector is normally fetched when the desk starts. A Send made before that finished waits for it
      // here, outside the start timeout; a fetch that failed is tried again once.
      if (!this.connector.ready(info.id)) this.addLine(`Getting ${info.name} ready (a one-time download)`, null);
      let entry: string;
      try {
        entry = await this.connector.ensure(info.id);
      } catch (e) {
        throw new ConnectorError(messageOf(e));
      }
      if (gen !== this.gen) throw new Halted();
      const level = this.startLevel();
      conn = AcpConnection.start(this.specFor(info, root, level, entry));
      this.attach(conn, info.id, level);
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
        : e instanceof ModeError || e instanceof ConnectorError
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
    const { loadSession } = await c.initialize(clientMeta(info.id));
    check();
    const settings = await this.loadSettings();
    check();
    const mcp = [this.mcp(root)];
    const level = this.adapters.get(c)?.level ?? "project-edits";
    const setup = sessionSetup(info.id, level);
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
    await this.agentMode(c, info, sessionId, modes, current, level);
    check();
    if (c.hasExited) throw new Error("the adapter exited as it started");
    this.sessionId = sessionId;
  }

  /**
   * R14/R15: every opened or loaded session goes into the mode for the row it was started under (§33: ASK_MODE for
   * Manual and Accept edits, in which the agent asks Rushes before it acts; the agent's own for Auto and Bypass), before
   * the first prompt. Fails closed (round 2, item 3): the start fails with a ModeError, and its
   * notes go back, when the mode isn't offered (or no modes are reported), when set_mode throws, or when the
   * session's mode isn't the ask mode afterwards. That mode is the setup response's currentModeId, then the
   * ask mode once set_mode succeeds, unless a current_mode_update during set_mode reports another one (as
   * claude-agent-acp's setSessionMode does when it falls back).
   */
  private async agentMode(c: AcpConnection, info: AgentInfo, sessionId: string, modes: string[], current: string | null, level: AgentPermissions): Promise<void> {
    const want = modeFor(info.id, level);
    const refused = new ModeError(
      level === "auto" ? `${info.name} could not be put in Auto mode`
        : level === "bypass" ? `${info.name} could not be put in Bypass mode`
          : `${info.name} could not be put in a mode where Rushes approves actions`,
    );
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
    // Claude's adapter falls back from auto to acceptEdits for a model that can't run auto: commands still ask Rushes.
    const fallback = level === "auto" ? AUTO_FALLBACK[info.id] : undefined;
    if (fallback !== undefined && adapter.mode === fallback) {
      this.addLine(`${info.name} can't use Auto with this model: file edits go through, commands ask here`, null);
      return;
    }
    if (adapter.mode !== want) throw refused;
  }

  /**
   * §33: the row the agent starts in: the next batch's (its row when it was sent), else the last batch's, else the rules'
   * row now. A follow-up never starts the agent in Auto or Bypass on its own: only a Send made under that row does.
   */
  private startLevel(): AgentPermissions {
    const batch = [...(this.turn ? [this.turn.job] : []), ...this.queue].find((j) => j.kind === "batch" && j.level);
    const level = batch?.level ?? this.lastLevel ?? this.rules.permissions;
    if (batch?.level === undefined && this.lastLevel === null && (level === "auto" || level === "bypass")) return "project-edits";
    return level;
  }

  /** §33: `job` is a Send made under another row than the one `conn` runs in. */
  private levelChanged(conn: AcpConnection | null, job: TurnJob | undefined): boolean {
    if (!conn || job?.kind !== "batch" || job.level === undefined) return false;
    const running = this.adapters.get(conn)?.level;
    return running !== undefined && running !== job.level;
  }

  /**
   * §33: the row an ask is decided by. A batch keeps the row it started in: in Auto or Bypass the agent's own mode
   * already decided, so that row holds. In Manual or Accept edits the row now holds (so a switch to Manual asks at once),
   * except a switch to Auto or Bypass, which applies from the next Send.
   */
  private askLevel(running: AgentPermissions | undefined, now: AgentPermissions): AgentPermissions {
    if (running === "auto" || running === "bypass") return running;
    if (now === "auto" || now === "bypass") return running ?? "project-edits";
    return now;
  }

  /** Makes `conn` the runner's adapter and listens to it. */
  private attach(conn: AcpConnection, agent: AgentId, level: AgentPermissions): void {
    this.conn = conn;
    this.sessionId = null;
    this.live.add(conn);
    // R16: Codex names an MCP call's server and tool only in its tool_call update, before the approval comes.
    const calls: McpCalls = new Map();
    // Task 10 (3): each adapter's tool calls are followed from announced to run, so a command says it ran only then.
    // Task 10 round 2 (1): every tool call's kind, input and paths, so an ask that lacks them (Codex under AIR) gets them.
    const seen: SeenCalls = new Map();
    const adapter = { agent, level, calls, seen, mode: null as string | null, modeReported: false, activity: new ActivityTracker(this.store.root) };
    this.adapters.set(conn, adapter);
    conn.on("update", (u: unknown) => {
      if (agent === "codex") noteMcpCall(calls, u);
      noteToolCall(seen, u);
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
  private async onPermission(conn: AcpConnection, asked: AcpPermissionParams): Promise<AcpPermissionOutcome> {
    const live = () => !this.closed && !this.stopping && conn === this.conn && !conn.hasExited;
    if (!live()) return CANCELLED;
    const adapter = this.adapters.get(conn);
    // What the ask lacks (a kind, a command, paths) comes from the tool call this adapter reported for it (seenCalls.ts).
    const p = adapter ? withSeen(asked, adapter.seen) : asked;
    // R16: Rushes's own MCP tools never ask, under any permission level.
    if (adapter && isOwnRushesTool(adapter.agent, this.store.root, p, adapter.calls)) return allowOutcome(p.options);
    // The adapter hears "yes" before an Always rule is written: wait for that write, then read the rules.
    await this.ruleWrite;
    const rules = await this.loadRules();
    if (!live()) return CANCELLED;
    const level = this.askLevel(adapter?.level, rules.permissions);
    if (decide(toRequest(p, this.store.root), { permissions: level, always: rules.always }, this.store.root) === "allow") return allowOutcome(p.options);
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
    if (this.levelChanged(conn, this.queue[0])) {
      // §33: the next Send was made under another row. Its mode is set as a session opens, so the agent starts again
      // (the conversation is loaded, as after any restart) before it begins.
      this.dropConn();
      this.ensureStarted().then(() => this.pump(), () => undefined);
      return;
    }
    const job = this.queue.shift()!;
    if (job.level) this.lastLevel = job.level;
    const gen = this.gen;
    const name = this.info?.name ?? "The agent";
    this.said = "";
    this.clearIdle();
    let done!: () => void;
    this.turn = { job, done: new Promise<void>((r) => (done = r)) };
    this.phase = "working";
    this.error = null;
    this.current = { note: null, doing: null };
    this.milestone(`${name} started on ${job.label}`, job, (p) => `${name} started on ${p.label}`);
    this.announce();
    this.track(
      conn.prompt(sessionId, job.prompt).then(
        (r) => {
          done();
          return r.failure !== null ? this.turnFailedInPlace(gen, job, r.failure) : this.turnEnded(gen, job, r.stopReason);
        },
        (err: unknown) => {
          done();
          this.turnFailed(gen, conn, job, err);
        },
      ),
    );
  }

  /**
   * The turn ended. §35: of the notes it left with the agent (still sent in its batch), the ones the agent replied on in
   * this turn go back to to do, their replies kept. §35.7: the ones it never answered (no reply, not done) stay sent, and
   * the batch is marked unfinished with the first line of the agent's last message, so the desk can say why and offer
   * Send again; they don't turn up in Send's count as if never sent. The "finished" line counts answered notes only.
   */
  private async turnEnded(gen: number, job: TurnJob, stopReason: string): Promise<void> {
    // Stopped, closed or failed meanwhile: whoever did that has already settled this job.
    if (gen !== this.gen || this.turn?.job !== job) return;
    const name = this.info?.name ?? "The agent";
    const said = this.saidLine();
    this.turn = null;
    this.ending = true;
    this.announce();
    // Still busy while the notes are read, so a send now queues and is picked up below.
    let back = 0;
    let kept = 0;
    let answered = new Set<string>();
    let whole: string[] = [];
    try {
      // §35.7: a note is answered by a reply made since its batch was sent (replies and batches carry the server's clock).
      const batch = (await this.store.read("batches")).batches.find((x) => x.id === job.batchId);
      whole = batch?.noteIds ?? [];
      const sinceMs = batch ? Date.parse(batch.sentAt) : 0;
      const replied = (n: Note) => repliedSince(n, sinceMs);
      const notes = await this.store.read("notes");
      if (notes.notes.some((n) => this.leftOver(job, n))) {
        const { result } = await this.store.update("notes", (f) => {
          let moved = 0;
          let stay = 0;
          for (const n of f.notes.filter((x) => this.leftOver(job, x))) {
            if (replied(n)) moved += recallNote(f.notes, n.id, job.batchId) ? 1 : 0;
            else stay += 1;
          }
          return { moved, stay };
        });
        back = result.moved;
        kept = result.stay;
      }
      if (kept > 0) {
        const at = this.now().toISOString();
        await this.store.update("batches", (f) => {
          const b = f.batches.find((x) => x.id === job.batchId);
          if (b) b.unfinished = { at, said };
        });
      }
      answered = new Set((await this.store.read("notes")).notes.filter((n) => noteState(n) === "done" || replied(n)).map((n) => n.id));
    } catch (e) {
      console.error(`Rushes: couldn't read the notes after a turn: ${messageOf(e)}`);
    }
    if (gen !== this.gen) return;
    const ended = (p: { label: string; ids: readonly string[] }) => endedText(name, p.label, p.ids.length, p.ids.filter((id) => answered.has(id)).length, stopReason);
    this.milestone(ended({ label: job.label, ids: whole }), job, ended);
    if (back > 0) this.addLine(back === 1 ? "1 note the agent replied on is back in to do" : `${back} notes the agent replied on are back in to do`, null);
    if (kept > 0) this.addLine(kept === 1 ? "1 note was not answered and stays sent" : `${kept} notes were not answered and stay sent`, null);
    if (gen !== this.gen) return;
    this.ending = false;
    if (this.queue.length) return this.pump();
    this.phase = "finished";
    this.current = { note: null, doing: null };
    this.announce();
    this.armIdle();
  }

  /**
   * §35.7: the first line of the agent's last message in the turn, as one short line with secrets masked and markdown's
   * leading marks dropped. Null when it said nothing.
   */
  private saidLine(): string | null {
    for (const raw of this.said.split(/\r?\n/)) {
      const text = oneLine(maskSecrets(raw.replace(/^[\s#>*\-•]+/, "").replace(/\*\*|__|`/g, "")), SAID_MAX);
      if (text !== "" && text !== "…") return text;
    }
    return null;
  }

  /** M3, §35: a note the ended turn left with the agent: still sent in the turn's batch. */
  private leftOver(job: TurnJob, n: Note): boolean {
    return n.batch === job.batchId && noteState(n) === "sent";
  }

  /**
   * Task 10 (1): the adapter answered the prompt but said the turn failed (Codex: a model it can't use, a service error).
   * The run fails with the adapter's words, one line: "<A> couldn't finish: <words>" in Activity and the Change Log, and
   * the words as the status's error. As when a turn ends (M3), the notes it left with the agent go back to to do, and
   * done ones stay; the jobs queued behind it give their notes back, as a failure's do. The adapter stays up.
   */
  private async turnFailedInPlace(gen: number, job: TurnJob, message: string): Promise<void> {
    if (gen !== this.gen || this.turn?.job !== job) return;
    const name = this.info?.name ?? "The agent";
    // Kept to a readable length for the chip's tooltip (Task 10 round 2, 4).
    const why = oneLine(message, ERROR_MAX) || "it stopped with an error";
    this.turn = null;
    this.ending = true;
    const queued = this.queue;
    this.queue = [];
    this.milestone(`${name} couldn't finish: ${why}`, job);
    this.announce();
    let back = 0;
    try {
      const notes = await this.store.read("notes");
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
    await this.recall({ batches: queued.map((j) => j.batchId), notes: [] });
    if (gen !== this.gen) return;
    if (back > 0) this.addLine(back === 1 ? "1 note was not picked up and is back in to do" : `${back} notes were not picked up and are back in to do`, null);
    this.ending = false;
    // A Send accepted while this was being settled queued behind it: it runs now, as after any turn (round 2, 3).
    if (this.queue.length) return this.pump();
    this.phase = "failed";
    this.error = why;
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
    if (this.turn) this.hear(update);
    const text = this.adapters.get(conn)?.activity.line(update) ?? null;
    if (!text) return;
    this.addLine(text, this.current.note);
    this.announce();
  }

  /** §35.7: keeps the agent's words since its last tool call, so the turn's end can quote the first line of its last message. */
  private hear(update: unknown): void {
    const u = update as { sessionUpdate?: unknown; content?: { type?: unknown; text?: unknown } } | null;
    if (u?.sessionUpdate === "tool_call") this.said = "";
    else if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text" && typeof u.content.text === "string" && this.said.length < SAID_KEPT) {
      this.said += u.content.text;
    }
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
    // Batches in flight or queued are dropped, and give their notes back.
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
      batches: jobs.map((j) => j.batchId),
      notes: [],
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

  /**
   * An Activity line and a Change Log line, for a run starting, finishing, stopping or failing. §30: with the run's
   * `job`, the Change Log line is written once per film its notes are on, each with that film, so a film's Activity
   * never tells another film's work; `say` words a batch's line from that film's own count ("2 notes").
   */
  private milestone(text: string, job?: TurnJob, say?: (part: FilmPart) => string): void {
    this.addLine(text, null);
    this.track(this.writeMilestone(text, job, say));
  }

  private async writeMilestone(text: string, job?: TurnJob, say?: (part: FilmPart) => string): Promise<unknown> {
    const at = this.now();
    // LogBook.add never throws: a line it can't write is reported and counted.
    const book = logBookFor(this.store);
    const parts = job ? await this.filmParts(job).catch(() => []) : [];
    if (parts.length === 0) return book.add(lineEvent(text, "notes"), "rushes", at);
    for (const p of parts) await book.add(lineEvent(say && job ? say(p) : text, "notes", { video: p.film }), "rushes", at);
    return undefined;
  }

  /** §30: the films a turn's notes are on, each with the label of its own share of them ("2 notes"). */
  private async filmParts(job: TurnJob): Promise<FilmPart[]> {
    const notes = await this.store.read("notes");
    const b = (await this.store.read("batches")).batches.find((x) => x.id === job.batchId);
    if (!b) return [];
    const filmOf = new Map(notes.notes.map((n) => [n.id, n.video ?? null]));
    const groups = byFilm(b.noteIds, (id) => filmOf.get(id));
    if (groups.length === 0 || (b.sectionIds.length > 0 && !groups.some(([f]) => f === null))) groups.push([null, []]);
    return groups.map(([film, ids]) => ({ film, ids, label: batchLabel({ noteIds: ids, sectionIds: film === null ? b.sectionIds : [] }) }));
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
