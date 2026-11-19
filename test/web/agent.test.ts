// Send to AI in the desk (plan 2, task 1): the pure helpers behind the chip, the note badges, the who-line,
// the live strip and what the desk does after Send. Every string is the plan's own.
import { describe, expect, it } from "vitest";
import {
  ASK_ARM_MS, ASK_WORDS, BYPASS_WARNING, askArmKey, askChoices, askHeading, askLead, revealParts, revealText, MENU_WORDS, PERMISSION_CHOICES, setDeskPlatform, signInWord, SHEET_WORDS, afterSend, focusAfterRemove, followSend, planLead, mayQuestion, notSignedInWhy, sendToLabel, sheetDefault, sheetPrimary, sheetRows, whoNext, agentName, canStop, chipShows, chipText, chipTone, footLine, liveLines, stripMode, stripLine, runLabel, menuAgents, menuRowCount, noteAgentBadge, rowText, ruleRows, whoLine, answerPlaceholder, badgeText, fixGo, noteLite, noteThread, replyBoxShows, threadParts, newCutFor, stepCuts, cutAction, unseenCut,
  type NoteLite,
} from "../../web/src/agent.js";
import type { AgentInfo, AgentStatus, Note, PendingAsk } from "../../web/src/types.js";

const status = (over: Partial<AgentStatus> = {}): AgentStatus => ({
  on: true, agent: "claude", phase: "idle", batches: [], followUps: [], current: { note: null, doing: null }, asks: [], lines: [], error: null, session: null, asked: true,
  permissions: "project-edits", always: [], ...over,
});

const note = (id: string, over: Partial<NoteLite> = {}): NoteLite => ({ id, batch: null, status: "todo", fixVersion: null, ...over });

/** Three notes in batch b1 and one in b2. */
const notes: NoteLite[] = [note("n1", { batch: "b1" }), note("n2", { batch: "b1" }), note("n9", { batch: "b2" }), note("n3", { batch: "b1" })];

describe("agentName", () => {
  it("names each agent, and says your agent for none", () => {
    expect(agentName("claude")).toBe("Claude Code");
    expect(agentName("codex")).toBe("Codex");
    expect(agentName(null)).toBe("your agent");
  });
});

describe("chipText", () => {
  it("starting", () => {
    expect(chipText(status({ phase: "starting" }), notes)).toBe("Starting Claude Code");
  });

  it("working on a note in a batch: its place among that batch's notes", () => {
    const s = status({ phase: "working", batches: ["b1"], current: { note: "n2", doing: "Editing the cut" } });
    expect(chipText(s, notes)).toBe("Claude Code · note 2 of 3");
    expect(chipText({ ...s, current: { note: "n3", doing: null } }, notes)).toBe("Claude Code · note 3 of 3");
  });

  it("working with no current note", () => {
    expect(chipText(status({ phase: "working", agent: "codex" }), notes)).toBe("Codex is working");
  });

  it("working on a note it doesn't hold, or one in no batch, is just working", () => {
    expect(chipText(status({ phase: "working", current: { note: "gone", doing: null } }), notes)).toBe("Claude Code is working");
    expect(chipText(status({ phase: "working", current: { note: "n0", doing: null } }), [note("n0")])).toBe("Claude Code is working");
  });

  it("waiting", () => {
    expect(chipText(status({ phase: "waiting" }), notes)).toBe("Claude Code is waiting for you");
  });

  it("question", () => {
    expect(chipText(status({ phase: "question" }), notes)).toBe("Claude Code has a question");
  });

  it("finished", () => {
    expect(chipText(status({ phase: "finished" }), notes)).toBe("Claude Code finished");
  });

  it("failed", () => {
    expect(chipText(status({ phase: "failed" }), notes)).toBe("Claude Code didn't finish");
  });

  it("off and idle show no chip", () => {
    expect(chipText(status({ phase: "off", on: false, agent: null }), notes)).toBeNull();
    expect(chipText(status({ phase: "idle" }), notes)).toBeNull();
    expect(chipText(status({ phase: "idle", batches: ["b1", "b2"] }), notes)).toBeNull();
  });

  it("with no agent chosen it names your agent", () => {
    expect(chipText(status({ phase: "starting", agent: null }), notes)).toBe("Starting your agent");
  });

  it("adds the batch count when more than one is in hand", () => {
    const s = status({ phase: "working", batches: ["b1", "b2"], current: { note: "n1", doing: null } });
    expect(chipText(s, notes)).toBe("Claude Code · note 1 of 3 · 2 batches");
    expect(chipText(status({ phase: "waiting", batches: ["b1", "b2", "b3"] }), notes)).toBe("Claude Code is waiting for you · 3 batches");
    expect(chipText(status({ phase: "working", batches: ["b1"] }), notes)).toBe("Claude Code is working");
  });
});

describe("noteAgentBadge", () => {
  const working = status({ phase: "working", batches: ["b1"], current: { note: "n1", doing: "Trimming the intro" } });

  it("a note that needs you says so, ahead of everything", () => {
    expect(noteAgentBadge(note("n1", { batch: "b1", needsYou: true }), working)).toEqual({ kind: "needsYou", text: "Needs you" });
  });

  it("the note being worked on says what the agent is doing", () => {
    expect(noteAgentBadge(note("n1", { batch: "b1" }), working)).toEqual({ kind: "working", text: "Trimming the intro" });
  });

  it("the note being worked on with nothing said yet: Working on it", () => {
    const s = { ...working, current: { note: "n1", doing: null } };
    expect(noteAgentBadge(note("n1", { batch: "b1" }), s)).toEqual({ kind: "working", text: "Working on it" });
  });

  it("the current note outside a running phase is only with the agent", () => {
    const s = { ...working, phase: "finished" as const };
    expect(noteAgentBadge(note("n1", { batch: "b1" }), s)).toEqual({ kind: "with", text: "With Claude Code" });
  });

  it("a sent note is with the agent", () => {
    expect(noteAgentBadge(note("n2", { batch: "b1" }), working)).toEqual({ kind: "with", text: "With Claude Code" });
    expect(noteAgentBadge(note("n2", { batch: "b1" }), null)).toEqual({ kind: "with", text: "With your agent" });
  });

  it("a done note with a fix version says where it was fixed", () => {
    expect(noteAgentBadge(note("n2", { batch: "b1", status: "done", fixVersion: "v8" }), working)).toEqual({ kind: "fixed", text: "Fixed in v8" });
  });

  it("anything else has no badge", () => {
    expect(noteAgentBadge(note("n2", { status: "done" }), working)).toBeNull();
    expect(noteAgentBadge(note("n4"), working)).toBeNull();
    expect(noteAgentBadge(note("n4"), null)).toBeNull();
  });
});

