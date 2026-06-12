import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
    // Minimal env defaults so Zod schema passes during test runs.
    // Real secrets must never appear here — these are test-only sentinels.
    env: {
      JWT_SECRET: "test-jwt-secret-for-vitest-minimum-32-chars!!",
      MCP_SERVER_URL: "http://localhost:3001",
      MCP_SERVICE_SECRET: "test-mcp-service-secret-vitest-32-chars!!",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/",
        "dist/",
        "src/index.ts",
        "src/types/**",
        "**/*.d.ts",
      ],
    },
  },
});
