# Rushes Plan 1: Foundation (data, server, MCP, CLI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working, headless Rushes that anyone can install from the public GitHub repo with one command, in any agent harness. It covers a project's `.rushes/` folder, a local server that is its only writer, eleven MCP tools, a CLI, `rushes setup` for every harness, and a Claude Code plugin. An agent can register cuts, script and audio variants, read the user's notes and batches, and reply. The dashboard comes in Plan 2.

**Architecture:** One TypeScript npm package. `src/core` is pure data logic: zod schemas, plus functions that change a file's data in memory. `src/core/store.ts` is the only code that touches disk: every write is validated, serialised per file, made atomic, and announced as an event. `src/server` wraps the store in a Hono HTTP API with server-sent events. `src/mcp` and `src/cli` are thin clients of that API, and they start a server in the background if none is running.

**Tech stack:** Node ≥ 20, TypeScript 5.9 (ESM, NodeNext), zod 4, Hono 4 + @hono/node-server 2, @modelcontextprotocol/sdk 1.31, vitest 5, tsx.

**Spec:** `docs/specs/2026-10-02-rushes-design.md`. Read sections 4, 5, 6 (unlock rules), 7 and 9 before starting.

**Verified:** every code block below was run in a prototype on 2 October 2026. There were 79 tests across 11 files, all passing, plus `tsc --noEmit` and `npm run build` clean. Also checked: `claude plugin validate` passes for the plugin, the marketplace and the skill, `npx -y git+file://…` installs and runs through `prepare`, and `rushes setup --dry-run` reports correctly on a real Mac.

## Global Constraints

- Node `>=20`. ESM only (`"type": "module"`). Relative imports end in `.js` (NodeNext).
- Package name `rushes`, bin `rushes`, licence MIT, author "Red Morley Hewitt", repository `github:iamredmh/rushes`.
- Runtime dependencies are exactly `@hono/node-server`, `@modelcontextprotocol/sdk`, `hono` and `zod`. No native modules. ffmpeg/ffprobe are optional and found on PATH at runtime.
- Only the server process writes `.rushes/*.json`. MCP and the CLI go through the HTTP API.
- Every data file has `"schema": 1` and a `"rev"` that increases by 1 on each write. It's written as two-space JSON with a trailing newline.
- Stages, in this order: `script, picture, voice, music, sfx, mix`.
- Media paths inside the project are stored relative with `/`. Paths outside the project are stored absolute.
- Field ownership on notes: the user owns `text, box, grab, scope, t, tOut`. The agent owns `reply, fixT, fixVersion`. Both own `status`.
- MCP tool names (eleven): `rushes_open, rushes_status, rushes_add_version, rushes_add_variant, rushes_set_script, rushes_get_script, rushes_add_take, rushes_list_notes, rushes_get_batch, rushes_reply, rushes_get_picks`. `rushes_set_script` merges by id unless `replace: true`.
- The server binds to `127.0.0.1` only. The default port is 4317, falling back up to +10.
- Install source: `SOURCE = "github:iamredmh/rushes"` in `src/setup/harnesses.ts`. Every doc and config uses `npx -y github:iamredmh/rushes <command>` until Plan 4 publishes to npm.
- Zero setup for users: no accounts, keys, telemetry or hosted services. Node ≥ 20 is the only requirement, plus git while installs come straight from GitHub.
- `rushes setup` never removes or rewrites settings it didn't add, backs up any file it changes to `<file>.rushes.bak`, leaves invalid configs untouched, and runs `claude` commands with the home folder as cwd.
- Prose in docs uses UK English. Code identifiers use the usual US spellings (`color`).

## Review Focus

These are the five inputs most likely to bite a real user. Each is pinned by a test in the task that owns the code:

1. **Project folders with spaces** (e.g. `~/Documents/My Projects`): every path still works. *Task 1 (`tmpProject` always uses "My Project"), Task 2 (manifest paths) and Task 9 (`init "Second Film"`).*
2. **The browser and the agent writing at the same moment:** no update is lost. *Task 1 (25 concurrent updates), Task 6 (two batches at once get different ids).*
3. **A hand-edited or half-written `.rushes` file:** never overwritten, and the error names the file and field. *Task 1, Task 6 (500 with `file: "notes.json"`).*
4. **A stale `server.json`** after a crash, or a reused port pointing at another project's server: Rushes must not talk to the wrong project. *Task 7 (dead pid) and Task 8 (a lock pointing at another project).*
5. **Port 4317 already in use:** it moves to the next free port. *Task 7.*
6. **A user's existing harness config** (Cursor, Gemini, Codex, Claude Desktop) that has other servers in it, or is broken: `setup` must keep everything, back it up, and never write over a file it can't parse. Running it twice must change nothing. *Task 9.*

## File structure

```
rushes/
  package.json  tsconfig.json  tsconfig.build.json  vitest.config.ts  .gitignore  LICENSE  README.md  AGENTS.md
  skills/rushes/SKILL.md
  docs/specs/2026-10-02-rushes-design.md        (copied from the brainstorm)
  docs/plans/2026-10-02-rushes-plan-1-foundation.md
  src/core/schema.ts      zod schemas + types for the five data files
  src/core/errors.ts      typed errors carrying an HTTP status and code
  src/core/store.ts       the only disk writer: init, read, update (serialised, atomic, rev, events)
  src/core/ids.ts         newId, slugify, uniqueId
  src/core/paths.ts       manifest path <-> absolute path
  src/core/project.ts     addVersion, addVariant, latestVersion, findVideo
  src/core/media.ts       optional ffprobe: duration + fps
  src/core/script.ts      fit maths, setSections, editSection, addTake, stale takes
  src/core/notes.ts       addNote, applyReply, applyUserEdit, filterNotes
  src/core/tabs.ts        unlock rules + to-do counts
  src/core/batches.ts     createBatch, buildPrompt, latestBatch
  src/server/app.ts       Hono routes + SSE
  src/server/lock.ts      .rushes/server.json
  src/server/start.ts     startServer (port fallback, lock life cycle)
  src/mcp/client.ts       RushesClient (fetch wrapper), ApiError
  src/mcp/ensure.ts       findServer, ensureServer (spawn detached `rushes serve`)
  src/mcp/tools.ts        createMcpServer: the ten tools
  src/mcp/stdio.ts        runStdio, openBrowser
  src/setup/harnesses.ts  SOURCE, harness table, mergeJson, mergeToml
  src/setup/setup.ts      setup(env, opts): register with each installed harness + copy the skill
  src/setup/env.ts        realSetupEnv(): home folder, which, exec
  src/cli/main.ts         main(argv, io): every CLI command
  src/cli/index.ts        bin entry
  test/helpers/tmp.ts     temp project in a folder with a space
  .claude-plugin/plugin.json  .claude-plugin/marketplace.json  .mcp.json   (Claude Code plugin + marketplace)
  test/core/*.test.ts  test/server/*.test.ts  test/mcp/*.test.ts  test/setup/*.test.ts  test/cli/*.test.ts  test/e2e/stdio.test.ts
```

---

### Task 1: Repo scaffold, schemas and the store

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `LICENSE`
- Create: `src/core/schema.ts`
- Create: `src/core/errors.ts`
- Create: `src/core/store.ts`
- Create: `test/helpers/tmp.ts`
- Create: `test/core/store.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
- `schema.ts`: `STAGES`, the type `Stage`, the type `LaneStage`, and a zod schema plus type for each data file: `Project`, `Script`, `NotesFile`, `Picks`, `BatchesFile`, along with `Version`, `Video`, `Variant`, `Lane`, `Cue`, `Section`, `Take`, `Note`, `Batch` and `BoxSchema`. Also `FILES` (key to file name and schema), `FileKey`, `FileData`.
- `errors.ts`: `RushesError(message, status, code, detail)` and its subclasses `NotFoundError(what, id)` (404), `InvalidError(message, issues)` (400), `RevConflictError(file, expected, current)` (409), `CorruptFileError(file, reason)` (500) and `EmptyBatchError(stage)` (409).
- `store.ts`: `RUSHES_DIR = ".rushes"`, `serialise(data)`, and `class Store extends EventEmitter` with `root`, `dir`, `path(key)`, `init(name)`, `read(key)`, `update(key, fn, expectedRev?) -> {data, result}` and `backup(key)`. It emits `"change"` with `{file, rev}`.
- `test/helpers/tmp.ts`: `tmpProject(name?) -> {root, store}`. The root always has a space in it, and it's cleaned up after each test.

- [ ] **Step 1: Create the repo**

```bash
mkdir -p ~/Documents/Projects/rushes && cd ~/Documents/Projects/rushes
git init -b main
mkdir -p src/core src/server src/mcp src/cli test/helpers test/core test/server test/mcp test/cli test/e2e docs/specs docs/plans skills/rushes
cp <brainstorm folder>/docs/specs/2026-10-02-rushes-design.md docs/specs/
cp <brainstorm folder>/docs/plans/2026-10-02-rushes-plan-1-foundation.md docs/plans/
```

- [ ] **Step 2: Add the project files**

`package.json`

```json
{
  "name": "rushes",
  "version": "0.1.0",
  "description": "A local review desk for video made with AI agents: timecoded notes, script edits and audio picks your agent can read and act on.",
  "type": "module",
  "license": "MIT",
  "author": "Red Morley Hewitt",
  "repository": "github:iamredmh/rushes",
  "bin": {
    "rushes": "dist/cli/index.js"
  },
  "files": [
    "dist",
    "skills",
    "AGENTS.md"
  ],
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "rushes": "tsx src/cli/index.ts"
  },
  "dependencies": {
    "@hono/node-server": "^2.1.3",
    "@modelcontextprotocol/sdk": "^1.31.0",
    "hono": "^4.12.0",
    "zod": "^4.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.20.0",
    "typescript": "^5.9.3",
    "vitest": "^5.0.0"
  }
}
```

`tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`tsconfig.build.json`

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

`vitest.config.ts`

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15000,
  },
});
```

`.gitignore`

```
node_modules/
dist/
coverage/
.DS_Store
*.log
.rushes/
```

`LICENSE`

```
MIT License

Copyright (c) 2026 Red Morley Hewitt

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`test/helpers/tmp.ts`

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { Store } from "../../src/core/store.js";

const made: string[] = [];

afterEach(async () => {
  while (made.length) await rm(made.pop()!, { recursive: true, force: true });
});

/** A fresh project folder whose path contains a space, like real project folders. */
export async function tmpProject(name = "demo"): Promise<{ root: string; store: Store }> {
  const base = await mkdtemp(join(tmpdir(), "rushes test "));
  made.push(base);
  const root = join(base, "My Project");
  const store = new Store(root);
  await store.init(name);
  return { root, store };
}
```

- [ ] **Step 3: Install dependencies**

```bash
npm install
```

Expected: it installs with no errors (`found 0 vulnerabilities`).

- [ ] **Step 4: Write the failing test**

`test/core/store.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { CorruptFileError, InvalidError, RevConflictError } from "../../src/core/errors.js";
import type { ChangeEvent } from "../../src/core/store.js";

describe("Store", () => {
  it("init writes every file with schema 1 and rev 0, plus a .gitignore", async () => {
    const { store } = await tmpProject("spring-launch");
    const project = await store.read("project");
    expect(project).toMatchObject({ schema: 1, rev: 0, name: "spring-launch", fps: 30, videos: [], lanes: [] });
    expect((await store.read("notes")).notes).toEqual([]);
    const ignore = await readFile(join(store.dir, ".gitignore"), "utf8");
    expect(ignore).toContain("server.json");
  });

  it("init does not overwrite existing files", async () => {
    const { store } = await tmpProject("first");
    await store.update("project", (p) => { p.fps = 60; });
    await store.init("second");
    const p = await store.read("project");
    expect(p.name).toBe("first");
    expect(p.fps).toBe(60);
  });

  it("update bumps rev, writes pretty JSON and emits a change event", async () => {
    const { store } = await tmpProject();
    const events: ChangeEvent[] = [];
    store.on("change", (e: ChangeEvent) => events.push(e));
    const { data } = await store.update("project", (p) => { p.fps = 25; });
    expect(data.rev).toBe(1);
    const raw = await readFile(store.path("project"), "utf8");
    expect(raw).toContain('\n  "fps": 25,');
    expect(events).toEqual([{ file: "project", rev: 1 }]);
  });

  it("rejects a write when expectedRev is stale", async () => {
    const { store } = await tmpProject();
    await store.update("project", (p) => { p.fps = 24; });
    await expect(store.update("project", (p) => { p.fps = 50; }, 0)).rejects.toBeInstanceOf(RevConflictError);
    expect((await store.read("project")).fps).toBe(24);
  });

  it("serialises concurrent updates so none are lost", async () => {
    const { store } = await tmpProject();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.update("picks", (p) => { p.lanes[`lane${i}`] = "a"; }),
      ),
    );
    const picks = await store.read("picks");
    expect(Object.keys(picks.lanes)).toHaveLength(25);
    expect(picks.rev).toBe(25);
  });

  it("refuses to touch a hand-edited file with invalid JSON", async () => {
    const { store } = await tmpProject();
    await writeFile(store.path("notes"), '{ "schema": 1, "rev": 3, "notes": [ oops ', "utf8");
    await expect(store.update("notes", (n) => { n.notes = []; })).rejects.toBeInstanceOf(CorruptFileError);
    expect(await readFile(store.path("notes"), "utf8")).toContain("oops");
  });

  it("refuses a file that fails the schema and names the field", async () => {
    const { store } = await tmpProject();
    await writeFile(store.path("project"), JSON.stringify({ schema: 1, rev: 0, name: "", fps: -1 }), "utf8");
    await expect(store.read("project")).rejects.toThrow(/fps/);
  });

  it("rejects a change that would make the file invalid, leaving it as it was", async () => {
    const { store } = await tmpProject();
    await expect(store.update("project", (p) => { p.fps = -5; })).rejects.toBeInstanceOf(InvalidError);
    expect((await store.read("project")).rev).toBe(0);
  });

  it("a failed update does not block the next one", async () => {
    const { store } = await tmpProject();
    await expect(store.update("project", () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const { data } = await store.update("project", (p) => { p.fps = 48; });
    expect(data.fps).toBe(48);
  });
});
```

- [ ] **Step 5: Run it and confirm it fails**

Run: `npx vitest run test/core/store.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/core/store.js"`.

- [ ] **Step 6: Implement**

`src/core/schema.ts`

```ts
import { z } from "zod";

export const STAGES = ["script", "picture", "voice", "music", "sfx", "mix"] as const;
export const StageSchema = z.enum(STAGES);
export type Stage = z.infer<typeof StageSchema>;

export const LaneStageSchema = z.enum(["voice", "music", "sfx"]);
export type LaneStage = z.infer<typeof LaneStageSchema>;

const id = z.string().min(1).max(64);
const seconds = z.number().nonnegative();

export const VersionSchema = z.object({
  id,
  file: z.string().min(1),
  duration: seconds.nullable().default(null),
  fps: z.number().positive().nullable().default(null),
  addedAt: z.string(),
  note: z.string().default(""),
});
export type Version = z.infer<typeof VersionSchema>;

export const VideoSchema = z.object({
  id,
  name: z.string().min(1),
  versions: z.array(VersionSchema).default([]),
});
export type Video = z.infer<typeof VideoSchema>;

export const CueSchema = z.object({ id, name: z.string().min(1), t: seconds });
export type Cue = z.infer<typeof CueSchema>;

export const VariantSchema = z.object({
  id,
  name: z.string().min(1),
  file: z.string().min(1),
  meta: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  cues: z.array(CueSchema).default([]),
});
export type Variant = z.infer<typeof VariantSchema>;

export const LaneSchema = z.object({
  id,
  stage: LaneStageSchema,
  name: z.string().min(1),
  variants: z.array(VariantSchema).default([]),
});
export type Lane = z.infer<typeof LaneSchema>;

export const ProjectSchema = z.object({
  schema: z.literal(1),
  rev: z.number().int().nonnegative(),
  name: z.string().min(1),
  fps: z.number().positive().default(30),
  videos: z.array(VideoSchema).default([]),
  lanes: z.array(LaneSchema).default([]),
});
export type Project = z.infer<typeof ProjectSchema>;

export const TakeSchema = z.object({
  id,
  file: z.string().min(1),
  duration: seconds.nullable().default(null),
  forText: z.string(),
});
export type Take = z.infer<typeof TakeSchema>;

export const SectionStatusSchema = z.enum(["draft", "approved", "flagged"]);
export const SectionSchema = z
  .object({
    id,
    start: seconds,
    end: seconds,
    current: z.string(),
    proposed: z.string().nullable().default(null),
    direction: z.string().default(""),
    status: SectionStatusSchema.default("draft"),
    takes: z.array(TakeSchema).default([]),
  })
  .refine((s) => s.end > s.start, { message: "end must be after start", path: ["end"] });
export type Section = z.infer<typeof SectionSchema>;

export const ScriptSchema = z.object({
  schema: z.literal(1),
  rev: z.number().int().nonnegative(),
  wordsPerSecond: z.number().positive().default(2.6),
  sections: z.array(SectionSchema).default([]),
});
export type Script = z.infer<typeof ScriptSchema>;

export const BoxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});

export const NoteSchema = z
  .object({
    id,
    stage: StageSchema,
    video: z.string().nullable().default(null),
    version: z.string().nullable().default(null),
    on: z.string().nullable().default(null),
    scope: z.enum(["point", "range", "whole"]),
    t: seconds.nullable().default(null),
    tOut: seconds.nullable().default(null),
    frame: z.number().int().nonnegative().nullable().default(null),
    text: z.string().trim().min(1).max(4000),
    box: BoxSchema.nullable().default(null),
    grab: z.string().nullable().default(null),
    status: z.enum(["todo", "done"]).default("todo"),
    reply: z.string().default(""),
    fixT: seconds.nullable().default(null),
    fixVersion: z.string().nullable().default(null),
    batch: z.string().nullable().default(null),
    createdAt: z.string(),
    by: z.enum(["user", "agent"]).default("user"),
  })
  .superRefine((n, ctx) => {
    if (n.scope === "point" && n.t === null) ctx.addIssue({ code: "custom", path: ["t"], message: "a point note needs t" });
    if (n.scope === "range") {
      if (n.t === null || n.tOut === null) ctx.addIssue({ code: "custom", path: ["tOut"], message: "a range note needs t and tOut" });
      else if (n.tOut <= n.t) ctx.addIssue({ code: "custom", path: ["tOut"], message: "tOut must be after t" });
    }
    if (n.scope === "whole" && (n.t !== null || n.tOut !== null))
      ctx.addIssue({ code: "custom", path: ["scope"], message: "a whole-track note has no t or tOut" });
  });
export type Note = z.infer<typeof NoteSchema>;

export const NotesFileSchema = z.object({
  schema: z.literal(1),
  rev: z.number().int().nonnegative(),
  notes: z.array(NoteSchema).default([]),
});
export type NotesFile = z.infer<typeof NotesFileSchema>;

export const PicksSchema = z.object({
  schema: z.literal(1),
  rev: z.number().int().nonnegative(),
  lanes: z.record(z.string(), z.string()).default({}),
  sections: z.record(z.string(), z.string()).default({}),
});
export type Picks = z.infer<typeof PicksSchema>;

export const BatchSchema = z.object({
  id,
  stage: StageSchema,
  noteIds: z.array(z.string()).default([]),
  sectionIds: z.array(z.string()).default([]),
  sentAt: z.string(),
  prompt: z.string(),
});
export type Batch = z.infer<typeof BatchSchema>;

export const BatchesFileSchema = z.object({
  schema: z.literal(1),
  rev: z.number().int().nonnegative(),
  batches: z.array(BatchSchema).default([]),
});
export type BatchesFile = z.infer<typeof BatchesFileSchema>;

export const FILES = {
  project: { name: "project.json", schema: ProjectSchema },
  script: { name: "script.json", schema: ScriptSchema },
  notes: { name: "notes.json", schema: NotesFileSchema },
  picks: { name: "picks.json", schema: PicksSchema },
  batches: { name: "batches.json", schema: BatchesFileSchema },
} as const;
export type FileKey = keyof typeof FILES;
export type FileData = {
  project: Project;
  script: Script;
  notes: NotesFile;
  picks: Picks;
  batches: BatchesFile;
};
```

