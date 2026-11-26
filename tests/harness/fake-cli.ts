import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeCliScript {
  /** Lines written to stdout, in order. */
  stdout: string[];
  stderr?: string;
  exitCode?: number;
  /** Kill the process with this signal after printing, instead of exiting. */
  killWith?: NodeJS.Signals;
  /** Files created (parents included) before anything is printed, as absolute path and content. */
  files?: { path: string; content: string }[];
  /** Start a long-lived grandchild process (its pid is readable through `grandchildPid`), then never finish on its own. */
  hang?: boolean;
}

export interface Invocation {
  cwd: string;
  args: string[];
  stdin: string;
}

export interface FakeCli {
  /** Environment to hand the Runner so the CLI resolves to the fake first. */
  env: NodeJS.ProcessEnv;
  /** What the fake was last called with. */
  lastInvocation(): Invocation;
  /** Pid of the grandchild a `hang` script started, or null until it exists. */
  grandchildPid(): number | null;
}

const SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const dir = process.env.FAKE_CLI_DIR;
const script = JSON.parse(fs.readFileSync(dir + "/script.json", "utf8"));
const stdin = fs.readFileSync(0, "utf8");
fs.writeFileSync(dir + "/invocation.json", JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), stdin }));
for (const f of script.files ?? []) {
  fs.mkdirSync(require("node:path").dirname(f.path), { recursive: true });
  fs.writeFileSync(f.path, f.content);
}
if (script.hang) {
  const child = require("node:child_process").spawn("sleep", ["60"], { stdio: "ignore" });
  fs.writeFileSync(dir + "/grandchild.pid", String(child.pid));
  setInterval(() => {}, 1000);
  return;
}
for (const line of script.stdout) process.stdout.write(line + "\\n");
if (script.stderr) process.stderr.write(script.stderr);
if (script.killWith) process.kill(process.pid, script.killWith);
process.exit(script.exitCode ?? 0);
`;

/** A CLI executable (`claude` by default) that replays a script, placed first on PATH via the returned env. */
export function createFakeCli(script: FakeCliScript, name = "claude"): FakeCli {
  const dir = mkdtempSync(join(tmpdir(), `forgequor-fake-${name}-`));
  const bin = join(dir, name);
  writeFileSync(bin, SCRIPT);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, "script.json"), JSON.stringify(script));
  return {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_CLI_DIR: dir },
    lastInvocation: () => JSON.parse(readFileSync(join(dir, "invocation.json"), "utf8")),
    grandchildPid: () => {
      try {
        return Number(readFileSync(join(dir, "grandchild.pid"), "utf8"));
      } catch {
        return null;
      }
    },
  };
}
