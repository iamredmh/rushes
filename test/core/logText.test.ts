import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { AREA_LABELS, LOG_TEXT_MAX, changeLogFileName, clock, dayHeading, localStamp, logMarkdown, logText, recentChanges } from "../../src/core/logText.js";
import { modulesPulledIn } from "../helpers/imports.js";

const local = (d: number, h: number, m: number, month = 9, y = 2026) => new Date(y, month, d, h, m);
const points = (s: string) => Array.from(s).length;

describe("logText (§22.3, Review Focus 2)", () => {
  it("is one clean line of 160 at most, never splitting an emoji", () => {
    expect(logText("  Slowed the zooms\n\tbecause the first cut\u0007 felt rushed  ")).toBe("Slowed the zooms because the first cut felt rushed");
    expect(logText(`${"a".repeat(158)}🎬🎬🎬`)).toBe(`${"a".repeat(158)}🎬…`);
    expect(Array.from(logText("word ".repeat(400))).length).toBeLessThanOrEqual(160);
  });
  it("drops bidi overrides and zero-width characters, and keeps a flag or a joined emoji whole at the cut", () => {
    expect(logText("Kept‮ the ​wide⁦ shot﻿")).toBe("Kept the wide shot");
    const flag = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"; // England, seven code points
    const cut = logText(`${"a".repeat(155)}${flag}${flag}`);
    expect(points(cut)).toBeLessThanOrEqual(LOG_TEXT_MAX);
    expect(cut).toBe(`${"a".repeat(155)}…`);
    const family = "\u{1F469}‍\u{1F469}‍\u{1F467}"; // five code points
    expect(logText(`${"a".repeat(151)}${family}${family}`)).toBe(`${"a".repeat(151)}${family}…`);
  });
  it("a lone surrogate never survives, and 2000 characters come back as 160", () => {
    expect(logText("half \ud83c a pair")).toBe("half � a pair");
    const long = logText("x".repeat(2000));
    expect(points(long)).toBe(LOG_TEXT_MAX);
    expect(long.endsWith("…")).toBe(true);
  });
  it("is empty only for text with nothing visible in it, which the log refuses (see appendEvent)", () => {
    expect(logText(" \n\t​‮ ")).toBe("");
    expect(logText("·")).toBe("·");
  });
});

describe("dates", () => {
  it("clock, stamp and file name are local", () => {
    expect(clock(local(7, 9, 5))).toBe("09:05");
    expect(localStamp(local(7, 14, 32))).toBe("2026-10-07 14:32");
    expect(changeLogFileName(local(7, 14, 32))).toBe("change-log-2026-10-07.md");
  });
  it("day headings: Today, Yesterday, then 'Mon 5 Oct' in the drawer; the full date in a file (§22.8)", () => {
    const now = local(7, 10, 0);
    expect(dayHeading(local(7, 0, 1), now, true)).toBe("Today");
    expect(dayHeading(local(6, 23, 59), now, true)).toBe("Yesterday");
    expect(dayHeading(local(5, 12, 0), now, true)).toBe("Mon 5 Oct");
    expect(dayHeading(local(31, 12, 0, 11, 2025), now, true)).toBe("Wed 31 Dec 2025");
    expect(dayHeading(local(31, 12, 0), local(1, 9, 0, 10), true)).toBe("Yesterday"); // across a month
    expect(dayHeading(local(31, 12, 0, 11, 2025), local(1, 9, 0, 0, 2026), true)).toBe("Yesterday"); // across a year
    expect(dayHeading(local(7, 14, 32), now, false)).toBe("Wednesday 7 October 2026");
  });
  it("a hand-edited time that doesn't parse reads as unknown, never NaN", () => {
    const bad = new Date("yesterday-ish");
    expect([clock(bad), localStamp(bad), dayHeading(bad, local(7, 10, 0), true), dayHeading(bad, local(7, 10, 0), false)]).toEqual(["--:--", "date unknown", "Date unknown", "Date unknown"]);
    const md = logMarkdown({ project: "P", entries: [{ at: "yesterday-ish", area: "project", text: "Kept the wide", by: "user" }], undated: [], dropped: 0, now: local(7, 15, 0) });
    expect(md).toContain("## Date unknown\n- --:-- · Project · Kept the wide (you)\n");
    expect(recentChanges([{ at: "", text: "Kept the wide" }])).toBe("Recent changes (newest first):\n- date unknown Kept the wide");
  });
});

