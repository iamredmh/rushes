// I1: /media must never touch the filesystem beyond the file it's serving for the common case
// -- a path the project explicitly registered (or one of the server's own screenshot/grab
// names). readdir is mocked (wrapping the real implementation, so behaviour is unchanged) only
// to count calls; vi.spyOn can't patch a built-in ESM module's own export directly.
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

import { readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { jsonPoster } from "../helpers/http.js";
import { createApp } from "../../src/server/app.js";

async function setup() {
  const { root, store } = await tmpProject("media-hotpath");
  const app = createApp(store);
  const call = (path: string, init: RequestInit = {}) => app.request(path, init);
  const post = jsonPoster(app);
  return { root, call, post };
}

describe("/media's fast path (I1)", () => {
  it("does no readdir at all for a registered cut", async () => {
    const { root, call, post } = await setup();
    await mkdir(join(root, "renders"), { recursive: true });
    await writeFile(join(root, "renders", "hero_v1.mp4"), Buffer.alloc(100, 1));
    await post("/api/versions", { video: "Hero", file: "renders/hero_v1.mp4" });
    (readdir as unknown as ReturnType<typeof vi.fn>).mockClear();

    const res = await call("/media?path=renders%2Fhero_v1.mp4");
    expect(res.status).toBe(200);
    expect(readdir).not.toHaveBeenCalled();
  });

  it("does no readdir for a screenshot or a grab, matched by their safe-name regex alone", async () => {
    const { root, call } = await setup();
    await mkdir(join(root, "screenshots"), { recursive: true });
    await writeFile(join(root, "screenshots", "hero_v1_00m00.00s_f1.png"), Buffer.alloc(10, 1));
    (readdir as unknown as ReturnType<typeof vi.fn>).mockClear();

    const res = await call("/media?path=screenshots%2Fhero_v1_00m00.00s_f1.png");
    expect(res.status).toBe(200);
    expect(readdir).not.toHaveBeenCalled();
  });

  it("still falls back to discovery (readdir) for an auto-discovered doc, and finds it", async () => {
    const { root, call } = await setup();
    await writeFile(join(root, "brief.md"), "# Brief\n");
    (readdir as unknown as ReturnType<typeof vi.fn>).mockClear();

    const res = await call("/media?path=brief.md");
    expect(res.status).toBe(200);
    expect(readdir).toHaveBeenCalled();
  });
});
