// "Sign in in Terminal" (§5.1): Rushes never runs a login itself. It opens Terminal with the agent's own
// login command for the user to run there, and never sees what they type.
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RushesError } from "../../core/errors.js";

/** How long the sign-in file is kept after Terminal is asked to open it. */
export const SIGN_IN_FILE_MS = 60_000;

/** Opens Terminal running `command`. The command is always an AgentInfo.signIn, never text from a request. */
export type TerminalOpener = (command: string) => Promise<void>;

/**
 * macOS: writes a `.command` file holding only `#!/bin/sh` and the command, and opens it in Terminal
 * (execFile, no shell). The file is in a private temporary folder, removed a minute later.
 */
export const openInTerminal: TerminalOpener = async (command) => {
  if (process.platform !== "darwin") {
    throw new RushesError(`Rushes can open Terminal only on a Mac. Run \`${command}\` in a terminal, then try again.`, 501, "no_terminal");
  }
  const dir = await mkdtemp(join(tmpdir(), "rushes-sign-in-"));
  const file = join(dir, "sign-in.command");
  await writeFile(file, `#!/bin/sh\n${command}\n`, { mode: 0o700 });
  await chmod(file, 0o700);
  // Terminal has read the file long before this: the folder goes, quietly, whatever happens.
  setTimeout(() => void rm(dir, { recursive: true, force: true }).catch(() => undefined), SIGN_IN_FILE_MS).unref();
  await new Promise<void>((resolve, reject) => {
    execFile("open", ["-a", "Terminal", file], (error) => (error ? reject(error) : resolve()));
  });
};
