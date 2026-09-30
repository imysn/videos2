import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: "artifacts/verification/e2e.json" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:3001",
    headless: true,
    launchOptions: {
      executablePath: "/usr/bin/chromium",
      args: ["--no-sandbox"],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "RAVE_CONFIG_FILE=.local/test/config.json pnpm start",
    url: "http://127.0.0.1:3001/health/ready",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
