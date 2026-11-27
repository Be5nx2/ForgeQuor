import type { StepResult } from "../runner/runner.js";
import type { AgentSeat, WorkflowContext } from "./workflow.js";

export interface AgentStep {
  /** The Step's name in the Run's record ("developer", "artist"). */
  name: string;
  attempt: number;
  /** The Asset this Step works on, for the Artist. */
  assetId?: number;
  instructions: string;
  prompt: string;
  /** Images shown to the Agent with the prompt (absolute paths). */
  images?: string[];
}

/**
 * One Agent attempt, recorded as a Step attempt and streamed live. Killed, and reported as timed out, after the Step
 * timeout; killed too when the human abandons the Run.
 */
export async function runAgentStep(
  ctx: WorkflowContext,
  seat: AgentSeat,
  step: AgentStep,
): Promise<{ result: StepResult; timedOut: boolean }> {
  const { run, pool, stop, stepTimeoutMs, worktreePath } = ctx;
  const { rows } = await pool.query(
    `INSERT INTO step_attempts (run_id, iteration, step, attempt, runner, model, status, asset_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'running', $7) RETURNING id`,
    [run.id, run.iteration, step.name, step.attempt, seat.runnerName, seat.model ?? null, step.assetId ?? null],
  );
  const attemptId = Number(rows[0].id);
  const log: string[] = [];
  ctx.changed();

  const abort = new AbortController();
  let timedOut = false;
  const stopStep = () => abort.abort();
  if (stop.aborted) abort.abort();
  stop.addEventListener("abort", stopStep, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, stepTimeoutMs);
  let result: StepResult;
  try {
    result = await seat.runner.run(
      { instructions: step.instructions, prompt: step.prompt, images: step.images, cwd: worktreePath, model: seat.model, signal: abort.signal },
      (e) => {
        if (e.raw) log.push(e.raw);
        ctx.emit({ type: "progress", runId: run.id, attemptId, kind: e.kind, summary: e.summary });
      },
    );
  } finally {
    clearTimeout(timer);
    stop.removeEventListener("abort", stopStep);
  }
  await pool.query(
    `UPDATE step_attempts SET status = $2, ended_at = now(), summary = $3, error = $4, quota_resets_at = $5, event_log = $6
     WHERE id = $1`,
    [
      attemptId,
      result.status,
      result.status === "succeeded" ? result.summary : null,
      result.status === "failed" ? result.error : null,
      result.status === "quota_exhausted" ? result.resetsAt : null,
      log.join("\n"),
    ],
  );
  ctx.changed();
  return { result, timedOut };
}
