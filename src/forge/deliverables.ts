import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { changesBetween, commitPaths, snapshotWorktree, type WorktreeSnapshot } from "./workspace.js";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });

/** What a conversation's Agent may change in the Project, as the paths it names. Everything else it leaves behind is undone. */
export type MayChange = (path: string) => boolean;

/** The paths a Step changed outside the Run Notes that the Agent may not change, and undoes them: the worktree is as it was before. */
export async function undoForbiddenChanges(worktreePath: string, before: WorktreeSnapshot, mayChange: MayChange): Promise<string[]> {
  const after = await snapshotWorktree(worktreePath);
  const changed = await changesBetween(worktreePath, before, after);
  // A commit that changed nothing else still has to go: the Agent leaves its commits to Forgequor.
  const forbidden = changed.filter((p) => !p.startsWith("(HEAD moved") && !mayChange(p));
  if (after.head !== before.head) await git(worktreePath, "reset", "-q", before.head);
  for (const path of forbidden) {
    const known = await git(worktreePath, "cat-file", "-e", `${before.head}:${path}`).then(() => true, () => false);
    if (known) await git(worktreePath, "checkout", "-q", before.head, "--", path);
    else {
      await git(worktreePath, "rm", "-r", "-f", "-q", "--cached", "--ignore-unmatch", "--", path);
      rmSync(join(worktreePath, path), { recursive: true, force: true });
    }
  }
  return forbidden;
}

/** Commits the changes the Agent left in the files it may change, and only those. Returns true when a commit was made. */
export async function commitDeliverables(worktreePath: string, mayChange: MayChange, message: string): Promise<boolean> {
  const { stdout } = await git(worktreePath, "status", "--porcelain", "-z", "-uall");
  const entries = stdout.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i]!.slice(0, 2);
    const path = entries[i]!.slice(3);
    // A rename lists the old path as the next entry.
    const old = status.includes("R") || status.includes("C") ? entries[++i] : undefined;
    for (const p of [path, old]) if (p && mayChange(p) && !paths.includes(p)) paths.push(p);
  }
  return paths.length ? commitPaths(worktreePath, paths, message) : false;
}
