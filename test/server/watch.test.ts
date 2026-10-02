import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { tmpProject } from "../helpers/tmp.js";
import { sse } from "../helpers/sse.js";
import { startServer } from "../../src/server/start.js";

describe("watching .rushes for hand edits", () => {
  it("announces a valid hand edit once, with its rev", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const events = await sse(s.url);
    await events.until("event: hello");
    const notes = JSON.parse(await readFile(s.store.path("notes"), "utf8"));
    notes.rev = 7;
    await writeFile(s.store.path("notes"), JSON.stringify(notes, null, 2));
    const text = await events.until('"rev":7');
    expect(text).toContain('"file":"notes"');
    events.stop();
    await s.close();
  });

  it("does not announce the server's own writes twice", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const events = await sse(s.url);
    await events.until("event: hello");
    await fetch(`${s.url}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: "picture", scope: "point", t: 1, text: "x" }),
    });
    await events.until('"file":"notes"');
    await new Promise((r) => setTimeout(r, 300));
    expect(events.text().match(/"file":"notes"/g)).toHaveLength(1);
    events.stop();
    await s.close();
  });

  it("announces again when a corrupt file is restored at the same rev it had before", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const events = await sse(s.url);
    await events.until("event: hello");
    const notes = JSON.parse(await readFile(s.store.path("notes"), "utf8"));
    notes.rev = 7;
    const valid = JSON.stringify(notes, null, 2);
    await writeFile(s.store.path("notes"), valid);
    await events.until('"rev":7');
    await writeFile(s.store.path("notes"), "{ broken");
    await events.until("event: corrupt");
    // Restore the exact file the watcher already announced, at the same rev.
    await writeFile(s.store.path("notes"), valid);
    const text = await events.untilNext('"rev":7');
    expect(text.match(/"rev":7/g)).toHaveLength(2);
    events.stop();
    await s.close();
  });

  it("reports a broken hand edit as corrupt and leaves it alone", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const events = await sse(s.url);
    await events.until("event: hello");
    await writeFile(s.store.path("picks"), "{ broken");
    const text = await events.until("event: corrupt");
    expect(text).toContain("picks.json");
    expect(await readFile(s.store.path("picks"), "utf8")).toBe("{ broken");
    events.stop();
    await s.close();
  });
});
