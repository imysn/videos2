import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    testTimeout: 30000,
    coverage: {
      include: ["packages/room-core/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: { branches: 90 },
    },
  },
});