describe("afterSend", () => {
  it("no hand-over at all, or a plain refusal: the Copy prompt dialog", () => {
    expect(afterSend(undefined)).toBe("dialog");
    expect(afterSend({ handedTo: null, why: "Send to AI is off" })).toBe("dialog");
  });

  it("a Stop's refusal", () => {
    expect(afterSend({ handedTo: null, why: "Stopped", stopped: true })).toBe("stopped");
  });

  it("a recalled start, even with no reason given", () => {
    expect(afterSend({ handedTo: null, why: "Claude Code did not start", recalled: true })).toBe("recalled");
    expect(afterSend({ handedTo: null, recalled: true } as never)).toBe("recalled");
  });

  it("still starting", () => {
    expect(afterSend({ handedTo: "claude", starting: true })).toBe("starting");
  });

  it("handed over", () => {
    expect(afterSend({ handedTo: "codex" })).toBe("handed");
  });
});

describe("whoLine", () => {
  it("auto and bypass (§33)", () => {
    expect(whoLine(status({ permissions: "auto", agent: "claude" }))).toBe("Auto: Claude Code decides what to ask");
    expect(whoLine(status({ permissions: "auto", agent: "codex" }))).toBe("Auto: Codex decides what to ask");
    expect(whoLine(status({ permissions: "bypass" }))).toBe("Bypass: nothing asks, nothing is checked");
  });

  it("ask-all", () => {
    expect(whoLine(status({ permissions: "ask-all" }))).toBe("Asks before everything");
  });

  it("project-edits", () => {
    expect(whoLine(status({ permissions: "project-edits" }))).toBe("Edits files in this project, asks before commands");
  });

  it("says the next Send continues a conversation there is", () => {
    expect(whoLine(status({ permissions: "ask-all", session: "s1" }))).toBe("Asks before everything · next Send continues the conversation");
    expect(whoLine(status({ session: "s1" }))).toBe("Edits files in this project, asks before commands · next Send continues the conversation");
  });
});

describe("liveLines", () => {
  const line = (i: number) => ({ at: `2026-11-17T10:00:${String(i).padStart(2, "0")}Z`, text: `line ${i}`, note: null });

  it("the newest lines first, at most 20 by default", () => {
    const s = status({ lines: Array.from({ length: 30 }, (_, i) => line(i)) });
    const got = liveLines(s);
    expect(got).toHaveLength(20);
    expect(got[0].text).toBe("line 29");
    expect(got[19].text).toBe("line 10");
  });

  it("takes a smaller limit, and fewer lines than the limit", () => {
    const s = status({ lines: [line(1), line(2), line(3)] });
    expect(liveLines(s, 2).map((l) => l.text)).toEqual(["line 3", "line 2"]);
    expect(liveLines(s).map((l) => l.text)).toEqual(["line 3", "line 2", "line 1"]);
  });

  it("never reorders the status it was given", () => {
    const s = status({ lines: [line(1), line(2)] });
    liveLines(s);
    expect(s.lines.map((l) => l.text)).toEqual(["line 1", "line 2"]);
  });
});

describe("the live strip (task 7)", () => {
  it("stripMode: live while the run goes, collapsed once it ended with lines, nothing off or idle", () => {
    const l = [{ at: "2026-11-17T10:00:00Z", text: "x", note: null }];
    for (const phase of ["starting", "working", "waiting", "question"] as const) expect(stripMode(status({ phase, lines: l }))).toBe("live");
    expect(stripMode(status({ phase: "working" }))).toBe("live");
    for (const phase of ["finished", "failed"] as const) expect(stripMode(status({ phase, lines: l }))).toBe("ended");
    expect(stripMode(status({ phase: "finished" }))).toBeNull();
    expect(stripMode(status({ phase: "off", lines: l }))).toBeNull();
    expect(stripMode(status({ phase: "idle", lines: l }))).toBeNull();
  });

  it("runLabel is the collapsed line", () => {
    expect(runLabel(3)).toBe("Show the run (3)");
    expect(runLabel(1)).toBe("Show the run (1)");
  });

  it("stripLine shows hidden characters in the agent's text", () => {
    expect(stripLine({ at: "x", text: "Read\u202e file", note: null })).toBe(revealText("Read\u202e file"));
    expect(stripLine({ at: "x", text: "Read file", note: null })).toBe("Read file");
  });
});

describe("the chip (task 2)", () => {
  const at = (iso: string) => ({ at: iso, text: "a line", note: null });
  const now = Date.parse("2026-11-17T12:00:00Z");

  it("chipShows: never for off or idle", () => {
    expect(chipShows(status({ phase: "off" }), now)).toBe(false);
    expect(chipShows(status({ phase: "idle" }), now)).toBe(false);
  });

  it("chipShows: always while the run is going", () => {
    for (const phase of ["starting", "working", "waiting", "question"] as const) {
      expect(chipShows(status({ phase, lines: [at("2026-11-17T09:00:00Z")] }), now)).toBe(true);
    }
  });

  it("chipShows: an ended run for 10 minutes after its newest line, then not", () => {
    for (const phase of ["finished", "failed"] as const) {
      expect(chipShows(status({ phase, lines: [at("2026-11-17T11:40:00Z"), at("2026-11-17T11:50:00Z")] }), now)).toBe(true);
      expect(chipShows(status({ phase, lines: [at("2026-11-17T11:49:59Z")] }), now)).toBe(false);
      // The newest line counts, wherever it sits.
      expect(chipShows(status({ phase, lines: [at("2026-11-17T11:55:00Z"), at("2026-11-17T11:00:00Z")] }), now)).toBe(true);
    }
  });

  it("chipShows: an ended run with no lines to date it still shows", () => {
    expect(chipShows(status({ phase: "finished" }), now)).toBe(true);
  });

  it("chipTone: busy while starting or working, to do while it waits on you, done, and over for a failure", () => {
    expect(chipTone("starting")).toBe("busy");
    expect(chipTone("working")).toBe("busy");
    expect(chipTone("waiting")).toBe("todo");
    expect(chipTone("question")).toBe("todo");
    expect(chipTone("finished")).toBe("done");
    expect(chipTone("failed")).toBe("over");
  });

  it("canStop: while starting, working or waiting only", () => {
    expect((["off", "idle", "starting", "working", "waiting", "question", "finished", "failed"] as const).filter(canStop)).toEqual(["starting", "working", "waiting"]);
  });
});

