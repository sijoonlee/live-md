import {defineConfig, devices} from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  // The prototype serves a single shared document, so tests must not run
  // concurrently against the same server or their edits race.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  projects: [{name: "chromium", use: {...devices["Desktop Chrome"]}}],
  webServer: {
    // Use a disposable data dir so each run starts from an empty document and
    // persisted state does not leak between runs (see persistence, M10).
    command: "rm -rf .playwright-data && npm run build && DATA_DIR=.playwright-data PORT=4173 npm start",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
