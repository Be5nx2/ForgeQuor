import { describeDuration } from "../duration.js";
import type { SessionRequest, StepResult } from "../runner/runner.js";
import type { AgentSeat, WorkflowContext } from "./workflow.js";

export interface AgentStep {
  /** The Step's name in the Run's record ("developer", "artist"). */
  name: string;
  attempt: number;
  /** The Workflow Step running it, when the Workflow is run by the engine. */
  stepId?: string;
  /** The Asset this Step works on, for the Artist. */
  assetId?: number;
  instructions: string;
  prompt: string;
  /** The Step must not change the worktree: the Runner is asked to keep it read-only. */
  readonly?: boolean;
  /** Images shown to the Agent with the prompt (absolute paths). */
  images?: string[];
  /** The Step keeps or resumes a Runner session (a Conversation Gate's Agent); the result then carries its id. */
  session?: SessionRequest;
}

type Succeeded = Extract<StepResult, { status: "succeeded" }>;

/**
 * The one executor of Agent Steps. Runs one Agent attempt, records it as a Step attempt and streams its progress live;
 * the Agent is killed after the Step timeout, and when the human abandons the Run. Then maps the result the same way for
 * every Workflow: success returns it; failure or timeout opens an Escalation naming the Agent; Quota exhaustion pauses
 * the Run. Returns null when the Run cannot go on (it waits at a Gate, is paused, or was abandoned).
 */
export async function runAgentStep(ctx: WorkflowContext, seat: AgentSeat, step: AgentStep): Promise<Succeeded | null> {
  const { run, stop, stepTimeoutMs, worktreePath, records } = ctx;
  const attemptId = await records.startAttempt({
    step: step.name,
    attempt: step.attempt,
    runner: seat.runnerName,
    model: seat.model,
    assetId: step.assetId,
    stepId: step.stepId,
  });
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
      { instructions: step.instructions, prompt: step.prompt, images: step.images, readonly: step.readonly, session: step.session, cwd: worktreePath, model: seat.model, signal: abort.signal },
      (e) => {
        if (e.raw) log.push(e.raw);
        ctx.emit({ type: "progress", runId: run.id, attemptId, kind: e.kind, summary: e.summary });
      },
    );
  } finally {
    clearTimeout(timer);
    stop.removeEventListener("abort", stopStep);
  }
  await records.finishAttempt(attemptId, result, log.join("\n"));
  ctx.changed();

  if (!(await ctx.stillRunning())) return null;
  const agent = step.name.charAt(0).toUpperCase() + step.name.slice(1);
  // A Step that finished on its own just as the timeout fired keeps its real result.
  if (timedOut && result.status === "failed") {
    await ctx.openGate("escalation", `The ${agent}'s Step timed out after ${describeDuration(stepTimeoutMs)} and was killed.`);
    return null;
  }
  if (result.status === "failed") {
    await ctx.openGate("escalation", `The ${agent} failed.`, result.error);
    return null;
  }
  if (result.status === "quota_exhausted") {
    await ctx.pause(result.resetsAt);
    return null;
  }
  return result;
}
