import { rmSync } from "node:fs";
import { join } from "node:path";
import { commitLeftovers, readReviewBrief, REVIEW_BRIEF_FILE, RUN_NOTES_DIR, runNotesInBranch } from "./workspace.js";
import { describeFailure, passed, runChecks } from "./checks.js";
import { runAgentStep } from "./step.js";
import type { Workflow } from "./workflow.js";

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

function deriveTitle(task: string): string {
  const first = task.trim().split("\n")[0]!.trim();
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}...` : first;
}

/** After this many failed Checks the Developer's extra attempts are used up (1 try + 2 extra). */
const MAX_DEVELOPER_ATTEMPTS = 3;

/** The `developer` Workflow: setup, Developer, Checks (retrying the Developer), pull request, then the final Gate. */
export const developerWorkflow: Workflow = {
  name: "developer",
  plan({ task, title }) {
    if (!task?.trim()) throw new Error("A Run needs a task.");
    return { task: task.trim(), title: title?.trim() || deriveTitle(task), assets: [] };
  },
  async run(ctx) {
    const { run, project, worktreePath, defaultBranch, stop, records } = ctx;
    if (!(await records.setupDone())) {
      const outcomes = await runChecks(project.setup, worktreePath, { timeoutMs: ctx.checkTimeoutMs, signal: stop });
      if (!(await ctx.stillRunning())) return;
      const failed = outcomes.find((c) => !passed(c));
      if (failed) return ctx.openGate("escalation", "A setup command failed, so the Developer did not start.", describeFailure(failed));
      await records.markSetupDone();
    }

    let { attempt, failedCheck, skipDeveloper, checksDone } = await records.resumePoint(project.checks.length);
    while (!checksDone) {
      if (attempt > MAX_DEVELOPER_ATTEMPTS) {
        return ctx.openGate("escalation", `A Check still fails after ${MAX_DEVELOPER_ATTEMPTS} attempts.`, failedCheck);
      }
      if (!skipDeveloper) {
        // The previous Iteration's Review Brief must not be posted again as this one's.
        if (run.iteration > 1 && attempt === 1) rmSync(join(worktreePath, REVIEW_BRIEF_FILE), { force: true });
        const done = await runAgentStep(ctx, ctx.agents.developer, {
          name: "developer",
          attempt,
          instructions: DEVELOPER_INSTRUCTIONS,
          prompt: developerPrompt(run.task, failedCheck, await records.earlierFeedbacks()),
        });
        if (!done) return;

        await commitLeftovers(worktreePath, "chore: commit work left by the Developer");
      }
      skipDeveloper = false;

      const outcomes = await runChecks(project.checks, worktreePath, { timeoutMs: ctx.checkTimeoutMs, signal: stop });
      if (!(await ctx.stillRunning())) return;
      await records.recordChecks(attempt, outcomes);
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
    const pr = await ctx.publishPullRequest(() => readReviewBrief(worktreePath) ?? "The Developer wrote no Review Brief for this pull request.");
    if (!pr) return;
    await ctx.openGate("final", "The Developer finished.");
  },
};
