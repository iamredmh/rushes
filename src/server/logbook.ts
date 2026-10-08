// §22: the Change Log's keeper on the server. One per store, so every route, the found scanner and
// the state share its backfill and its cache. Every write goes through store.update, so writes
// serialise with each other (§22.9).
import { rename, stat } from "node:fs/promises";
import { CorruptFileError } from "../core/errors.js";
import { appendEvent, backfillLog, logView, type LogEvent, type LogQuery, type LogView, type UndatedContext } from "../core/log.js";
import { LOG_MAX, logMarkdown, type LogBy } from "../core/logText.js";
import type { LogEntry, LogFile, Project } from "../core/schema.js";
import type { Store } from "../core/store.js";

/** What the header's button needs (§22.8, R19): the file's rev, its newest line as id@at, and its size. */
export interface LogHead {
  rev: number;
  mark: string | null;
  total: number;
}

/** R8: the dashboard sends its project id with every request (web/src/api.ts); MCP, the CLI and curl don't. */
export function byOf(projectHeader: string | undefined): "user" | "agent" {
  return projectHeader ? "user" : "agent";
}

const books = new WeakMap<Store, LogBook>();

/** The one LogBook for `store`, shared by the app's routes and the found scanner. */
export function logBookFor(store: Store): LogBook {
  let book = books.get(store);
  if (!book) {
    book = new LogBook(store);
    books.set(store, book);
  }
  return book;
}

/** Thrown inside an update to leave the file exactly as it was: nothing is written and rev stays. */
const UNCHANGED = Symbol("unchanged");

export class LogBook {
  /** When this log began, for this server: the backfill reads in only what's older (R6). */
  private readonly since = Date.now();
  private readying: Promise<void> | null = null;
  private fixing: Promise<LogFile> | null = null;
  private cache: { key: string; file: LogFile } | null = null;
  /** Lines that couldn't be written since this server started; /api/health carries it for `rushes doctor` (ruling e). */
  failures = 0;

  constructor(private readonly store: Store) {}

  /** Backfills once (§22.6) and sets a corrupt file aside (R7). Never throws. Concurrent callers share one run. */
  ready(): Promise<void> {
    this.readying ??= this.prepare()
      .catch((e: unknown) => console.error(`Rushes: the Change Log isn't ready: ${(e as Error).message}`))
      .finally(() => {
        this.readying = null;
      });
    return this.readying;
  }

  private async prepare(): Promise<void> {
    const file = await this.read(true);
    // Ruling b: once backfilled, reading never writes.
    if (file.backfilled) return;
    const [project, batches, script] = await Promise.all([this.store.read("project"), this.store.read("batches"), this.store.read("script")]);
    // update runs one at a time per file, so a second LogBook racing this one finds the marker set
    // and leaves the file untouched: the history is read in once and written once (Review Focus 1).
    await this.store
      .update("log", (f) => {
        if (f.backfilled) throw UNCHANGED;
        backfillLog(f, { project, batches, script }, this.since);
      })
      .catch((e: unknown) => {
        if (e !== UNCHANGED) throw e;
      });
  }

  /** The file, parsed once per change on disk. With `fix`, a corrupt one is set aside as log.json.bad and the log starts again (R7). */
  private async read(fix: boolean): Promise<LogFile> {
    const path = this.store.path("log");
    const st = await stat(path).catch(() => null);
    const key = st ? `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}` : "missing";
    if (this.cache?.key === key) return this.cache.file;
    try {
      const file = await this.store.read("log");
      this.cache = { key, file };
      return file;
    } catch (e) {
      if (!fix || !(e instanceof CorruptFileError)) throw e;
      // Requests that meet the same bad file at once share one fix, so it's set aside once.
      this.fixing ??= this.setAside(path).finally(() => {
        this.fixing = null;
      });
      return this.fixing;
    }
  }

  private async setAside(path: string): Promise<LogFile> {
    // Another server on the folder may have moved it already; then there's nothing to move.
    await rename(path, `${path}.bad`).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
    this.store.forget("log");
    // It "reads as empty" (§22.9): a fresh log, marked as backfilled, so history isn't read in again.
    const { data } = await this.store.update("log", (f) => {
      f.backfilled = true;
    });
    console.error(`Rushes: ${path} couldn't be read, so it was set aside as log.json.bad and the Change Log started again.`);
    return data;
  }

  /**
   * §22.5: writes one event. Routes pass a function that builds it, so a builder that throws is
   * caught here too (M1). A failure is reported on the console, counted, and returns null: the
   * change it describes has already been made.
   */
  async add(make: LogEvent | (() => LogEvent), by: LogBy, at: Date = new Date()): Promise<LogEntry | null> {
    try {
      const event = typeof make === "function" ? make() : make;
      await this.ready();
      const { result } = await this.store.update("log", (f) => appendEvent(f, event, by, at));
      return result;
    } catch (e) {
      this.failures += 1;
      console.error(`Rushes: couldn't write to the Change Log: ${(e as Error).message}`);
      return null;
    }
  }

  /** §22.7: a page of the log, newest first. The first read backfills (R6). */
  async view(q: LogQuery, ctx: UndatedContext): Promise<LogView> {
    await this.ready();
    return logView(await this.read(true), q, ctx);
  }

  /** The head for the header's dot. Read-only: it never backfills or fixes, and null means it couldn't be read. */
  async head(): Promise<LogHead | null> {
    try {
      const f = await this.read(false);
      const last = f.entries[f.entries.length - 1];
      return { rev: f.rev, mark: last ? `${last.id}@${last.at}` : null, total: f.entries.length };
    } catch {
      return null;
    }
  }

  /** §22.7: the whole log as Markdown, what Export writes. */
  async markdown(ctx: UndatedContext & { project: Pick<Project, "name"> }, now: Date): Promise<string> {
    const v = await this.view({ limit: LOG_MAX }, ctx);
    return logMarkdown({ project: ctx.project.name, entries: v.entries, undated: v.undated, dropped: v.dropped, now });
  }
}
