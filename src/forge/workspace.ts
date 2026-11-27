import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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

/** Adds `patterns` to the repository's local exclude file (those not there yet), so they are never committed and the Project's own files stay as they are. */
export async function excludeFromGit(worktreePath: string, ...patterns: string[]): Promise<void> {
  const exclude = resolve(worktreePath, await gitOrThrow(worktreePath, "rev-parse", "--git-path", "info/exclude"));
  mkdirSync(dirname(exclude), { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const lines = new Set(current.split("\n"));
  const missing = patterns.filter((p) => !lines.has(p));
  if (missing.length) appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
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

  await excludeFromGit(worktreePath, `${RUN_NOTES_DIR}/`);
  mkdirSync(join(worktreePath, RUN_NOTES_DIR), { recursive: true });
}

/** Whether `path` exists on the remote's `branch` as last fetched. */
export async function existsInBranch(repoRoot: string, branch: string, path: string): Promise<boolean> {
  return (await git(repoRoot, "cat-file", "-e", `origin/${branch}:${path}`)) !== null;
}

/** Whether `path` is in the worktree's checked-out commit (what the Run started from, before it committed anything). */
export async function existsAtHead(worktreePath: string, path: string): Promise<boolean> {
  return (await git(worktreePath, "cat-file", "-e", `HEAD:${path}`)) !== null;
}

/** The text of `path` on the remote's `branch` as last fetched, or null when it is not there. */
export async function readInBranch(repoRoot: string, branch: string, path: string): Promise<string | null> {
  try {
    return (await run("git", ["show", `origin/${branch}:${path}`], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch {
    return null;
  }
}

/** Every file path of the remote's `branch` as last fetched, sorted. */
export async function listInBranch(repoRoot: string, branch: string): Promise<string[]> {
  try {
    // NUL-separated so that names with special characters come back as they are; the buffer is large for big repositories.
    const { stdout } = await run("git", ["ls-tree", "-r", "-z", "--name-only", `origin/${branch}`], { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024 });
    return stdout.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/** Commits whatever the Developer left uncommitted. Returns true if a commit was made. */
export async function commitLeftovers(worktreePath: string, message: string): Promise<boolean> {
  await gitOrThrow(worktreePath, "add", "-A");
  if (!(await gitOrThrow(worktreePath, "status", "--porcelain"))) return false;
  await gitOrThrow(worktreePath, "commit", "-q", "-m", message);
  return true;
}

/** Commits exactly these paths (and whatever else is staged is left out). Returns true if a commit was made; false when they have no change to commit. */
export async function commitPaths(worktreePath: string, paths: string[], message: string): Promise<boolean> {
  await gitOrThrow(worktreePath, "add", "--", ...paths);
  if (!(await gitOrThrow(worktreePath, "status", "--porcelain", "--", ...paths))) return false;
  await gitOrThrow(worktreePath, "commit", "-q", "-m", message, "--", ...paths);
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

/** A repository-relative path, tidied: no leading or trailing slash. Throws when it is empty, absolute or climbs out of the repository. */
export function repositoryPath(value: string): string {
  const path = value.trim().replace(/\/+$/, "");
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new Error(`"${value.trim()}" is not a path inside the repository.`);
  }
  return path;
}

/** How the worktree stands outside the Run Notes: the commit it is at, and a fingerprint of each changed or untracked file. */
export interface WorktreeSnapshot {
  head: string;
  files: Map<string, string>;
}

/** Takes the snapshot a read-only Step is compared against. The Run Notes folder is left out. */
export async function snapshotWorktree(worktreePath: string): Promise<WorktreeSnapshot> {
  const head = await gitOrThrow(worktreePath, "rev-parse", "HEAD");
  const { stdout } = await run("git", ["status", "--porcelain", "-z", "-uall"], { cwd: worktreePath, maxBuffer: 64 * 1024 * 1024 });
  const files = new Map<string, string>();
  const entries = stdout.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i]!.slice(0, 2);
    const path = entries[i]!.slice(3);
    // A rename lists the old path as the next entry.
    if (status.includes("R") || status.includes("C")) files.set(entries[++i]!, "renamed");
    if (path === RUN_NOTES_DIR || path.startsWith(`${RUN_NOTES_DIR}/`)) continue;
    const file = join(worktreePath, path);
    files.set(path, existsSync(file) ? createHash("sha1").update(readFileSync(file)).digest("hex") : "missing");
  }
  return { head, files };
}

/** The paths outside the Run Notes that differ between two snapshots of the same worktree, sorted. */
export async function changesBetween(worktreePath: string, before: WorktreeSnapshot, after: WorktreeSnapshot): Promise<string[]> {
  const changed = new Set<string>();
  for (const path of new Set([...before.files.keys(), ...after.files.keys()])) {
    if (before.files.get(path) !== after.files.get(path)) changed.add(path);
  }
  if (before.head !== after.head) {
    const out = await gitOrThrow(worktreePath, "diff", "--name-only", "-z", before.head, after.head);
    for (const path of out.split("\0").filter(Boolean)) if (path !== RUN_NOTES_DIR && !path.startsWith(`${RUN_NOTES_DIR}/`)) changed.add(path);
    if (!changed.size) changed.add(`(HEAD moved from ${before.head.slice(0, 7)} to ${after.head.slice(0, 7)})`);
  }
  return [...changed].sort();
}