describe("the Send to AI row and the agent menu (task 3)", () => {
  const info = (id: "claude" | "codex", over: Partial<AgentInfo> = {}): AgentInfo => ({
    id, name: id === "claude" ? "Claude Code" : "Codex", installed: true, signedIn: true, path: `/usr/local/bin/${id}`, signIn: `${id} login`, ...over,
  });

  it("rowText: the agent by name, or Set up Send to AI with none chosen", () => {
    expect(rowText(status())).toBe("Send to AI · Claude Code");
    expect(rowText(status({ agent: "codex", on: false }))).toBe("Send to AI · Codex");
    expect(rowText(status({ agent: null, on: false }))).toBe("Set up Send to AI");
  });

  it("rowText: Set up Send to AI until the user has answered the sheet, whatever agent the project names", () => {
    expect(rowText(status({ agent: "codex", on: false, asked: false }))).toBe("Set up Send to AI");
    expect(rowText(status({ agent: "claude", on: false, asked: false }))).toBe("Set up Send to AI");
  });

  it("footLine: the who-line while on, what Send does while off", () => {
    expect(footLine(status())).toBe("Edits files in this project, asks before commands");
    expect(footLine(status({ permissions: "ask-all", session: "s1" }))).toBe("Asks before everything · next Send continues the conversation");
    expect(footLine(status({ on: false }))).toBe("Copies a prompt for your own chat");
    expect(footLine(status({ on: false, agent: null }))).toBe("Copies a prompt for your own chat");
  });

  it("menuAgents: installed agents only, in order, the current one ticked", () => {
    const got = menuAgents([info("claude"), info("codex", { signedIn: false })], status({ agent: "codex" }));
    expect(got).toEqual([
      { id: "claude", name: "Claude Code", signedIn: true, current: false },
      { id: "codex", name: "Codex", signedIn: false, current: true },
    ]);
    expect(menuAgents([info("claude", { installed: false, signedIn: false }), info("codex")], status())).toEqual([
      { id: "codex", name: "Codex", signedIn: true, current: false },
    ]);
    expect(menuAgents(null, status())).toEqual([]);
  });

  it("ruleRows: each Always rule by its label, and the rule to remove", () => {
    const always = [{ kind: "execute", command: "npx hyperframes" }, { kind: "fetch", command: null }];
    expect(ruleRows(status({ always }))).toEqual([
      { rule: always[0], label: "Always for npx hyperframes here" },
      { rule: always[1], label: "Always for web requests here" },
    ]);
    expect(ruleRows(status())).toEqual([]);
  });

  it("menuRowCount: every row the arrows reach", () => {
    const agents = menuAgents([info("claude"), info("codex", { signedIn: false })], status());
    // Two agents, Codex's Sign in, the four permission rows (§33).
    expect(menuRowCount(status(), agents)).toBe(7);
    // A conversation to start fresh from, and a rule's Remove.
    expect(menuRowCount(status({ session: "s1", always: [{ kind: "execute", command: "npx hyperframes" }] }), agents)).toBe(9);
  });

  it("focusAfterRemove: the next rule's Remove, else the previous one's, else the menu's first row", () => {
    const agents = menuAgents([info("claude"), info("codex")], status());
    const r = (command: string) => ({ kind: "execute", command });
    // Two agents and four permission rows come first: the Removes start at row 6.
    const three = status({ always: [r("a b"), r("c d"), r("e f")] });
    expect(focusAfterRemove(three, agents, 0)).toBe(6);
    expect(focusAfterRemove(three, agents, 1)).toBe(7);
    expect(focusAfterRemove(three, agents, 2)).toBe(7);
    expect(focusAfterRemove(status({ always: [r("a b")] }), agents, 0)).toBe(0);
    // A conversation to start fresh from moves the Removes down a row.
    expect(focusAfterRemove(status({ session: "s1", always: [r("a b"), r("c d")] }), agents, 1)).toBe(7);
  });

  it("the menu's fixed words", () => {
    // §33: four rows, the same for both agents, Bypass last.
    expect(PERMISSION_CHOICES.map((p) => [p.value, p.label])).toEqual([
      ["ask-all", "Manual"],
      ["project-edits", "Accept edits"],
      ["auto", "Auto"],
      ["bypass", "Bypass"],
    ]);
    expect(PERMISSION_CHOICES.map((p) => p.hint.split(/[.:]/)[0])).toEqual(["Always ask", "Edit files in this project without asking", "The agent decides", "Accepts everything"]);
    // Auto's and Bypass's help lines say plainly that Rushes no longer guards .rushes and .git.
    for (const v of ["auto", "bypass"]) expect(PERMISSION_CHOICES.find((p) => p.value === v)!.hint).toMatch(/\.rushes and \.git/);
    expect(BYPASS_WARNING).toMatch(/^Bypass: /);
    expect(MENU_WORDS).toEqual({
      sendTo: "Send notes to",
      signedIn: "Signed in",
      notSignedIn: "Not signed in",
      signIn: "Sign in in Terminal",
      fresh: "Start a fresh conversation",
      may: "What it may do without asking",
      always: "Always rules",
      noRules: "No Always rules yet",
      remove: "Remove",
      footer: "Switch off: Send copies a prompt, as now",
    });
  });
});

// ---- the first-Send sheet and what Send does with the answer (task 4) ----

