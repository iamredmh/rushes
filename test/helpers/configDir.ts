// §32: Send to AI's Mac-wide default (agent-defaults.json) sits in the user's config folder, one file for every project.
// Each test worker gets a config folder of its own, and every test starts with no default, so a test that sets up Send
// to AI never sets up the next test's new project. A test that wants a default writes one (or answers the sheet).
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach } from "vitest";
import { defaultsPath } from "../../src/server/agent/rules.js";

process.env.XDG_CONFIG_HOME = join(tmpdir(), `rushes-test-config-${process.env.VITEST_POOL_ID ?? "0"}-${process.pid}`);

beforeEach(() => {
  rmSync(defaultsPath(), { force: true });
});
