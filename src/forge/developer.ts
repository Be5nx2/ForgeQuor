import { rmSync } from "node:fs";
import { join } from "node:path";
import { commitLeftovers, REVIEW_BRIEF_FILE, RUN_NOTES_DIR } from "./workspace.js";
import { describeFailure, passed, runChecks } from "./checks.js";
import type { AgentModule } from "./step-types.js";
import { loadBuiltInWorkflow } from "./workflow-definition.js";
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

/** The Developer Agent: the Project's setup commands once, then the task (with Feedback and the Check that failed). */
export const developerAgent: AgentModule = {
  name: "developer",
  seat: "developer",
  instructions: DEVELOPER_INSTRUCTIONS,
  async before(ctx, attempt) {
    const { run, project, worktreePath, stop, records } = ctx;
    if (!(await records.setupDone())) {
      const outcomes = await runChecks(project.setup, worktreePath, { timeoutMs: ctx.checkTimeoutMs, signal: stop });
      if (!(await ctx.stillRunning())) return false;
      const failed = outcomes.find((c) => !passed(c));
      if (failed) {
        await ctx.openGate("escalation", "A setup command failed, so the Developer did not start.", describeFailure(failed));
        return false;
      }
      await records.markSetupDone();
    }
    // The previous Iteration's Review Brief must not be posted again as this one's.
    if (run.iteration > 1 && attempt.number === 1) rmSync(join(worktreePath, REVIEW_BRIEF_FILE), { force: true });
    return true;
  },
  async prompt(ctx, attempt) {
    return developerPrompt(ctx.run.task, attempt.sentBack ?? undefined, await ctx.records.earlierFeedbacks());
  },
  async after(ctx) {
    await commitLeftovers(ctx.worktreePath, "chore: commit work left by the Developer");
  },
};

/**
 * The `developer` Workflow, from its YAML: the Developer, Checks (sending a failure back to the Developer), the pull
 * request, then the final Gate.
 */
export const developerWorkflow: Workflow = {
  name: "developer",
  inputs: ["task"],
  definition: loadBuiltInWorkflow("developer"),
  plan({ task, title }) {
    if (!task?.trim()) throw new Error("A Run needs a task.");
    return { task: task.trim(), title: title?.trim() || deriveTitle(task) };
  },
};