describe("the first-Send sheet (task 4)", () => {
  const info = (id: "claude" | "codex", installed: boolean, signedIn: boolean): AgentInfo => ({
    id, name: id === "claude" ? "Claude Code" : "Codex", installed, signedIn: installed && signedIn, path: installed ? `/bin/${id}` : null, signIn: `${id} login`,
  });

  it("its fixed words, as the plan and ruling P2-R3 give them", () => {
    expect(SHEET_WORDS).toEqual({
      who: "Who should get these notes?",
      copy: "Copy a prompt, as now",
      copyButton: "Copy a prompt",
      next: "Next",
      back: "Back",
      cancel: "Cancel",
      notInstalled: "Not installed",
      noKey: "Rushes never sees a password or key. The agent uses your own sign-in.",
      setUp: "Set up",
    });
    expect(mayQuestion("claude")).toBe("What may Claude Code do without asking?");
    expect(mayQuestion("codex")).toBe("What may Codex do without asking?");
    expect(sendToLabel("claude")).toBe("Send to Claude Code");
    setDeskPlatform("darwin");
    expect(notSignedInWhy("claude")).toBe("Claude Code is not signed in. Choose Sign in in Terminal, then try again.");
    // §34: the button's words follow the OS the server says it runs on.
    setDeskPlatform("win32");
    expect(notSignedInWhy("claude")).toBe("Claude Code is not signed in. Choose Sign in in Command Prompt, then try again.");
    expect(signInWord()).toBe("Sign in in Command Prompt");
    setDeskPlatform("linux");
    expect(signInWord()).toBe("Sign in in a terminal");
    setDeskPlatform("darwin");
  });

  it("sheetRows: every agent detection knows, in its order, by state, then the copy row", () => {
    const rows = sheetRows([info("claude", true, false), info("codex", false, false)]);
    expect(rows).toEqual([
      { pick: "claude", name: "Claude Code", state: "signedOut", note: "Not signed in" },
      { pick: "codex", name: "Codex", state: "missing", note: "Not installed", help: { kind: "install", command: "npm install -g @openai/codex", url: "https://developers.openai.com/codex/cli" } },
      { pick: "copy", name: "Copy a prompt, as now", state: "copy", note: null },
    ]);
    expect(sheetRows([info("claude", true, true)])[0]).toEqual({ pick: "claude", name: "Claude Code", state: "ready", note: "Signed in" });
  });

  it("§34 sheetRows: an outdated agent can't be picked and shows its update command; a downloading connector says so", () => {
    const old = { ...info("claude", true, true), version: "1.0.44", outdated: true };
    const [row] = sheetRows([old]);
    expect(row).toEqual({ pick: "claude", name: "Claude Code", state: "outdated", note: "1.0.44 is too old: update it", help: { kind: "update", command: "claude update" } });
    expect(whoNext("claude", [row])).toBe("missing");
    expect(sheetDefault([row], "claude")).toBe("copy");
    const fetching = { ...info("codex", true, true), connector: { state: "fetching" as const } };
    expect(sheetRows([fetching])[0]).toMatchObject({ state: "ready", note: "Getting Codex ready…" });
    expect(sheetRows([{ ...fetching, connector: { state: "ready" as const } }])[0].note).toBe("Signed in");
    expect(menuAgents([fetching], { agent: "codex" } as AgentStatus)[0]).toMatchObject({ note: "Getting Codex ready…" });
  });

  it("sheetRows: detection not back yet, or failed: the copy row alone", () => {
    expect(sheetRows(null).map((r) => r.pick)).toEqual(["copy"]);
    expect(sheetRows([]).map((r) => r.pick)).toEqual(["copy"]);
  });

  it("sheetDefault: the current agent if it is ready, else the first ready one, else copy", () => {
    const both = sheetRows([info("claude", true, true), info("codex", true, true)]);
    expect(sheetDefault(both, null)).toBe("claude");
    expect(sheetDefault(both, "codex")).toBe("codex");
    const codexOnly = sheetRows([info("claude", true, false), info("codex", true, true)]);
    expect(sheetDefault(codexOnly, "claude")).toBe("codex");
    expect(sheetDefault(sheetRows([info("claude", true, false), info("codex", false, false)]), null)).toBe("copy");
    expect(sheetDefault(sheetRows(null), "claude")).toBe("copy");
  });

  it("whoNext: what step 1's primary does with the row picked", () => {
    const rows = sheetRows([info("claude", true, true), info("codex", true, false)]);
    expect(whoNext("copy", rows)).toBe("copy");
    expect(whoNext("claude", rows)).toBe("may");
    expect(whoNext("codex", rows)).toBe("signedOut");
    expect(whoNext("codex", sheetRows([info("codex", false, false)]))).toBe("missing");
    // An agent detection no longer lists is missing.
    expect(whoNext("claude", sheetRows([]))).toBe("missing");
  });

  it("sheetPrimary: Next for an agent, Copy a prompt for the copy row, Send to <A> on step 2 when notes wait", () => {
    expect(sheetPrimary({ step: "who", pick: "claude" }, true)).toBe("Next");
    expect(sheetPrimary({ step: "who", pick: "copy" }, true)).toBe("Copy a prompt");
    expect(sheetPrimary({ step: "may", agent: "codex", permissions: "ask-all" }, true)).toBe("Send to Codex");
  });

  it("sheetPrimary with nothing waiting: Use <A>, since it sends nothing (I3)", () => {
    expect(sheetPrimary({ step: "may", agent: "claude", permissions: "project-edits" }, false)).toBe("Use Claude Code");
    expect(sheetPrimary({ step: "may", agent: "codex", permissions: "ask-all" }, false)).toBe("Use Codex");
    expect(sheetPrimary({ step: "who", pick: "claude" }, false)).toBe("Next");
    expect(sheetPrimary({ step: "who", pick: "copy" }, false)).toBe("Copy a prompt");
  });
});