`src/core/errors.ts`

```ts
export class RushesError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends RushesError {
  constructor(what: string, id: string) {
    super(`${what} "${id}" not found`, 404, "not_found", { what, id });
  }
}

export class InvalidError extends RushesError {
  constructor(message: string, issues: unknown = []) {
    super(message, 400, "invalid", { issues });
  }
}

export class RevConflictError extends RushesError {
  constructor(file: string, expected: number, current: number) {
    super(`${file} changed (expected rev ${expected}, now ${current})`, 409, "rev_conflict", { file, expected, current });
  }
}

export class CorruptFileError extends RushesError {
  constructor(file: string, reason: string) {
    super(`${file} can't be read: ${reason}. It was not changed.`, 500, "corrupt_file", { file, reason });
  }
}

export class EmptyBatchError extends RushesError {
  constructor(stage: string) {
    super(`Nothing open on the ${stage} tab to send`, 409, "empty_batch", { stage });
  }
}
```

`src/core/store.ts`

```ts
import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile, copyFile, access } from "node:fs/promises";
import { join } from "node:path";
import { FILES, type FileData, type FileKey } from "./schema.js";
import { CorruptFileError, InvalidError, RevConflictError } from "./errors.js";

export const RUSHES_DIR = ".rushes";

const GITIGNORE = "proxies/\npeaks/\nserver.json\n*.tmp\n*.bak\n";

function defaults(key: FileKey, name: string): FileData[FileKey] {
  switch (key) {
    case "project":
      return { schema: 1, rev: 0, name, fps: 30, videos: [], lanes: [] };
    case "script":
      return { schema: 1, rev: 0, wordsPerSecond: 2.6, sections: [] };
    case "notes":
      return { schema: 1, rev: 0, notes: [] };
    case "picks":
      return { schema: 1, rev: 0, lanes: {}, sections: {} };
    case "batches":
      return { schema: 1, rev: 0, batches: [] };
  }
}

export interface ChangeEvent {
  file: FileKey;
  rev: number;
}

/**
 * The only writer of a project's .rushes folder. Every write is validated,
 * serialised per file, written atomically (tmp + rename) and announced with
 * a "change" event.
 */
export class Store extends EventEmitter {
  readonly dir: string;
  private queues = new Map<FileKey, Promise<unknown>>();

  constructor(readonly root: string) {
    super();
    this.dir = join(root, RUSHES_DIR);
  }

  path(key: FileKey): string {
    return join(this.dir, FILES[key].name);
  }

  async init(name: string): Promise<void> {
    await mkdir(join(this.dir, "grabs"), { recursive: true });
    await writeIfMissing(join(this.dir, ".gitignore"), GITIGNORE);
    for (const key of Object.keys(FILES) as FileKey[]) {
      await writeIfMissing(this.path(key), serialise(defaults(key, name)));
    }
  }

  async read<K extends FileKey>(key: K): Promise<FileData[K]> {
    const file = FILES[key].name;
    let raw: string;
    try {
      raw = await readFile(this.path(key), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new CorruptFileError(file, "missing; run rushes init");
      throw e;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      throw new CorruptFileError(file, `invalid JSON (${(e as Error).message})`);
    }
    const parsed = FILES[key].schema.safeParse(json);
    if (!parsed.success) throw new CorruptFileError(file, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return parsed.data as FileData[K];
  }

  /**
   * Read, change and write one file. `fn` mutates the draft and may return a
   * value, which update() passes back. Pass `expectedRev` to reject the write
   * if the file changed since the caller read it.
   */
  update<K extends FileKey, R>(key: K, fn: (draft: FileData[K]) => R, expectedRev?: number): Promise<{ data: FileData[K]; result: R }> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async () => {
      const draft = await this.read(key);
      if (expectedRev !== undefined && expectedRev !== draft.rev) throw new RevConflictError(FILES[key].name, expectedRev, draft.rev);
      const result = fn(draft);
      draft.rev += 1;
      const checked = FILES[key].schema.safeParse(draft);
      if (!checked.success) throw new InvalidError(`Change to ${FILES[key].name} is invalid`, checked.error.issues);
      const data = checked.data as FileData[K];
      await atomicWrite(this.path(key), serialise(data));
      this.emit("change", { file: key, rev: data.rev } satisfies ChangeEvent);
      return { data, result };
    });
    this.queues.set(key, run);
    return run;
  }

  async backup(key: FileKey): Promise<string> {
    const to = this.path(key) + ".bak";
    await copyFile(this.path(key), to);
    return to;
  }
}

export function serialise(data: unknown): string {
  return JSON.stringify(data, null, 2) + "\n";
}

async function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}

async function writeIfMissing(path: string, text: string): Promise<void> {
  try {
    await access(path);
  } catch {
    await writeFile(path, text, "utf8");
  }
}
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `npx vitest run test/core/store.test.ts && npx tsc --noEmit`
Expected: 9 passed, and tsc prints nothing.

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json tsconfig.build.json vitest.config.ts .gitignore LICENSE src/core/schema.ts src/core/errors.ts src/core/store.ts test/helpers/tmp.ts test/core/store.test.ts
git commit -m "feat(core): data schemas and the .rushes store"
```

---

### Task 2: Ids, manifest paths, versions and variants

**Files:**
- Create: `src/core/ids.ts`
- Create: `src/core/paths.ts`
- Create: `src/core/project.ts`
- Create: `src/core/media.ts`
- Create: `test/core/project.test.ts`

**Interfaces:**
- Consumes: the types `Project`, `Video`, `Version`, `Lane`, `Variant`, `Cue` and `LaneStage` from `schema.ts`, and `InvalidError` and `NotFoundError` from `errors.ts`.
- Produces:
- `ids.ts`: `newId(prefix) -> "prefix_xxxxxx"`, `slugify(text)`, `uniqueId(base, taken)`.
- `paths.ts`: `toManifestPath(root, file)` and `fromManifestPath(root, file)`.
- `project.ts`: `addVersion(p, {video, file, note?, duration?, fps?}, now?) -> {video, version}`, `latestVersion(video)`, `addVariant(p, {stage, lane?, name, file, meta?, cues?}) -> {lane, variant}`, `findVideo(p, id)`.
- `media.ts`: `hasFfprobe()`, `parseRate(rate)` and `probe(file) -> {duration, fps}`. When ffprobe is missing, `probe` returns nulls rather than throwing.

- [ ] **Step 1: Write the failing test**

`test/core/project.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { addVariant, addVersion, latestVersion } from "../../src/core/project.js";
import { fromManifestPath, toManifestPath } from "../../src/core/paths.js";
import { slugify, uniqueId } from "../../src/core/ids.js";
import { parseRate } from "../../src/core/media.js";
import type { Project } from "../../src/core/schema.js";

const empty = (): Project => ({ schema: 1, rev: 0, name: "demo", fps: 30, videos: [], lanes: [] });

describe("ids", () => {
  it("slugifies names, keeping digits and dropping accents", () => {
    expect(slugify("Hero 60s!")).toBe("hero-60s");
    expect(slugify("Café Señor")).toBe("cafe-senor");
    expect(slugify("!!!")).toBe("item");
  });
  it("uniqueId appends -2, -3", () => {
    expect(uniqueId("a", ["a", "a-2"])).toBe("a-3");
    expect(uniqueId("b", ["a"])).toBe("b");
  });
});

describe("manifest paths", () => {
  const root = "/Users/red/My Project";
  it("stores files inside the project as relative, forward-slash paths", () => {
    expect(toManifestPath(root, "/Users/red/My Project/renders/hero v3.mp4")).toBe("renders/hero v3.mp4");
    expect(toManifestPath(root, "renders/hero.mp4")).toBe("renders/hero.mp4");
  });
  it("keeps files outside the project absolute", () => {
    expect(toManifestPath(root, "/Volumes/Extreme SSD/out.mov")).toBe("/Volumes/Extreme SSD/out.mov");
    expect(toManifestPath(root, "../elsewhere/a.mp4")).toBe("/Users/red/elsewhere/a.mp4");
  });
  it("round-trips back to an absolute path", () => {
    expect(fromManifestPath(root, "renders/hero v3.mp4")).toBe(join(root, "renders", "hero v3.mp4"));
    expect(fromManifestPath(root, "/Volumes/x.mov")).toBe("/Volumes/x.mov");
  });
});

describe("addVersion", () => {
  it("creates the video on first use and numbers versions v1, v2", () => {
    const p = empty();
    const a = addVersion(p, { video: "Hero 60s", file: "renders/v1.mp4" }, new Date("2026-10-02T10:00:00Z"));
    expect(a.video).toMatchObject({ id: "hero-60s", name: "Hero 60s" });
    expect(a.version).toMatchObject({ id: "v1", file: "renders/v1.mp4", addedAt: "2026-10-02T10:00:00.000Z", note: "" });
    const b = addVersion(p, { video: "hero-60s", file: "renders/v2.mp4", note: "logo hold" });
    expect(b.version.id).toBe("v2");
    expect(p.videos).toHaveLength(1);
    expect(latestVersion(p.videos[0])?.note).toBe("logo hold");
  });
  it("keeps counting from the highest version even if one was removed", () => {
    const p = empty();
    addVersion(p, { video: "a", file: "1.mp4" });
    addVersion(p, { video: "a", file: "2.mp4" });
    p.videos[0].versions.shift();
    expect(addVersion(p, { video: "a", file: "3.mp4" }).version.id).toBe("v3");
  });
});

describe("addVariant", () => {
  it("creates a lane named after the stage and gives variants unique ids", () => {
    const p = empty();
    const a = addVariant(p, { stage: "music", name: "Deep house", file: "a.wav", meta: { bpm: 120 } });
    expect(a.lane).toMatchObject({ id: "music", stage: "music", name: "Music" });
    expect(a.variant).toMatchObject({ id: "deep-house", meta: { bpm: 120 }, cues: [] });
    const b = addVariant(p, { stage: "music", name: "Deep house", file: "b.wav" });
    expect(b.variant.id).toBe("deep-house-2");
    expect(p.lanes).toHaveLength(1);
  });
  it("stores cues with ids", () => {
    const p = empty();
    const { variant } = addVariant(p, { stage: "sfx", name: "Pass A", file: "s.wav", cues: [{ name: "Swipe", t: 31.05 }, { name: "Swipe", t: 40 }] });
    expect(variant.cues.map((c) => c.id)).toEqual(["swipe", "swipe-2"]);
  });
  it("refuses to put a music bed in an sfx lane", () => {
    const p = empty();
    addVariant(p, { stage: "sfx", lane: "fx", name: "A", file: "a.wav" });
    expect(() => addVariant(p, { stage: "music", lane: "fx", name: "B", file: "b.wav" })).toThrow(/belongs to sfx/);
  });
});

