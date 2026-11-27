import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { loadEnvFile } from "../../src/startup/env.js";

// Acceptance (BA) suite: real Forgequor, real GitHub sandbox, real Agents. Never part of `npm test`.
const root = fileURLToPath(new URL("../..", import.meta.url));
loadEnvFile(root);

export default defineConfig({
  root,
  test: {
    include: ["tests/acceptance/**/*.ba.ts"],
    globalSetup: ["./vitest.global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30 * 60_000,
    hookTimeout: 10 * 60_000,
    bail: 0,
  },
});
