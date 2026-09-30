import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({
  ...base,
  testDir: "tests/soak",
  timeout: 1900000,
  use: { ...base.use, trace: "off" },
  reporter: [
    ["list"],
    ["json", { outputFile: "artifacts/sync/soak-results.json" }],
  ],
});
