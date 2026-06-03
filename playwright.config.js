import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "rm -f data/e2e-test.db data/e2e-test.db-shm data/e2e-test.db-wal && PORT=3100 NODE_ENV=e2e SESSION_SECRET=e2e-test-secret DB_PATH=./data/e2e-test.db BACKUP_ENABLED=false node server.js",
    url: "http://127.0.0.1:3100/healthz",
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
