import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile, copyFile, access } from "node:fs/promises";
import { join } from "node:path";
import { FILES, type FileData, type FileKey } from "./schema.js";
import { CorruptFileError, InvalidError, RevConflictError } from "./errors.js";

export const RUSHES_DIR = ".rushes";

const GITIGNORE = "proxies/\npeaks/\nserver.json\nserver.log\n*.tmp\n*.bak\n";

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
