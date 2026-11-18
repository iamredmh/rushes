// A fake ACP agent (Agent Client Protocol over stdio, one JSON object per line).
// Every runner and route test drives this instead of a real adapter or model.
// Run it as: node test/helpers/fake-acp.mjs
//
// Environment
//   FAKE_ACP_SCENARIO  path to a JSON scenario file (required)
//   FAKE_ACP_LOG       path; every received message (requests, notifications and
//                      responses) is appended as one JSON line
//   FAKE_ACP_BASE      base URL used by `http` steps
//   FAKE_ACP_MODES     modes offered when the scenario names none (see `modes`)
//
// Scenario: { loadSession?: boolean, loadFails?: string, exitOnCancel?: boolean, modes?: string[], ignoreModeChanges?: boolean,
//             setModeFails?: string, exitOnStart?: number,
//             ignoreSigterm?: boolean, hangOnInitialize?: boolean, turns: Step[][] }
//   loadSession  advertised as agentCapabilities.loadSession (default false)
//   loadFails    session/load answers a JSON-RPC error with this message (still logged as { loaded: id }),
//                as an agent does for a session it has pruned
//   exitOnCancel on session/cancel during a turn, exit with code 0 instead of ending the turn
//   modes        when given, session/new and session/load answer
//                { modes: { currentModeId, availableModes: modes.map(id => ({ id, name: id })) } }; currentModeId is
//                modes[0], or the request's configOptions "mode" value when offered. session/set_mode to an offered
//                mode changes it; to one not offered it answers an error. Without `modes`, FAKE_ACP_MODES
//                (comma-separated) is used; without either, no modes. Each session/prompt logs { promptMode }.
//   ignoreModeChanges  configOptions and set_mode leave the mode as it is; set_mode then sends a
//                current_mode_update with the mode it stayed in before it answers, as an adapter that falls back does
//   setModeFails session/set_mode answers a JSON-RPC error with this message
//   exitOnStart  exit with that code before reading anything
//   hangOnInitialize  never answer initialize (an adapter that stalls as it starts)
//   ignoreSigterm  trap SIGTERM and carry on, so only SIGKILL ends the process
//   turns        turn i runs on the i-th session/prompt; with fewer turns than
//                prompts the extra prompt ends at once with end_turn
//
// Steps (run in order within a turn)
//   { update: object }      send session/update { sessionId, update }
//   { permission: { toolCall: object, options?: object[], meta?: object }, record?: string }
//                           send session/request_permission (with `meta` as the request's _meta) and wait for the answer, which
//                           is logged (as a received response) and, when `record` is given,
//                           also appended to the log as { recorded: record, outcome }.
//                           Default options: allow_once, allow_always, reject_once.
//   { permissions: [{ toolCall, options?, meta?, record? }, ...] }
//                           send every one of these session/request_permission at once (an agent asking for parallel
//                           tool calls) and wait until all are answered; each answer is logged, and recorded as above
//                           when it has `record` as soon as it comes. session/cancel answers all still open as cancelled.
//   { startedAsk: { toolCall: object, permission: object }, record?: string }
//                           an ask for a tool call that has already started, as codex-acp 2.7.0 sends it to a client
//                           that advertised AIR (its "AIR tool-call contract"): first the session/update tool_call
//                           with `toolCall` (its kind, title, status, rawInput…), then session/request_permission whose
//                           toolCall is `{ toolCallId, ...permission }` and carries no kind or status of its own.
//                           The answer is logged and recorded as for `permission`. For a command codex-acp parsed as a
//                           read, search or listing, `toolCall` has that kind (read, search) and, for a read, the file as
//                           a location; the ask still has no kind, and `rawInput.command` holds the command.
//   { http: { method, path, body } }
//                           fetch(FAKE_ACP_BASE + path) with a JSON body and wait for it
//                           (stands in for the agent's rushes_* tools)
//   { sleep: ms }           wait
//   { stderr: "text" }      write the text to stderr
//   { crash: code }         exit the process with that code at once
//   { stop: "end_turn" | "refusal" }
//                           end the turn with that stopReason (default end_turn)
//   { fail: "message" }     end the turn as codex-acp 2.7.0 ends a failed Codex turn (a model error): stopReason end_turn
//                           all the same. A client that advertised the AIR "sessionFailure" capability at initialize
//                           (clientCapabilities._meta.jetbrains.air) gets the error as the response's
//                           _meta.jetbrains.air.sessionFailure { severity: "error", title }; any other client gets only an
//                           agent_message_chunk with the text and no messageId, as codex-acp sends it
//
// Methods answered: initialize, session/new (sessions fake-session-1, -2, ...),
// session/load (records the id in the log as { loaded: id }), session/set_mode,
// session/prompt. On the session/cancel notification it answers any open permission
// request locally as cancelled, stops the turn and answers the open prompt with
// stopReason "cancelled".
import { createInterface } from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";

