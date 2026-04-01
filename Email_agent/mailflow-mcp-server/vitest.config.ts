import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/tests/**/*.test.ts"],
    env: {
      // Prevent MOCK_MAILFLOW=true (from .env) from failing the env validation
      // refine() which forbids it outside of NODE_ENV=development.
      // Tests that need mock behavior construct mocks directly (vi.fn / MockMailFlowApiClient).
      MOCK_MAILFLOW: "false",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/tests/**",
        "src/integration/**",
        "src/index.ts",
      ],
    },
  },
});
