import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { RpcPeer } from "../../../src/server/agent/rpc.js";

function pair() {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  return { a: new RpcPeer(bToA, aToB), b: new RpcPeer(aToB, bToA), aToB, bToA };
}

describe("RpcPeer", () => {
  it("matches responses to requests by id and ignores blank lines", async () => {
    const { a, b, bToA } = pair();
    b.onRequest("add", async (p) => p.x + p.y);
    bToA.write("\n   \n");
    const [r1, r2] = await Promise.all([a.request("add", { x: 1, y: 2 }), a.request("add", { x: 10, y: 20 })]);
    expect([r1, r2]).toEqual([3, 30]);
  });

  it("answers an unknown request with -32601", async () => {
    const { a } = pair();
    await expect(a.request("nope", {})).rejects.toMatchObject({ code: -32601 });
  });

  it("rejects in-flight requests on close with the given reason", async () => {
    const { a, b } = pair();
    b.onRequest("never", () => new Promise(() => {}));
    const pending = a.request("never", {});
    a.close(new Error("gone: code 3"));
    await expect(pending).rejects.toThrow("gone: code 3");
    await expect(a.request("later", {})).rejects.toThrow("gone: code 3");
  });

  it("handles a request from the other side and sends back its result", async () => {
    const { a, b } = pair();
    a.onRequest("echo", async (p) => ({ got: p }));
    expect(await b.request("echo", { v: 1 })).toEqual({ got: { v: 1 } });
  });

  it("delivers notifications and turns a handler throw into an error response", async () => {
    const { a, b } = pair();
    const seen: unknown[] = [];
    b.onNotification("ping", (p) => seen.push(p));
    a.notify("ping", { n: 1 });
    b.onRequest("boom", async () => { throw new Error("bad"); });
    await expect(a.request("boom", {})).rejects.toThrow("bad");
    expect(seen).toEqual([{ n: 1 }]);
  });

  it("a throwing notification handler does not stop later requests being answered", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { a, b } = pair();
      b.onNotification("bad", () => { throw new Error("handler bug"); });
      b.onRequest("ok", async () => "fine");
      a.notify("bad", {});
      expect(await a.request("ok", {})).toBe("fine");
      expect(spy.mock.calls.some((c) => String(c[0]).includes("bad"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
