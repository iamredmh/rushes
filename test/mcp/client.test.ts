import { describe, expect, it } from "vitest";
import { createServer, type RequestListener } from "node:http";
import { dashboardUrlFor } from "../../src/mcp/client.js";

/** A tiny stub HTTP server, for testing dashboardUrlFor against health responses the real app wouldn't send. */
async function stub(handler: RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function json(body: unknown, status = 200) {
  return (req: Parameters<RequestListener>[0], res: Parameters<RequestListener>[1]) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
}

describe("dashboardUrlFor", () => {
  it("returns the /p/<id>/ address for a current server", async () => {
    const s = await stub(json({ ok: true, id: "abcdefgh" }));
    expect(await dashboardUrlFor(s.url)).toBe(`${s.url}/p/abcdefgh/`);
    await s.close();
  });

  it("returns the plain base address for an older server (before project ids), which has no id", async () => {
    const s = await stub(json({ ok: true, app: "rushes", root: "/some/project" }));
    expect(await dashboardUrlFor(s.url)).toBe(`${s.url}/`);
    await s.close();
  });

  it("returns the plain base address when id doesn't match the project id shape", async () => {
    const s = await stub(json({ ok: true, id: "Not-An-Id!" }));
    expect(await dashboardUrlFor(s.url)).toBe(`${s.url}/`);
    await s.close();
  });

  it("throws a clear error when the health check itself fails (non-2xx)", async () => {
    const s = await stub(json({ error: "internal", message: "boom" }, 500));
    await expect(dashboardUrlFor(s.url)).rejects.toThrow(`Rushes at ${s.url} didn't answer its health check`);
    await s.close();
  });

  it("throws a clear error when nothing is listening", async () => {
    await expect(dashboardUrlFor("http://127.0.0.1:1")).rejects.toThrow(/didn't answer its health check/);
  });
});
