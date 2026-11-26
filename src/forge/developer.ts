import { rmSync } from "node:fs";
import { join } from "node:path";
import { commitLeftovers, pushBranch, readReviewBrief, REVIEW_BRIEF_FILE, RUN_NOTES_DIR, runNotesInBranch } from "./workspace.js";
import type { StepResult } from "../runner/runner.js";
import { describeDuration } from "../duration.js";
import { describeFailure, passed, runChecks } from "./checks.js";
import { resumePoint } from "./resume.js";
import type { Workflow, WorkflowContext } from "./workflow.js";

/** The Developer Agent's standing instructions. */
export const DEVELOPER_INSTRUCTIONS = `You are the Developer on a Forgequor Run. Work only inside the current directory, which is this Run's own git worktree and branch.

- Implement the task, following the repository's own conventions and instructions.
- Commit your work on the current branch as you go, using Conventional Commits ("type(scope): subject"); a commit body is at most 5 lines.
- Never commit the ${RUN_NOTES_DIR}/ folder: it holds Run Notes and is ignored by git.
- When you are done, write the Review Brief to ${REVIEW_BRIEF_FILE}: what the change does, where the reviewer should look closely, and what to test.`;

/** The Developer's prompt; on a retry it carries the Check that failed, so the Developer can fix it. */
export function developerPrompt(task: string, failedCheck?: string, feedbacks: string[] = []): string {
  let prompt = `Task:\n\n${task}`;
  if (feedbacks.length) {
    const history = feedbacks.map((f, i) => `${i + 1}. ${f}`).join("\n");
    prompt += `\n\nThe reviewer rejected your earlier work. Your work is already on this branch: build on it, address the latest Feedback (the last one), keep the earlier ones satisfied, commit, and rewrite the Review Brief.\n\nFeedback so far, oldest first:\n${history}`;
  }
  if (!failedCheck) return prompt;
  return `${prompt}\n\nYour previous attempt failed this Check. Fix the cause, keep your earlier work, and commit.\n\n${failedCheck}`;
}

/** After this many failed Checks the Developer's extra attempts are used up (1 try + 2 extra). */
const MAX_DEVELOPER_ATTEMPTS = 3;

/** The Feedback of every rejection of this Run, oldest first. */
async function earlierFeedbacks(pool: WorkflowContext["pool"], runId: number): Promise<string[]> {
  const { rows } = await pool.query("SELECT feedback FROM gates WHERE run_id = $1 AND decision = 'reject' ORDER BY id", [runId]);
  return rows.map((r) => r.feedback);
}