const scenario = JSON.parse(readFileSync(process.env.FAKE_ACP_SCENARIO, "utf8"));
if (scenario.ignoreSigterm) process.on("SIGTERM", () => {});
if (typeof scenario.exitOnStart === "number") process.exit(scenario.exitOnStart);

const logPath = process.env.FAKE_ACP_LOG;
const log = (obj) => {
  if (logPath) appendFileSync(logPath, JSON.stringify(obj) + "\n");
};
const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\n");

const waiting = new Map(); // id -> { resolve } for requests we sent
let nextOutId = 1;
let sessions = 0;
let promptCount = 0;
let openTurn = null; // { id, sessionId, cancelled, wake }
let clientCaps = null; // initialize's clientCapabilities

// The modes offered: the scenario's, else FAKE_ACP_MODES (comma-separated, set by the rigs per agent), else none.
const offered = scenario.modes ?? (process.env.FAKE_ACP_MODES ? process.env.FAKE_ACP_MODES.split(",") : null);
const modeOf = new Map(); // sessionId -> current mode id
/** A setup request's mode: modes[0], or the configOptions "mode" entry when offered (unless ignoreModeChanges). */
function openMode(sessionId, params) {
  let mode = offered?.[0];
  const asked = Array.isArray(params?.configOptions) ? params.configOptions.find((o) => o?.configId === "mode")?.value : undefined;
  if (!scenario.ignoreModeChanges && offered?.includes(asked)) mode = asked;
  modeOf.set(sessionId, mode);
}
const modesBlock = (sessionId) =>
  offered ? { modes: { currentModeId: modeOf.get(sessionId), availableModes: offered.map((id) => ({ id, name: id })) } } : {};

const sleep = (ms, turn) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    turn.wake = () => { clearTimeout(t); resolve(); };
  });

function askClient(method, params, turn) {
  const id = `f${nextOutId++}`;
  return new Promise((resolve) => {
    waiting.set(id, { resolve });
    turn.wake = () => { waiting.delete(id); resolve({ result: { outcome: { outcome: "cancelled" } } }); };
    send({ id, method, params });
  });
}

function permissionParams(p, turn) {
  const options = p.options ?? [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ];
  const params = { sessionId: turn.sessionId, toolCall: p.toolCall, options };
  if (p.meta) params._meta = p.meta;
  return params;
}

/**
 * Sends every permission request at once and waits for all the answers, recording each as it comes; a cancel answers
 * those still open.
 */
function askAll(list, turn) {
  const ids = [];
  const answers = list.map(
    (p) =>
      new Promise((resolve) => {
        const id = `f${nextOutId++}`;
        ids.push(id);
        waiting.set(id, { resolve });
        send({ id, method: "session/request_permission", params: permissionParams(p, turn) });
      }).then((res) => {
        if (p.record) log({ recorded: p.record, outcome: res.result?.outcome ?? null });
      }),
  );
  turn.wake = () => {
    for (const id of ids) {
      const w = waiting.get(id);
      if (!w) continue;
      waiting.delete(id);
      w.resolve({ result: { outcome: { outcome: "cancelled" } } });
    }
  };
  return Promise.all(answers);
}

