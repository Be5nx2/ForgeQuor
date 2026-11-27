import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { forgetProcessGroup, killProcessGroup, trackProcessGroup } from "../process-group.js";

export interface CliCall {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the CLI's standard input, which is then closed. */
  stdin: string;
  /** Aborting it kills the CLI and everything it started. */
  signal?: AbortSignal;
}

/** How a CLI call ended: it ran to its end (whatever its exit status), or it could not run at all. */
export type CliOutcome =
  | { ran: true; code: number | null; signal: NodeJS.Signals | null; stderr: string }
  | { ran: false; error: string };

/**
 * Runs a Runner's CLI in its own process group, so a cancel (or Forgequor stopping) ends it and every tool it started.
 * Every complete line of its standard output goes to `onLine` as it arrives. Never rejects.
 */
export function runCli(call: CliCall, onLine: (line: string) => void): Promise<CliOutcome> {
  return new Promise((resolve) => {
    if (!existsSync(call.cwd)) return resolve({ ran: false, error: `working directory does not exist: ${call.cwd}` });
    if (call.signal?.aborted) return resolve({ ran: false, error: "the Step was cancelled before it started" });

    const child = spawn(call.command, call.args, { cwd: call.cwd, env: call.env ?? process.env, detached: true });
    trackProcessGroup(child.pid);
    const cancel = () => killProcessGroup(child.pid);
    call.signal?.addEventListener("abort", cancel, { once: true });
    let buffer = "";
    let stderr = "";
    let settled = false;
    const finish = (r: CliOutcome) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        onLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (e: NodeJS.ErrnoException) =>
      finish({ ran: false, error: e.code === "ENOENT" ? `${call.command} CLI not found on PATH` : `could not start ${call.command}: ${e.message}` }),
    );
    child.on("close", (code, signal) => {
      call.signal?.removeEventListener("abort", cancel);
      forgetProcessGroup(child.pid);
      onLine(buffer);
      finish({ ran: true, code, signal, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(call.stdin);
  });
}
