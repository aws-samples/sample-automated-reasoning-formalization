import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/services/acp-connection.integration.test.ts"],
    globals: true,
  },
});
