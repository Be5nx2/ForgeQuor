import { pushBranch } from "./workspace.js";
import type { WorkflowContext } from "./workflow.js";

/**
 * Pushes the Run's branch, opens its pull request unless it has one, and posts the Review Brief once. Returns the pull
 * request, or null when the human abandoned the Run meanwhile (the pull request is then closed). Safe to run again after
 * a restart: each part is done only if it was not yet.
 */
export async function publishPullRequest(ctx: WorkflowContext, brief: () => string): Promise<{ number: number; url: string } | null> {
  const { run, project, worktreePath, branch, defaultBranch, pool } = ctx;
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
    return null;
  }
  const { rows: posted } = await pool.query("SELECT brief_posted FROM runs WHERE id = $1", [run.id]);
  if (!posted[0].brief_posted) {
    await ctx.codeHost.comment({ owner: project.remoteOwner, repo: project.remoteName, number: pr.number, body: brief() });
    await pool.query("UPDATE runs SET brief_posted = true WHERE id = $1", [run.id]);
    ctx.changed();
  }
  return pr;
}
