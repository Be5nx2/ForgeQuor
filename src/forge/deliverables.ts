import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { commitPaths } from "./workspace.js";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });

/** What an Agent may change in the Project, as the paths it names. Everything else it leaves behind is swept. */
export type MayChange = (path: string) => boolean;

/** The commit the worktree is at. */
export async function headOf(worktreePath: string): Promise<string> {
  return (await git(worktreePath, "rev-parse", "HEAD")).stdout.trim();
}

/**
 * Puts the worktree back to HEAD for every path the Agent may not change: a dirty tracked file is checked out again, an
 * untracked one is deleted. When `head` is given and the Agent moved HEAD (it committed), HEAD goes back there first,
 * keeping the files as they are, so that what it committed is swept too. Returns the paths it swept, sorted. The Run
 * Notes folder is never touched (it is excluded from git). Reusable by any Agent that may change only some files.
 */
export async function sweepForbiddenChanges(worktreePath: string, mayChange: MayChange, head?: string): Promise<string[]> {
  if (head && (await headOf(worktreePath)) !== head) await git(worktreePath, "reset", "-q", head);
  const at = head ?? (await headOf(worktreePath));
  const { stdout } = await git(worktreePath, "status", "--porcelain", "-z", "-uall");
  const entries = stdout.split("\0").filter(Boolean);
  const swept = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i]!.slice(0, 2);
    const paths = [entries[i]!.slice(3)];
    // A rename lists the old path as the next entry.
    if (status.includes("R") || status.includes("C")) paths.push(entries[++i]!);
    for (const path of paths) if (!mayChange(path)) swept.add(path);
  }
  for (const path of swept) {
    const known = await git(worktreePath, "cat-file", "-e", `${at}:${path}`).then(() => true, () => false);
    if (known) await git(worktreePath, "checkout", "-q", at, "--", path);
    else {
      await git(worktreePath, "rm", "-r", "-f", "-q", "--cached", "--ignore-unmatch", "--", path);
      rmSync(join(worktreePath, path), { recursive: true, force: true });
    }
  }
  return [...swept].sort();
}

/** Commits the changes the Agent left in the files it may change, and only those. Returns true when a commit was made. */
export async function commitDeliverables(worktreePath: string, mayChange: MayChange, message: string): Promise<boolean> {
  const { stdout } = await git(worktreePath, "status", "--porcelain", "-z", "-uall");
  const entries = stdout.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i]!.slice(0, 2);
    const path = entries[i]!.slice(3);
    const old = status.includes("R") || status.includes("C") ? entries[++i] : undefined;
    for (const p of [path, old]) if (p && mayChange(p) && !paths.includes(p)) paths.push(p);
  }
  return paths.length ? commitPaths(worktreePath, paths, message) : false;
}
