import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnvFile } from "../../src/startup/env.js";

const dir = () => mkdtempSync(join(tmpdir(), "forgequor-env-"));

describe("loadEnvFile", () => {
  it("sets variables from a .env file at the given root", () => {
    const root = dir();
    writeFileSync(join(root, ".env"), "FORGEQUOR_PORT=5000\n# comment\nFORGEQUOR_WORKTREES=/tmp/wt\n");
    const env: NodeJS.ProcessEnv = {};
    expect(loadEnvFile(root, env)).toBe(true);
    expect(env).toEqual({ FORGEQUOR_PORT: "5000", FORGEQUOR_WORKTREES: "/tmp/wt" });
  });

  it("does nothing when there is no .env file", () => {
    const env: NodeJS.ProcessEnv = { FORGEQUOR_PORT: "1" };
    expect(loadEnvFile(dir(), env)).toBe(false);
    expect(env).toEqual({ FORGEQUOR_PORT: "1" });
  });

  it("lets the shell win over the file", () => {
    const root = dir();
    writeFileSync(join(root, ".env"), "FORGEQUOR_PORT=5000\nFORGEQUOR_DEVELOPER_MODEL=sonnet\n");
    const env: NodeJS.ProcessEnv = { FORGEQUOR_PORT: "9999" };
    loadEnvFile(root, env);
    expect(env).toEqual({ FORGEQUOR_PORT: "9999", FORGEQUOR_DEVELOPER_MODEL: "sonnet" });
  });

  it("handles quotes and ignores blank lines", () => {
    const root = dir();
    writeFileSync(join(root, ".env"), '\nA="x y"\nB=\'z\'\n');
    const env: NodeJS.ProcessEnv = {};
    loadEnvFile(root, env);
    expect(env).toEqual({ A: "x y", B: "z" });
  });
});
