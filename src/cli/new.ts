import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { oneLineOf } from "../core/labels.js";
import { Store } from "../core/store.js";

// §24.10 step 1: `rushes new <folder>` starts a film in Rushes. It makes the project, the folders
// README and AGENTS recommend, and a brief.md for the agent to fill in with the user. The Assets tab
// already finds a Markdown file in the project root, so nothing here needs the dashboard to change.

export const BRIEF_FILE = "brief.md";

/** The sections of brief.md, in order. AGENTS.md names every one; test/docs-start.test.ts keeps the two in step. */
export const BRIEF_SECTIONS = ["Title", "Purpose", "Audience", "Length and formats", "Tone", "Include and avoid", "Built with", "Open questions", "References"] as const;

export function briefTemplate(name: string): string {
  return `# Brief: ${name}

Status: draft

Your agent drafts this with you. Change anything. Nothing gets built until you say the brief is approved.

## Title
_The working title._

## Purpose
_What this film is for, in one sentence._

## Audience
_Who watches it, and what they already know._

## Length and formats
Length: _seconds_
Formats: _for example 16:9, 9:16_

## Tone
_How it should sound and feel. A film or two you would point at._

## Include and avoid
Include: _what has to be in it._
Avoid: _what must not be._

## Built with
_The tool your agent will build it in, or leave this blank._

## Open questions
_Ideas floated but not settled, and anything the agent had to guess._

## References
- _Brand files, screenshots, a film you like._
`;
}

export interface NewProject {
  /** The project folder, absolute. */
  dir: string;
  /** False when a brief.md was already there and was left alone. */
  briefWritten: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/**
 * Turns `folder` into a Rushes project ready for the planning flow. The folder may be new or already
 * hold files; nothing in it is overwritten. A folder that is already a Rushes project is refused.
 */
export async function makeProject(folder: string, opts: { name?: string } = {}): Promise<NewProject> {
  const root = resolve(folder);
  if (await exists(join(root, ".rushes"))) {
    throw new Error(`${root} is already a Rushes project. Open it with: rushes open "${root}"`);
  }
  // One clean line for both the project name and the brief's title; a blank name falls back to the folder's.
  const name = oneLineOf(opts.name ?? "") || basename(root) || "Film";
  await Promise.all(["renders", join("audio", "voiceover"), join("audio", "music"), join("audio", "sfx")].map((d) => mkdir(join(root, d), { recursive: true })));
  await new Store(root).init(name);
  let briefWritten = true;
  try {
    // "wx": fails instead of replacing a brief the user already wrote.
    await writeFile(join(root, BRIEF_FILE), briefTemplate(name), { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    briefWritten = false;
  }
  return { dir: root, briefWritten };
}