describe("followSend (task 4)", () => {
  const off = status({ on: false, agent: null });

  it("handed: a toast naming the agent, no dialog, and notifications asked for", () => {
    expect(followSend({ handedTo: "claude" }, status())).toEqual({ toast: { text: "Sent to Claude Code", ms: 2400 }, dialog: false, why: null, handed: true });
  });

  it("starting: Starting <A>; one starting with no agent is afterSend's dialog, with no reason to give", () => {
    expect(followSend({ handedTo: "codex", starting: true }, status())).toEqual({ toast: { text: "Starting Codex", ms: 2400 }, dialog: false, why: null, handed: true });
    expect(followSend({ handedTo: null, starting: true }, status())).toEqual({ toast: null, dialog: true, why: null, handed: false });
  });

  it("recalled: why, for 6 seconds, with no dialog and nothing to copy", () => {
    expect(followSend({ handedTo: null, why: "the adapter exited (code 3)", recalled: true }, status())).toEqual({
      toast: { text: "Claude Code couldn't start: the adapter exited (code 3). The notes are back in to do.", ms: 6000 }, dialog: false, why: null, handed: false,
    });
    // A reason that names the agent's failure to start itself is not said twice.
    expect(followSend({ handedTo: null, why: "Claude Code could not start: Agent adapter exited with code 3", recalled: true }, status())!.toast!.text).toBe(
      "Claude Code couldn't start: Agent adapter exited with code 3. The notes are back in to do.",
    );
    // A reason that ends its own sentence isn't given a second full stop.
    expect(followSend({ handedTo: null, why: "It timed out.", recalled: true }, status({ agent: "codex" }))!.toast!.text).toBe("Codex couldn't start: It timed out. The notes are back in to do.");
  });

  it("stopped: nothing at all", () => {
    expect(followSend({ handedTo: null, why: "Stopped", stopped: true }, status())).toEqual({ toast: null, dialog: false, why: null, handed: false });
  });

  it("a refusal where nothing started: today's dialog, with the reason only while Send to AI is on", () => {
    expect(followSend({ handedTo: null, why: "Claude Code is not signed in" }, status())).toEqual({ toast: null, dialog: true, why: "Claude Code is not signed in", handed: false });
    // Off is today's Send: the dialog exactly as it was, no reason line.
    expect(followSend({ handedTo: null, why: "Send to AI is off" }, off)).toEqual({ toast: null, dialog: true, why: null, handed: false });
    expect(followSend(undefined, null)).toEqual({ toast: null, dialog: true, why: null, handed: false });
  });
});

describe("planLead (I4)", () => {
  it("when the notes went to an agent, the brief and storyboard lines say that agent doesn't have them", () => {
    expect(planLead(followSend({ handedTo: "claude" }, status()), status())).toBe("Claude Code has the notes. These lines aren't sent to it yet.");
    expect(planLead(followSend({ handedTo: "codex", starting: true }, status({ agent: "codex" })), status({ agent: "codex" }))).toBe(
      "Codex has the notes. These lines aren't sent to it yet.",
    );
  });

  it("says nothing when no notes went to an agent: off, refused, recalled, stopped, or no batch at all", () => {
    expect(planLead(followSend({ handedTo: null, why: "Send to AI is off" }, status({ on: false })), status({ on: false }))).toBeNull();
    expect(planLead(followSend({ handedTo: null, why: "Claude Code is not signed in" }, status()), status())).toBeNull();
    expect(planLead(followSend({ handedTo: null, why: "x", recalled: true }, status()), status())).toBeNull();
    expect(planLead(followSend({ handedTo: null, why: "Stopped", stopped: true }, status()), status())).toBeNull();
    expect(planLead(null, status())).toBeNull();
  });
});

describe("askHeading: the card's bold line never repeats its command (Task 10, 5)", () => {
  const ask = (title: string, command: string | null) => ({ title, command });

  it("a title that is the command, whitespace and backticks aside, gives way to Run a command", () => {
    expect(askHeading(ask("ffprobe -v error renders/a.mp4", "ffprobe -v error renders/a.mp4"))).toBe("Run a command");
    expect(askHeading(ask("  for f in *.mp4;\n  do ffprobe \"$f\"; done ", "for f in *.mp4; do ffprobe \"$f\"; done"))).toBe("Run a command");
    expect(askHeading(ask("`npm test`", "npm test"))).toBe("Run a command");
  });

  it("a title that says something of its own stays, with hidden characters spelled out", () => {
    expect(askHeading(ask("Run ffprobe", "ffprobe -v error renders/a.mp4"))).toBe("Run ffprobe");
    expect(askHeading(ask("Edit a\u202Eb", null))).toBe("Edit a<U+202E>b");
    expect(askHeading(ask("Read src/a.ts", null))).toBe("Read src/a.ts");
  });
});

describe("the ask card (task 5)", () => {
  const ask = (over: Partial<PendingAsk> = {}): PendingAsk => ({ id: "ask_1", title: "Run ffprobe", kind: "execute", command: "ffprobe -v error renders/a.mp4", always: "", at: "2026-11-17T10:00:00.000Z", ...over });

  it("leads with the agent's name, or your agent", () => {
    expect(askLead("claude")).toBe("Claude Code wants to:");
    expect(askLead("codex")).toBe("Codex wants to:");
    expect(askLead(null)).toBe("your agent wants to:");
  });

  it("offers Allow once, then the server's Always only when it gives one, then No", () => {
    expect(askChoices(ask())).toEqual([
      { choice: "once", label: "Allow once" },
      { choice: "no", label: "No" },
    ]);
    expect(askChoices(ask({ command: "npx hyperframes render out.mp4", always: "Always for npx hyperframes here" }))).toEqual([
      { choice: "once", label: "Allow once" },
      { choice: "always", label: "Always for npx hyperframes here" },
      { choice: "no", label: "No" },
    ]);
  });

  it("never offers Always the server didn't: a chained command, an untyped call, a blank label", () => {
    expect(askChoices(ask({ command: "npm run build && rm -rf out", always: "" })).map((c) => c.choice)).toEqual(["once", "no"]);
    expect(askChoices(ask({ kind: null, command: null, always: "" })).map((c) => c.choice)).toEqual(["once", "no"]);
    expect(askChoices(ask({ always: "   " })).map((c) => c.choice)).toEqual(["once", "no"]);
  });

  it("each choice is one the route takes, said as the server's words", () => {
    expect(ASK_WORDS).toEqual({ once: "Allow once", no: "No" });
    for (const c of askChoices(ask({ always: "Always for reads here" }))) expect(["once", "always", "no"]).toContain(c.choice);
  });
});

