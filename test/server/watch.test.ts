import { describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { tmpProject } from "../helpers/tmp.js";
import { sse } from "../helpers/sse.js";
import { startServer } from "../../src/server/start.js";
import { ensureProjectId } from "../../src/core/project.js";

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

  it("reports a corrupt file once, not again on every poll while it stays broken", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const events = await sse(s.url);
    await events.until("event: hello");
    await writeFile(s.store.path("picks"), "{ broken");
    await events.until("event: corrupt");
    // Three or more poll periods (the poll runs every 500ms) with the file left broken.
    await new Promise((r) => setTimeout(r, 1500));
    expect(events.text().match(/event: corrupt/g)).toHaveLength(1);
    events.stop();
    await s.close();
  });

  it("the safety poll reads nothing while the project is idle", async () => {
    const { root, store } = await tmpProject();
    // Assign the project id up front, so the server's own startup doesn't write
    // to project.json (ensureProjectIdOnce is a no-op once an id exists) — a
    // write there would otherwise cost one legitimate, pre-existing fs.watch
    // read of its own, unrelated to what this test is about.
    await store.update("project", ensureProjectId);
    const s = await startServer(root, { port: 0 });
    // The start-up scan (§20.1) reads the project once in the background; let it
    // finish, so the spy below only sees what the poll does.
    await s.found.settled();
    // Attached after startServer() resolves, so it only sees reads from here on —
    // the watcher's own startup seed (one read per file) has already happened.
    const spy = vi.spyOn(s.store, "read");
    const events = await sse(s.url);
    await events.until("event: hello");
    // Three or more poll periods with no edits at all.
    await new Promise((r) => setTimeout(r, 1500));
    expect(spy).not.toHaveBeenCalled();
    events.stop();
    await s.close();
  });

  // A dropped fs.watch notification (the OS failing to deliver one at all, as
  // opposed to a corrupt or duplicate one) isn't something this suite can force
  // deterministically — there's no seam to simulate it without faking fs.watch
  // itself. It's covered instead by stress evidence from building this fix: the
  // same stress recipe that reproduced the loss 5 times in 150 runs (see
  // .superpowers/sdd/2026-10-03-rushes-plan-2c-assets/task-3-report.md) passed
  // 150/150 once the poll safety net was added.
});
