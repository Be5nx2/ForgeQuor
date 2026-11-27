import type pg from "pg";
import type { StepResult } from "../runner/runner.js";
import type { CheckOutcome } from "./checks.js";
import type { GateDecision } from "./types.js";
import { createStepStates, type StepStates } from "./step-states.js";
import type { WorkflowInput } from "./workflow-definition.js";

/** What a Step attempt is recorded with when it starts. */
export interface AttemptStart {
  /** The Step's name in the Run's record ("developer", "artist"). */
  step: string;
  attempt: number;
  runner: string;
  model?: string;
  /** The Asset the attempt works on, for the Artist. */
  assetId?: number;
  /** The Workflow Step the attempt belongs to. */
  stepId?: string;
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
  /** Where each Step of the Run stands in its current Iteration. */
  steps: StepStates;
  /** The inputs the Run has: given at launch, or produced by a Step. */
  inputs(): Promise<WorkflowInput[]>;
  /** Adds an input the Step `stepId` produced; it goes again when that Step is replayed. */
  giveInput(input: WorkflowInput, stepId: string): Promise<void>;
  /** The decision of the latest Gate the Step opened in the current Iteration: null when it is still open, undefined when it opened none. */
  gateDecision(stepId: string): Promise<GateDecision | null | undefined>;
  /** Forgets the Check results of a Developer attempt, such as those an interrupted run of the Checks left. */
  clearChecks(attempt: number): Promise<void>;
  /** Records the outcome of every Check of a Developer attempt. */
  recordChecks(attempt: number, outcomes: CheckOutcome[]): Promise<void>;
  /** The Feedback of every rejection of this Run, and of every retry or go back from an Escalation that was given one, oldest first. */
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
        `INSERT INTO step_attempts (run_id, iteration, step, attempt, runner, model, status, asset_id, step_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'running', $7, $8) RETURNING id`,
        [runId, iteration, s.step, s.attempt, s.runner, s.model ?? null, s.assetId ?? null, s.stepId ?? null],
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
    steps: createStepStates(pool, runId, iteration),
    async inputs() {
      const { rows } = await pool.query("SELECT inputs FROM runs WHERE id = $1", [runId]);
      return rows[0].inputs;
    },
    async giveInput(input, stepId) {
      const added = await pool.query("UPDATE runs SET inputs = inputs || to_jsonb($2::text) WHERE id = $1 AND NOT inputs ? $2", [runId, input]);
      if (!added.rowCount) return;
      await pool.query(
        "UPDATE step_states SET produced = produced || to_jsonb($4::text) WHERE run_id = $1 AND iteration = $2 AND step = $3",
        [runId, iteration, stepId, input],
      );
    },
    async gateDecision(stepId) {
      const { rows } = await pool.query(
        `SELECT decision FROM gates WHERE run_id = $1 AND iteration = $2 AND step = $3
           AND id > COALESCE((SELECT since_gate FROM step_states WHERE run_id = $1 AND iteration = $2 AND step = $3), 0)
         ORDER BY id DESC LIMIT 1`,
        [runId, iteration, stepId],
      );
      return rows[0] ? rows[0].decision : undefined;
    },
    async clearChecks(attempt) {
      await pool.query("DELETE FROM check_results WHERE run_id = $1 AND iteration = $2 AND attempt = $3", [runId, iteration, attempt]);
    },
    async recordChecks(attempt, outcomes) {
      for (const c of outcomes) {
        await pool.query(
          "INSERT INTO check_results (run_id, iteration, attempt, command, exit_status, output) VALUES ($1, $2, $3, $4, $5, $6)",
          [runId, iteration, attempt, c.command, c.exitStatus, c.output],
        );
      }
    },
    async earlierFeedbacks() {
      const { rows } = await pool.query("SELECT feedback FROM gates WHERE run_id = $1 AND (decision = 'reject' OR (decision IN ('retry', 'go_back') AND feedback IS NOT NULL)) ORDER BY id", [runId]);
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
