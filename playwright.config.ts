import {defineConfig, devices} from "@playwright/test";
import {authFile} from "./tests/e2e/auth-file";

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
  projects: [
    {name: "setup", testMatch: /auth\.setup\.ts/},
    {
      name: "chromium",
      // Tests run signed in by default (editing requires a human session); the
      // signed-out auth tests opt out with an empty storageState.
      use: {...devices["Desktop Chrome"], storageState: authFile},
      dependencies: ["setup"],
    },
  ],
  webServer: {
    // Use a disposable data dir so each run starts from an empty document and
    // persisted state does not leak between runs (see persistence, M10).
    command: "rm -rf .playwright-data && npm run build && DATA_DIR=.playwright-data PORT=4173 AUTH_DEV_LOGIN=1 npm start",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
