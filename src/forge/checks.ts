import { spawn } from "node:child_process";

export interface CheckOutcome {
  command: string;
  /** Exit status; null when the command was killed (by a signal or the timeout). */
  exitStatus: number | null;
  /** Standard output and error, interleaved, tail-truncated. */
  output: string;
}

const MAX_OUTPUT = 20_000;
const TIMEOUT_MS = 10 * 60 * 1000;

export const passed = (c: CheckOutcome) => c.exitStatus === 0;

function runOne(command: string, cwd: string): Promise<CheckOutcome> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: string) => {
      output = (output + chunk).slice(-MAX_OUTPUT);
    };
    child.stdout.setEncoding("utf8").on("data", collect);
    child.stderr.setEncoding("utf8").on("data", collect);
    const timer = setTimeout(() => {
      collect(`\n[killed after ${TIMEOUT_MS / 60000} minutes]`);
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ command, exitStatus: null, output: `could not start: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ command, exitStatus: code, output });
    });
  });
}

/** Runs the commands in order in `cwd`, stopping after the first failure. Returns what ran. */
export async function runChecks(commands: string[], cwd: string): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  for (const command of commands) {
    const outcome = await runOne(command, cwd);
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
