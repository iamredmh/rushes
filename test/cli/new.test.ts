import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIEF_FILE, BRIEF_SECTIONS, briefTemplate, makeProject } from "../../src/cli/new.js";
import { Store } from "../../src/core/store.js";

const made: string[] = [];
afterEach(async () => {
  while (made.length) await rm(made.pop()!, { recursive: true, force: true });
});

/** An empty folder whose path contains a space, like real project folders. */
async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "rushes new ")));
  made.push(dir);
  return dir;
}
const exists = (p: string) => access(p).then(() => true, () => false);

describe("briefTemplate", () => {
  it("has the title, a draft status line and the nine sections, in order, with Open questions before References", () => {
    const text = briefTemplate("Lumen launch film");
    expect(text.split("\n")[0]).toBe("# Brief: Lumen launch film");
    expect(text).toContain("\nStatus: draft\n");
    expect([...text.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual([...BRIEF_SECTIONS]);
    expect(BRIEF_SECTIONS).toHaveLength(9);
    expect(BRIEF_SECTIONS.indexOf("Open questions")).toBe(BRIEF_SECTIONS.indexOf("References") - 1);
  });
});

describe("makeProject", () => {
  it("creates the project, the recommended folders and brief.md", async () => {
    const base = await scratch();
    const target = join(base, "My Film");
    const made1 = await makeProject(target);
    expect(made1).toEqual({ dir: target, briefWritten: true });
    expect(await exists(join(target, ".rushes", "project.json"))).toBe(true);
    for (const d of ["renders", "audio/voiceover", "audio/music", "audio/sfx"]) expect(await exists(join(target, d))).toBe(true);
    const brief = await readFile(join(target, BRIEF_FILE), "utf8");
    expect(brief.split("\n")[0]).toBe("# Brief: My Film");
    expect((await new Store(target).read("project")).name).toBe("My Film");
  });

  it("uses --name for both the project and the brief title", async () => {
    const target = join(await scratch(), "film");
    await makeProject(target, { name: "Lumen launch film" });
    expect((await new Store(target).read("project")).name).toBe("Lumen launch film");
    expect((await readFile(join(target, BRIEF_FILE), "utf8")).split("\n")[0]).toBe("# Brief: Lumen launch film");
  });

  // Review Focus 3.
  it("keeps a name with a line break on one line, and falls back to the folder name for a blank one", async () => {
    const base = await scratch();
    const a = join(base, "a");
    await makeProject(a, { name: "Line one\nLine two" });
    expect((await readFile(join(a, BRIEF_FILE), "utf8")).split("\n")[0]).toBe("# Brief: Line one Line two");
    expect((await new Store(a).read("project")).name).toBe("Line one Line two");
    const b = join(base, "Blank Name");
    await makeProject(b, { name: "  \n " });
    expect((await new Store(b).read("project")).name).toBe("Blank Name");
  });

  // Review Focus 1.
  it("never overwrites a brief.md that is already there, and says so", async () => {
    const target = join(await scratch(), "film");
    await mkdir(target);
    await writeFile(join(target, BRIEF_FILE), "my own brief\n");
    const r = await makeProject(target);
    expect(r.briefWritten).toBe(false);
    expect(await readFile(join(target, BRIEF_FILE), "utf8")).toBe("my own brief\n");
    expect(await exists(join(target, ".rushes", "project.json"))).toBe(true);
  });

  it("works in a folder that already holds other files, and leaves them alone", async () => {
    const target = join(await scratch(), "has files");
    await mkdir(target);
    await writeFile(join(target, "notes.txt"), "keep me");
    await makeProject(target);
    expect(await readFile(join(target, "notes.txt"), "utf8")).toBe("keep me");
  });

  // Review Focus 2.
  it("refuses a folder that is already a Rushes project and changes nothing in it", async () => {
    const target = join(await scratch(), "film");
    await makeProject(target);
    const before = await readFile(join(target, ".rushes", "project.json"), "utf8");
    await writeFile(join(target, BRIEF_FILE), "edited by the user\n");
    await expect(makeProject(target)).rejects.toThrow(/already a Rushes project/);
    expect(await readFile(join(target, ".rushes", "project.json"), "utf8")).toBe(before);
    expect(await readFile(join(target, BRIEF_FILE), "utf8")).toBe("edited by the user\n");
  });
});