describe("logMarkdown and recentChanges (§22.7)", () => {
  const entries = [
    { at: local(7, 14, 32).toISOString(), area: "picture" as const, text: "v6 added: launch 1.45x slower", by: "agent" as const },
    { at: local(7, 13, 5).toISOString(), area: "notes" as const, text: "3 notes sent from Picture", by: "user" as const },
    { at: local(5, 18, 10).toISOString(), area: "assets" as const, text: "2 files added: Scripts & docs", by: "rushes" as const },
  ];
  it("is newest first, one heading per day, then Before the log and the removed note", () => {
    expect(logMarkdown({ project: "Lumen launch film", entries, undated: [{ text: "Music: night-drive (3 variants)" }], dropped: 2, now: local(7, 15, 0) })).toBe(
      "# Lumen launch film — change log\nExported 2026-10-07 15:00\n\n" +
        "## Wednesday 7 October 2026\n- 14:32 · Picture · v6 added: launch 1.45x slower (agent)\n- 13:05 · Notes · 3 notes sent from Picture (you)\n\n" +
        "## Monday 5 October 2026\n- 18:10 · Files · 2 files added: Scripts & docs (Rushes)\n\n" +
        "## Before the log\n- Music: night-drive (3 variants)\n\nEarlier entries were removed.\n",
    );
    expect(logMarkdown({ project: "Lumen launch film", entries: [], undated: [], dropped: 0, now: local(7, 15, 0) })).toBe(
      "# Lumen launch film — change log\nExported 2026-10-07 15:00\n\nNothing yet.\n",
    );
    expect(logMarkdown({ project: "P", entries: entries.slice(0, 1), undated: [], dropped: 0, earlier: 4, now: local(7, 15, 0) })).toContain("\n\n4 earlier entries not shown.\n");
    expect(logMarkdown({ project: "P", entries: entries.slice(0, 1), undated: [], dropped: 0, earlier: 1, now: local(7, 15, 0) })).toContain("\n\n1 earlier entry not shown.\n");
  });
  it("an area filter is named in the heading and in the empty line (review M3)", () => {
    const base = { project: "Lumen launch film", undated: [], dropped: 0, now: local(7, 15, 0) };
    expect(logMarkdown({ ...base, entries: [], area: "sfx" })).toBe("# Lumen launch film \u2014 change log: Sound effects\nExported 2026-10-07 15:00\n\nNothing in Sound effects yet.\n");
    expect(logMarkdown({ ...base, entries: entries.slice(0, 1), area: "picture" }).split("\n")[0]).toBe("# Lumen launch film \u2014 change log: Picture");
  });
  it("an area or writer this build doesn't know prints as it came, never a TypeError (review M6)", () => {
    const odd = [{ at: local(7, 14, 32).toISOString(), area: "formats", text: "Added a format", by: "plugin" }] as unknown as Parameters<typeof logMarkdown>[0]["entries"];
    expect(logMarkdown({ project: "P", entries: odd, undated: [], dropped: 0, now: local(7, 15, 0) })).toContain("- 14:32 \u00b7 formats \u00b7 Added a format (plugin)");
  });
  it("the project's name is one clean line in the heading (minor 6)", () => {
    const md = (project: string) => logMarkdown({ project, entries: [], undated: [], dropped: 0, now: local(7, 15, 0) });
    expect(md("Lumen\nlaunch\tfilm‮")).toBe("# Lumen launch film — change log\nExported 2026-10-07 15:00\n\nNothing yet.\n");
    expect(md(" ​ ").split("\n")[0]).toBe("# Untitled project — change log");
  });
  it("the Send-to-agent block is the last five lines, newest first, and nothing for an empty log", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ at: local(7, 10, 6 - i).toISOString(), text: `Line ${6 - i}` }));
    expect(recentChanges(six)).toBe(
      "Recent changes (newest first):\n- 2026-10-07 10:06 Line 6\n- 2026-10-07 10:05 Line 5\n- 2026-10-07 10:04 Line 4\n- 2026-10-07 10:03 Line 3\n- 2026-10-07 10:02 Line 2",
    );
    expect(recentChanges([])).toBe("");
  });
  it("the area words match the mockup's chips", () => {
    expect(AREA_LABELS).toEqual({ script: "Script", picture: "Picture", voice: "Voice", music: "Music", sfx: "Sound effects", mix: "Mix", notes: "Notes", assets: "Files", project: "Project" });
  });
});

it("logText.ts imports only labels.ts, so the dashboard can bundle it without zod or Node", () => {
  const text = readFileSync(new URL("../../src/core/logText.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, removeComments: true } }).outputText;
  expect(modulesPulledIn(text)).toEqual(['"./labels.js"']);
  expect(modulesPulledIn(js)).toEqual(['"./labels.js"']);
  expect(js).toContain('import { oneLine, oneLineOf } from "./labels.js";');
  // Safari before 16.4 can't parse a lookbehind, and this file runs in the dashboard.
  expect(text).not.toMatch(/\(\?<[=!]/);
});
