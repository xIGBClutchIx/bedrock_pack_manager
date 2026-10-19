import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    include: ["tests/**/*.test.ts", "src/**/*.test.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text", "lcov"],
    },
  },
});