async function runTurn(turn) {
  const steps = scenario.turns?.[turn.index] ?? [];
  let stopReason = "end_turn";
  let failure = null;
  for (const step of steps) {
    if (turn.cancelled) break;
    if (step.update) {
      send({ method: "session/update", params: { sessionId: turn.sessionId, update: step.update } });
    } else if (step.permission) {
      const res = await askClient("session/request_permission", permissionParams(step.permission, turn), turn);
      if (step.record) log({ recorded: step.record, outcome: res.result?.outcome ?? null });
    } else if (step.startedAsk) {
      const { toolCall, permission } = step.startedAsk;
      send({ method: "session/update", params: { sessionId: turn.sessionId, update: { sessionUpdate: "tool_call", ...toolCall } } });
      const res = await askClient("session/request_permission", permissionParams({ toolCall: { toolCallId: toolCall.toolCallId, ...permission } }, turn), turn);
      if (step.record) log({ recorded: step.record, outcome: res.result?.outcome ?? null });
    } else if (Array.isArray(step.permissions)) {
      await askAll(step.permissions, turn);
    } else if (step.http) {
      const { method, path, body } = step.http;
      const r = await fetch(process.env.FAKE_ACP_BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      await r.text();
    } else if (typeof step.sleep === "number") {
      await sleep(step.sleep, turn);
    } else if (typeof step.stderr === "string") {
      process.stderr.write(step.stderr);
    } else if (typeof step.crash === "number") {
      process.exit(step.crash);
    } else if (step.stop) {
      stopReason = step.stop;
      break;
    } else if (typeof step.fail === "string") {
      failure = step.fail;
      break;
    }
  }
  if (turn.cancelled) stopReason = "cancelled";
  if (openTurn === turn) openTurn = null;
  if (failure !== null && !turn.cancelled) {
    const air = clientCaps?._meta?.jetbrains?.air;
    if (air && Array.isArray(air.capabilities) && air.capabilities.includes("sessionFailure")) {
      const sessionFailure = { id: `turn-${turn.index}:error`, revision: 1, category: "service", severity: "error", title: failure, actions: [] };
      send({ id: turn.id, result: { stopReason: "end_turn", _meta: { jetbrains: { air: { version: 1, sessionFailure } } } } });
      return;
    }
    send({ method: "session/update", params: { sessionId: turn.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${failure}\n\n` } } } });
  }
  send({ id: turn.id, result: { stopReason } });
}

function onMessage(msg) {
  const hasId = msg.id !== undefined && msg.id !== null;
  if (typeof msg.method !== "string") {
    if (hasId && waiting.has(msg.id)) {
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      w.resolve(msg);
    }
    return;
  }
  if (!hasId) {
    if (msg.method === "session/cancel" && openTurn) {
      if (scenario.exitOnCancel) process.exit(0);
      openTurn.cancelled = true;
      openTurn.wake?.();
    }
    return;
  }
  switch (msg.method) {
    case "initialize":
      clientCaps = msg.params?.clientCapabilities ?? null;
      if (scenario.hangOnInitialize) break;
      send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: !!scenario.loadSession }, authMethods: [] } });
      break;
    case "session/new": {
      const sessionId = `fake-session-${++sessions}`;
      openMode(sessionId, msg.params);
      send({ id: msg.id, result: { sessionId, ...modesBlock(sessionId) } });
      break;
    }
    case "session/load":
      log({ loaded: msg.params?.sessionId });
      if (typeof scenario.loadFails === "string") send({ id: msg.id, error: { code: -32603, message: scenario.loadFails } });
      else {
        openMode(msg.params?.sessionId, msg.params);
        send({ id: msg.id, result: { ...modesBlock(msg.params?.sessionId) } });
      }
      break;
    case "session/set_mode": {
      const { sessionId, modeId } = msg.params ?? {};
      if (typeof scenario.setModeFails === "string") send({ id: msg.id, error: { code: -32603, message: scenario.setModeFails } });
      else if (!offered?.includes(modeId)) send({ id: msg.id, error: { code: -32602, message: `Mode ${modeId} is not available in this session` } });
      else {
        // Like claude-agent-acp's setSessionMode: an adapter that ends in another mode than asked says so first.
        if (!scenario.ignoreModeChanges) modeOf.set(sessionId, modeId);
        if (modeOf.get(sessionId) !== modeId) send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: modeOf.get(sessionId) } } });
        send({ id: msg.id, result: {} });
      }
      break;
    }
    case "session/prompt": {
      log({ promptMode: modeOf.get(msg.params?.sessionId) ?? null });
      const turn = { id: msg.id, sessionId: msg.params?.sessionId, index: promptCount++, cancelled: false, wake: null };
      openTurn = turn;
      void runTurn(turn);
      break;
    }
    default:
      send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  log(msg);
  onMessage(msg);
});
process.stdin.on("end", () => process.exit(0));
