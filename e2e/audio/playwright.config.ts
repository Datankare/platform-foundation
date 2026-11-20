import { defineConfig, devices } from "@playwright/test";

// The browser-audio gate (TASK-234; DESIGN-56f1 §9): its own config, so the main e2e run (CI
// Layer 3, playwright.config.ts with testIgnore "audio/**") never picks it up. No web server and
// no global setup: the spec starts e2e/audio/serve.mjs itself (127.0.0.1, every path under
// /audio-gate/). No retries: a flaky gate is a defect. Linux CI runs the chromium project; the
// macOS job and the owner's Mac run all three, then real Safari with safari-check.mjs.
export default defineConfig({
  testDir: ".",
  testMatch: "browser-audio.spec.ts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 660_000,
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
