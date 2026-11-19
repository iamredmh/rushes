import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { createApp, type AppOptions } from "../../src/server/app.js";
import type { LoudnessRunner } from "../../src/server/loudness.js";
import { readingArgs } from "../../src/server/balance.js";

// §29: the Balance route and the automatic balance, on a fake ffmpeg that answers per file.

/** ebur128's stderr for a take: frames every 0.1 s from stretches [from, to, LUFS], silence elsewhere, then the summary. */
function ebur(length: number, parts: [number, number, number][], integrated: number | null): string {
  const lines: string[] = [];
  for (let i = 1; i <= length * 10; i++) {
    const t = i / 10;
    const p = parts.find(([a, b]) => t >= a - 1e-9 && t <= b + 1e-9);
    const m = p ? p[2].toFixed(1) : "-120.0";
    lines.push(`[Parsed_ebur128_0 @ 0x1] t: ${t.toFixed(1)}  TARGET:-23 LUFS    M: ${m} S: ${m}     I: -23.0 LUFS       LRA:   0.0 LU`);
  }
  const I = integrated === null ? "-inf" : integrated.toFixed(1);
  return `${lines.join("\n")}\n  Integrated loudness:\n    I:         ${I} LUFS\n\n  True peak:\n    Peak:      -6.0 dBFS\n`;
}

const TAKES: Record<string, string> = {
  "vo.wav": ebur(20, [[1, 9, -22], [11, 19, -22]], -22),
  "bed.wav": ebur(20, [[0.1, 20, -30]], -30),
  "bed2.wav": ebur(20, [[0.1, 20, -26]], -26),
  "fx.wav": ebur(20, [[3, 3.1, -30], [8, 8.1, -30]], -35),
};

// The same takes through the speech band: the bed's low end drops out, so the voice clears it by 12 LU at 0 dB.
const BAND: Record<string, string> = {
  "vo.wav": ebur(20, [[1, 9, -24], [11, 19, -24]], -24),
  "bed.wav": ebur(20, [[0.1, 20, -36]], -36),
  "bed2.wav": ebur(20, [[0.1, 20, -32]], -32),
};

/** A runner answering by file name; `gate` holds every reading until it resolves. */
function fakeRunner(calls: string[][] = [], gate?: Promise<void>): LoudnessRunner {
  return async (args) => {
    calls.push(args);
    if (args[0] === "-version") return { code: 0, stderr: "" };
    await gate;
    const file = args[args.indexOf("-i") + 1];
    const name = Object.keys(TAKES).find((n) => file.endsWith(n));
    const band = args.some((a) => a.includes("highpass"));
    return { code: 0, stderr: name ? (band ? BAND[name] : TAKES[name]) : "" };
  };
}

