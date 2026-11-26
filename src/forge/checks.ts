import { spawn } from "node:child_process";
import { describeDuration } from "../duration.js";
import { forgetProcessGroup, killProcessGroup, trackProcessGroup } from "../process-group.js";

export interface CheckOutcome {
  command: string;
  /** Exit status; null when the command was killed (by a signal or the timeout). */
  exitStatus: number | null;
  /** Standard output and error, interleaved, tail-truncated. */
  output: string;
}

const MAX_OUTPUT = 20_000;
/** How long one Check command may run unless told otherwise. */
export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;

export interface CheckOptions {
  /** Longest a single command may run before it and everything it started is killed. */
  timeoutMs?: number;
  /** Aborting it kills the running command the same way and skips the ones after it. */
  signal?: AbortSignal;
}

export const passed = (c: CheckOutcome) => c.exitStatus === 0;

function runOne(command: string, cwd: string, { timeoutMs = DEFAULT_CHECK_TIMEOUT_MS, signal }: CheckOptions): Promise<CheckOutcome> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ command, exitStatus: null, output: "[not run: the Run was stopped]" });
      return;
    }
    // Its own process group, so the whole tree (a build tool's children included) can be killed at once.
    const child = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    trackProcessGroup(child.pid);
    let output = "";
    const collect = (chunk: string) => {
      output = (output + chunk).slice(-MAX_OUTPUT);
    };
    child.stdout.setEncoding("utf8").on("data", collect);
    child.stderr.setEncoding("utf8").on("data", collect);
    const timer = setTimeout(() => {
      collect(`\n[killed after ${describeDuration(timeoutMs)}]`);
      killProcessGroup(child.pid);
    }, timeoutMs);
    const stop = () => {
      collect("\n[killed: the Run was stopped]");
      killProcessGroup(child.pid);
    };
    signal?.addEventListener("abort", stop, { once: true });
    const done = () => {
      forgetProcessGroup(child.pid);
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    };
    child.on("error", (e) => {
      done();
      resolve({ command, exitStatus: null, output: `could not start: ${e.message}` });
    });
    // Whatever the command left running in the background goes with it, so it cannot hold the Check open.
    child.on("exit", () => killProcessGroup(child.pid));
    child.on("close", (code) => {
      done();
      resolve({ command, exitStatus: code, output });
    });
  });
}

/** Runs the commands in order in `cwd`, stopping after the first failure. Returns what ran. */
export async function runChecks(commands: string[], cwd: string, options: CheckOptions = {}): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  for (const command of commands) {
    const outcome = await runOne(command, cwd, options);
    outcomes.push(outcome);
    if (!passed(outcome)) break;
  }
  return outcomes;
}

/** A failed Check as text, for the Developer's retry prompt and for an Escalation's evidence. */
export function describeFailure(c: CheckOutcome): string {
  const status = c.exitStatus === null ? "was killed" : `exited with status ${c.exitStatus}`;
  return `$ ${c.command}\n(${status})\n\n${c.output.trim()}`;
}
