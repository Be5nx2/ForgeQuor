import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { loadEnvFile } from "./src/startup/env.js";

// Same settings as the app: a local .env (e.g. FORGEQUOR_SMOKE_REPO) applies to tests too; the shell still wins.
loadEnvFile(fileURLToPath(new URL(".", import.meta.url)));

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./vitest.global-setup.ts"],
    testTimeout: 20_000,
  },
});
