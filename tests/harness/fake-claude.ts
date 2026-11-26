import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeClaudeScript {
  /** Lines written to stdout, in order. */
  stdout: string[];
  stderr?: string;
  exitCode?: number;
  /** Kill the process with this signal after printing, instead of exiting. */
  killWith?: NodeJS.Signals;
}

export interface Invocation {
  cwd: string;
  args: string[];
  stdin: string;
}

export interface FakeClaude {
  /** Environment to hand the Runner so `claude` resolves to the fake first. */
  env: NodeJS.ProcessEnv;
  /** What the fake was last called with. */
  lastInvocation(): Invocation;
}

const SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const dir = process.env.FAKE_CLAUDE_DIR;
const script = JSON.parse(fs.readFileSync(dir + "/script.json", "utf8"));
const stdin = fs.readFileSync(0, "utf8");
fs.writeFileSync(dir + "/invocation.json", JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), stdin }));
for (const line of script.stdout) process.stdout.write(line + "\\n");
if (script.stderr) process.stderr.write(script.stderr);
if (script.killWith) process.kill(process.pid, script.killWith);
process.exit(script.exitCode ?? 0);
`;

/** A `claude` executable that replays a script, placed first on PATH via the returned env. */
export function createFakeClaude(script: FakeClaudeScript): FakeClaude {
  const dir = mkdtempSync(join(tmpdir(), "forgequor-fake-claude-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, SCRIPT);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, "script.json"), JSON.stringify(script));
  return {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_CLAUDE_DIR: dir },
    lastInvocation: () => JSON.parse(readFileSync(join(dir, "invocation.json"), "utf8")),
  };
}