describe("the ask card shows hidden characters (task 5, fix 1)", () => {
  it("plain text is one plain part", () => {
    expect(revealParts("ffprobe -v error renders/a.mp4")).toEqual([{ text: "ffprobe -v error renders/a.mp4" }]);
    expect(revealParts("")).toEqual([]);
  });

  it("bidi controls show as <U+XXXX>, each its own part, the text around them kept", () => {
    expect(revealParts("ls \u202Etxt.exe")).toEqual([{ text: "ls " }, { hidden: "<U+202E>" }, { text: "txt.exe" }]);
    for (const c of ["\u202A", "\u202B", "\u202C", "\u202D", "\u202E", "\u2066", "\u2067", "\u2068", "\u2069", "\u200E", "\u200F", "\u061C"]) {
      expect(revealText(`a${c}b`)).toBe(`a<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>b`);
    }
  });

  it("zero-width and other invisible characters show too", () => {
    expect(revealText("rm\u200B -rf\u200C\u200D\u2060\uFEFF x")).toBe("rm<U+200B> -rf<U+200C><U+200D><U+2060><U+FEFF> x");
    expect(revealText("a\u00ADb\u2028c\u2029d")).toBe("a<U+00AD>b<U+2028>c<U+2029>d");
    // Control characters other than tab and newline, and the invisible tag characters.
    expect(revealText("a\rb\u0007c\u007Fd\u0085e")).toBe("a<U+000D>b<U+0007>c<U+007F>d<U+0085>e");
    expect(revealText("a\u{E0041}b")).toBe("a<U+E0041>b");
    expect(revealText("a\uFE0Fb")).toBe("a<U+FE0F>b");
  });

  it("tabs, newlines, ordinary Unicode and right-to-left letters are left alone", () => {
    expect(revealParts("for f in *; do\n\techo \"$f\"; done")).toEqual([{ text: "for f in *; do\n\techo \"$f\"; done" }]);
    expect(revealParts("ffmpeg -i café-שלום-日本.mp4 → out.mp4")).toEqual([{ text: "ffmpeg -i café-שלום-日本.mp4 → out.mp4" }]);
  });

  it("the joined parts are the revealed text", () => {
    const s = "x\u202Ey\u2066z";
    expect(revealParts(s).map((p) => ("text" in p ? p.text : p.hidden)).join("")).toBe(revealText(s));
  });
});

describe("when a card's buttons may be pressed (task 5, fix 1)", () => {
  it("the arm key is the ids of the asks above the card: it changes when one above goes or arrives, not below", () => {
    expect(askArmKey(["ask_1", "ask_2", "ask_3"], 0)).toBe("");
    expect(askArmKey(["ask_1", "ask_2", "ask_3"], 2)).toBe("ask_1 ask_2");
    // ask_1 answered: ask_2 moves up into its place, so its key changes.
    expect(askArmKey(["ask_2", "ask_3"], 0)).not.toBe(askArmKey(["ask_1", "ask_2", "ask_3"], 1));
    // A new ask below changes nothing above it.
    expect(askArmKey(["ask_1", "ask_2", "ask_4"], 1)).toBe(askArmKey(["ask_1", "ask_2"], 1));
    expect(ASK_ARM_MS).toBeGreaterThanOrEqual(400);
  });
});

// ---- a note's badge, thread and reply box (task 6) ----

describe("noteAgentBadge priority (task 6)", () => {
  it("needs you beats working, even on the note being worked on", () => {
    const s = status({ phase: "working", batches: ["b1"], current: { note: "n1", doing: "Measuring the cut" } });
    expect(noteAgentBadge(note("n1", { batch: "b1", needsYou: true }), s)?.kind).toBe("needsYou");
    expect(noteAgentBadge(note("n1", { batch: "b1" }), s)).toEqual({ kind: "working", text: "Measuring the cut" });
  });

  it("a done note with fixVersion v8 says Fixed in v8", () => {
    expect(noteAgentBadge(note("n1", { batch: "b1", status: "done", fixVersion: "v8" }), status())).toEqual({ kind: "fixed", text: "Fixed in v8" });
    expect(noteAgentBadge(note("n1", { batch: "b1", status: "done", fixVersion: "v8" }), null)).toEqual({ kind: "fixed", text: "Fixed in v8" });
  });

  it("with Send to AI on, a sent note the agent was never handed is with your agent, with no box (I3)", () => {
    // Refused (not signed in), or sent by copying a prompt before the switch went on: no run holds its batch.
    const on = status({ phase: "idle", batches: [] });
    expect(noteAgentBadge(note("n1", { batch: "b1" }), on)).toEqual({ kind: "with", text: "With your agent" });
    expect(replyBoxShows(note("n1", { batch: "b1" }), on)).toBe(false);
    expect(answerPlaceholder(note("n1", { batch: "b1" }), on)).toBe("Answer your agent");
    // Another batch held is not this one.
    const other = status({ phase: "working", batches: ["b2"], current: { note: "n9", doing: null } });
    expect(noteAgentBadge(note("n1", { batch: "b1" }), other)).toEqual({ kind: "with", text: "With your agent" });
    expect(replyBoxShows(note("n1", { batch: "b1" }), other)).toBe(false);
  });

  it("the agent is named while its run holds the note's batch, or is on the note", () => {
    const queued = status({ phase: "starting", batches: ["b1"] });
    expect(noteAgentBadge(note("n1", { batch: "b1" }), queued)).toEqual({ kind: "with", text: "With Claude Code" });
    expect(replyBoxShows(note("n1", { batch: "b1" }), queued)).toBe(true);
    expect(answerPlaceholder(note("n1", { batch: "b1" }), queued)).toBe("Answer Claude Code");
    // A follow-up's turn on the note (its batch's own turn over).
    const followUp = status({ phase: "working", batches: [], current: { note: "n1", doing: null } });
    expect(replyBoxShows(note("n1", { batch: "b1" }), followUp)).toBe(true);
    expect(answerPlaceholder(note("n1", { batch: "b1" }), followUp)).toBe("Answer Claude Code");
  });

  it("a follow-up queued or running for the note: the agent has it, before it says what it is doing (Task 10, 2)", () => {
    const running = status({ phase: "working", batches: [], followUps: ["n1"], current: { note: null, doing: null } });
    expect(noteAgentBadge(note("n1", { batch: "b1" }), running)).toEqual({ kind: "with", text: "With Claude Code" });
    expect(replyBoxShows(note("n1", { batch: "b1" }), running)).toBe(true);
    expect(answerPlaceholder(note("n1", { batch: "b1" }), running)).toBe("Answer Claude Code");
    // Another note of the same batch, with no follow-up of its own, is not held by it.
    expect(noteAgentBadge(note("n2", { batch: "b1" }), running)).toEqual({ kind: "with", text: "With your agent" });
  });

  it("an answer to the agent's question names it while Send to AI is on with the conversation kept: the answer goes there", () => {
    const asked = note("n1", { batch: "b1", needsYou: true });
    expect(answerPlaceholder(asked, status({ phase: "question", session: "s-1" }))).toBe("Answer Claude Code");
    expect(answerPlaceholder(asked, status({ phase: "question", session: null }))).toBe("Answer your agent");
    expect(answerPlaceholder(asked, status({ on: false, session: "s-1" }))).toBe("Answer your agent");
    expect(answerPlaceholder(asked, null)).toBe("Answer your agent");
  });

  it("switched off mid-run: the badge still names the agent that holds the batch, but no box, since an answer wouldn't go", () => {
    const off = status({ on: false, phase: "working", batches: ["b1"] });
    expect(noteAgentBadge(note("n1", { batch: "b1" }), off)).toEqual({ kind: "with", text: "With Claude Code" });
    expect(replyBoxShows(note("n1", { batch: "b1" }), off)).toBe(false);
    expect(answerPlaceholder(note("n1", { batch: "b1", needsYou: true }), off)).toBe("Answer your agent");
  });

  it("with Send to AI off, a sent note is with your agent (a copied prompt went to a chat Rushes can't name)", () => {
    expect(noteAgentBadge(note("n1", { batch: "b1" }), status({ on: false }))).toEqual({ kind: "with", text: "With your agent" });
    // Unless the agent still holds its batch (switched off mid-run).
    expect(noteAgentBadge(note("n1", { batch: "b1" }), status({ on: false, batches: ["b1"] }))).toEqual({ kind: "with", text: "With Claude Code" });
  });
});