/** One Developer attempt, recorded as a Step attempt. Killed, and reported as timed out, after the Step timeout. */
async function developerStep(
  ctx: WorkflowContext,
  attempt: number,
  failedCheck: string | undefined,
): Promise<{ result: StepResult; timedOut: boolean }> {
  const { run, pool, runner, stop, stepTimeoutMs, worktreePath } = ctx;
  const { rows } = await pool.query(
    `INSERT INTO step_attempts (run_id, iteration, step, attempt, runner, model, status)
     VALUES ($1, $2, 'developer', $3, 'claude', $4, 'running') RETURNING id`,
    [run.id, run.iteration, attempt, ctx.developerModel ?? null],
  );
  const attemptId = rows[0].id;
  const log: string[] = [];
  ctx.changed();

  const step = new AbortController();
  let timedOut = false;
  const stopStep = () => step.abort();
  if (stop.aborted) step.abort();
  stop.addEventListener("abort", stopStep, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    step.abort();
  }, stepTimeoutMs);
  let result: StepResult;
  try {
    result = await runner.run(
      {
        instructions: DEVELOPER_INSTRUCTIONS,
        prompt: developerPrompt(run.task, failedCheck, await earlierFeedbacks(pool, run.id)),
        cwd: worktreePath,
        model: ctx.developerModel,
        signal: step.signal,
      },
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

/** The `developer` Workflow: setup, Developer, Checks (retrying the Developer), pull request, then the final Gate. */
export const developerWorkflow: Workflow = {
  name: "developer",
  async run(ctx) {
    const { run, project, worktreePath, branch, defaultBranch, pool, stop, stepTimeoutMs } = ctx;
    const { rows: prepared } = await pool.query("SELECT setup_done FROM runs WHERE id = $1", [run.id]);
    if (!prepared[0].setup_done) {
      const outcomes = await runChecks(project.setup, worktreePath, { timeoutMs: ctx.checkTimeoutMs, signal: stop });
      if (!(await ctx.stillRunning())) return;
      const failed = outcomes.find((c) => !passed(c));
      if (failed) return ctx.openGate("escalation", "A setup command failed, so the Developer did not start.", describeFailure(failed));
      await pool.query("UPDATE runs SET setup_done = true WHERE id = $1", [run.id]);
    }

    let { attempt, failedCheck, skipDeveloper, checksDone } = await resumePoint(pool, run.id, run.iteration, project.checks.length);
    while (!checksDone) {
      if (attempt > MAX_DEVELOPER_ATTEMPTS) {
        return ctx.openGate("escalation", `A Check still fails after ${MAX_DEVELOPER_ATTEMPTS} attempts.`, failedCheck);
      }
      if (!skipDeveloper) {
        // The previous Iteration's Review Brief must not be posted again as this one's.
        if (run.iteration > 1 && attempt === 1) rmSync(join(worktreePath, REVIEW_BRIEF_FILE), { force: true });
        const { result, timedOut } = await developerStep(ctx, attempt, failedCheck);
        if (!(await ctx.stillRunning())) return;
        // A Step that finished on its own just as the timeout fired keeps its real result.
        if (timedOut && result.status === "failed") {
          return ctx.openGate("escalation", `The Developer's Step timed out after ${describeDuration(stepTimeoutMs)} and was killed.`);
        }
        if (result.status === "failed") return ctx.openGate("escalation", "The Developer failed.", result.error);
        if (result.status === "quota_exhausted") return ctx.pause(result.resetsAt);

        await commitLeftovers(worktreePath, "chore: commit work left by the Developer");
      }
      skipDeveloper = false;

      const outcomes = await runChecks(project.checks, worktreePath, { timeoutMs: ctx.checkTimeoutMs, signal: stop });
      if (!(await ctx.stillRunning())) return;
      for (const c of outcomes) {
        await pool.query(
          "INSERT INTO check_results (run_id, iteration, attempt, command, exit_status, output) VALUES ($1, $2, $3, $4, $5, $6)",
          [run.id, run.iteration, attempt, c.command, c.exitStatus, c.output],
        );
      }
      ctx.changed();
      const failed = outcomes.find((c) => !passed(c));
      if (!failed) break;
      failedCheck = describeFailure(failed);
      if (attempt === MAX_DEVELOPER_ATTEMPTS) {
        return ctx.openGate("escalation", `A Check still fails after ${attempt} attempts.`, failedCheck);
      }
      attempt++;
    }

    if (!(await ctx.stillRunning())) return;
    const notes = await runNotesInBranch(worktreePath, defaultBranch);
    if (notes.length) {
      return ctx.openGate("escalation", "A commit adds Run Notes, so the branch was not pushed.", notes.join("\n"));
    }
    await pushBranch(worktreePath, branch);
    let pr = run.prNumber ? { number: run.prNumber, url: run.prUrl! } : null;
    if (!pr) {
      pr = await ctx.codeHost.openPullRequest({
        owner: project.remoteOwner,
        repo: project.remoteName,
        base: defaultBranch,
        head: branch,
        title: run.title,
        body: `${run.task}\n\n---\nForgequor Run #${run.id}`,
      });
      await pool.query("UPDATE runs SET pr_number = $2, pr_url = $3 WHERE id = $1", [run.id, pr.number, pr.url]);
      ctx.changed();
    }
    if (!(await ctx.stillRunning())) {
      // Abandoned while the pull request was being opened: it may not have seen it, so close it here.
      await ctx.codeHost.closePullRequest({ owner: project.remoteOwner, repo: project.remoteName, number: pr.number }).catch(() => {});
      return;
    }
    const { rows: posted } = await pool.query("SELECT brief_posted FROM runs WHERE id = $1", [run.id]);
    if (!posted[0].brief_posted) {
      await ctx.codeHost.comment({
        owner: project.remoteOwner,
        repo: project.remoteName,
        number: pr.number,
        body: readReviewBrief(worktreePath) ?? "The Developer wrote no Review Brief for this pull request.",
      });
      await pool.query("UPDATE runs SET brief_posted = true WHERE id = $1", [run.id]);
      ctx.changed();
    }
    await ctx.openGate("final", "The Developer finished.");
  },
};
