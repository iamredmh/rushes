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
//   { http: { method, path, body } }
//                           fetch(FAKE_ACP_BASE + path) with a JSON body and wait for it
//                           (stands in for the agent's rushes_* tools)
//   { sleep: ms }           wait
//   { stderr: "text" }      write the text to stderr
//   { crash: code }         exit the process with that code at once
//   { stop: "end_turn" | "refusal" }
//                           end the turn with that stopReason (default end_turn)
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

async function runTurn(turn) {
  const steps = scenario.turns?.[turn.index] ?? [];
  let stopReason = "end_turn";
  for (const step of steps) {
    if (turn.cancelled) break;
    if (step.update) {
      send({ method: "session/update", params: { sessionId: turn.sessionId, update: step.update } });
    } else if (step.permission) {
      const options = step.permission.options ?? [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ];
      const params = { sessionId: turn.sessionId, toolCall: step.permission.toolCall, options };
      if (step.permission.meta) params._meta = step.permission.meta;
      const res = await askClient("session/request_permission", params, turn);
      if (step.record) log({ recorded: step.record, outcome: res.result?.outcome ?? null });
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
    }
  }
  if (turn.cancelled) stopReason = "cancelled";
  if (openTurn === turn) openTurn = null;
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