describe("parseRate", () => {
  it("reads ffprobe rates", () => {
    expect(parseRate("30000/1001")).toBe(29.97);
    expect(parseRate("60/1")).toBe(60);
    expect(parseRate("0/0")).toBeNull();
    expect(parseRate(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/core/project.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/core/project.js"`.

- [ ] **Step 3: Implement**

`src/core/ids.ts`

```ts
import { randomBytes } from "node:crypto";

/** Short random id such as "n_k3f9x2". */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex").slice(0, 6)}`;
}

/** "Hero 60s!" -> "hero-60s". Falls back to "item" when nothing is left. */
export function slugify(text: string): string {
  const s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "item";
}

/** First id from base, base-2, base-3 ... not in `taken`. */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) if (!set.has(`${base}-${i}`)) return `${base}-${i}`;
}
```

`src/core/paths.ts`

```ts
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Store a media path the way the manifest wants it: relative to the project
 * root with forward slashes when the file is inside the project, absolute
 * when it lives elsewhere (renders often do).
 */
export function toManifestPath(root: string, file: string): string {
  const abs = isAbsolute(file) ? file : resolve(root, file);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return abs;
  return rel.split(sep).join("/");
}

/** Turn a manifest path back into an absolute path on disk. */
export function fromManifestPath(root: string, file: string): string {
  return isAbsolute(file) ? file : resolve(root, ...file.split("/"));
}
```

`src/core/project.ts`

```ts
import type { Cue, Lane, LaneStage, Project, Variant, Version, Video } from "./schema.js";
import { slugify, uniqueId } from "./ids.js";
import { InvalidError, NotFoundError } from "./errors.js";

export interface AddVersionInput {
  /** Video id or display name. A new video is created when no id matches. */
  video: string;
  /** Manifest path (already passed through toManifestPath). */
  file: string;
  note?: string;
  duration?: number | null;
  fps?: number | null;
}

export function addVersion(p: Project, input: AddVersionInput, now = new Date()): { video: Video; version: Version } {
  const vid = slugify(input.video);
  let video = p.videos.find((v) => v.id === input.video || v.id === vid);
  if (!video) {
    video = { id: uniqueId(vid, p.videos.map((v) => v.id)), name: input.video, versions: [] };
    p.videos.push(video);
  }
  const n = video.versions.reduce((max, v) => Math.max(max, Number(v.id.replace(/^v/, "")) || 0), 0) + 1;
  const version: Version = {
    id: `v${n}`,
    file: input.file,
    duration: input.duration ?? null,
    fps: input.fps ?? null,
    addedAt: now.toISOString(),
    note: input.note ?? "",
  };
  video.versions.push(version);
  return { video, version };
}

export function latestVersion(video: Video): Version | undefined {
  return video.versions[video.versions.length - 1];
}

export interface AddVariantInput {
  stage: LaneStage;
  /** Lane id. Defaults to the stage name, e.g. "music". */
  lane?: string;
  name: string;
  file: string;
  meta?: Record<string, string | number>;
  cues?: { name: string; t: number }[];
}

const LANE_NAMES: Record<LaneStage, string> = { voice: "Voiceover", music: "Music", sfx: "Sound effects" };

export function addVariant(p: Project, input: AddVariantInput): { lane: Lane; variant: Variant } {
  const laneId = slugify(input.lane ?? input.stage);
  let lane = p.lanes.find((l) => l.id === laneId);
  if (lane && lane.stage !== input.stage) throw new InvalidError(`Lane "${laneId}" belongs to ${lane.stage}, not ${input.stage}`);
  if (!lane) {
    lane = { id: laneId, stage: input.stage, name: input.lane ?? LANE_NAMES[input.stage], variants: [] };
    p.lanes.push(lane);
  }
  const cues: Cue[] = [];
  for (const c of input.cues ?? []) {
    cues.push({ id: uniqueId(slugify(c.name), cues.map((x) => x.id)), name: c.name, t: c.t });
  }
  const variant: Variant = {
    id: uniqueId(slugify(input.name), lane.variants.map((v) => v.id)),
    name: input.name,
    file: input.file,
    meta: input.meta ?? {},
    cues,
  };
  lane.variants.push(variant);
  return { lane, variant };
}

export function findVideo(p: Project, id: string): Video {
  const v = p.videos.find((x) => x.id === id);
  if (!v) throw new NotFoundError("video", id);
  return v;
}
```

`src/core/media.ts`

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Probe {
  duration: number | null;
  fps: number | null;
}

let ffprobeChecked: Promise<boolean> | null = null;

/** True when ffprobe is on PATH. Checked once per process. */
export function hasFfprobe(): Promise<boolean> {
  ffprobeChecked ??= run("ffprobe", ["-version"]).then(
    () => true,
    () => false,
  );
  return ffprobeChecked;
}

/** "30000/1001" -> 29.97. Returns null for "0/0" or junk. */
export function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [a, b] = rate.split("/").map(Number);
  const v = b ? a / b : a;
  return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) / 1000 : null;
}

/** Read duration and frame rate with ffprobe. Returns nulls when ffprobe is missing or fails. */
export async function probe(file: string): Promise<Probe> {
  if (!(await hasFfprobe())) return { duration: null, fps: null };
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,avg_frame_rate,r_frame_rate",
      "-of", "json",
      file,
    ]);
    const j = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: { codec_type?: string; avg_frame_rate?: string; r_frame_rate?: string }[];
    };
    const video = j.streams?.find((s) => s.codec_type === "video");
    const duration = j.format?.duration ? Number(j.format.duration) : null;
    return {
      duration: duration !== null && Number.isFinite(duration) ? duration : null,
      fps: parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate),
    };
  } catch {
    return { duration: null, fps: null };
  }
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/core/project.test.ts && npx tsc --noEmit`
Expected: all project tests pass, and tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/core/ids.ts src/core/paths.ts src/core/project.ts src/core/media.ts test/core/project.test.ts
git commit -m "feat(core): versions, variants and manifest paths"
```

---

### Task 3: Script sections, fit check and takes

**Files:**
- Create: `src/core/script.ts`
- Create: `test/core/script.test.ts`

**Interfaces:**
- Consumes: the types `Script`, `Section` and `Take` from `schema.ts`, `InvalidError` and `NotFoundError`, and `uniqueId`.
- Produces: `fit(text, slotSeconds, wps) -> {words, seconds, ratio, state: "ok"|"tight"|"over"}`, `isChanged(section)`, `isTakeStale(take, section)`, `setSections(script, SectionInput[])`, `findSection`, `editSection(script, id, {proposed?, direction?, status?})`, `addTake(script, sectionId, {file, duration?}) -> Take` (the take records `forText`).

- [ ] **Step 1: Write the failing test**

`test/core/script.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { addTake, editSection, fit, isChanged, isTakeStale, setSections } from "../../src/core/script.js";
import type { Script } from "../../src/core/schema.js";

const empty = (): Script => ({ schema: 1, rev: 0, wordsPerSecond: 2.6, sections: [] });

describe("fit", () => {
  it("counts words and compares reading time to the slot", () => {
    expect(fit("Your work lives on one laptop.", 13, 2.6)).toMatchObject({ words: 6, state: "ok" });
    const tight = fit("one two three four five six seven eight nine ten", 4.5, 2.6);
    expect(tight.state).toBe("tight");
    expect(fit("a b c d e f g h i j k l m n o p q r s t u v w", 8, 2.6).state).toBe("over");
  });
  it("treats an empty line as zero words that fit", () => {
    expect(fit("   ", 5, 2.6)).toMatchObject({ words: 0, seconds: 0, state: "ok" });
  });
});

describe("setSections", () => {
  it("sorts by start, numbers new sections s1, s2 and rejects overlaps", () => {
    const s = empty();
    setSections(s, [
      { start: 13, end: 30, current: "B" },
      { start: 0, end: 13, current: "A" },
    ]);
    expect(s.sections.map((x) => [x.id, x.current])).toEqual([["s1", "A"], ["s2", "B"]]);
    expect(() => setSections(s, [{ start: 0, end: 10, current: "A" }, { start: 9, end: 20, current: "B" }])).toThrow(/overlap/);
    expect(() => setSections(s, [{ start: 5, end: 5, current: "A" }])).toThrow(/end after/);
  });

  it("keeps the user's proposal, direction and takes when the agent re-sends a section", () => {
    const s = empty();
    setSections(s, [{ start: 0, end: 10, current: "Old line." }]);
    editSection(s, "s1", { proposed: "New line.", direction: "Lighter", status: "flagged" });
    addTake(s, "s1", { file: "t1.wav" });
    setSections(s, [{ id: "s1", start: 0, end: 10, current: "Old line." }]);
    expect(s.sections[0]).toMatchObject({ proposed: "New line.", direction: "Lighter", status: "flagged" });
    expect(s.sections[0].takes).toHaveLength(1);
  });

  it("clears the proposal once the agent adopts it as the current line", () => {
    const s = empty();
    setSections(s, [{ start: 0, end: 10, current: "Old line." }]);
    editSection(s, "s1", { proposed: "New line.", status: "flagged" });
    setSections(s, [{ id: "s1", start: 0, end: 10, current: "New line." }]);
    expect(s.sections[0]).toMatchObject({ current: "New line.", proposed: null, status: "draft" });
    expect(isChanged(s.sections[0])).toBe(false);
  });
});

describe("takes", () => {
  it("marks a take stale when the line changes after it was read", () => {
    const s = empty();
    setSections(s, [{ start: 0, end: 10, current: "Line one." }]);
    const take = addTake(s, "s1", { file: "a.wav", duration: 3.2 });
    expect(take).toMatchObject({ id: "t1", forText: "Line one.", duration: 3.2 });
    expect(isTakeStale(take, s.sections[0])).toBe(false);
    setSections(s, [{ id: "s1", start: 0, end: 10, current: "Line one, rewritten." }]);
    expect(isTakeStale(s.sections[0].takes[0], s.sections[0])).toBe(true);
  });
  it("throws for an unknown section", () => {
    expect(() => addTake(empty(), "nope", { file: "a.wav" })).toThrow(/section "nope" not found/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/core/script.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/core/script.js"`.

- [ ] **Step 3: Implement**

`src/core/script.ts`

```ts
import type { Script, Section, Take } from "./schema.js";
import { InvalidError, NotFoundError } from "./errors.js";
import { uniqueId } from "./ids.js";

export type FitState = "ok" | "tight" | "over";

/** Does this line fit its slot at reading speed? "tight" means over 80% of the slot. */
export function fit(text: string, slotSeconds: number, wordsPerSecond: number): { words: number; seconds: number; ratio: number; state: FitState } {
  const words = (text.trim().match(/\S+/g) ?? []).length;
  const seconds = words / wordsPerSecond;
  const ratio = slotSeconds > 0 ? seconds / slotSeconds : Infinity;
  const state: FitState = ratio > 1 ? "over" : ratio > 0.8 ? "tight" : "ok";
  return { words, seconds, ratio, state };
}

/** A row counts as changed when the user's version differs from the agent's line. */
export function isChanged(s: Section): boolean {
  return s.proposed !== null && s.proposed.trim() !== s.current.trim();
}

/** A take is stale once the section's line no longer matches the text it was read from. */
export function isTakeStale(take: Take, s: Section): boolean {
  return take.forText.trim() !== s.current.trim();
}

export interface SectionInput {
  id?: string;
  start: number;
  end: number;
  current: string;
}

/**
 * Replace the script's sections. Sections that keep their id keep the user's
 * proposed text, direction, status and takes. If the agent changed `current`
 * to the user's proposal, the proposal is cleared because it has landed.
 */
export function setSections(script: Script, input: SectionInput[]): Section[] {
  const sorted = [...input].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    if (!(s.end > s.start)) throw new InvalidError(`Section at ${s.start}s must end after it starts`);
    if (i > 0 && s.start < sorted[i - 1].end) throw new InvalidError(`Sections overlap at ${s.start}s`);
  }
  const old = new Map(script.sections.map((s) => [s.id, s]));
  const ids: string[] = [];
  const next: Section[] = sorted.map((s, i) => {
    const id = s.id ?? uniqueId(`s${i + 1}`, [...ids, ...input.flatMap((x) => (x.id ? [x.id] : []))]);
    ids.push(id);
    const prev = old.get(id);
    const landed = prev?.proposed != null && prev.proposed.trim() === s.current.trim();
    return {
      id,
      start: s.start,
      end: s.end,
      current: s.current,
      proposed: landed ? null : prev?.proposed ?? null,
      direction: prev?.direction ?? "",
      status: landed ? "draft" : prev?.status ?? "draft",
      takes: prev?.takes ?? [],
    };
  });
  script.sections = next;
  return next;
}

export function findSection(script: Script, id: string): Section {
  const s = script.sections.find((x) => x.id === id);
  if (!s) throw new NotFoundError("section", id);
  return s;
}

export interface SectionEdit {
  proposed?: string | null;
  direction?: string;
  status?: Section["status"];
}

export function editSection(script: Script, id: string, edit: SectionEdit): Section {
  const s = findSection(script, id);
  if (edit.proposed !== undefined) s.proposed = edit.proposed;
  if (edit.direction !== undefined) s.direction = edit.direction;
  if (edit.status !== undefined) s.status = edit.status;
  return s;
}

export function addTake(script: Script, sectionId: string, input: { file: string; duration?: number | null }): Take {
  const s = findSection(script, sectionId);
  const take: Take = {
    id: uniqueId(`t${s.takes.length + 1}`, s.takes.map((t) => t.id)),
    file: input.file,
    duration: input.duration ?? null,
    forText: s.current,
  };
  s.takes.push(take);
  return take;
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/core/script.test.ts && npx tsc --noEmit`
Expected: all script tests pass, and tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/core/script.ts test/core/script.test.ts
git commit -m "feat(core): script sections, fit check and stale takes"
```

---

### Task 4: Notes and field ownership

**Files:**
- Create: `src/core/notes.ts`
- Create: `test/core/notes.test.ts`

**Interfaces:**
- Consumes: `NoteSchema` and the types `Note`, `NotesFile` and `Stage` from `schema.ts`, `InvalidError` and `NotFoundError`, and `newId`.
- Produces: `addNote(file, NewNote, now?) -> Note`, `applyReply(file, Reply) -> Note` (agent fields plus status only), `applyUserEdit(file, UserEdit) -> Note` (user fields plus status, re-validated), `filterNotes(notes, {stage?, status?, batch?, version?})`, and the types `NewNote`, `Reply`, `UserEdit` and `NoteFilter`.

- [ ] **Step 1: Write the failing test**

`test/core/notes.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { addNote, applyReply, applyUserEdit, filterNotes } from "../../src/core/notes.js";
import type { NotesFile } from "../../src/core/schema.js";

const empty = (): NotesFile => ({ schema: 1, rev: 0, notes: [] });

describe("addNote", () => {
  it("adds a point note with defaults", () => {
    const f = empty();
    const n = addNote(f, { stage: "picture", video: "hero", version: "v3", scope: "point", t: 12.4, frame: 744, text: " Logo lands early. " }, new Date("2026-10-02T12:00:00Z"));
    expect(n).toMatchObject({ stage: "picture", scope: "point", t: 12.4, text: "Logo lands early.", status: "todo", reply: "", batch: null, by: "user", createdAt: "2026-10-02T12:00:00.000Z" });
    expect(n.id).toMatch(/^n_[0-9a-f]{6}$/);
    expect(f.notes).toHaveLength(1);
  });

  it("validates scope against times", () => {
    const f = empty();
    expect(() => addNote(f, { stage: "picture", scope: "point", text: "x" })).toThrow(/invalid/i);
    expect(() => addNote(f, { stage: "picture", scope: "range", t: 10, tOut: 10, text: "x" })).toThrow(/invalid/i);
    expect(() => addNote(f, { stage: "music", scope: "whole", t: 3, text: "x" })).toThrow(/invalid/i);
    expect(() => addNote(f, { stage: "picture", scope: "point", t: -1, text: "x" })).toThrow(/invalid/i);
    expect(() => addNote(f, { stage: "picture", scope: "point", t: 1, text: "   " })).toThrow(/invalid/i);
    expect(addNote(f, { stage: "music", scope: "whole", on: "a", text: "Make it 110 BPM" }).t).toBeNull();
    expect(f.notes).toHaveLength(1);
  });
});

describe("field ownership", () => {
  it("a reply changes only reply, status, fixT and fixVersion", () => {
    const f = empty();
    const n = addNote(f, { stage: "picture", scope: "point", t: 4.1, text: "Title too short" });
    applyReply(f, { id: n.id, reply: "Held 1.2 s longer.", status: "done", fixT: 4.6, fixVersion: "v4" });
    expect(f.notes[0]).toMatchObject({ text: "Title too short", t: 4.1, reply: "Held 1.2 s longer.", status: "done", fixT: 4.6, fixVersion: "v4" });
  });

  it("a user edit changes only user fields and is re-validated", () => {
    const f = empty();
    const n = addNote(f, { stage: "picture", scope: "point", t: 4.1, text: "First" });
    applyReply(f, { id: n.id, reply: "On it" });
    applyUserEdit(f, { id: n.id, text: "Second", scope: "range", tOut: 6 });
    expect(f.notes[0]).toMatchObject({ text: "Second", scope: "range", t: 4.1, tOut: 6, reply: "On it" });
    expect(() => applyUserEdit(f, { id: n.id, tOut: 2 })).toThrow(/invalid/i);
    expect(f.notes[0].tOut).toBe(6);
  });

  it("unknown ids throw not found", () => {
    expect(() => applyReply(empty(), { id: "n_nope", reply: "x" })).toThrow(/not found/);
  });
});

describe("filterNotes", () => {
  it("filters by stage, status, batch and version", () => {
    const f = empty();
    addNote(f, { stage: "picture", version: "v3", scope: "point", t: 1, text: "a" });
    const b = addNote(f, { stage: "picture", version: "v2", scope: "point", t: 2, text: "b" });
    addNote(f, { stage: "music", scope: "whole", text: "c" });
    applyReply(f, { id: b.id, status: "done" });
    expect(filterNotes(f.notes, { stage: "picture" })).toHaveLength(2);
    expect(filterNotes(f.notes, { stage: "picture", status: "todo" }).map((n) => n.text)).toEqual(["a"]);
    expect(filterNotes(f.notes, { version: "v2" }).map((n) => n.text)).toEqual(["b"]);
    expect(filterNotes(f.notes)).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/core/notes.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/core/notes.js"`.

- [ ] **Step 3: Implement**

`src/core/notes.ts`

```ts
import { NoteSchema, type Note, type NotesFile, type Stage } from "./schema.js";
import { InvalidError, NotFoundError } from "./errors.js";
import { newId } from "./ids.js";

export interface NewNote {
  stage: Stage;
  video?: string | null;
  version?: string | null;
  on?: string | null;
  scope: Note["scope"];
  t?: number | null;
  tOut?: number | null;
  frame?: number | null;
  text: string;
  box?: Note["box"];
  grab?: string | null;
  by?: Note["by"];
}

export function addNote(file: NotesFile, input: NewNote, now = new Date()): Note {
  const parsed = NoteSchema.safeParse({ ...input, id: newId("n"), createdAt: now.toISOString() });
  if (!parsed.success) throw new InvalidError("Note is invalid", parsed.error.issues);
  file.notes.push(parsed.data);
  return parsed.data;
}

function find(file: NotesFile, id: string): Note {
  const n = file.notes.find((x) => x.id === id);
  if (!n) throw new NotFoundError("note", id);
  return n;
}

/** Fields the agent owns. Status is shared. */
export interface Reply {
  id: string;
  reply?: string;
  status?: Note["status"];
  fixT?: number | null;
  fixVersion?: string | null;
}

export function applyReply(file: NotesFile, r: Reply): Note {
  const n = find(file, r.id);
  if (r.reply !== undefined) n.reply = r.reply;
  if (r.status !== undefined) n.status = r.status;
  if (r.fixT !== undefined) n.fixT = r.fixT;
  if (r.fixVersion !== undefined) n.fixVersion = r.fixVersion;
  return n;
}

/** Fields the user owns. Status is shared. */
export interface UserEdit {
  id: string;
  text?: string;
  box?: Note["box"];
  grab?: string | null;
  scope?: Note["scope"];
  t?: number | null;
  tOut?: number | null;
  status?: Note["status"];
}

export function applyUserEdit(file: NotesFile, e: UserEdit): Note {
  const n = find(file, e.id);
  const next = { ...n };
  for (const k of ["text", "box", "grab", "scope", "t", "tOut", "status"] as const) {
    if (e[k] !== undefined) (next as Record<string, unknown>)[k] = e[k];
  }
  const parsed = NoteSchema.safeParse(next);
  if (!parsed.success) throw new InvalidError("Note edit is invalid", parsed.error.issues);
  Object.assign(n, parsed.data);
  return n;
}

export interface NoteFilter {
  stage?: Stage;
  status?: Note["status"];
  batch?: string;
  version?: string;
}

export function filterNotes(notes: Note[], f: NoteFilter = {}): Note[] {
  return notes.filter(
    (n) =>
      (f.stage === undefined || n.stage === f.stage) &&
      (f.status === undefined || n.status === f.status) &&
      (f.batch === undefined || n.batch === f.batch) &&
      (f.version === undefined || n.version === f.version),
  );
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/core/notes.test.ts && npx tsc --noEmit`
Expected: all notes tests pass, and tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/core/notes.ts test/core/notes.test.ts
git commit -m "feat(core): notes with field ownership"
```

---

### Task 5: Tab unlock rules and batches

**Files:**
- Create: `src/core/tabs.ts`
- Create: `src/core/batches.ts`
- Create: `test/core/tabs-batches.test.ts`

**Interfaces:**
- Consumes: the schema types, `isChanged` from `script.ts`, `EmptyBatchError`, `newId`, and (in tests) `addVersion`, `addVariant`, `setSections`, `editSection`, `addTake` and `addNote`.
- Produces: `tabStates(project, script, notes) -> {stage, unlocked, todo}[]` in stage order. `createBatch({project, script, notes, batches}, stage, now?) -> Batch` (it marks notes with the batch id and pushes into `batches`). `buildPrompt(project, stage, batchId, notes, sections)`. `latestBatch(file)`.

- [ ] **Step 1: Write the failing test**

`test/core/tabs-batches.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { tabStates } from "../../src/core/tabs.js";
import { createBatch, latestBatch } from "../../src/core/batches.js";
import { addVariant, addVersion } from "../../src/core/project.js";
import { addTake, editSection, setSections } from "../../src/core/script.js";
import { addNote } from "../../src/core/notes.js";
import type { BatchesFile, NotesFile, Project, Script } from "../../src/core/schema.js";

function ctx() {
  const project: Project = { schema: 1, rev: 0, name: "spring-launch", fps: 30, videos: [], lanes: [] };
  const script: Script = { schema: 1, rev: 0, wordsPerSecond: 2.6, sections: [] };
  const notes: NotesFile = { schema: 1, rev: 0, notes: [] };
  const batches: BatchesFile = { schema: 1, rev: 0, batches: [] };
  return { project, script, notes, batches };
}
const unlocked = (c: ReturnType<typeof ctx>) =>
  Object.fromEntries(tabStates(c.project, c.script, c.notes).map((t) => [t.stage, t.unlocked]));

describe("tabStates", () => {
  it("starts with every tab locked, in workflow order", () => {
    const c = ctx();
    const tabs = tabStates(c.project, c.script, c.notes);
    expect(tabs.map((t) => t.stage)).toEqual(["script", "picture", "voice", "music", "sfx", "mix"]);
    expect(tabs.every((t) => !t.unlocked)).toBe(true);
  });

  it("unlocks each tab as its element arrives, and mix only with picture plus audio", () => {
    const c = ctx();
    setSections(c.script, [{ start: 0, end: 10, current: "Line" }]);
    expect(unlocked(c)).toMatchObject({ script: true, picture: false, mix: false });
    addVariant(c.project, { stage: "music", name: "A", file: "a.wav" });
    expect(unlocked(c)).toMatchObject({ music: true, mix: false });
    addVersion(c.project, { video: "Hero", file: "v1.mp4" });
    expect(unlocked(c)).toMatchObject({ picture: true, mix: true, voice: false, sfx: false });
    addTake(c.script, "s1", { file: "t.wav" });
    expect(unlocked(c).voice).toBe(true);
  });

  it("does not unlock picture for a video with no versions, or music for an empty lane", () => {
    const c = ctx();
    c.project.videos.push({ id: "x", name: "X", versions: [] });
    c.project.lanes.push({ id: "music", stage: "music", name: "Music", variants: [] });
    expect(unlocked(c)).toMatchObject({ picture: false, music: false });
  });

  it("counts to-do notes per tab, and changed or flagged sections on script", () => {
    const c = ctx();
    setSections(c.script, [{ start: 0, end: 5, current: "A" }, { start: 5, end: 9, current: "B" }]);
    editSection(c.script, "s1", { proposed: "A2" });
    editSection(c.script, "s2", { status: "flagged" });
    addNote(c.notes, { stage: "picture", scope: "point", t: 1, text: "x" });
    addNote(c.notes, { stage: "picture", scope: "point", t: 2, text: "y" });
    const todo = Object.fromEntries(tabStates(c.project, c.script, c.notes).map((t) => [t.stage, t.todo]));
    expect(todo).toMatchObject({ script: 2, picture: 2, music: 0 });
  });
});

describe("createBatch", () => {
  it("batches this tab's unsent to-do notes and builds a prompt", () => {
    const c = ctx();
    const a = addNote(c.notes, { stage: "picture", scope: "point", t: 1, text: "a" });
    addNote(c.notes, { stage: "music", scope: "whole", text: "m" });
    const b = createBatch(c, "picture", new Date("2026-10-02T13:00:00Z"));
    expect(b).toMatchObject({ id: "b_1", stage: "picture", noteIds: [a.id], sectionIds: [], sentAt: "2026-10-02T13:00:00.000Z" });
    expect(b.prompt).toContain("picture batch b_1 on spring-launch: 1 note.");
    expect(b.prompt).toContain("rushes_reply");
    expect(c.notes.notes[0].batch).toBe("b_1");
    expect(c.notes.notes[1].batch).toBeNull();
    expect(latestBatch(c.batches)?.id).toBe("b_1");
  });

  it("does not resend notes that are already in a batch", () => {
    const c = ctx();
    addNote(c.notes, { stage: "picture", scope: "point", t: 1, text: "a" });
    createBatch(c, "picture");
    expect(() => createBatch(c, "picture")).toThrow(/Nothing open/);
    const n2 = addNote(c.notes, { stage: "picture", scope: "point", t: 2, text: "b" });
    expect(createBatch(c, "picture")).toMatchObject({ id: "b_2", noteIds: [n2.id] });
  });

  it("puts changed and flagged sections in a script batch", () => {
    const c = ctx();
    setSections(c.script, [{ start: 0, end: 5, current: "A" }, { start: 5, end: 9, current: "B" }, { start: 9, end: 12, current: "C" }]);
    editSection(c.script, "s1", { proposed: "A2" });
    editSection(c.script, "s3", { status: "flagged" });
    const b = createBatch(c, "script");
    expect(b.sectionIds).toEqual(["s1", "s3"]);
    expect(b.prompt).toContain("2 script sections");
    expect(b.prompt).toContain("rushes_set_script");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/core/tabs-batches.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/core/tabs.js"`.

- [ ] **Step 3: Implement**

`src/core/tabs.ts`

```ts
import { STAGES, type NotesFile, type Project, type Script, type Stage } from "./schema.js";
import { isChanged } from "./script.js";

export interface TabState {
  stage: Stage;
  unlocked: boolean;
  /** Open items: to-do notes, plus changed or flagged sections on the script tab. */
  todo: number;
}

function laneHasVariants(p: Project, stage: "voice" | "music" | "sfx"): boolean {
  return p.lanes.some((l) => l.stage === stage && l.variants.length > 0);
}

export function tabStates(p: Project, s: Script, n: NotesFile): TabState[] {
  const picture = p.videos.some((v) => v.versions.length > 0);
  const voice = s.sections.some((x) => x.takes.length > 0) || laneHasVariants(p, "voice");
  const music = laneHasVariants(p, "music");
  const sfx = laneHasVariants(p, "sfx");
  const unlocked: Record<Stage, boolean> = {
    script: s.sections.length > 0,
    picture,
    voice,
    music,
    sfx,
    mix: picture && (voice || music || sfx),
  };
  return STAGES.map((stage) => {
    const notes = n.notes.filter((x) => x.stage === stage && x.status === "todo").length;
    const rows = stage === "script" ? s.sections.filter((x) => isChanged(x) || x.status === "flagged").length : 0;
    return { stage, unlocked: unlocked[stage], todo: notes + rows };
  });
}
```

`src/core/batches.ts`

```ts
import type { Batch, BatchesFile, NotesFile, Project, Script, Stage } from "./schema.js";
import { EmptyBatchError } from "./errors.js";
import { newId } from "./ids.js";
import { isChanged } from "./script.js";

const STAGE_NAMES: Record<Stage, string> = {
  script: "script",
  picture: "picture",
  voice: "voiceover",
  music: "music",
  sfx: "sound effects",
  mix: "mix",
};

/**
 * Gather this tab's open, unsent items into a batch: to-do notes with no
 * batch yet, and (on the script tab) changed or flagged sections.
 */
export function createBatch(
  ctx: { project: Project; script: Script; notes: NotesFile; batches: BatchesFile },
  stage: Stage,
  now = new Date(),
): Batch {
  const notes = ctx.notes.notes.filter((n) => n.stage === stage && n.status === "todo" && n.batch === null);
  const sections = stage === "script" ? ctx.script.sections.filter((s) => isChanged(s) || s.status === "flagged") : [];
  if (notes.length === 0 && sections.length === 0) throw new EmptyBatchError(stage);

  const id = `b_${ctx.batches.batches.length + 1}`;
  for (const n of notes) n.batch = id;
  const batch: Batch = {
    id,
    stage,
    noteIds: notes.map((n) => n.id),
    sectionIds: sections.map((s) => s.id),
    sentAt: now.toISOString(),
    prompt: buildPrompt(ctx.project.name, stage, id, notes.length, sections.length),
  };
  ctx.batches.batches.push(batch);
  return batch;
}

export function buildPrompt(project: string, stage: Stage, batchId: string, notes: number, sections: number): string {
  const parts: string[] = [];
  if (notes) parts.push(`${notes} note${notes === 1 ? "" : "s"}`);
  if (sections) parts.push(`${sections} script section${sections === 1 ? "" : "s"}`);
  const steps =
    stage === "script"
      ? "Use rushes_get_batch, take each section's proposed line, then rushes_set_script."
      : "Use rushes_get_batch, fix each note, then rushes_reply with a fixT for each and rushes_add_version for the new cut.";
  return `Work through ${STAGE_NAMES[stage]} batch ${batchId} on ${project}: ${parts.join(" and ")}.\n${steps}`;
}

export function latestBatch(file: BatchesFile): Batch | undefined {
  return file.batches[file.batches.length - 1];
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/core/tabs-batches.test.ts && npx tsc --noEmit`
Expected: all tabs and batches tests pass, and tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/core/tabs.ts src/core/batches.ts test/core/tabs-batches.test.ts
git commit -m "feat(core): tab unlock rules and send-to-agent batches"
```

---

### Task 6: HTTP API

**Files:**
- Create: `src/server/app.ts`
- Create: `test/server/app.test.ts`

**Interfaces:**
- Consumes: `Store` and `ChangeEvent`, every core function above, `probe`, and `toManifestPath` / `fromManifestPath`.
- Produces:
`createApp(store) -> Hono` and `VERSION = "0.1.0"`. The routes:
- `GET /api/health`, `GET /api/state`, `GET /api/tabs`
- `GET|POST /api/notes`, `PATCH /api/notes/:id`, `POST /api/replies {replies[]}`
- `POST /api/versions {video, file, note?}`, `POST /api/variants {stage, name, file, lane?, meta?, cues?}`
- `PUT /api/script {sections[], wordsPerSecond?}`, `PATCH /api/script/:id`, `POST /api/script/:id/takes {file}`
- `GET|PUT /api/picks`
- `POST /api/batches {stage}`, `GET /api/batches/:id` (`latest` allowed)
- `GET /api/events` (SSE: `hello`, `change`, `ping`)

Errors come back as JSON `{error: code, message, ...detail}` with the error's status.

- [ ] **Step 1: Write the failing test**

`test/server/app.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { tmpProject } from "../helpers/tmp.js";
import { createApp } from "../../src/server/app.js";

async function setup() {
  const { root, store } = await tmpProject("spring-launch");
  const app = createApp(store);
  const call = async (method: string, path: string, json?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: json === undefined ? {} : { "content-type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { root, store, call };
}

describe("API", () => {
  it("health names the app and the project root", async () => {
    const { call, root } = await setup();
    expect((await call("GET", "/api/health")).json).toMatchObject({ ok: true, app: "rushes", root });
  });

  it("state starts with every tab locked", async () => {
    const { call } = await setup();
    const { json } = await call("GET", "/api/state");
    expect(json.project.name).toBe("spring-launch");
    expect(json.tabs.every((t: any) => !t.unlocked)).toBe(true);
  });

  it("adding a version unlocks Picture and stores a relative path", async () => {
    const { call, root } = await setup();
    const r = await call("POST", "/api/versions", { video: "Hero 60s", file: `${root}/renders/hero v1.mp4`, note: "first cut" });
    expect(r.status).toBe(201);
    expect(r.json.version).toMatchObject({ id: "v1", file: "renders/hero v1.mp4", note: "first cut" });
    const tabs = (await call("GET", "/api/tabs")).json.tabs;
    expect(tabs.find((t: any) => t.stage === "picture").unlocked).toBe(true);
  });

  it("notes: create, list with filters, edit, reply", async () => {
    const { call } = await setup();
    const a = (await call("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 12.4, frame: 744, text: "Logo lands early" })).json.note;
    await call("POST", "/api/notes", { stage: "music", scope: "whole", on: "deep-house", text: "Make it 110 BPM" });
    expect((await call("GET", "/api/notes?stage=picture")).json.notes).toHaveLength(1);
    const edited = (await call("PATCH", `/api/notes/${a.id}`, { text: "Logo lands a beat early" })).json.note;
    expect(edited.text).toBe("Logo lands a beat early");
    const replied = (await call("POST", "/api/replies", { replies: [{ id: a.id, reply: "Held 0.5 s", status: "done", fixT: 12.9, fixVersion: "v2" }] })).json.notes[0];
    expect(replied).toMatchObject({ status: "done", reply: "Held 0.5 s", fixT: 12.9, text: "Logo lands a beat early" });
    expect((await call("GET", "/api/notes?status=todo")).json.notes).toHaveLength(1);
  });

  it("rejects bad input with 400 and an explanation, and unknown ids with 404", async () => {
    const { call } = await setup();
    const bad = await call("POST", "/api/notes", { stage: "picture", scope: "range", t: 5, tOut: 2, text: "x" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("invalid");
    expect(JSON.stringify(bad.json.issues)).toContain("tOut");
    expect((await call("GET", "/api/notes?stage=nope")).status).toBe(400);
    expect((await call("PATCH", "/api/notes/n_missing", { text: "x" })).status).toBe(404);
    expect((await call("POST", "/api/replies", { replies: [] })).status).toBe(400);
  });

  it("returns 500 with the file name when a data file is corrupt, and leaves it alone", async () => {
    const { call, store } = await setup();
    await writeFile(store.path("notes"), "{ not json", "utf8");
    const r = await call("POST", "/api/notes", { stage: "picture", scope: "point", t: 1, text: "x" });
    expect(r.status).toBe(500);
    expect(r.json).toMatchObject({ error: "corrupt_file", file: "notes.json" });
  });

  it("script: set sections, edit a row, add a take", async () => {
    const { call } = await setup();
    const set = await call("PUT", "/api/script", { sections: [{ start: 0, end: 13, current: "Your work lives on one laptop." }] });
    expect(set.json.sections[0].id).toBe("s1");
    const edit = await call("PATCH", "/api/script/s1", { proposed: "Your work lives on one machine.", status: "flagged" });
    expect(edit.json.section).toMatchObject({ proposed: "Your work lives on one machine.", status: "flagged" });
    const take = await call("POST", "/api/script/s1/takes", { file: "audio/vo_s1.wav" });
    expect(take.status).toBe(201);
    expect(take.json.take).toMatchObject({ id: "t1", forText: "Your work lives on one laptop." });
    expect((await call("PUT", "/api/script", { sections: [{ start: 0, end: 5, current: "a" }, { start: 4, end: 8, current: "b" }] })).status).toBe(400);
  });

  it("variants and picks", async () => {
    const { call } = await setup();
    const v = await call("POST", "/api/variants", { stage: "music", name: "Deep house", file: "audio/a.wav", meta: { bpm: 120 } });
    expect(v.json.variant.id).toBe("deep-house");
    const picks = await call("PUT", "/api/picks", { lanes: { music: "deep-house" } });
    expect(picks.json.lanes).toEqual({ music: "deep-house" });
  });

  it("batches: send the tab's open notes once, then 409 when nothing is left", async () => {
    const { call } = await setup();
    const n = (await call("POST", "/api/notes", { stage: "picture", scope: "point", t: 1, text: "x" })).json.note;
    const b = await call("POST", "/api/batches", { stage: "picture" });
    expect(b.status).toBe(201);
    expect(b.json.batch).toMatchObject({ id: "b_1", noteIds: [n.id] });
    expect((await call("POST", "/api/batches", { stage: "picture" })).status).toBe(409);
    const latest = await call("GET", "/api/batches/latest");
    expect(latest.json.batch.id).toBe("b_1");
    expect(latest.json.notes[0].batch).toBe("b_1");
    expect((await call("GET", "/api/batches/b_9")).status).toBe(404);
  });

  it("two batch requests at once get different ids and split the notes", async () => {
    const { call } = await setup();
    await call("POST", "/api/notes", { stage: "picture", scope: "point", t: 1, text: "x" });
    await call("POST", "/api/notes", { stage: "music", scope: "whole", text: "y" });
    const [a, b] = await Promise.all([call("POST", "/api/batches", { stage: "picture" }), call("POST", "/api/batches", { stage: "music" })]);
    expect(new Set([a.json.batch.id, b.json.batch.id]).size).toBe(2);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/server/app.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/server/app.js"`.

- [ ] **Step 3: Implement**

`src/server/app.ts`

```ts
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Store, ChangeEvent } from "../core/store.js";
import { RushesError, InvalidError, NotFoundError } from "../core/errors.js";
import { addVariant, addVersion } from "../core/project.js";
import { addTake, editSection, setSections } from "../core/script.js";
import { addNote, applyReply, applyUserEdit, filterNotes } from "../core/notes.js";
import { createBatch, latestBatch } from "../core/batches.js";
import { tabStates } from "../core/tabs.js";
import { fromManifestPath, toManifestPath } from "../core/paths.js";
import { probe } from "../core/media.js";
import { LaneStageSchema, SectionStatusSchema, StageSchema, BoxSchema, type Batch } from "../core/schema.js";

export const VERSION = "0.1.0";

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new InvalidError("Request body must be JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new InvalidError("Request body is invalid", parsed.error.issues);
  return parsed.data;
}

const t = z.number().nonnegative();

const NewNoteBody = z.object({
  stage: StageSchema,
  video: z.string().nullish(),
  version: z.string().nullish(),
  on: z.string().nullish(),
  scope: z.enum(["point", "range", "whole"]),
  t: t.nullish(),
  tOut: t.nullish(),
  frame: z.number().int().nonnegative().nullish(),
  text: z.string(),
  box: BoxSchema.nullish(),
  grab: z.string().nullish(),
});

const UserEditBody = z.object({
  text: z.string().optional(),
  box: BoxSchema.nullable().optional(),
  grab: z.string().nullable().optional(),
  scope: z.enum(["point", "range", "whole"]).optional(),
  t: t.nullable().optional(),
  tOut: t.nullable().optional(),
  status: z.enum(["todo", "done"]).optional(),
});

const RepliesBody = z.object({
  replies: z
    .array(
      z.object({
        id: z.string(),
        reply: z.string().optional(),
        status: z.enum(["todo", "done"]).optional(),
        fixT: t.nullable().optional(),
        fixVersion: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

const VersionBody = z.object({ video: z.string().min(1), file: z.string().min(1), note: z.string().optional() });
const VariantBody = z.object({
  stage: LaneStageSchema,
  lane: z.string().optional(),
  name: z.string().min(1),
  file: z.string().min(1),
  meta: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  cues: z.array(z.object({ name: z.string().min(1), t })).optional(),
});
const ScriptBody = z.object({
  wordsPerSecond: z.number().positive().optional(),
  sections: z.array(z.object({ id: z.string().optional(), start: t, end: t, current: z.string() })),
});
const SectionEditBody = z.object({
  proposed: z.string().nullable().optional(),
  direction: z.string().optional(),
  status: SectionStatusSchema.optional(),
});
const TakeBody = z.object({ file: z.string().min(1) });
const PicksBody = z.object({ lanes: z.record(z.string(), z.string()).optional(), sections: z.record(z.string(), z.string()).optional() });
const BatchBody = z.object({ stage: StageSchema });

const NoteQuery = z.object({
  stage: StageSchema.optional(),
  status: z.enum(["todo", "done"]).optional(),
  batch: z.string().optional(),
  version: z.string().optional(),
});

export function createApp(store: Store): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof RushesError) return c.json({ error: err.code, message: err.message, ...err.detail }, err.status as 400);
    console.error(err);
    return c.json({ error: "internal", message: (err as Error).message }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true, app: "rushes", version: VERSION, root: store.root }));

  app.get("/api/state", async (c) => {
    const [project, script, notes, picks, batches] = await Promise.all([
      store.read("project"), store.read("script"), store.read("notes"), store.read("picks"), store.read("batches"),
    ]);
    return c.json({ project, script, notes, picks, batches, tabs: tabStates(project, script, notes) });
  });

  app.get("/api/tabs", async (c) => {
    const [project, script, notes] = await Promise.all([store.read("project"), store.read("script"), store.read("notes")]);
    return c.json({ tabs: tabStates(project, script, notes) });
  });

  // ---- notes ----
  app.get("/api/notes", async (c) => {
    const q = NoteQuery.safeParse(c.req.query());
    if (!q.success) throw new InvalidError("Query is invalid", q.error.issues);
    const { notes } = await store.read("notes");
    return c.json({ notes: filterNotes(notes, q.data) });
  });

  app.post("/api/notes", async (c) => {
    const b = await body(c, NewNoteBody);
    const { result } = await store.update("notes", (f) => addNote(f, { ...b, by: "user" }));
    return c.json({ note: result }, 201);
  });

  app.patch("/api/notes/:id", async (c) => {
    const b = await body(c, UserEditBody);
    const { result } = await store.update("notes", (f) => applyUserEdit(f, { id: c.req.param("id"), ...b }));
    return c.json({ note: result });
  });

  app.post("/api/replies", async (c) => {
    const b = await body(c, RepliesBody);
    const { result } = await store.update("notes", (f) => b.replies.map((r) => applyReply(f, r)));
    return c.json({ notes: result });
  });

  // ---- media ----
  app.post("/api/versions", async (c) => {
    const b = await body(c, VersionBody);
    const file = toManifestPath(store.root, b.file);
    const info = await probe(fromManifestPath(store.root, file));
    const { result } = await store.update("project", (p) => {
      const out = addVersion(p, { video: b.video, file, note: b.note, duration: info.duration, fps: info.fps });
      if (info.fps && p.videos.length === 1 && p.videos[0].versions.length === 1) p.fps = info.fps;
      return out;
    });
    return c.json(result, 201);
  });

  app.post("/api/variants", async (c) => {
    const b = await body(c, VariantBody);
    const { result } = await store.update("project", (p) => addVariant(p, { ...b, file: toManifestPath(store.root, b.file) }));
    return c.json(result, 201);
  });

  // ---- script ----
  app.put("/api/script", async (c) => {
    const b = await body(c, ScriptBody);
    const { result } = await store.update("script", (s) => {
      if (b.wordsPerSecond) s.wordsPerSecond = b.wordsPerSecond;
      return setSections(s, b.sections);
    });
    return c.json({ sections: result });
  });

  app.patch("/api/script/:id", async (c) => {
    const b = await body(c, SectionEditBody);
    const { result } = await store.update("script", (s) => editSection(s, c.req.param("id"), b));
    return c.json({ section: result });
  });

  app.post("/api/script/:id/takes", async (c) => {
    const b = await body(c, TakeBody);
    const file = toManifestPath(store.root, b.file);
    const info = await probe(fromManifestPath(store.root, file));
    const { result } = await store.update("script", (s) => addTake(s, c.req.param("id"), { file, duration: info.duration }));
    return c.json({ take: result }, 201);
  });

  // ---- picks ----
  app.get("/api/picks", async (c) => c.json(await store.read("picks")));

  app.put("/api/picks", async (c) => {
    const b = await body(c, PicksBody);
    const { data } = await store.update("picks", (p) => {
      Object.assign(p.lanes, b.lanes ?? {});
      Object.assign(p.sections, b.sections ?? {});
    });
    return c.json(data);
  });

  // ---- batches ----
  // A batch touches two files (notes and batches), so batch creation runs one at a time.
  let batchQueue: Promise<unknown> = Promise.resolve();
  app.post("/api/batches", async (c) => {
    const { stage } = await body(c, BatchBody);
    const run = batchQueue.catch(() => undefined).then(async (): Promise<Batch> => {
      const [project, script, batches] = await Promise.all([store.read("project"), store.read("script"), store.read("batches")]);
      const { result } = await store.update("notes", (notes) => createBatch({ project, script, notes, batches }, stage));
      await store.update("batches", (f) => { f.batches.push(result); });
      return result;
    });
    batchQueue = run;
    return c.json({ batch: await run }, 201);
  });

  app.get("/api/batches/:id", async (c) => {
    const [batches, notes, script] = await Promise.all([store.read("batches"), store.read("notes"), store.read("script")]);
    const id = c.req.param("id");
    const batch = id === "latest" ? latestBatch(batches) : batches.batches.find((b) => b.id === id);
    if (!batch) throw new NotFoundError("batch", id);
    return c.json({
      batch,
      notes: notes.notes.filter((n) => batch.noteIds.includes(n.id)),
      sections: script.sections.filter((s) => batch.sectionIds.includes(s.id)),
    });
  });

  // ---- live updates ----
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const send = (e: ChangeEvent) => void stream.writeSSE({ event: "change", data: JSON.stringify(e) });
      store.on("change", send);
      stream.onAbort(() => { store.off("change", send); });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ root: store.root }) });
      while (!stream.aborted) await stream.sleep(15000).then(() => stream.writeSSE({ event: "ping", data: "" }));
    }),
  );

  return app;
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/server/app.test.ts && npx tsc --noEmit`
Expected: all API tests pass, and tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/server/app.ts test/server/app.test.ts
git commit -m "feat(server): HTTP API over the store"
```

---

### Task 7: Server start-up, lockfile and live events

**Files:**
- Create: `src/server/lock.ts`
- Create: `src/server/start.ts`
- Create: `test/server/start.test.ts`

**Interfaces:**
- Consumes: `createApp` and `Store`.
- Produces: `lock.ts`: `Lock {port, pid, startedAt}`, `lockPath(root)`, `readLock(root)` (null if the pid is dead or the file is bad), `writeLock(root, port)`, `removeLock(root)` (only removes its own lock). `start.ts`: `DEFAULT_PORT = 4317`, `startServer(root, {port?, host?, name?}) -> Running {url, port, store, close()}`. Port 0 means the OS chooses.

- [ ] **Step 1: Write the failing test**

`test/server/start.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { access, writeFile } from "node:fs/promises";
import { tmpProject } from "../helpers/tmp.js";
import { startServer } from "../../src/server/start.js";
import { lockPath, readLock } from "../../src/server/lock.js";

describe("startServer", () => {
  it("serves the API, writes a lockfile and removes it on close", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const health = await (await fetch(`${s.url}/api/health`)).json();
    expect(health).toMatchObject({ ok: true, root });
    expect(await readLock(root)).toMatchObject({ port: s.port, pid: process.pid });
    await s.close();
    await expect(access(lockPath(root))).rejects.toThrow();
  });

  it("moves to the next port when the first is taken", async () => {
    const { root } = await tmpProject();
    const blocker = createServer();
    await new Promise<void>((ok) => blocker.listen(0, "127.0.0.1", () => ok()));
    const taken = (blocker.address() as { port: number }).port;
    const s = await startServer(root, { port: taken });
    expect(s.port).toBeGreaterThan(taken);
    expect(s.port).toBeLessThanOrEqual(taken + 10);
    await s.close();
    await new Promise<void>((ok) => blocker.close(() => ok()));
  });

  it("treats a lock left by a dead process as no lock", async () => {
    const { root } = await tmpProject();
    await writeFile(lockPath(root), JSON.stringify({ port: 4999, pid: 999999, startedAt: "2026-01-01T00:00:00Z" }), "utf8");
    expect(await readLock(root)).toBeNull();
  });

  it("streams a change event over SSE after a write", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const ctrl = new AbortController();
    const res = await fetch(`${s.url}/api/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await until("event: hello");
    await fetch(`${s.url}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: "picture", scope: "point", t: 1, text: "x" }),
    });
    await until("event: change");
    expect(text).toContain('"file":"notes"');
    ctrl.abort();
    await s.close();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/server/start.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/server/start.js"`.

- [ ] **Step 3: Implement**

`src/server/lock.ts`

```ts
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RUSHES_DIR } from "../core/store.js";

export interface Lock {
  port: number;
  pid: number;
  startedAt: string;
}

export function lockPath(root: string): string {
  return join(root, RUSHES_DIR, "server.json");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The running server's lock, or null when there is none or its process has gone. */
export async function readLock(root: string): Promise<Lock | null> {
  try {
    const lock = JSON.parse(await readFile(lockPath(root), "utf8")) as Lock;
    if (typeof lock.port !== "number" || typeof lock.pid !== "number") return null;
    return alive(lock.pid) ? lock : null;
  } catch {
    return null;
  }
}

export async function writeLock(root: string, port: number): Promise<Lock> {
  const lock: Lock = { port, pid: process.pid, startedAt: new Date().toISOString() };
  await writeFile(lockPath(root), JSON.stringify(lock, null, 2) + "\n", "utf8");
  return lock;
}

/** Remove the lock only if it is ours, so a newer server's lock survives. */
export async function removeLock(root: string): Promise<void> {
  try {
    const lock = JSON.parse(await readFile(lockPath(root), "utf8")) as Lock;
    if (lock.pid === process.pid) await rm(lockPath(root), { force: true });
  } catch {
    // nothing to remove
  }
}
```

`src/server/start.ts`

```ts
import { createServer, type Server } from "node:http";
import { basename, resolve } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { Store } from "../core/store.js";
import { createApp } from "./app.js";
import { removeLock, writeLock } from "./lock.js";

export const DEFAULT_PORT = 4317;

export interface Running {
  url: string;
  port: number;
  store: Store;
  close(): Promise<void>;
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((ok, fail) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      fail(e);
    };
    const onListening = () => {
      server.off("error", onError);
      const addr = server.address();
      ok(typeof addr === "object" && addr ? addr.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * Start the Rushes server for a project folder. Tries `port` and the next ten
 * ports; pass port 0 to let the OS choose (tests do).
 */
export async function startServer(rootDir: string, opts: { port?: number; host?: string; name?: string } = {}): Promise<Running> {
  const root = resolve(rootDir);
  const store = new Store(root);
  await store.init(opts.name ?? basename(root));
  const app = createApp(store);
  const server = createServer(getRequestListener(app.fetch));
  const host = opts.host ?? "127.0.0.1";
  const first = opts.port ?? DEFAULT_PORT;

  let port = -1;
  let lastError: unknown;
  for (let p = first; p <= (first === 0 ? 0 : first + 10); p++) {
    try {
      port = await listen(server, p, host);
      break;
    } catch (e) {
      lastError = e;
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    }
  }
  if (port < 0) throw new Error(`No free port from ${first} to ${first + 10}: ${(lastError as Error)?.message}`);

  await writeLock(root, port);
  const url = `http://${host}:${port}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections?.();
    await new Promise<void>((ok) => server.close(() => ok()));
    await removeLock(root);
  };
  return { url, port, store, close };
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/server/start.test.ts && npx tsc --noEmit`
Expected: all start-up tests pass, and tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/server/lock.ts src/server/start.ts test/server/start.test.ts
git commit -m "feat(server): start-up with port fallback, lockfile and SSE"
```

---

### Task 8: MCP server and its ten tools

**Files:**
- Create: `src/mcp/client.ts`
- Create: `src/mcp/ensure.ts`
- Create: `src/mcp/tools.ts`
- Create: `src/mcp/stdio.ts`
- Create: `test/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `startServer`, `readLock` and `VERSION`, plus the HTTP routes from Task 6.
- Produces: `client.ts`: `RushesClient(baseUrl)` with `get`, `post`, `put` and `patch`, and `ApiError(status, body)`. `ensure.ts`: `findServer(root) -> url|null` (checks that `/api/health` reports the same root), and `ensureServer(root, {spawnServer?, timeoutMs?}) -> RushesClient`. `tools.ts`: `createMcpServer({client(project?), openBrowser(url)}) -> McpServer`. `stdio.ts`: `openBrowser(url)`, `runStdio(defaultRoot?)`.

- [ ] **Step 1: Write the failing test**

`test/mcp/tools.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeFile } from "node:fs/promises";
import { tmpProject } from "../helpers/tmp.js";
import { startServer } from "../../src/server/start.js";
import { createMcpServer } from "../../src/mcp/tools.js";
import { RushesClient } from "../../src/mcp/client.js";
import { ensureServer, findServer } from "../../src/mcp/ensure.js";
import { lockPath } from "../../src/server/lock.js";

async function connect() {
  const { root } = await tmpProject("spring-launch");
  const running = await startServer(root, { port: 0 });
  const opened: string[] = [];
  const server = createMcpServer({ client: async () => new RushesClient(running.url), openBrowser: (u) => opened.push(u) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = r.content[0].text;
    return { isError: !!r.isError, text, json: r.isError ? null : JSON.parse(text) };
  };
  return { root, running, call, client, opened, close: async () => { await client.close(); await running.close(); } };
}

describe("MCP tools", () => {
  it("lists the ten v1 tools", async () => {
    const t = await connect();
    const { tools } = await t.client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual([
      "rushes_add_take", "rushes_add_variant", "rushes_add_version", "rushes_get_batch", "rushes_get_picks",
      "rushes_list_notes", "rushes_open", "rushes_reply", "rushes_set_script", "rushes_status",
    ]);
    await t.close();
  });

  it("runs the full review loop: add cut, user notes, batch, agent replies", async () => {
    const t = await connect();
    expect((await t.call("rushes_open")).json.url).toBe(t.running.url);
    expect(t.opened).toEqual([t.running.url]);

    const v = await t.call("rushes_add_version", { video: "Hero 60s", file: "renders/hero_v1.mp4" });
    expect(v.json.version.id).toBe("v1");

    // The user leaves a note and presses Send in the dashboard.
    const api = new RushesClient(t.running.url);
    const note = (await api.post("/api/notes", { stage: "picture", video: "hero-60s", version: "v1", scope: "point", t: 12.4, text: "Logo lands early" })).note;
    await api.post("/api/batches", { stage: "picture" });

    const batch = await t.call("rushes_get_batch");
    expect(batch.json.batch.id).toBe("b_1");
    expect(batch.json.notes.map((n: any) => n.id)).toEqual([note.id]);

    await t.call("rushes_add_version", { video: "hero-60s", file: "renders/hero_v2.mp4", note: "logo hold" });
    const r = await t.call("rushes_reply", { replies: [{ id: note.id, reply: "Held 0.5 s", status: "done", fixT: 12.9, fixVersion: "v2" }] });
    expect(r.json.notes[0]).toMatchObject({ status: "done", fixT: 12.9 });

    expect((await t.call("rushes_list_notes", { stage: "picture", status: "todo" })).json.notes).toEqual([]);
    const status = await t.call("rushes_status");
    expect(status.json.tabs.find((x: any) => x.stage === "picture")).toMatchObject({ unlocked: true, todo: 0 });
    await t.close();
  });

  it("script, takes, variants and picks", async () => {
    const t = await connect();
    await t.call("rushes_set_script", { sections: [{ start: 0, end: 13, current: "Your work lives on one laptop." }] });
    expect((await t.call("rushes_add_take", { section: "s1", file: "audio/s1.wav" })).json.take.id).toBe("t1");
    expect((await t.call("rushes_add_variant", { stage: "music", name: "Deep house", file: "a.wav", meta: { bpm: 120 } })).json.variant.id).toBe("deep-house");
    expect((await t.call("rushes_get_picks")).json).toMatchObject({ lanes: {}, sections: {} });
    await t.close();
  });

  it("returns readable tool errors instead of throwing", async () => {
    const t = await connect();
    const r = await t.call("rushes_reply", { replies: [{ id: "n_missing", reply: "x" }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('note "n_missing" not found');
    const b = await t.call("rushes_get_batch");
    expect(b.isError).toBe(true);
    await t.close();
  });
});

describe("ensureServer", () => {
  it("finds a running server for the same root", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    expect(await findServer(root)).toBe(s.url);
    const c = await ensureServer(root, { spawnServer: () => { throw new Error("should not spawn"); } });
    expect(c.baseUrl).toBe(s.url);
    await s.close();
  });

  it("ignores a lock that points at another project's server, and starts its own", async () => {
    const { root: other } = await tmpProject("other");
    const otherServer = await startServer(other, { port: 0 });
    const { root } = await tmpProject("mine");
    // A stale lock whose pid is alive (ours) but whose port belongs to the other project.
    await writeFile(lockPath(root), JSON.stringify({ port: otherServer.port, pid: process.pid, startedAt: "x" }), "utf8");
    expect(await findServer(root)).toBeNull();
    let mine: Awaited<ReturnType<typeof startServer>> | undefined;
    const c = await ensureServer(root, { spawnServer: (r) => { void startServer(r, { port: 0 }).then((s) => { mine = s; }); } });
    expect(c.baseUrl).not.toBe(otherServer.url);
    expect((await c.get("/api/health")).root).toBe(root);
    await mine?.close();
    await otherServer.close();
  });

  it("gives a clear error when no server comes up", async () => {
    const { root } = await tmpProject();
    await expect(ensureServer(root, { spawnServer: () => undefined, timeoutMs: 400 })).rejects.toThrow(/did not start/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/mcp/tools.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/mcp/tools.js"`.

- [ ] **Step 3: Implement**

`src/mcp/client.ts`

```ts
/** Thin HTTP client for the Rushes server API, used by the MCP server and the CLI. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { error?: string; message?: string; [k: string]: unknown },
  ) {
    super(body.message ?? `Rushes server returned ${status}`);
  }
}

export class RushesClient {
  constructor(readonly baseUrl: string) {}

  private async call<T>(method: string, path: string, json?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: json === undefined ? {} : { "content-type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    if (!res.ok) throw new ApiError(res.status, body);
    return body as T;
  }

  get<T = any>(path: string) { return this.call<T>("GET", path); }
  post<T = any>(path: string, json: unknown) { return this.call<T>("POST", path, json); }
  put<T = any>(path: string, json: unknown) { return this.call<T>("PUT", path, json); }
  patch<T = any>(path: string, json: unknown) { return this.call<T>("PATCH", path, json); }
}
```

`src/mcp/ensure.ts`

```ts
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readLock } from "../server/lock.js";
import { RushesClient } from "./client.js";

/** URL of a live Rushes server for exactly this project root, or null. */
export async function findServer(rootDir: string): Promise<string | null> {
  const root = resolve(rootDir);
  const lock = await readLock(root);
  if (!lock) return null;
  const url = `http://127.0.0.1:${lock.port}`;
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    const health = (await res.json()) as { app?: string; root?: string };
    // A reused port or pid can point at something else, so check it's ours.
    return health.app === "rushes" && health.root === root ? url : null;
  } catch {
    return null;
  }
}

export interface EnsureOptions {
  /** Command that starts a server in the foreground, given the project root. Defaults to this package's CLI. */
  spawnServer?: (root: string) => void;
  timeoutMs?: number;
}

function defaultSpawn(root: string): void {
  const cli = fileURLToPath(new URL("../cli/index.js", import.meta.url));
  const child = spawn(process.execPath, [cli, "serve", root], { detached: true, stdio: "ignore" });
  child.unref();
}

/** Find the project's server, starting one in the background if needed. */
export async function ensureServer(rootDir: string, opts: EnsureOptions = {}): Promise<RushesClient> {
  const root = resolve(rootDir);
  const found = await findServer(root);
  if (found) return new RushesClient(found);
  (opts.spawnServer ?? defaultSpawn)(root);
  const deadline = Date.now() + (opts.timeoutMs ?? 8000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const url = await findServer(root);
    if (url) return new RushesClient(url);
  }
  throw new Error(`Rushes server did not start for ${root}. Try running "npx rushes open" in that folder.`);
}
```

`src/mcp/tools.ts`

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiError, type RushesClient } from "./client.js";
import { VERSION } from "../server/app.js";

export interface ToolContext {
  /** Resolve a client for a project folder (defaults to the working directory). */
  client(project?: string): Promise<RushesClient>;
  /** Open a URL in the user's browser. */
  openBrowser(url: string): void;
}

const project = z.string().optional().describe("Project folder. Defaults to the current working directory.");
const stage = z.enum(["script", "picture", "voice", "music", "sfx", "mix"]);

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(e: unknown) {
  const message = e instanceof ApiError ? `${e.message} (${e.body.error ?? e.status})` : (e as Error).message;
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** Wrap a handler so API errors come back as tool errors the agent can read. */
function safe<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "rushes", version: VERSION });

  server.registerTool(
    "rushes_open",
    {
      title: "Open Rushes",
      description: "Start the Rushes review desk for a project (if it isn't running) and open it in the browser. Returns the URL.",
      inputSchema: { project, browser: z.boolean().optional().describe("Open the browser. Default true.") },
    },
    safe(async ({ project, browser }) => {
      const c = await ctx.client(project);
      if (browser !== false) ctx.openBrowser(c.baseUrl);
      return { url: c.baseUrl };
    }),
  );

  server.registerTool(
    "rushes_status",
    {
      title: "Rushes status",
      description: "Which tabs are unlocked and how many open items each has.",
      inputSchema: { project },
    },
    safe(async ({ project }) => (await ctx.client(project)).get("/api/tabs")),
  );

  server.registerTool(
    "rushes_add_version",
    {
      title: "Add a cut",
      description: "Register a new cut of a video. The first cut creates the video. Returns the new version id (v1, v2 ...).",
      inputSchema: {
        project,
        video: z.string().describe("Video id or name, e.g. \"Hero 60s\"."),
        file: z.string().describe("Path to the rendered file, absolute or relative to the project."),
        note: z.string().optional().describe("What changed in this cut."),
      },
    },
    safe(async ({ project, ...b }) => (await ctx.client(project)).post("/api/versions", b)),
  );

  server.registerTool(
    "rushes_add_variant",
    {
      title: "Add an audio variant",
      description: "Add a music bed, SFX pass or VO lane variant for side-by-side review.",
      inputSchema: {
        project,
        stage: z.enum(["voice", "music", "sfx"]),
        name: z.string().describe("Shown on the lane, e.g. \"Deep house\"."),
        file: z.string(),
        lane: z.string().optional().describe("Lane id. Defaults to the stage."),
        meta: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe("e.g. {\"bpm\": 120, \"key\": \"A minor\"}"),
        cues: z.array(z.object({ name: z.string(), t: z.number().nonnegative() })).optional().describe("SFX cues with times in seconds."),
      },
    },
    safe(async ({ project, ...b }) => (await ctx.client(project)).post("/api/variants", b)),
  );

  server.registerTool(
    "rushes_set_script",
    {
      title: "Set the VO script",
      description: "Create or replace the script sections. Keep a section's id to keep the user's edits, direction and takes on it.",
      inputSchema: {
        project,
        sections: z.array(z.object({ id: z.string().optional(), start: z.number().nonnegative(), end: z.number().nonnegative(), current: z.string() })),
        wordsPerSecond: z.number().positive().optional(),
      },
    },
    safe(async ({ project, ...b }) => (await ctx.client(project)).put("/api/script", b)),
  );

  server.registerTool(
    "rushes_add_take",
    {
      title: "Add a VO take",
      description: "Attach a recorded or generated VO take to a script section.",
      inputSchema: { project, section: z.string(), file: z.string() },
    },
    safe(async ({ project, section, file }) => (await ctx.client(project)).post(`/api/script/${encodeURIComponent(section)}/takes`, { file })),
  );

  server.registerTool(
    "rushes_list_notes",
    {
      title: "List notes",
      description: "Notes left in Rushes, filtered by tab, status, batch or version.",
      inputSchema: {
        project,
        stage: stage.optional(),
        status: z.enum(["todo", "done"]).optional(),
        batch: z.string().optional(),
        version: z.string().optional(),
      },
    },
    safe(async ({ project, ...f }) => {
      const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined) as [string, string][]);
      return (await ctx.client(project)).get(`/api/notes${q.size ? `?${q}` : ""}`);
    }),
  );

  server.registerTool(
    "rushes_get_batch",
    {
      title: "Get a batch",
      description: "The batch the user sent with Send to agent (latest by default), with its notes and script sections.",
      inputSchema: { project, id: z.string().optional() },
    },
    safe(async ({ project, id }) => (await ctx.client(project)).get(`/api/batches/${encodeURIComponent(id ?? "latest")}`)),
  );

  server.registerTool(
    "rushes_reply",
    {
      title: "Reply to notes",
      description: "Reply to one or more notes. Set status \"done\" when fixed, fixT to the time the fix is visible in the new cut, and fixVersion to that cut.",
      inputSchema: {
        project,
        replies: z
          .array(
            z.object({
              id: z.string(),
              reply: z.string().optional(),
              status: z.enum(["todo", "done"]).optional(),
              fixT: z.number().nonnegative().optional(),
              fixVersion: z.string().optional(),
            }),
          )
          .min(1),
      },
    },
    safe(async ({ project, replies }) => (await ctx.client(project)).post("/api/replies", { replies })),
  );

  server.registerTool(
    "rushes_get_picks",
    {
      title: "Get picks",
      description: "Which variant is in use per audio lane and which take per script section.",
      inputSchema: { project },
    },
    safe(async ({ project }) => (await ctx.client(project)).get("/api/picks")),
  );

  return server;
}
```

`src/mcp/stdio.ts`

```ts
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./tools.js";
import { ensureServer } from "./ensure.js";

export function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
}

/** Run the MCP server over stdio. Projects default to the directory the agent launched it in. */
export async function runStdio(defaultRoot = process.cwd()): Promise<void> {
  const server = createMcpServer({
    client: (project) => ensureServer(resolve(defaultRoot, project ?? ".")),
    openBrowser,
  });
  await server.connect(new StdioServerTransport());
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/mcp/tools.test.ts && npx tsc --noEmit`
Expected: all MCP tests pass, and tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/client.ts src/mcp/ensure.ts src/mcp/tools.ts src/mcp/stdio.ts test/mcp/tools.test.ts
git commit -m "feat(mcp): ten review tools and background server start"
```

---

### Task 9: `rushes setup`: register Rushes with every harness

**Files:**
- Create: `src/setup/harnesses.ts`
- Create: `src/setup/setup.ts`
- Create: `src/setup/env.ts`
- Create: `test/setup/setup.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. It reads `skills/rushes/SKILL.md`, which Task 11 writes. Tests use their own temporary skill file.
- Produces:
- `harnesses.ts`: `SOURCE`, `MCP_COMMAND = "npx"`, `MCP_ARGS = ["-y", SOURCE, "mcp"]`, `HarnessId` (`claude-code | codex | cursor | claude-desktop | gemini`), `harnesses(home, platform, appData?)`, `mergeJson(text|null) -> {text, changed}`, `mergeToml(text|null) -> {text, changed}`.
- `setup.ts`: the types `SetupEnv {home, platform, appData?, which(cmd), exec(cmd, args, cwd), skillFile?}`, `SetupOptions {only?, dryRun?}`, `SetupResult {harness, name, status: added|already|not-found|failed|would-add, detail, skill?}`, plus `setup(env, opts) -> SetupResult[]` and `packagedSkill()`.
- `env.ts`: `realSetupEnv()`.

- [ ] **Step 1: Write the failing test**

`test/setup/setup.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { mergeJson, mergeToml, MCP_ARGS, SOURCE } from "../../src/setup/harnesses.js";
import { setup, type SetupEnv } from "../../src/setup/setup.js";

const homes: string[] = [];
afterEach(async () => { while (homes.length) await rm(homes.pop()!, { recursive: true, force: true }); });

async function fakeHome() {
  const home = await mkdtemp(join(tmpdir(), "rushes home "));
  homes.push(home);
  const skillFile = join(home, "SKILL.src.md");
  await writeFile(skillFile, "---\nname: rushes\n---\nskill body\n");
  const calls: string[][] = [];
  let registered = false;
  const env: SetupEnv = {
    home,
    platform: "darwin",
    skillFile,
    which: async (cmd) => cmd === "claude",
    exec: async (cmd, args, cwd) => {
      expect(cwd).toBe(home);
      calls.push([cmd, ...args]);
      if (args[1] === "get") return { code: registered ? 0 : 1, out: "" };
      registered = true;
      return { code: 0, out: "Added" };
    },
  };
  return { home, env, calls };
}

describe("mergeJson", () => {
  it("adds rushes and keeps every other key", () => {
    const before = JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } });
    const { text, changed } = mergeJson(before);
    expect(changed).toBe(true);
    const doc = JSON.parse(text);
    expect(doc.theme).toBe("dark");
    expect(doc.mcpServers.other).toEqual({ command: "x" });
    expect(doc.mcpServers.rushes).toEqual({ command: "npx", args: ["-y", SOURCE, "mcp"] });
  });
  it("is a no-op when rushes is already there", () => {
    const once = mergeJson(null).text;
    expect(mergeJson(once)).toEqual({ text: once, changed: false });
  });
  it("refuses a config that isn't a JSON object", () => {
    expect(() => mergeJson("[1,2]")).toThrow(/not a JSON object/);
    expect(() => mergeJson("{ broken")).toThrow();
  });
});

describe("mergeToml", () => {
  it("appends the table, keeping what's there", () => {
    const { text } = mergeToml('model = "o4"\n\n[mcp_servers.other]\ncommand = "x"\n');
    expect(text).toContain('model = "o4"');
    expect(text).toContain("[mcp_servers.other]");
    expect(text).toContain(`[mcp_servers.rushes]\ncommand = "npx"\nargs = ["-y", "${SOURCE}", "mcp"]`);
  });
  it("replaces an outdated rushes table and is idempotent", () => {
    const old = '[mcp_servers.rushes]\ncommand = "node"\nargs = ["old.js"]\n\n[profiles.x]\nmodel = "y"\n';
    const once = mergeToml(old);
    expect(once.changed).toBe(true);
    expect(once.text).not.toContain("old.js");
    expect(once.text).toContain("[profiles.x]");
    expect(mergeToml(once.text).changed).toBe(false);
  });
});

describe("setup", () => {
  it("only touches harnesses that are installed", async () => {
    const { env, home } = await fakeHome();
    await mkdir(join(home, ".cursor"));
    const r = await setup(env);
    const by = Object.fromEntries(r.map((x) => [x.harness, x.status]));
    expect(by).toMatchObject({ "claude-code": "added", cursor: "added", codex: "not-found", "claude-desktop": "not-found", gemini: "not-found" });
    const cursor = JSON.parse(await readFile(join(home, ".cursor", "mcp.json"), "utf8"));
    expect(cursor.mcpServers.rushes.args).toEqual(MCP_ARGS);
  });

  it("registers with Claude Code through its CLI, installs the skill, and is idempotent", async () => {
    const { env, home, calls } = await fakeHome();
    const first = (await setup(env, { only: ["claude-code"] }))[0];
    expect(first).toMatchObject({ status: "added", skill: "added" });
    expect(calls).toContainEqual(["claude", "mcp", "add", "--scope", "user", "rushes", "--", "npx", ...MCP_ARGS]);
    expect(await readFile(join(home, ".claude", "skills", "rushes", "SKILL.md"), "utf8")).toContain("skill body");
    const second = (await setup(env, { only: ["claude-code"] }))[0];
    expect(second).toMatchObject({ status: "already", skill: "already" });
  });

  it("backs up an existing config before changing it", async () => {
    const { env, home } = await fakeHome();
    const dir = join(home, ".gemini");
    await mkdir(dir);
    await writeFile(join(dir, "settings.json"), '{ "theme": "GitHub" }');
    const r = (await setup(env, { only: ["gemini"] }))[0];
    expect(r.status).toBe("added");
    expect(await readFile(join(dir, "settings.json.rushes.bak"), "utf8")).toBe('{ "theme": "GitHub" }');
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).theme).toBe("GitHub");
  });

  it("leaves a broken config alone and says so", async () => {
    const { env, home } = await fakeHome();
    await mkdir(join(home, ".cursor"));
    await writeFile(join(home, ".cursor", "mcp.json"), "{ nope");
    const r = (await setup(env, { only: ["cursor"] }))[0];
    expect(r.status).toBe("failed");
    expect(r.detail).toContain("Nothing was changed");
    expect(await readFile(join(home, ".cursor", "mcp.json"), "utf8")).toBe("{ nope");
  });

  it("dry run changes nothing", async () => {
    const { env, home, calls } = await fakeHome();
    await mkdir(join(home, ".codex"));
    const r = await setup(env, { dryRun: true, only: ["codex", "claude-code"] });
    expect(r.map((x) => x.status)).toEqual(["would-add", "would-add"]);
    expect(calls.filter((c) => c[2] === "add")).toEqual([]);
    await expect(readFile(join(home, ".codex", "config.toml"), "utf8")).rejects.toThrow();
  });

  it("finds Claude Desktop in the right folder per platform", async () => {
    const { env, home } = await fakeHome();
    const mac = join(home, "Library", "Application Support", "Claude");
    await mkdir(mac, { recursive: true });
    const r = (await setup(env, { only: ["claude-desktop"] }))[0];
    expect(r.status).toBe("added");
    expect(JSON.parse(await readFile(join(mac, "claude_desktop_config.json"), "utf8")).mcpServers.rushes.command).toBe("npx");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/setup/setup.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/setup/harnesses.js"`.

- [ ] **Step 3: Implement**

`src/setup/harnesses.ts`

```ts
import { join } from "node:path";

/** What every harness runs to start the Rushes MCP server. Switches to "rushes" once it's on npm. */
export const SOURCE = "github:iamredmh/rushes";
export const MCP_COMMAND = "npx";
export const MCP_ARGS = ["-y", SOURCE, "mcp"];

export type HarnessId = "claude-code" | "codex" | "cursor" | "claude-desktop" | "gemini";

export interface Harness {
  id: HarnessId;
  name: string;
  /** How Rushes gets registered. */
  kind: "claude-cli" | "json" | "toml";
  /** Config file (json/toml kinds). */
  config?: string;
  /** Folder whose presence means the harness is installed. */
  marker: string;
  /** CLI on PATH that also means the harness is installed. */
  bin?: string;
  /** Where to copy the Rushes skill, if the harness reads skills. */
  skillDir?: string;
}

export function harnesses(home: string, platform: NodeJS.Platform, appData = join(home, "AppData", "Roaming")): Harness[] {
  const desktopDir =
    platform === "darwin"
      ? join(home, "Library", "Application Support", "Claude")
      : platform === "win32"
        ? join(appData, "Claude")
        : join(home, ".config", "Claude");
  return [
    { id: "claude-code", name: "Claude Code", kind: "claude-cli", marker: join(home, ".claude"), bin: "claude", skillDir: join(home, ".claude", "skills", "rushes") },
    { id: "codex", name: "Codex", kind: "toml", config: join(home, ".codex", "config.toml"), marker: join(home, ".codex"), bin: "codex", skillDir: join(home, ".codex", "skills", "rushes") },
    { id: "cursor", name: "Cursor", kind: "json", config: join(home, ".cursor", "mcp.json"), marker: join(home, ".cursor") },
    { id: "claude-desktop", name: "Claude Desktop", kind: "json", config: join(desktopDir, "claude_desktop_config.json"), marker: desktopDir },
    { id: "gemini", name: "Gemini CLI", kind: "json", config: join(home, ".gemini", "settings.json"), marker: join(home, ".gemini"), bin: "gemini" },
  ];
}

/**
 * Add Rushes to a JSON config's "mcpServers" without touching anything else.
 * Throws if the existing file isn't a JSON object, so we never clobber it.
 */
export function mergeJson(existing: string | null): { text: string; changed: boolean } {
  const doc: Record<string, unknown> = existing && existing.trim() ? JSON.parse(existing) : {};
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error("config is not a JSON object");
  const servers = (doc.mcpServers ?? {}) as Record<string, unknown>;
  if (typeof servers !== "object" || Array.isArray(servers)) throw new Error('"mcpServers" is not an object');
  const want = { command: MCP_COMMAND, args: MCP_ARGS };
  if (JSON.stringify(servers.rushes) === JSON.stringify(want)) return { text: existing ?? "", changed: false };
  doc.mcpServers = { ...servers, rushes: want };
  return { text: JSON.stringify(doc, null, 2) + "\n", changed: true };
}

const TOML_BLOCK = `[mcp_servers.rushes]\ncommand = "${MCP_COMMAND}"\nargs = [${MCP_ARGS.map((a) => JSON.stringify(a)).join(", ")}]\n`;

/** Add or replace the [mcp_servers.rushes] table in a Codex config.toml, leaving everything else as written. */
export function mergeToml(existing: string | null): { text: string; changed: boolean } {
  const text = existing ?? "";
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === "[mcp_servers.rushes]");
  if (start === -1) {
    const sep = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return { text: text + sep + TOML_BLOCK, changed: true };
  }
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  if (end === -1) end = lines.length;
  const current = lines.slice(start, end).join("\n").trim();
  if (current === TOML_BLOCK.trim()) return { text, changed: false };
  const next = [...lines.slice(0, start), ...TOML_BLOCK.trimEnd().split("\n"), "", ...lines.slice(end)].join("\n");
  return { text: next.replace(/\n{3,}/g, "\n\n"), changed: true };
}
```

`src/setup/setup.ts`

```ts
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { harnesses, mergeJson, mergeToml, MCP_ARGS, MCP_COMMAND, type Harness, type HarnessId } from "./harnesses.js";

export interface SetupEnv {
  home: string;
  platform: NodeJS.Platform;
  appData?: string;
  /** Is this command on PATH? */
  which(cmd: string): Promise<boolean>;
  /** Run a command in `cwd`; resolve with exit code and output. */
  exec(cmd: string, args: string[], cwd: string): Promise<{ code: number; out: string }>;
  /** Path of the SKILL.md to install. Defaults to the one shipped in this package. */
  skillFile?: string;
}

export interface SetupOptions {
  only?: HarnessId[];
  dryRun?: boolean;
}

export interface SetupResult {
  harness: HarnessId;
  name: string;
  status: "added" | "already" | "not-found" | "failed" | "would-add";
  detail: string;
  skill?: "added" | "already" | "would-add";
}

const exists = (p: string) => access(p).then(() => true, () => false);

export function packagedSkill(): string {
  return fileURLToPath(new URL("../../skills/rushes/SKILL.md", import.meta.url));
}

async function installed(h: Harness, env: SetupEnv): Promise<boolean> {
  return (await exists(h.marker)) || (h.bin ? await env.which(h.bin) : false);
}

async function writeConfig(path: string, text: string, existed: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (existed) await copyFile(path, `${path}.rushes.bak`);
  await writeFile(path, text, "utf8");
}

async function installSkill(h: Harness, env: SetupEnv, dryRun: boolean): Promise<SetupResult["skill"]> {
  if (!h.skillDir) return undefined;
  const target = join(h.skillDir, "SKILL.md");
  const source = env.skillFile ?? packagedSkill();
  const want = await readFile(source, "utf8");
  const have = await readFile(target, "utf8").catch(() => null);
  if (have === want) return "already";
  if (dryRun) return "would-add";
  await mkdir(h.skillDir, { recursive: true });
  await writeFile(target, want, "utf8");
  return "added";
}

async function one(h: Harness, env: SetupEnv, dryRun: boolean): Promise<SetupResult> {
  const base = { harness: h.id, name: h.name };
  if (!(await installed(h, env))) return { ...base, status: "not-found", detail: "not installed" };
  try {
    if (h.kind === "claude-cli") {
      if (!(await env.which("claude"))) return { ...base, status: "failed", detail: "the claude command isn't on PATH. Run: claude mcp add --scope user rushes -- " + [MCP_COMMAND, ...MCP_ARGS].join(" ") };
      // Run from home so a project's own .mcp.json can't make it look registered.
      const got = await env.exec("claude", ["mcp", "get", "rushes"], env.home);
      const skill = await installSkill(h, env, dryRun);
      if (got.code === 0) return { ...base, status: "already", detail: "rushes MCP server already registered", skill };
      if (dryRun) return { ...base, status: "would-add", detail: "claude mcp add --scope user rushes", skill };
      const add = await env.exec("claude", ["mcp", "add", "--scope", "user", "rushes", "--", MCP_COMMAND, ...MCP_ARGS], env.home);
      if (add.code !== 0) return { ...base, status: "failed", detail: add.out.trim() || "claude mcp add failed", skill };
      return { ...base, status: "added", detail: "registered with claude mcp add --scope user", skill };
    }
    const path = h.config!;
    const existed = await exists(path);
    const before = existed ? await readFile(path, "utf8") : null;
    const merged = h.kind === "toml" ? mergeToml(before) : mergeJson(before);
    const skill = await installSkill(h, env, dryRun);
    if (!merged.changed) return { ...base, status: "already", detail: path, skill };
    if (dryRun) return { ...base, status: "would-add", detail: path, skill };
    await writeConfig(path, merged.text, existed);
    return { ...base, status: "added", detail: existed ? `${path} (backup: ${path}.rushes.bak)` : path, skill };
  } catch (e) {
    return { ...base, status: "failed", detail: `${h.config ?? h.name}: ${(e as Error).message}. Nothing was changed.` };
  }
}

/** Register the Rushes MCP server (and skill, where supported) with every installed harness. */
export async function setup(env: SetupEnv, opts: SetupOptions = {}): Promise<SetupResult[]> {
  const list = harnesses(env.home, env.platform, env.appData).filter((h) => !opts.only || opts.only.includes(h.id));
  const out: SetupResult[] = [];
  for (const h of list) out.push(await one(h, env, !!opts.dryRun));
  return out;
}
```

`src/setup/env.ts`

```ts
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import type { SetupEnv } from "./setup.js";

function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise((ok) => {
    let out = "";
    const child = spawn(cmd, args, { cwd, shell: process.platform === "win32" });
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (e) => ok({ code: 127, out: e.message }));
    child.on("close", (code) => ok({ code: code ?? 1, out }));
  });
}

/** The real machine: your home folder, PATH lookups and real commands. */
export function realSetupEnv(): SetupEnv {
  return {
    home: homedir(),
    platform: process.platform,
    appData: process.env.APPDATA,
    which: async (cmd) => (await run(process.platform === "win32" ? "where" : "which", [cmd])).code === 0,
    exec: run,
  };
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/setup/setup.test.ts && npx tsc --noEmit`
Expected: all setup tests pass, and tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/setup/harnesses.ts src/setup/setup.ts src/setup/env.ts test/setup/setup.test.ts
git commit -m "feat(setup): register Rushes with Claude Code, Codex, Cursor, Claude Desktop and Gemini CLI"
```

---

### Task 10: CLI

**Files:**
- Create: `src/cli/main.ts`
- Create: `src/cli/index.ts`
- Create: `test/cli/main.test.ts`

**Interfaces:**
- Consumes: `Store`, `startServer`, `DEFAULT_PORT`, `Running`, `ensureServer`, `ApiError`, `openBrowser`, `runStdio`, `VERSION`, plus `setup`, `SetupEnv`, `realSetupEnv` and `HarnessId` from Task 9.
- Produces: `main(argv, io) -> Promise<exit code>`, `HELP`, and the type `Io {out, err, cwd, ensure?, openBrowser?, onServer?, setupEnv?}`. Commands: `open`, `serve`, `init`, `setup`, `mcp`, `status`, `add version`, `add variant`, `notes`, `reply`. `index.ts` is the `rushes` bin. It exits straight away unless the command is `open`, `serve` or `mcp`.

- [ ] **Step 1: Write the failing test**

`test/cli/main.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { main, type Io } from "../../src/cli/main.js";
import { startServer, type Running } from "../../src/server/start.js";

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const x: Io = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    cwd,
    openBrowser: (u) => opened.push(u),
    ensure: { spawnServer: () => { throw new Error("tests start the server themselves"); }, timeoutMs: 300 },
  };
  return { x, out, err, opened };
}

describe("cli", () => {
  it("prints help with no command, and exits 2 on an unknown one", async () => {
    const a = io("/tmp");
    expect(await main([], a.x)).toBe(0);
    expect(a.out.join("\n")).toContain("rushes open [dir]");
    const b = io("/tmp");
    expect(await main(["frobnicate"], b.x)).toBe(2);
    expect(b.err[0]).toContain('Unknown command "frobnicate"');
  });

  it("init creates the .rushes folder in a path with spaces", async () => {
    const { root } = await tmpProject();
    const target = join(root, "Second Film");
    const a = io(root);
    expect(await main(["init", "Second Film"], a.x)).toBe(0);
    await access(join(target, ".rushes", "project.json"));
  });

  it("add, notes and reply talk to the running server", async () => {
    const { root } = await tmpProject("spring-launch");
    const s = await startServer(root, { port: 0 });
    const a = io(root);
    expect(await main(["add", "version", "renders/hero v1.mp4", "--video", "Hero 60s"], a.x)).toBe(0);
    expect(a.out.pop()).toBe("Added Hero 60s v1");
    expect(await main(["add", "variant", "music", "audio/a.wav", "--name", "Deep house"], a.x)).toBe(0);

    const note = (await (await fetch(`${s.url}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: "picture", scope: "range", t: 31.05, tOut: 33.1, text: "Too fast" }),
    })).json()).note;

    const b = io(root);
    expect(await main(["notes", "--stage", "picture"], b.x)).toBe(0);
    expect(b.out[0]).toContain("0:31.05–0:33.10");
    expect(b.out[0]).toContain("Too fast");

    const c = io(root);
    expect(await main(["reply", note.id, "Slowed", "to", "2.4", "s", "--done", "--fix-t", "31.4"], c.x)).toBe(0);
    const d = io(root);
    await main(["notes", "--json"], d.x);
    expect(JSON.parse(d.out[0])[0]).toMatchObject({ reply: "Slowed to 2.4 s", status: "done", fixT: 31.4 });

    const e = io(root);
    await main(["status"], e.x);
    expect(e.out.find((l) => l.startsWith("picture"))).toMatch(/open/);
    await s.close();
  });

  it("explains missing arguments and server errors", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const a = io(root);
    expect(await main(["add", "version", "x.mp4"], a.x)).toBe(2);
    expect(a.err[0]).toContain("--video");
    const b = io(root);
    expect(await main(["reply", "n_missing", "hello"], b.x)).toBe(1);
    expect(b.err[0]).toContain('note "n_missing" not found');
    await s.close();
  });

  it("open starts the server and opens the browser", async () => {
    const { root } = await tmpProject();
    const a = io(root);
    let server: Running | undefined;
    a.x.onServer = (s) => { server = s; };
    expect(await main(["open", ".", "--port", "0"], a.x)).toBe(0);
    expect(a.opened).toEqual([server!.url]);
    const health = await (await fetch(`${a.opened[0]}/api/health`)).json();
    expect(health.root).toBe(root);
    await server!.close();
  });
});

describe("cli setup", () => {
  it("prints one line per harness and the restart hint", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const home = await mkdtemp(join(tmpdir(), "rushes cli home "));
    await mkdir(join(home, ".cursor"));
    const skillFile = join(home, "s.md");
    await writeFile(skillFile, "x");
    const a = io(home);
    a.x.setupEnv = { home, platform: "linux", skillFile, which: async () => false, exec: async () => ({ code: 1, out: "" }) };
    expect(await main(["setup"], a.x)).toBe(0);
    expect(a.out.find((l) => l.startsWith("+ Cursor"))).toContain("added");
    expect(a.out.find((l) => l.startsWith("- Codex"))).toContain("not-found");
    expect(a.out.join("\n")).toContain('ask your agent to "open Rushes"');
    await rm(home, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/cli/main.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/cli/main.js"`.

- [ ] **Step 3: Implement**

`src/cli/main.ts`

```ts
import { parseArgs } from "node:util";
import { basename, resolve } from "node:path";
import { Store } from "../core/store.js";
import { startServer, DEFAULT_PORT, type Running } from "../server/start.js";
import { ensureServer, type EnsureOptions } from "../mcp/ensure.js";
import { ApiError } from "../mcp/client.js";
import { openBrowser, runStdio } from "../mcp/stdio.js";
import { VERSION } from "../server/app.js";
import { setup, type SetupEnv } from "../setup/setup.js";
import { realSetupEnv } from "../setup/env.js";
import type { HarnessId } from "../setup/harnesses.js";

export interface Io {
  out(line: string): void;
  err(line: string): void;
  cwd: string;
  ensure?: EnsureOptions;
  openBrowser?: (url: string) => void;
  /** Receives the server started by open/serve. When set, main does not install signal handlers (tests close it). */
  onServer?: (s: Running) => void;
  /** Environment for `rushes setup`. Tests pass a fake home. */
  setupEnv?: SetupEnv;
}

export const HELP = `rushes ${VERSION}: a local review desk for video made with AI agents

Usage
  rushes open [dir] [--port 4317] [--no-browser]   start the review desk and open it
  rushes serve [dir] [--port 4317]                 start the server without a browser
  rushes init [dir] [--name NAME]                  create the .rushes folder
  rushes setup [--only claude-code,codex,...] [--dry-run]
                                                    add Rushes to every agent harness on this machine
  rushes mcp                                        run the MCP server over stdio
  rushes status [dir]                               tabs and open items
  rushes add version <file> --video NAME [--note TEXT]
  rushes add variant <music|sfx|voice> <file> --name NAME [--lane ID]
  rushes notes [--stage S] [--status todo|done] [--batch ID] [--json]
  rushes reply <note-id> <text> [--done] [--fix-t SECONDS] [--fix-version V]

Options
  --dir DIR   project folder for commands that talk to the server (default: current folder)
`;

const OPTIONS = {
  port: { type: "string" },
  "no-browser": { type: "boolean" },
  name: { type: "string" },
  video: { type: "string" },
  note: { type: "string" },
  lane: { type: "string" },
  stage: { type: "string" },
  status: { type: "string" },
  batch: { type: "string" },
  json: { type: "boolean" },
  done: { type: "boolean" },
  "fix-t": { type: "string" },
  "fix-version": { type: "string" },
  dir: { type: "string" },
  only: { type: "string" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

/** Run the CLI. Returns an exit code. Long-running commands (open, serve, mcp) resolve once started. */
export async function main(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (e) {
    io.err((e as Error).message);
    io.err(HELP);
    return 2;
  }
  const { values: o, positionals: p } = parsed;
  if (o.version) return io.out(VERSION), 0;
  const [cmd, ...rest] = p;
  if (!cmd || o.help || cmd === "help") return io.out(HELP), 0;

  const dir = resolve(io.cwd, o.dir ?? ".");
  const client = () => ensureServer(dir, io.ensure);

  try {
    switch (cmd) {
      case "open":
      case "serve": {
        const root = resolve(io.cwd, rest[0] ?? ".");
        const s = await startServer(root, { port: o.port ? Number(o.port) : DEFAULT_PORT });
        io.out(`Rushes is running for ${root}\n${s.url}`);
        if (cmd === "open" && !o["no-browser"]) (io.openBrowser ?? openBrowser)(s.url);
        if (io.onServer) return io.onServer(s), 0;
        const stop = () => void s.close().then(() => process.exit(0));
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        return 0;
      }
      case "init": {
        const root = resolve(io.cwd, rest[0] ?? ".");
        await new Store(root).init(o.name ?? basename(root));
        io.out(`Created ${root}/.rushes`);
        return 0;
      }
      case "setup": {
        const only = o.only ? (o.only.split(",").map((x) => x.trim()) as HarnessId[]) : undefined;
        const results = await setup(io.setupEnv ?? realSetupEnv(), { only, dryRun: o["dry-run"] });
        const mark = { added: "+", "would-add": "~", already: "=", "not-found": "-", failed: "!" } as const;
        for (const r of results) {
          const skill = r.skill ? `, skill ${r.skill}` : "";
          io.out(`${mark[r.status]} ${r.name.padEnd(15)} ${r.status}${skill}${r.status === "not-found" ? "" : `  ${r.detail}`}`);
        }
        const added = results.filter((r) => r.status === "added").length;
        if (added) io.out(`\nRestart ${added === 1 ? "that app" : "those apps"} so ${added === 1 ? "it picks" : "they pick"} up the rushes tools. Then ask your agent to "open Rushes".`);
        if (!results.some((r) => r.status !== "not-found")) io.out("No supported agent harness found. See https://github.com/iamredmh/rushes#other-harnesses");
        return results.some((r) => r.status === "failed") ? 1 : 0;
      }
      case "mcp":
        await runStdio(io.cwd);
        return 0;
      case "status": {
        const { tabs } = await (await client()).get("/api/tabs");
        for (const t of tabs as { stage: string; unlocked: boolean; todo: number }[]) {
          io.out(`${t.stage.padEnd(8)} ${t.unlocked ? "open  " : "locked"} ${t.todo ? `${t.todo} to do` : ""}`.trimEnd());
        }
        return 0;
      }
      case "add": {
        const [what, a, b] = rest;
        const c = await client();
        if (what === "version") {
          if (!a || !o.video) return usage(io, "rushes add version <file> --video NAME");
          const r = await c.post("/api/versions", { video: o.video, file: resolve(io.cwd, a), note: o.note });
          io.out(`Added ${r.video.name} ${r.version.id}`);
          return 0;
        }
        if (what === "variant") {
          if (!a || !b || !o.name) return usage(io, "rushes add variant <music|sfx|voice> <file> --name NAME");
          const r = await c.post("/api/variants", { stage: a, file: resolve(io.cwd, b), name: o.name, lane: o.lane });
          io.out(`Added ${r.lane.name}: ${r.variant.name}`);
          return 0;
        }
        return usage(io, "rushes add version|variant ...");
      }
      case "notes": {
        const q = new URLSearchParams();
        for (const k of ["stage", "status", "batch"] as const) if (o[k]) q.set(k, o[k]!);
        const { notes } = await (await client()).get(`/api/notes${q.size ? `?${q}` : ""}`);
        if (o.json) return io.out(JSON.stringify(notes, null, 2)), 0;
        for (const n of notes) io.out(`${n.id}  ${n.status === "done" ? "done" : "todo"}  ${n.stage.padEnd(7)} ${when(n).padEnd(17)} ${n.text}`);
        if (!notes.length) io.out("No notes");
        return 0;
      }
      case "reply": {
        const [id, ...words] = rest;
        if (!id || !words.length) return usage(io, "rushes reply <note-id> <text> [--done] [--fix-t SECONDS]");
        const reply = {
          id,
          reply: words.join(" "),
          ...(o.done ? { status: "done" } : {}),
          ...(o["fix-t"] ? { fixT: Number(o["fix-t"]) } : {}),
          ...(o["fix-version"] ? { fixVersion: o["fix-version"] } : {}),
        };
        await (await client()).post("/api/replies", { replies: [reply] });
        io.out(`Replied to ${id}`);
        return 0;
      }
      default:
        io.err(`Unknown command "${cmd}"`);
        io.err(HELP);
        return 2;
    }
  } catch (e) {
    io.err(e instanceof ApiError ? `${e.message}` : (e as Error).message);
    return 1;
  }
}

function usage(io: Io, line: string): number {
  io.err(`Usage: ${line}`);
  return 2;
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
}

function when(n: { scope: string; t: number | null; tOut: number | null }): string {
  if (n.scope === "whole" || n.t === null) return "whole";
  return n.scope === "range" && n.tOut !== null ? `${fmt(n.t)}–${fmt(n.tOut)}` : fmt(n.t);
}
```

`src/cli/index.ts`

```ts
#!/usr/bin/env node
import { main } from "./main.js";

const code = await main(process.argv.slice(2), {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  cwd: process.cwd(),
});
// open, serve and mcp keep running on their own handles; everything else exits.
const [cmd] = process.argv.slice(2);
if (!["open", "serve", "mcp"].includes(cmd ?? "") || code !== 0) process.exit(code);
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/cli/main.test.ts && npx tsc --noEmit`
Expected: all CLI tests pass, and tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/cli/main.ts src/cli/index.ts test/cli/main.test.ts
git commit -m "feat(cli): open, serve, init, setup, mcp, status, add, notes, reply"
```

---

### Task 11: Install from GitHub, Claude Code plugin, agent docs and the repo

**Files:**
- Modify: `package.json` (add the `prepare` script)
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json`, `AGENTS.md`, `skills/rushes/SKILL.md`, `README.md`, `test/e2e/stdio.test.ts`

**Interfaces:**
- Consumes: the built `dist/cli/index.js`, `readLock`, `tmpProject`, and `SOURCE` (the docs repeat its value).
- Produces: a repo that installs itself straight from GitHub, a Claude Code plugin and marketplace, the docs an agent reads, and a test that drives the built package over stdio the way a harness does.

- [ ] **Step 1: Write the end-to-end test**

`test/e2e/stdio.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpProject } from "../helpers/tmp.js";
import { readLock } from "../../src/server/lock.js";

const cli = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

// Runs against the built package, the way an agent harness launches it.
describe.skipIf(!existsSync(cli))("built package over stdio", () => {
  it("an agent can open Rushes, which starts its own background server", async () => {
    const { root } = await tmpProject("e2e");
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], cwd: root, stderr: "pipe" });
    const client = new Client({ name: "e2e", version: "0" });
    await client.connect(transport);

    const r = (await client.callTool({ name: "rushes_open", arguments: { browser: false } })) as { content: { text: string }[] };
    const { url } = JSON.parse(r.content[0].text);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const v = (await client.callTool({ name: "rushes_add_version", arguments: { video: "Hero", file: "renders/v1.mp4" } })) as { content: { text: string }[] };
    expect(JSON.parse(v.content[0].text).version.id).toBe("v1");

    await client.close();
    const lock = await readLock(root);
    expect(lock).not.toBeNull();
    process.kill(lock!.pid, "SIGTERM");
  });
});
```

- [ ] **Step 2: Build, then run it**

Run: `npm run build && npx vitest run test/e2e`
Expected: 1 passed. The test launches `node dist/cli/index.js mcp`. `rushes_open` spawns a detached `rushes serve`, and the test kills it at the end. Without a build the test is skipped, not failed.

- [ ] **Step 3: Make it installable straight from GitHub**

In `package.json`, add a `prepare` script after `"rushes"` in `scripts`:

```json
    "rushes": "tsx src/cli/index.ts",
    "prepare": "npm run build"
```

Then prove that a git install builds and runs. Commit first, because the install reads committed files:

```bash
git add -A && git commit -m "build: build on install so npx can run it from git"
cd "$(mktemp -d)" && npx -y "git+file://$HOME/Documents/Projects/rushes" --help | head -1
```
Expected: `rushes 0.1.0: a local review desk for video made with AI agents`. The first run takes about 7 seconds while it builds.

- [ ] **Step 4: Add the Claude Code plugin and marketplace**

`.claude-plugin/plugin.json`

```json
{
  "name": "rushes",
  "description": "A local review desk for video made with AI agents: timecoded notes, script edits and audio picks your agent reads and acts on.",
  "version": "0.1.0",
  "author": { "name": "Red Morley Hewitt" },
  "homepage": "https://github.com/iamredmh/rushes",
  "repository": "https://github.com/iamredmh/rushes",
  "license": "MIT",
  "keywords": ["video", "review", "voiceover", "music", "mcp"]
}
```

`.claude-plugin/marketplace.json`

```json
{
  "name": "iamredmh",
  "description": "Rushes: a local review desk for video made with AI agents.",
  "owner": {
    "name": "Red Morley Hewitt"
  },
  "plugins": [
    {
      "name": "rushes",
      "source": "./",
      "description": "A local review desk for video made with AI agents."
    }
  ]
}
```

`.mcp.json`

```json
{
  "mcpServers": {
    "rushes": {
      "command": "npx",
      "args": ["-y", "github:iamredmh/rushes", "mcp"]
    }
  }
}
```

- [ ] **Step 5: Write the agent docs and README**

`AGENTS.md`

````markdown
# Rushes, for agents

Rushes is a local review desk. Your user watches the work in a browser, leaves timecoded notes, edits the script and picks audio variants. You read that feedback, act on it, and reply. Everything is saved in the project's `.rushes/` folder, and one local server is the only thing that writes to it.

## Setup (once per machine)

```bash
npx -y github:iamredmh/rushes setup
```

This registers the Rushes MCP server with every supported harness it finds (Claude Code, Codex, Cursor, Claude Desktop, Gemini CLI), and installs the skill where the harness supports skills. If it added anything, ask the user to restart the app. Use `--dry-run` to preview, and `--only claude-code,codex` to limit it.

## The loop

1. **Register what you made.**
   - A render: `rushes_add_version` with `video` and `file`. Run it again for each new cut.
   - A VO script: `rushes_set_script` with sections `{start, end, current}` in seconds.
   - VO takes: `rushes_add_take` for each section.
   - Music beds, SFX passes or alternative VO lanes: `rushes_add_variant` with `stage` `music`, `sfx` or `voice`.
2. **Open it for the user:** `rushes_open`. A tab unlocks as soon as it has something in it.
3. **Wait for feedback.** The user presses **Send to agent**, which saves a batch and gives them a prompt to paste to you. Call `rushes_get_batch` to read the latest batch, its notes and any changed script sections.
4. **Fix each note.** A note has `stage`, `scope` (`point`, `range` or `whole`), `t`, `tOut`, `on` (the lane, variant, take, cue or section it's about), `text`, and optionally `box` (normalised 0 to 1) and `grab` (a PNG path in `.rushes/grabs/`).
5. **Register the new cut** with `rushes_add_version` and note what changed.
6. **Reply to every note** in one `rushes_reply` call. For each, set `status: "done"`, a one-line `reply`, `fixT` (when the fix is visible in the new cut, in seconds) and `fixVersion`. If you didn't fix a note, leave it `todo` and say why in `reply`.
7. **Script batches.** When a section's `proposed` differs from `current`, the user rewrote the line. Adopt it by calling `rushes_set_script` with that section's `id` and the new `current`. The proposal then clears itself. A changed line makes that section's existing takes stale, so record new takes and add them.

## Rules

- Never edit `.rushes/*.json` by hand while the server is running. Use the tools, or the CLI (`rushes add`, `rushes notes`, `rushes reply`).
- You own a note's `reply`, `fixT` and `fixVersion`. The user owns its text, times and box. Either of you can set `status`.
- Times are seconds from the start of the video, as numbers (e.g. `31.05`).

## Without MCP

```bash
npx -y github:iamredmh/rushes open
npx -y github:iamredmh/rushes add version renders/hero_v2.mp4 --video "Hero 60s" --note "logo hold"
npx -y github:iamredmh/rushes notes --stage picture --status todo --json
npx -y github:iamredmh/rushes reply n_8f2k3a "Held the phone 0.5 s longer" --done --fix-t 12.9 --fix-version v2
```
````

`skills/rushes/SKILL.md`

```markdown
---
name: rushes
description: Review video work with the user in Rushes, a local review desk. Use when you've rendered a cut, written a VO script, generated VO takes, music beds or SFX passes and the user should review them, or when the user says they left notes, pressed Send to agent, or pastes a Rushes batch prompt.
---

# Rushes

Rushes shows your work to the user stage by stage (script, picture, voiceover, music, sound effects, mix). The user leaves timecoded notes that you act on.

1. Register what you made:
   - `rushes_add_version` for a render;
   - `rushes_set_script` for the VO script;
   - `rushes_add_take` for each VO take;
   - `rushes_add_variant` for each music bed or SFX pass.
2. Call `rushes_open` and tell the user it's ready.
3. When the user sends a batch, call `rushes_get_batch` and fix every note in it.
4. Register the new cut with `rushes_add_version`.
5. Reply to all the notes in one `rushes_reply` call. For each note set `status: "done"`, a one-line `reply`, `fixT` (when the fix is visible in the new cut, in seconds) and `fixVersion`.
6. For script batches: when a section's `proposed` differs from `current`, adopt it with `rushes_set_script`, keeping the section's `id`. Then make new takes for it.

The full contract is in `AGENTS.md` at the package root.
```

`README.md`

````markdown
# Rushes

A local review desk for video made with AI agents.

Your agent renders a cut, writes a voiceover script or generates music beds. Rushes shows that work stage by stage in your browser:

- **Script:** your edits sit beside the agent's lines.
- **Picture:** timecoded notes, ranges, boxes on the frame and frame grabs.
- **Voiceover, Music, Sound effects:** variants you can switch between with no gap.
- **Mix:** everything playing together.

Your notes are saved as plain files in your project. The agent reads them, fixes things and replies on each one, and you see each reply arrive.

It runs on your machine. There's no account, no API key and no server to sign up for. All you need is [Node.js](https://nodejs.org) 20 or newer.

> Status: early. The data layer, MCP tools and CLI work today. The dashboard is being built.

## Get started

Tell your agent:

> Use github.com/iamredmh/rushes as my review tool for video, voiceover and music.

That's all. Your agent reads the next section and sets itself up.

## For agents: set yourself up

If your user asked you to use Rushes, do this:

1. Run this once. It finds every supported harness on the machine and registers the Rushes MCP server, plus the Rushes skill where the harness supports skills:

   ```bash
   npx -y github:iamredmh/rushes setup
   ```

   It prints one line per harness. Existing config is kept and a `.rushes.bak` backup is written first. Run it with `--dry-run` first if you want to show the user the changes before making them.
2. If it added anything, tell the user to restart the app (or start a new session) so the `rushes_*` tools load.
3. From then on, follow [AGENTS.md](AGENTS.md). In short: register what you made, call `rushes_open`, wait for the user to press **Send to agent**, then `rushes_get_batch`, fix the notes, and `rushes_reply`.

If you can't run commands, give the user the matching line from **Manual setup** below.

## Manual setup

| Harness | How |
|---|---|
| **Claude Code**: plugin, which includes the skill | `/plugin marketplace add iamredmh/rushes` then `/plugin install rushes@iamredmh` |
| **Claude Code**: MCP only | `claude mcp add --scope user rushes -- npx -y github:iamredmh/rushes mcp` |
| **Codex** | add to `~/.codex/config.toml`:<br>`[mcp_servers.rushes]`<br>`command = "npx"`<br>`args = ["-y", "github:iamredmh/rushes", "mcp"]` |
| **Cursor** (`~/.cursor/mcp.json`), **Claude Desktop** (`claude_desktop_config.json`), **Gemini CLI** (`~/.gemini/settings.json`) | `{ "mcpServers": { "rushes": { "command": "npx", "args": ["-y", "github:iamredmh/rushes", "mcp"] } } }` |

### Other harnesses

Any MCP client that can launch a local stdio server works. Point it at `npx -y github:iamredmh/rushes mcp`. Agents with no MCP support can use the CLI instead (`rushes add`, `rushes notes`, `rushes reply`): see [AGENTS.md](AGENTS.md).

ChatGPT's apps can't run local MCP servers yet. Use Codex, OpenAI's agent, instead.

## Use it yourself

```bash
cd your-project
npx -y github:iamredmh/rushes open
```

## What gets saved

```
your-project/.rushes/
  project.json   videos, versions, audio lanes and variants
  script.json    VO sections: the agent's line, your version, direction, takes
  notes.json     every note, with the agent's replies
  picks.json     which variant or take is in use
  batches.json   what you sent to the agent
  grabs/         frame grabs
```

Add `.rushes/` to git if you want your review history kept with the project. Rushes ignores its own temporary files.

## Develop

```bash
git clone https://github.com/iamredmh/rushes && cd rushes
npm install
npm test
npm run rushes -- open ../some-project
```

ffmpeg and ffprobe are optional. With them installed, Rushes reads frame rates and durations and can make browser-playable copies.

## Licence

MIT © Red Morley Hewitt
````

- [ ] **Step 6: Validate the plugin, run everything, build**

Run:
```bash
claude plugin validate .claude-plugin/plugin.json && claude plugin validate .claude-plugin/marketplace.json && claude plugin validate skills
npm test && npx tsc --noEmit && npm run build
node dist/cli/index.js setup --dry-run
```
Expected:
- `✔ Validation passed` three times.
- 79 tests passed across 11 files, with no tsc output.
- The dry run prints one line per harness: `~ would-add` for each one installed, `- not-found` for the others. It changes nothing.

- [ ] **Step 7: Try it by hand**

```bash
mkdir -p "/tmp/rushes try/renders" && cd "/tmp/rushes try"
node ~/Documents/Projects/rushes/dist/cli/index.js serve . &
node ~/Documents/Projects/rushes/dist/cli/index.js add version renders/hero_v1.mp4 --video "Hero 60s"
node ~/Documents/Projects/rushes/dist/cli/index.js status
kill %1
```
Expected: `Added Hero 60s v1`, then `picture  open` in the status, and `.rushes/project.json` holds `"file": "renders/hero_v1.mp4"`.

- [ ] **Step 8: Commit**

```bash
git add package.json .claude-plugin .mcp.json AGENTS.md skills/rushes/SKILL.md README.md test/e2e/stdio.test.ts
git commit -m "feat: Claude Code plugin, agent-first README and e2e test over stdio"
```

- [ ] **Step 9: Create the public GitHub repo (ask Red first)**

This publishes code, so stop and ask Red before running it: *"Plan 1 is green. OK to create the public repo github.com/iamredmh/rushes and push main?"* Only run it after he says yes.

```bash
gh repo create iamredmh/rushes --public --description "A local review desk for video made with AI agents" --source . --push
```

Then check it works from a stranger's side. This is the zero-setup promise:

```bash
cd "$(mktemp -d)" && npx -y github:iamredmh/rushes --help | head -1
```
Expected: the help line. Don't publish to npm. That happens in Plan 4.

---

## What comes after Plan 1

Each of these gets its own plan once the one before it lands. They're listed here so the boundaries are clear.

- **Plan 2: Dashboard, Script and Picture tabs.**
  - Build the Preact + Vite web UI, served by the same server.
  - Media routes with HTTP Range support, limited to files registered in `project.json`.
  - The SSE client, the stage tabs and their unlock state, and the shortcuts popover.
  - A server-side watcher on `.rushes/` that validates and broadcasts hand edits (spec section 4).
  - The **Script** tab: current line and your version side by side, fit bar, direction, approve, flag and revert.
  - The **Picture** tab: player, frame stepping, In/Out ranges, box drawing, frame grab (`POST /api/grabs`), and notes down the right with the to-do/done circle.
  - Send to agent, with the clipboard prompt.
  - Visual system from spec section 10. Playwright tests for each tab.
- **Plan 3: Audio tabs and the playback engine.**
  - Web Audio lanes with sample-locked switching, browser-computed waveforms, and audio-master sync with drift correction.
  - **Voiceover**: assembled read plus takes for each section, and stale-take marks.
  - **Music**: Use and Blind.
  - **Sound effects**: cue labels.
  - **Mix**: mute and solo, plus loudness via ffmpeg when present.
  - The shared notes column, with an "On" target and point, range or whole scope.
- **Plan 4: Robustness and release.**
  - Playable proxies via ffmpeg (`.rushes/proxies/`) and missing-file states.
  - `rushes doctor`, `rushes demo` (a generated sample project with every tab unlocked), and recovery from `.bak` files.
  - README GIF, CI on GitHub Actions (macOS + Linux, Node 20/22), and `npm publish` of `rushes` with `@iamredmh/rushes` reserved.
