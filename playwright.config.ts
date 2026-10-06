import { defineConfig, devices } from "@playwright/test";

// Browser tests drive the built dashboard (npm run build first) against a real Rushes server per test.
// Every test runs in Chromium and in WebKit (Safari's engine), at the same viewport (§19.4).
const viewport = { width: 1440, height: 900 };

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // On CI an HTML report is kept as well, uploaded when a run fails.
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 30_000,
  use: { trace: "retain-on-failure" },
  projects: [
    // Muted, as WebKit is in e2e/fixture.ts: the fixtures are 440 Hz tones and a run shouldn't beep.
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport, launchOptions: { args: ["--mute-audio"] } } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport } },
  ],
});
