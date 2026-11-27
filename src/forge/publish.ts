import { pushBranch } from "./workspace.js";
import type { CodeHost } from "../codehost/codehost.js";
import type { WorkflowContext } from "./workflow.js";

/** What publishing needs of a Run: the Workflow context, and the code host the core holds. */
export type PublishContext = Pick<WorkflowContext, "run" | "project" | "worktreePath" | "branch" | "defaultBranch" | "records" | "changed" | "stillRunning"> & {
  codeHost: CodeHost;
};

/**
 * Pushes the Run's branch, opens its pull request unless it has one, and posts the Review Brief once. Returns the pull
 * request, or null when the human abandoned the Run meanwhile (the pull request is then closed). Safe to run again after
 * a restart: each part is done only if it was not yet.
 */
export async function publishPullRequest(ctx: PublishContext, brief: () => string): Promise<{ number: number; url: string } | null> {
  const { run, project, worktreePath, branch, defaultBranch, records } = ctx;
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
    await records.recordPullRequest(pr.number, pr.url);
    ctx.changed();
  }
  if (!(await ctx.stillRunning())) {
    // Abandoned while the pull request was being opened: it may not have seen it, so close it here.
    await ctx.codeHost.closePullRequest({ owner: project.remoteOwner, repo: project.remoteName, number: pr.number }).catch(() => {});
    return null;
  }
  if (!(await records.briefPosted())) {
    await ctx.codeHost.comment({ owner: project.remoteOwner, repo: project.remoteName, number: pr.number, body: brief() });
    await records.markBriefPosted();
    ctx.changed();
  }
  return pr;
}