describe("noteThread", () => {
  const at = (m: number) => new Date(2026, 10, 17, 14, m).toISOString();
  const r = (by: "agent" | "user", text: string, m: number) => ({ by, text, at: at(m) });

  it("each reply on a line, oldest first, with its local time", () => {
    const t = noteThread({ reply: "", replies: [r("agent", "Full stop?", 5), r("user", "No full stop.", 7)] });
    expect(t.lines).toEqual([
      { by: "agent", text: "Full stop?", time: "14:05" },
      { by: "user", text: "No full stop.", time: "14:07" },
    ]);
    expect(t.more).toBeNull();
  });

  it("the last three, with Show all (n) when there are more; all of them once asked", () => {
    const replies = [r("agent", "a", 1), r("user", "b", 2), r("agent", "c", 3), r("user", "d", 4), r("agent", "e", 5)];
    const t = noteThread({ reply: "", replies });
    expect(t.lines.map((l) => l.text)).toEqual(["c", "d", "e"]);
    expect(t.more).toBe("Show all (5)");
    const all = noteThread({ reply: "", replies }, true);
    expect(all.lines.map((l) => l.text)).toEqual(["a", "b", "c", "d", "e"]);
    expect(all.more).toBeNull();
    expect(noteThread({ reply: "", replies: replies.slice(0, 3) }).more).toBeNull();
  });

  it("a legacy note with only its old reply text still shows it, as the agent's, with no time", () => {
    expect(noteThread({ reply: "Lifted the shadows.", replies: [] }).lines).toEqual([{ by: "agent", text: "Lifted the shadows.", time: "" }]);
    expect(noteThread({ reply: "  ", replies: [] }).lines).toEqual([]);
    // Once migrated, the thread is the one source: the old text isn't shown twice.
    expect(noteThread({ reply: "Lifted.", replies: [r("agent", "Lifted.", 1)] }).lines).toHaveLength(1);
  });

  it("a time that doesn't parse shows as --:--", () => {
    expect(noteThread({ reply: "", replies: [{ by: "agent", text: "x", at: "soon" }] }).lines[0].time).toBe("--:--");
  });
});

describe("noteLite: needs you, worked out in the desk", () => {
  const full = (over: Partial<Note>) => ({ id: "n1", batch: "b1", status: "todo", fixVersion: null, replies: [], ...over }) as unknown as Note;
  it("a note with the agent whose last word is the agent's needs you; GET /api/state sends notes as stored, without it", () => {
    expect(noteLite(full({ replies: [{ by: "agent", text: "Which?", at: "" }] })).needsYou).toBe(true);
    expect(noteLite(full({ replies: [{ by: "agent", text: "Which?", at: "" }, { by: "user", text: "This.", at: "" }] })).needsYou).toBe(false);
    expect(noteLite(full({ batch: null, replies: [{ by: "agent", text: "Which?", at: "" }] })).needsYou).toBe(false);
    expect(noteLite(full({ status: "done", replies: [{ by: "agent", text: "Done.", at: "" }] })).needsYou).toBe(false);
  });
});

describe("replyBoxShows and its placeholder", () => {
  it("shows on a note that needs you, whatever the switch", () => {
    expect(replyBoxShows(note("n1", { batch: "b1", needsYou: true }), status())).toBe(true);
    expect(replyBoxShows(note("n1", { batch: "b1", needsYou: true }), status({ on: false }))).toBe(true);
    expect(replyBoxShows(note("n1", { batch: "b1", needsYou: true }), null)).toBe(true);
  });

  it("shows on a sent note while the agent holds its batch, and not otherwise", () => {
    expect(replyBoxShows(note("n1", { batch: "b1" }), status({ phase: "working", batches: ["b1"] }))).toBe(true);
    expect(replyBoxShows(note("n1", { batch: "b1" }), status())).toBe(false);
    expect(replyBoxShows(note("n1", { batch: "b1" }), status({ on: false }))).toBe(false);
    expect(replyBoxShows(note("n1", { batch: "b1" }), null)).toBe(false);
  });

  it("never on a to-do or a done note", () => {
    expect(replyBoxShows(note("n1"), status())).toBe(false);
    expect(replyBoxShows(note("n1", { batch: "b1", status: "done" }), status())).toBe(false);
  });

  it("Answer <A> for a note the agent holds", () => {
    const held = note("n1", { batch: "b1" });
    expect(answerPlaceholder(held, status({ phase: "working", batches: ["b1"] }))).toBe("Answer Claude Code");
    expect(answerPlaceholder(held, status({ agent: "codex", phase: "working", batches: ["b1"] }))).toBe("Answer Codex");
    expect(answerPlaceholder(held, null)).toBe("Answer your agent");
  });
});

