import { rmSync } from "node:fs";
import { join } from "node:path";
import { commitLeftovers, REVIEW_BRIEF_FILE, RUN_NOTES_DIR } from "./workspace.js";
import { describeFailure, passed, runChecks } from "./checks.js";
import { REVIEW_REASON_PREFIX } from "./review.js";
import type { AgentModule } from "./step-types.js";
import { catalogueOf } from "./step-types.js";
import { loadBuiltInWorkflow } from "./workflow-definition.js";
import type { Workflow } from "./workflow.js";

/** The Developer Agent's standing instructions. */
export const DEVELOPER_INSTRUCTIONS = `You are the Developer on a Forgequor Run. Work only inside the current directory, which is this Run's own git worktree and branch.

- Implement the task, following the repository's own conventions and instructions.
- Commit your work on the current branch as you go, using Conventional Commits ("type(scope): subject"); a commit body is at most 5 lines.
- Never commit the ${RUN_NOTES_DIR}/ folder: it holds Run Notes and is ignored by git.
- When you are done, write the Review Brief to ${REVIEW_BRIEF_FILE}: what the change does, where the reviewer should look closely, and what to test.`;

/** What the Developer is told when it works on a bug: the same Developer, in bug-fixing mode. */
export const BUGFIX_INSTRUCTIONS = `${DEVELOPER_INSTRUCTIONS}

This Run fixes a bug, and the task is the bug description. Follow the \`diagnosing-bugs\` Skill, and the \`tdd\` Skill for the tests. In short:
- First reproduce the bug: write a test that fails because of it, run it and see it fail for the reason the description gives. Commit that failing test on its own, before any fix.
- Then find the cause and fix it at the cause, not the symptom. The failing test must now pass, and nothing that passed before may fail.
- In the Review Brief, say how the bug was reproduced, what the cause was, and which test proves the fix.`;

/**
 * The Developer's prompt; on a retry it carries what sent the work back: the Check that failed, or the Review that asked
 * for changes. The Feedback of the human's rejections is listed as well.
 */
export function developerPrompt(task: string, sentBack?: string, feedbacks: string[] = [], summary?: string | null, assetPaths: string[] = []): string {
  let prompt = `Task:\n\n${task}`;
  if (summary) prompt += `\n\nThe human talked this task through with the Griller and confirmed this summary of what to build; build exactly that:\n\n${summary}`;
  if (assetPaths.length) prompt += `\n\nThe Artist drew these Assets for this work and the human approved them. They are already committed on this branch: use them, and do not redraw or change them.\n${assetPaths.map((p) => `- ${p}`).join("\n")}`;
  if (feedbacks.length) {
    const history = feedbacks.map((f, i) => `${i + 1}. ${f}`).join("\n");
    prompt += `\n\nThe reviewer rejected your earlier work. Your work is already on this branch: build on it, address the latest Feedback (the last one), keep the earlier ones satisfied, commit, and rewrite the Review Brief.\n\nFeedback so far, oldest first:\n${history}`;
  }
  if (!sentBack) return prompt;
  if (sentBack.startsWith(REVIEW_REASON_PREFIX)) {
    return `${prompt}\n\n${sentBack.replace(REVIEW_REASON_PREFIX, "A Reviewer read your work and asked for changes. Your work is already on this branch: address every finding you agree is right, keep your earlier work, commit, and rewrite the Review Brief. The Checks and the review run again afterwards. The Review:")}`;
  }
  return `${prompt}\n\nYour previous attempt failed this Check. Fix the cause, keep your earlier work, and commit.\n\n${sentBack}`;
}

export function deriveTitle(task: string): string {
  const first = task.trim().split("\n")[0]!.trim();
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}...` : first;
}

/** The Developer Agent: the Project's setup commands once, then the task (with Feedback, and the Check or Review that sent it back). */
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
    return developerPrompt(ctx.run.task, attempt.sentBack ?? undefined, await ctx.records.earlierFeedbacks(), await ctx.records.conversation.confirmedSummary(), await ctx.records.approvedAssetPaths());
  },
  async after(ctx) {
    await commitLeftovers(ctx.worktreePath, "chore: commit work left by the Developer");
  },
};

/** The Developer in bug-fixing mode: the same Agent and seat under its own name, whose instructions demand a failing test first. */
export const bugfixAgent: AgentModule = { ...developerAgent, name: "bugfixer", instructions: BUGFIX_INSTRUCTIONS };

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

/**
 * The `bugfix` Workflow, from its YAML: a bug description goes to the Developer in bug-fixing mode, then the Checks, the
 * review (solo unless the human asks for duo), the pull request and the final Gate.
 */
export const bugfixWorkflow: Workflow = {
  name: "bugfix",
  inputs: ["task", "review"],
  definition: loadBuiltInWorkflow("bugfix", catalogueOf([developerAgent, bugfixAgent])),
  plan({ task, title }) {
    if (!task?.trim()) throw new Error("A bugfix Run needs a bug description.");
    return { task: task.trim(), title: title?.trim() || deriveTitle(task) };
  },
};
