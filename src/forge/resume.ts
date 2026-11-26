import type pg from "pg";
import { describeFailure } from "./checks.js";

/** Where a Run picks up its Developer and Checks loop, within its current Iteration. */
export interface ResumePoint {
  /** The Developer attempt to run next, or the one whose Checks are still to run. */
  attempt: number;
  /** The Check output the Developer is sent back with. */
  failedCheck: string | undefined;
  /** The Developer's work for `attempt` is already done: go straight to its Checks. */
  skipDeveloper: boolean;
  /** Every Check already passed: go on to the pull request. */
  checksDone: boolean;
}

/**
 * Works out where a (re)started Run picks up from what is recorded: after a Quota pause or a restart, the Step it was in
 * starts again from scratch, with the earlier failed Check's output when there was one.
 */
export async function resumePoint(pool: pg.Pool, runId: number, iteration: number, checkCount: number): Promise<ResumePoint> {
  const { rows: done } = await pool.query(
    "SELECT max(attempt) AS attempt FROM step_attempts WHERE run_id = $1 AND iteration = $2 AND step = 'developer' AND status = 'succeeded'",
    [runId, iteration],
  );
  const worked: number | null = done[0].attempt;
  if (!worked) return { attempt: 1, failedCheck: undefined, skipDeveloper: false, checksDone: false };

  const { rows: checks } = await pool.query("SELECT * FROM check_results WHERE run_id = $1 AND iteration = $2 AND attempt = $3 ORDER BY id", [runId, iteration, worked]);
  const failed = checks.find((c) => c.exit_status !== 0);
  if (failed) {
    const failedCheck = describeFailure({ command: failed.command, exitStatus: failed.exit_status, output: failed.output });
    return { attempt: worked + 1, failedCheck, skipDeveloper: false, checksDone: false };
  }
  if (checks.length === checkCount) return { attempt: worked, failedCheck: undefined, skipDeveloper: true, checksDone: true };
  // The Checks were interrupted part way: run them all again on the Developer's work.
  await pool.query("DELETE FROM check_results WHERE run_id = $1 AND iteration = $2 AND attempt = $3", [runId, iteration, worked]);
  return { attempt: worked, failedCheck: undefined, skipDeveloper: true, checksDone: false };
}
