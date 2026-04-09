import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: [
      "src/services/acp-connection.integration.test.ts",
      "src/**/*.e2e.test.ts",
    ],
    globals: true,
  },
});
