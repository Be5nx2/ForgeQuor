import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export class RegistrationError extends Error {}

export interface RepositoryFacts {
  /** Repository root (symlinks resolved). */
  root: string;
  remoteOwner: string;
  remoteName: string;
  defaultBranch: string;
}

async function git(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    return (await run("git", args, { cwd })).stdout.trim();
  } catch {
    return null;
  }
}

/** Parses `git@github.com:o/n.git`, `https://github.com/o/n(.git)` and `ssh://git@github.com/o/n.git`. */
export function parseGitHubRemote(url: string): { owner: string; name: string } | null {
  const m = url.match(/^(?:git@github\.com:|(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1]!, name: m[2]! } : null;
}

/** Reads what Forgequor needs to know about a local repository, or throws a RegistrationError saying why not. */
export async function inspectRepository(path: string): Promise<RepositoryFacts> {
  if (!existsSync(path)) throw new RegistrationError(`${path} does not exist.`);
  const root = await git(path, "rev-parse", "--show-toplevel");
  if (!root) throw new RegistrationError(`${path} is not a git repository.`);

  const remoteUrl = await git(root, "remote", "get-url", "origin");
  if (!remoteUrl) throw new RegistrationError(`${root} has no GitHub remote: add an "origin" remote pointing at GitHub.`);
  const remote = parseGitHubRemote(remoteUrl);
  if (!remote) throw new RegistrationError(`The "origin" remote (${remoteUrl}) is not a GitHub remote.`);

  const defaultBranch =
    (await git(root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"))?.replace(/^origin\//, "") ??
    (await git(root, "ls-remote", "--symref", "origin", "HEAD"))?.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1];
  if (!defaultBranch) {
    throw new RegistrationError(
      `Cannot determine the default branch of ${remote.owner}/${remote.name}. Try: git -C ${root} remote set-head origin -a`,
    );
  }

  return {
    root: realpathSync(root),
    remoteOwner: remote.owner,
    remoteName: remote.name,
    defaultBranch,
  };
}

/** Hidden folder at the root of each worktree where Agents leave Run Notes. Never committed. */
export const RUN_NOTES_DIR = ".forgequor";
/** Where the Developer writes the Review Brief, relative to the worktree. */
export const REVIEW_BRIEF_FILE = `${RUN_NOTES_DIR}/review-brief.md`;

async function gitOrThrow(cwd: string, ...args: string[]): Promise<string> {
  try {
    return (await run("git", args, { cwd })).stdout.trim();
  } catch (e: any) {
    const detail = String(e.stderr ?? e.message).trim();
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
}

export function slugify(text: string, max = 40): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

/**
 * Asks the remote for its current default branch and fetches it, so a stale `origin/HEAD` is never used.
 * Returns the default branch name.
 */
export async function refreshDefaultBranch(repoRoot: string): Promise<string> {
  await gitOrThrow(repoRoot, "fetch", "origin");
  await gitOrThrow(repoRoot, "remote", "set-head", "origin", "-a");
  return (await gitOrThrow(repoRoot, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).replace(/^origin\//, "");
}

/**
 * Creates `branch` in a new worktree at `worktreePath`, from the remote's `defaultBranch`, with the Run Notes
 * folder in place and excluded through the repository's local exclude file (no change to the Project's files).
 */
export async function createRunWorktree(opts: {
  repoRoot: string;
  defaultBranch: string;
  branch: string;
  worktreePath: string;
}): Promise<void> {
  const { repoRoot, defaultBranch, branch, worktreePath } = opts;
  mkdirSync(dirname(worktreePath), { recursive: true });
  await gitOrThrow(repoRoot, "worktree", "add", "-b", branch, worktreePath, `origin/${defaultBranch}`);

  const exclude = resolve(worktreePath, await gitOrThrow(worktreePath, "rev-parse", "--git-path", "info/exclude"));
  mkdirSync(dirname(exclude), { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!current.split("\n").includes(`${RUN_NOTES_DIR}/`)) {
    appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${RUN_NOTES_DIR}/\n`);
  }
  mkdirSync(join(worktreePath, RUN_NOTES_DIR), { recursive: true });
}

/** Commits whatever the Developer left uncommitted. Returns true if a commit was made. */
export async function commitLeftovers(worktreePath: string, message: string): Promise<boolean> {
  await gitOrThrow(worktreePath, "add", "-A");
  if (!(await gitOrThrow(worktreePath, "status", "--porcelain"))) return false;
  await gitOrThrow(worktreePath, "commit", "-q", "-m", message);
  return true;
}

/** Run Notes paths that some commit of the branch (since `defaultBranch`) adds. Empty when the branch is clean. */
export async function runNotesInBranch(worktreePath: string, defaultBranch: string): Promise<string[]> {
  const out = await gitOrThrow(
    worktreePath, "log", "--name-only", "--diff-filter=A", "--format=", `origin/${defaultBranch}..HEAD`, "--", RUN_NOTES_DIR,
  );
  return [...new Set(out.split("\n").filter(Boolean))];
}

/** Pushes the Run's branch to `origin`. */
export async function pushBranch(worktreePath: string, branch: string): Promise<void> {
  await gitOrThrow(worktreePath, "push", "-q", "origin", `${branch}:refs/heads/${branch}`);
}

/** The Review Brief the Developer wrote, or null when there is none (or it is blank). */
export function readReviewBrief(worktreePath: string): string | null {
  const file = join(worktreePath, REVIEW_BRIEF_FILE);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  return text.trim() ? text : null;
}
