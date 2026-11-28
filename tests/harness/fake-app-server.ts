import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { until } from "./wait.js";

/** A `codex` that speaks the app-server protocol from a script (`body` runs for each request `m`, and may send `ANSWER`, the recorded answer given). */
export function fakeAppServer(body: string, answer: object = {}) {
  const dir = mkdtempSync(join(tmpdir(), "forgequor-fake-appserver-"));
  const bin = join(dir, "codex");
  const script = join(dir, "server.cjs");
  // A shell records the pid and becomes node (same pid): the pid is known as soon as the process exists, however long node takes to start.
  writeFileSync(bin, `#!/bin/sh\necho $$ > ${JSON.stringify(join(dir, "pid"))}\nexec node ${JSON.stringify(script)} "$@"\n`);
  writeFileSync(
    script,
    `
const fs = require("node:fs");
const log = (m) => fs.appendFileSync(${JSON.stringify(join(dir, "seen.log"))}, JSON.stringify(m) + "\\n");
fs.writeFileSync(${JSON.stringify(join(dir, "args.json"))}, JSON.stringify(process.argv.slice(2)));
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const ANSWER = ${JSON.stringify(answer)};
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    log(m.method ?? m);
    ${body}
  }
});
`,
  );
  chmodSync(bin, 0o755);
  return {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    seen: (): string[] => readFileSync(join(dir, "seen.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)),
    args: (): string[] => JSON.parse(readFileSync(join(dir, "args.json"), "utf8")),
    /** The server's pid; null when it was stopped before it ran at all (a loaded machine can be slower than the short wait of a test). */
    pid: (): number | null => (existsSync(join(dir, "pid")) ? Number(readFileSync(join(dir, "pid"), "utf8")) : null),
  };
}

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Waits until the fake server's process is gone (what only the operating system can tell). */
export const stopped = (fake: { pid: () => number | null }) => until(() => expect(fake.pid() === null || !alive(fake.pid()!)).toBe(true));