async function setup(opts: AppOptions = {}) {
  const { root, store } = await tmpProject("spring-launch");
  const app = createApp(store, opts);
  const call = async (method: string, path: string, json?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: json === undefined ? undefined : { "content-type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  await mkdir(join(root, "audio"), { recursive: true });
  for (const name of Object.keys(TAKES)) await writeFile(join(root, "audio", name), "not real audio");
  await call("POST", "/api/variants", { stage: "voice", name: "Read one", file: "audio/vo.wav" });
  await call("POST", "/api/variants", { stage: "music", name: "Bed", file: "audio/bed.wav" });
  await call("POST", "/api/variants", { stage: "sfx", name: "Pass one", file: "audio/fx.wav" });
  const lane = async (stage: string) => (await store.read("project")).lanes.find((l) => l.stage === stage)!;
  return { call, store, root, lane };
}

async function pickAll({ call, lane }: Awaited<ReturnType<typeof setup>>) {
  const lanes: Record<string, string> = {};
  for (const stage of ["voice", "music", "sfx"]) {
    const l = await lane(stage);
    lanes[l.id] = l.variants[0].id;
  }
  return call("PUT", "/api/picks", { lanes });
}

describe("POST /api/mix/balance (§29)", () => {
  it("sets the music and effects against the voice, records the balance, and says what it did", async () => {
    const t = await setup({ loudnessRunner: fakeRunner() });
    await pickAll(t);
    const r = await t.call("POST", "/api/mix/balance", {});
    expect(r.status).toBe(200);
    // Music -30 to sit level with a -22 voice: +8. Effects peaking -30 go 1 dB under the moved groove (-22): +7.
    expect(r.json.levels).toEqual({ voice: 0, music: 8, sfx: 7 });
    expect(r.json.summary).toBe("Music +8 dB, level with the voice. Effects +7 dB: 2 hits just under the music around them.");
    const picks = (await t.call("GET", "/api/picks")).json;
    expect(picks.levels).toEqual({ music: 8, sfx: 7 });
    expect(picks.balanced.levels).toEqual({ music: 8, sfx: 7 });
    const log = (await t.call("GET", "/api/log")).json;
    const lines = log.lines ?? log.log ?? log;
    expect(JSON.stringify(lines)).toContain("Mix balanced: Music +8 dB");
  });

  it("reads voice and music in the speech band too, effects only full band", async () => {
    const calls: string[][] = [];
    const t = await setup({ loudnessRunner: fakeRunner(calls) });
    await pickAll(t);
    await t.call("POST", "/api/mix/balance", {});
    // The takes' own readings (the balanced mix's peak check is one more run, through -filter_complex).
    const reads = calls.filter((a) => a.includes("-af")).map((a) => `${a[a.indexOf("-i") + 1].split("/").pop()} ${a[a.indexOf("-af") + 1]}`);
    expect(reads.sort()).toEqual(["bed.wav ebur128", "bed.wav highpass=f=300,lowpass=f=4000,ebur128", "fx.wav ebur128", "vo.wav ebur128", "vo.wav highpass=f=300,lowpass=f=4000,ebur128"]);
  });

  it("brings everything down together when the balanced mix would clip", async () => {
    const base = fakeRunner();
    const run: LoudnessRunner = async (args, signal) => {
      const r = await base(args, signal);
      return args.includes("-filter_complex") ? { code: 0, stderr: r.stderr.replace("Peak:      -6.0 dBFS", "Peak:       0.3 dBFS") } : r;
    };
    const t = await setup({ loudnessRunner: run });
    await pickAll(t);
    const r = await t.call("POST", "/api/mix/balance", {});
    expect(r.json.levels).toEqual({ voice: -1.5, music: 6.5, sfx: 5.5 });
    expect(r.json.summary).toMatch(/Everything \u22121.5 dB so the mix doesn't clip\.$/);
  });

  it("changes nothing without ffmpeg", async () => {
    const run: LoudnessRunner = async () => ({ code: 1, stderr: "" });
    const t = await setup({ loudnessRunner: run });
    await pickAll(t);
    await t.call("PUT", "/api/picks", { levels: { music: -3 } });
    const r = await t.call("POST", "/api/mix/balance", {});
    expect(r.json).toEqual({ available: false, summary: "Install ffmpeg to balance the mix." });
    expect((await t.call("GET", "/api/picks")).json.levels).toEqual({ music: -3 });
  });

  it("is a 404 for a film that isn't there", async () => {
    const t = await setup({ loudnessRunner: fakeRunner() });
    expect((await t.call("POST", "/api/mix/balance", { video: "nope" })).status).toBe(404);
  });

  it("reads files whole, local only, as audio", () => {
    expect(readingArgs("/a/b.wav", false)).toEqual(["-nostats", "-protocol_whitelist", "file", "-format_whitelist", expect.any(String), "-i", "/a/b.wav", "-af", "ebur128", "-f", "null", "-"]);
  });
});

describe("automatic balance (§29)", () => {
  function auto(gate?: Promise<void>) {
    const done: (string | null)[] = [];
    let wake: () => void = () => undefined;
    const next = () => new Promise<void>((r) => (wake = r));
    const opts: AppOptions = {
      loudnessRunner: fakeRunner([], gate),
      autoBalance: true,
      onAutoBalance: (_v, summary) => {
        done.push(summary);
        wake();
      },
    };
    return { opts, done, next };
  }

  it("balances by itself when a take is put in use and no fader has been moved", async () => {
    const a = auto();
    const t = await setup(a.opts);
    const ran = a.next();
    await pickAll(t);
    await ran;
    expect(a.done[0]).toMatch(/^Music \+8 dB/);
    expect((await t.call("GET", "/api/picks")).json.levels).toEqual({ music: 8, sfx: 7 });
  });

  it("balances again for a new take while the levels are still the balance's own", async () => {
    const a = auto();
    const t = await setup(a.opts);
    let ran = a.next();
    await pickAll(t);
    await ran;
    // A second, louder bed in the music lane, put in use: -26 needs only +4.
    await t.call("POST", "/api/variants", { stage: "music", name: "Bed two", file: "audio/bed2.wav", lane: (await t.lane("music")).id });
    const music = await t.lane("music");
    ran = a.next();
    await t.call("PUT", "/api/picks", { lanes: { [music.id]: music.variants[1].id } });
    await ran;
    expect((await t.call("GET", "/api/picks")).json.levels.music).toBe(4);
  });

  it("leaves a fader moved by hand alone: a new take keeps it until Balance is pressed", async () => {
    const a = auto();
    const t = await setup(a.opts);
    let ran = a.next();
    await pickAll(t);
    await ran;
    await t.call("PUT", "/api/picks", { levels: { music: 2 } });
    await t.call("POST", "/api/variants", { stage: "music", name: "Bed two", file: "audio/bed2.wav", lane: (await t.lane("music")).id });
    const music = await t.lane("music");
    await t.call("PUT", "/api/picks", { lanes: { [music.id]: music.variants[1].id } });
    await new Promise((r) => setTimeout(r, 20));
    expect(a.done).toHaveLength(1);
    expect((await t.call("GET", "/api/picks")).json.levels.music).toBe(2);
    // Pressing Balance takes the levels back, and from then on a new take is balanced again.
    await t.call("POST", "/api/mix/balance", {});
    expect((await t.call("GET", "/api/picks")).json.levels.music).toBe(4);
  });

  it("writes nothing if a fader is moved while it measures", async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((r) => (open = r));
    const a = auto(gate);
    const t = await setup(a.opts);
    const ran = a.next();
    await pickAll(t);
    await t.call("PUT", "/api/picks", { levels: { music: -6 } });
    open();
    await ran;
    expect(a.done).toEqual([null]);
    expect((await t.call("GET", "/api/picks")).json.levels).toEqual({ music: -6 });
  });

  it("is off unless asked for (a bare createApp)", async () => {
    const calls: string[][] = [];
    const t = await setup({ loudnessRunner: fakeRunner(calls) });
    await pickAll(t);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
    expect((await t.call("GET", "/api/picks")).json.levels).toEqual({});
  });
});
