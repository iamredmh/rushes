import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15000,
    // Nothing a test does may open Finder/Explorer: osRevealer honours this instead of spawning.
    env: { RUSHES_NO_REVEAL: "1" },
  },
});
