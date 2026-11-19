import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15000,
    // §32: a config folder per worker, and no Send to AI default at the start of any test.
    setupFiles: ["test/helpers/configDir.ts"],
    env: {
      // Nothing a test does may open Finder/Explorer: osRevealer honours this instead of spawning.
      RUSHES_NO_REVEAL: "1",
      // Nor show a macOS notification: osNotifier does nothing with this set.
      RUSHES_NO_NOTIFY: "1",
      // R10: the agent's rules live in the user's config folder. Tests keep theirs in a temp folder instead,
      // one file per test project (the file is named from the project's path), never in ~/.config.
      XDG_CONFIG_HOME: join(tmpdir(), "rushes-test-config"),
    },
  },
});
