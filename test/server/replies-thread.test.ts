import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import { tmpProject } from "../helpers/tmp.js";
import { createApp, type AppOptions } from "../../src/server/app.js";
import { settleOldQuestions } from "../../src/server/oneWay.js";
import { addNote } from "../../src/core/notes.js";
import { noteState } from "../../src/core/noteState.js";

async function setup(opts: AppOptions = {}) {
  const { root, store } = await tmpProject("lumen");
  const server = createApp(store, opts);
  const call = async (method: string, path: string, json?: unknown, headers: Record<string, string> = {}) => {
    const res = await server.request(path, { method, headers: { ...(json === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: json === undefined ? undefined : JSON.stringify(json) });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  };
  const sent = async (text = "Tighten the opening") => {
    const { json } = await call("POST", "/api/notes", { stage: "script", scope: "whole", text });
    await call("POST", "/api/batches", { stage: "script" });
    return json.note.id as string;
  };
  const attention = async () => (await store.read("log")).entries.filter((e) => e.kind === "attention");
  return { root, store, call, sent, attention };
}

describe("notes go one way over HTTP (§35)", () => {
  it("there is no route for the user's answer on a note: 404, and nothing is announced", async () => {
    const { store, call, sent } = await setup();
    const heard: unknown[] = [];
    store.on("user-reply", (e) => heard.push(e));
    const id = await sent();
    expect((await call("POST", `/api/notes/${id}/replies`, { text: "No full stop." })).status).toBe(404);
    expect(heard).toEqual([]);
    expect((await store.read("notes")).notes.find((n) => n.id === id)!.replies).toEqual([]);
  });

  it("GET /api/notes carries each note's state and no needsYou", async () => {
    const { call, sent } = await setup();
    const id = await sent();
    await call("POST", "/api/replies", { replies: [{ id, reply: "Which opening?" }] });
    const n = (await call("GET", "/api/notes")).json.notes.find((x: { id: string }) => x.id === id);
    expect(n.state).toBe("sent");
    expect("needsYou" in n).toBe(false);
  });

  it("migration: a note left in the old Needs you state goes back to to do on start, keeping its replies; nothing else moves", async () => {
    const { store } = await setup();
    await store.update("notes", (f) => {
      const asking = addNote(f, { stage: "picture", scope: "whole", text: "Asked on" });
      asking.batch = "b_1";
      asking.replies.push({ by: "agent", text: "Unlock the keychain?", at: "2026-11-20T09:00:00.000Z" });
      const answered = addNote(f, { stage: "picture", scope: "whole", text: "Answered" });
      answered.batch = "b_1";
      answered.replies.push({ by: "agent", text: "Which?", at: "2026-11-20T09:00:00.000Z" }, { by: "user", text: "The left", at: "2026-11-20T09:01:00.000Z" });
      const waiting = addNote(f, { stage: "picture", scope: "whole", text: "Still sent" });
      waiting.batch = "b_2";
      const done = addNote(f, { stage: "picture", scope: "whole", text: "Done" });
      done.batch = "b_1";
      done.status = "done";
      done.replies.push({ by: "agent", text: "Fixed.", at: "2026-11-20T09:00:00.000Z" });
    });
    const moved = await settleOldQuestions(store);
    const notes = (await store.read("notes")).notes;
    const byText = (t: string) => notes.find((n) => n.text === t)!;
    expect(moved).toEqual([byText("Asked on").id]);
    expect(noteState(byText("Asked on"))).toBe("todo");
    expect(byText("Asked on").replies.map((r) => r.text)).toEqual(["Unlock the keychain?"]);
    // Old follow-up data is left as it is: an answered note is still sent (its last word is the user's).
    expect(noteState(byText("Answered"))).toBe("sent");
    expect(noteState(byText("Still sent"))).toBe("sent");
    expect(noteState(byText("Done"))).toBe("done");
    // Idempotent: a second start moves nothing and writes nothing.
    const rev = (await store.read("notes")).rev;
    expect(await settleOldQuestions(store)).toEqual([]);
    expect((await store.read("notes")).rev).toBe(rev);
  });
});

describe("attention items (§35.5)", () => {
  it("rushes_attention writes one attention line on the note's film, and raising it again adds nothing", async () => {
    const { store, call, attention } = await setup();
    await store.update("project", (p) => {
      p.videos.push({ id: "v_a", name: "Meet", versions: [] } as any, { id: "v_b", name: "Five views", versions: [] } as any);
    });
    const note = (await call("POST", "/api/notes", { stage: "voice", scope: "whole", text: "Warmer read", video: "v_b" })).json.note.id as string;
    const first = await call("POST", "/api/attention", { title: "ElevenLabs sign-in needed on this Mac", note });
    expect(first.status).toBe(201);
    expect(first.json.attention).toMatchObject({ kind: "attention", area: "notes", video: "v_b", note, text: "ElevenLabs sign-in needed on this Mac", by: "agent" });
    expect(first.json.attention.resolved).toBeUndefined();
    const again = await call("POST", "/api/attention", { title: "ElevenLabs sign-in needed on this Mac", note });
    expect(again.status).toBe(200);
    expect(again.json.created).toBe(false);
    expect(await attention()).toHaveLength(1);
    // Without a note, the film is named; with several films and none named, it is refused.
    expect((await call("POST", "/api/attention", { title: "Missing key" })).status).toBe(400);
    expect((await call("POST", "/api/attention", { title: "Missing key", film: "Meet" })).json.attention.video).toBe("v_a");
    expect((await call("POST", "/api/attention", { title: "x", note: "n_nope" })).status).toBe(404);
    // The film's head counts its open items for the Activity dot; another film's doesn't.
    const state = (await call("GET", "/api/state")).json;
    expect(state.films.v_b.log.attention).toBe(1);
    expect(state.films.v_a.log.attention).toBe(1);
    expect(state.log.attention).toBe(2);
  });

  it("clears when its note is marked done, or replied with a fix version; a plain reply leaves it open", async () => {
    const { call, sent, attention } = await setup();
    const a = await sent("One");
    await call("POST", "/api/attention", { title: "Sign in to ElevenLabs", note: a });
    await call("POST", "/api/replies", { replies: [{ id: a, reply: "Couldn't sign in." }] });
    expect((await attention())[0].resolved).toBeUndefined();
    await call("POST", "/api/replies", { replies: [{ id: a, reply: "Done.", fixVersion: "v2" }] });
    expect((await attention())[0].resolved).toEqual(expect.any(String));

    const b = (await call("POST", "/api/notes", { stage: "picture", scope: "whole", text: "Two" })).json.note.id as string;
    await call("POST", "/api/attention", { title: "Missing file", note: b });
    await call("PATCH", `/api/notes/${b}`, { status: "done" });
    expect((await attention()).find((e) => e.note === b)!.resolved).toEqual(expect.any(String));
    expect((await call("GET", "/api/state")).json.log.attention).toBe(0);
  });

  it("Dismiss clears it; an unknown id is 404", async () => {
    const { call, attention } = await setup();
    const id = (await call("POST", "/api/attention", { title: "Missing key" })).json.attention.id as string;
    expect((await call("POST", `/api/attention/${id}/dismiss`, {})).json.cleared).toBe(1);
    expect((await attention())[0].resolved).toEqual(expect.any(String));
    expect((await call("POST", "/api/attention/l_nope/dismiss", {})).status).toBe(404);
    // Raised again after it cleared: a new line.
    expect((await call("POST", "/api/attention", { title: "Missing key" })).status).toBe(201);
    expect(await attention()).toHaveLength(2);
  });

  describe("open: back to the agent's conversation", () => {
    const session = { id: "a2973322-28b7-4e44-91b7-8e306bbd4fb6", agent: "claude" as const, startedAt: "2026-11-19T09:23:34.350Z" };
    const rig = async (o: { here?: string; fromHere?: boolean; terminalFails?: boolean; agent?: "claude" | "codex"; noSession?: boolean } = {}) => {
      const opened: { command: string; argv?: string[]; cwd?: string }[] = [];
      const r = await setup({
        here: () => o.here,
        fromHere: (_c: Context) => o.fromHere ?? true,
        hostname: () => "Reds-Mac-mini",
        detect: async () => [{ id: o.agent ?? "claude", name: "x", installed: true, signedIn: true, path: `/bin/${o.agent ?? "claude"}`, signIn: "" } as any],
        terminal: async (command, argv, opts) => {
          if (o.terminalFails) throw new Error("no terminal");
          opened.push({ command, argv, cwd: opts?.cwd });
        },
      });
      if (!o.noSession) await r.store.update("agent", (f) => void (f.session = { ...session, agent: o.agent ?? "claude" }));
      const id = (await r.call("POST", "/api/attention", { title: "Sign in" })).json.attention.id as string;
      return { ...r, id, opened };
    };

    it("on this computer (the here key matches, from here): opens a terminal in the project folder resuming the session", async () => {
      const r = await rig({ here: "k1" });
      const res = await r.call("POST", `/api/attention/${r.id}/open`, {}, { "x-rushes-here": "k1" });
      expect(res.json).toMatchObject({ opened: true, local: true, agent: "claude", session: session.id, command: `claude --resume ${session.id}` });
      expect(r.opened).toEqual([{ command: `claude --resume ${session.id}`, argv: ["/bin/claude", "--resume", session.id], cwd: r.store.root }]);
    });

    it("Codex resumes with codex resume <id>", async () => {
      const r = await rig({ here: "k1", agent: "codex" });
      const res = await r.call("POST", `/api/attention/${r.id}/open`, {}, { "x-rushes-here": "k1" });
      expect(res.json.command).toBe(`codex resume ${session.id}`);
      expect(r.opened[0].argv).toEqual(["/bin/codex", "resume", session.id]);
    });

    it("from another computer (no key, a wrong key, or a request not from here): no terminal, the command and where to run it", async () => {
      for (const [o, header] of [[{ here: "k1" }, {}], [{ here: "k1" }, { "x-rushes-here": "k2" }], [{ here: "k1", fromHere: false }, { "x-rushes-here": "k1" }], [{}, { "x-rushes-here": "k1" }]] as const) {
        const r = await rig(o);
        const res = await r.call("POST", `/api/attention/${r.id}/open`, {}, header as Record<string, string>);
        expect(res.json).toMatchObject({ opened: false, local: false, host: "Reds-Mac-mini", folder: r.store.root, command: `claude --resume ${session.id}` });
        expect(r.opened).toEqual([]);
      }
    });

    it("on this computer with no terminal: the command instead", async () => {
      const r = await rig({ here: "k1", terminalFails: true });
      const res = await r.call("POST", `/api/attention/${r.id}/open`, {}, { "x-rushes-here": "k1" });
      expect(res.json).toMatchObject({ opened: false, local: true, command: `claude --resume ${session.id}` });
    });

    it("with no conversation kept: no command, and where the project is", async () => {
      const r = await rig({ here: "k1", noSession: true });
      const res = await r.call("POST", `/api/attention/${r.id}/open`, {}, { "x-rushes-here": "k1" });
      expect(res.json).toMatchObject({ opened: false, command: null, session: null, host: "Reds-Mac-mini", folder: r.store.root });
      expect(r.opened).toEqual([]);
    });
  });
});
