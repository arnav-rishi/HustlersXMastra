import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    isolate: true,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
