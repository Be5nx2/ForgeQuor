import type pg from "pg";
import type { StepResult } from "../runner/runner.js";
import type { CheckOutcome } from "./checks.js";
import { resumePoint, type ResumePoint } from "./resume.js";

/** What a Step attempt is recorded with when it starts. */
export interface AttemptStart {
  /** The Step's name in the Run's record ("developer", "artist"). */
  step: string;
  attempt: number;
  runner: string;
  model?: string;
  /** The Asset the attempt works on, for the Artist. */
  assetId?: number;
}

/** The Run's own records, and the only way a Workflow reads or writes them: no Workflow holds the database pool. */
export interface RunRecords {
  /** Records a Step attempt as running and returns its id. */
  startAttempt(start: AttemptStart): Promise<number>;
  /** Closes a Step attempt with its result and the Runner's raw events. */
  finishAttempt(attemptId: number, result: StepResult, eventLog: string): Promise<void>;
  /** Whether the Project's setup commands already passed for this Run. */
  setupDone(): Promise<boolean>;
  markSetupDone(): Promise<void>;
  /** Where the Developer and Checks loop picks up, within the Run's current Iteration. */
  resumePoint(checkCount: number): Promise<ResumePoint>;
  /** Records the outcome of every Check of a Developer attempt. */
  recordChecks(attempt: number, outcomes: CheckOutcome[]): Promise<void>;
  /** The Feedback of every rejection of this Run, oldest first. */
  earlierFeedbacks(): Promise<string[]>;
  /** Remembers the pull request opened for the Run. */
  recordPullRequest(number: number, url: string): Promise<void>;
  /** Whether the Review Brief was already posted on the pull request. */
  briefPosted(): Promise<boolean>;
  markBriefPosted(): Promise<void>;
}

export function createRunRecords(pool: pg.Pool, runId: number, iteration: number): RunRecords {
  return {
    async startAttempt(s) {
      const { rows } = await pool.query(
        `INSERT INTO step_attempts (run_id, iteration, step, attempt, runner, model, status, asset_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'running', $7) RETURNING id`,
        [runId, iteration, s.step, s.attempt, s.runner, s.model ?? null, s.assetId ?? null],
      );
      return Number(rows[0].id);
    },
    async finishAttempt(attemptId, result, eventLog) {
      await pool.query(
        `UPDATE step_attempts SET status = $2, ended_at = now(), summary = $3, error = $4, quota_resets_at = $5, event_log = $6
         WHERE id = $1`,
        [
          attemptId,
          result.status,
          result.status === "succeeded" ? result.summary : null,
          result.status === "failed" ? result.error : null,
          result.status === "quota_exhausted" ? result.resetsAt : null,
          eventLog,
        ],
      );
    },
    async setupDone() {
      const { rows } = await pool.query("SELECT setup_done FROM runs WHERE id = $1", [runId]);
      return rows[0].setup_done;
    },
    async markSetupDone() {
      await pool.query("UPDATE runs SET setup_done = true WHERE id = $1", [runId]);
    },
    resumePoint: (checkCount) => resumePoint(pool, runId, iteration, checkCount),
    async recordChecks(attempt, outcomes) {
      for (const c of outcomes) {
        await pool.query(
          "INSERT INTO check_results (run_id, iteration, attempt, command, exit_status, output) VALUES ($1, $2, $3, $4, $5, $6)",
          [runId, iteration, attempt, c.command, c.exitStatus, c.output],
        );
      }
    },
    async earlierFeedbacks() {
      const { rows } = await pool.query("SELECT feedback FROM gates WHERE run_id = $1 AND decision = 'reject' ORDER BY id", [runId]);
      return rows.map((r) => r.feedback);
    },
    async recordPullRequest(number, url) {
      await pool.query("UPDATE runs SET pr_number = $2, pr_url = $3 WHERE id = $1", [runId, number, url]);
    },
    async briefPosted() {
      const { rows } = await pool.query("SELECT brief_posted FROM runs WHERE id = $1", [runId]);
      return rows[0].brief_posted;
    },
    async markBriefPosted() {
      await pool.query("UPDATE runs SET brief_posted = true WHERE id = $1", [runId]);
    },
  };
}
