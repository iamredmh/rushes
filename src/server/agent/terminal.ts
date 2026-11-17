// "Sign in in Terminal" (§5.1): Rushes never runs a login itself. It opens Terminal with the agent's own
// login command for the user to run there, and never sees what they type.
import { execFile } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RushesError } from "../../core/errors.js";

/** Opens Terminal running `command`. The command is always an AgentInfo.signIn, never text from a request. */
export type TerminalOpener = (command: string) => Promise<void>;

/**
 * macOS: writes a `.command` file holding only `#!/bin/sh` and the command, and opens it in Terminal
 * (execFile, no shell). The file is left in a private temporary folder: Terminal reads it as it opens.
 */
export const openInTerminal: TerminalOpener = async (command) => {
  if (process.platform !== "darwin") {
    throw new RushesError(`Rushes can open Terminal only on a Mac. Run \`${command}\` in a terminal, then try again.`, 501, "no_terminal");
  }
  const dir = await mkdtemp(join(tmpdir(), "rushes-sign-in-"));
  const file = join(dir, "sign-in.command");
  await writeFile(file, `#!/bin/sh\n${command}\n`, { mode: 0o700 });
  await chmod(file, 0o700);
  await new Promise<void>((resolve, reject) => {
    execFile("open", ["-a", "Terminal", file], (error) => (error ? reject(error) : resolve()));
  });
};