describe("fixGo: where Fixed in <v> goes", () => {
  const fixed = (over: Partial<Parameters<typeof fixGo>[0]> = {}) => ({ stage: "picture" as const, video: "hero", status: "done" as const, fixVersion: "v8", fixT: 2.1, ...over });

  it("on the fix's version: seeks to fixT", () => {
    expect(fixGo(fixed(), "v8")).toEqual({ kind: "seek", t: 2.1 });
  });

  it("on another version of a cut: opens the fix's version, then seeks", () => {
    expect(fixGo(fixed(), "v7")).toEqual({ kind: "jump", to: { tab: "picture", video: "hero", version: "v8" }, t: 2.1 });
    expect(fixGo(fixed({ fixT: null }), "v7")).toEqual({ kind: "jump", to: { tab: "picture", video: "hero", version: "v8" }, t: null });
  });

  it("nowhere to go: not done, no fix version, no time on this version, or not a cut", () => {
    expect(fixGo(fixed({ status: "todo" }), "v7")).toBeNull();
    expect(fixGo(fixed({ fixVersion: null }), "v7")).toBeNull();
    expect(fixGo(fixed({ fixT: null }), "v8")).toBeNull();
    expect(fixGo(fixed({ stage: "visuals", video: null }), "v7")).toBeNull();
  });
});

describe("agent-written words on a card show hidden characters (task 6, fix 1)", () => {
  it("Fixed in <v> spells out a bidi control in the agent's fixVersion", () => {
    const b = noteAgentBadge(note("n1", { batch: "b1", status: "done", fixVersion: "v2‮" }), status())!;
    expect(badgeText(b)).toBe("Fixed in v2<U+202E>");
  });

  it("what the agent is doing, too; Rushes' own words are unchanged", () => {
    const s = status({ phase: "working", batches: ["b1"], current: { note: "n1", doing: "Trim​ming" } });
    expect(badgeText(noteAgentBadge(note("n1", { batch: "b1" }), s)!)).toBe("Trim<U+200B>ming");
    expect(badgeText(noteAgentBadge(note("n1", { batch: "b1", needsYou: true }), s)!)).toBe("Needs you");
    expect(badgeText(noteAgentBadge(note("n2", { batch: "b1" }), s)!)).toBe("With Claude Code");
  });

  it("a reply's lines: an RLO inside is shown as what it is, the newlines kept", () => {
    expect(threadParts("Moved it‮evif.\nDone.")).toEqual([[{ text: "Moved it" }, { hidden: "<U+202E>" }, { text: "evif." }], [{ text: "Done." }]]);
  });
});

describe("the new cut (task 8)", () => {
  it("newCutFor gives the version next has and prev lacks, and null for identical lists", () => {
    expect(newCutFor(["v1", "v2"], ["v1", "v2", "v3"])).toBe("v3");
    expect(newCutFor(["v1", "v2"], ["v1", "v2"])).toBeNull();
    expect(newCutFor(["v1", "v2"], ["v1"])).toBeNull();
  });

  it("two cuts arriving together give the last", () => {
    expect(newCutFor(["v1"], ["v1", "v2", "v3"])).toBe("v3");
  });

  it("the first look at a project that already has versions is not news", () => {
    const first = stepCuts(null, "hero", ["v1", "v2"]);
    expect(first.arrived).toBeNull();
    expect(first.memory).toEqual({ film: "hero", versions: ["v1", "v2"] });
  });

  it("the state loading in after an empty first render is not news either", () => {
    const empty = stepCuts(null, null, []);
    expect(stepCuts(empty.memory, "hero", ["v1", "v2"]).arrived).toBeNull();
  });

  it("a cut that arrives afterwards is, whoever added it", () => {
    const m = stepCuts(null, "hero", ["v1", "v2"]).memory;
    expect(stepCuts(m, "hero", ["v1", "v2"]).arrived).toBeNull();
    expect(stepCuts(m, "hero", ["v1", "v2", "v3"]).arrived).toBe("v3");
  });

  it("two cuts in a quick run: each look names the last one it has not seen", () => {
    const a = stepCuts(stepCuts(null, "hero", ["v1"]).memory, "hero", ["v1", "v2", "v3"]);
    expect(a.arrived).toBe("v3");
    expect(stepCuts(a.memory, "hero", ["v1", "v2", "v3", "v4"]).arrived).toBe("v4");
  });

  it("switching film is not news; the other film's own cuts then are", () => {
    const m = stepCuts(null, "hero", ["v1", "v2"]).memory;
    const sw = stepCuts(m, "teaser", ["v1"]);
    expect(sw.arrived).toBeNull();
    expect(stepCuts(sw.memory, "teaser", ["v1", "v2"]).arrived).toBe("v2");
    expect(stepCuts(sw.memory, "hero", ["v1", "v2", "v3"]).arrived).toBeNull();
  });

  it("not busy: switches and says so; busy: leaves the picture, offers Show and a dot", () => {
    expect(cutAction("v3", "v2", false)).toEqual({ text: "v3 is in", show: true, offer: false, dot: false });
    expect(cutAction("v3", "v2", true)).toEqual({ text: "v3 is in", show: false, offer: true, dot: true });
    expect(cutAction(null, "v2", false)).toBeNull();
  });

  it("a cut already on screen needs no Show and no dot", () => {
    expect(cutAction("v3", "v3", true)).toEqual({ text: "v3 is in", show: false, offer: false, dot: false });
    expect(cutAction("v3", "v3", false)).toEqual({ text: "v3 is in", show: false, offer: false, dot: false });
  });

  it("an agent-written name shows its hidden characters", () => {
    expect(cutAction("v3‮", "v2", false)!.text).toBe("v3<U+202E> is in");
  });

  it("the dot stays until the cut is on screen, and goes with the film or the cut", () => {
    const u = { film: "hero", id: "v3" };
    expect(unseenCut(u, "hero", "v2", ["v1", "v2", "v3"])).toBe("v3");
    expect(unseenCut(u, "hero", "v3", ["v1", "v2", "v3"])).toBeNull();
    expect(unseenCut(u, "teaser", "v2", ["v1", "v2", "v3"])).toBeNull();
    expect(unseenCut(u, "hero", "v2", ["v1", "v2"])).toBeNull();
    expect(unseenCut(null, "hero", "v2", ["v1", "v2"])).toBeNull();
  });
});
