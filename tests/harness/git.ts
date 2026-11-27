import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export interface TempRepo {
  path: string;
  cleanup: () => void;
}

/**
 * A real git repository in a temp folder. With `remote`, it has an `origin`
 * pointing at that URL (never contacted) whose default branch is `main`.
 */
export function createTempRepo(opts: { remote?: string } = {}): TempRepo {
  const root = mkdtempSync(join(tmpdir(), "forgequor-test-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "README.md"), "# game\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "chore: init");
  if (opts.remote) {
    git(root, "remote", "add", "origin", opts.remote);
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  }
  return { path: root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function createTempFolder(): TempRepo {
  const root = mkdtempSync(join(tmpdir(), "forgequor-test-"));
  return { path: root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export interface TempRemote {
  /** Path of the bare repository standing in for GitHub. */
  bare: string;
  /** Repoints the repository's `origin` at the bare remote (done after registering, which needs a GitHub URL). */
  pointOriginAtBare: () => void;
  /** Commits a file on `branch` of the remote, as someone else pushing. */
  advance: (file: string, content: string, opts?: { branch?: string; message?: string }) => void;
  /** Moves the remote's default branch (its HEAD) to `branch`, creating it from `main` if needed. */
  setDefaultBranch: (branch: string) => void;
  cleanup: () => void;
}

/**
 * A repository with a temporary bare remote that already holds `main`.
 * The repo registers with `remote` (a GitHub-looking URL); call `pointOriginAtBare()` once it is registered.
 */
export function createRepoWithBareRemote(opts: { remote: string }): { repo: TempRepo; remote: TempRemote } {
  const repo = createTempRepo({ remote: opts.remote });
  const bare = mkdtempSync(join(tmpdir(), "forgequor-bare-"));
  git(bare, "init", "-q", "--bare", "-b", "main");
  git(repo.path, "push", "-q", bare, "main");
  const scratch: string[] = [];

  const remote: TempRemote = {
    bare,
    pointOriginAtBare() {
      git(repo.path, "remote", "set-url", "origin", bare);
      git(repo.path, "fetch", "-q", "origin");
      git(repo.path, "remote", "set-head", "origin", "-a");
    },
    advance(file, content, { branch = "main", message = `chore: update ${file}` } = {}) {
      const clone = mkdtempSync(join(tmpdir(), "forgequor-clone-"));
      scratch.push(clone);
      git(clone, "clone", "-q", "--branch", branch, bare, ".");
      git(clone, "config", "user.email", "other@example.com");
      git(clone, "config", "user.name", "Other");
      mkdirSync(dirname(join(clone, file)), { recursive: true });
      writeFileSync(join(clone, file), content);
      git(clone, "add", ".");
      git(clone, "commit", "-q", "-m", message);
      git(clone, "push", "-q", "origin", branch);
    },
    setDefaultBranch(branch) {
      try {
        git(bare, "branch", branch, "main");
      } catch {
        // already exists
      }
      git(bare, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
    },
    cleanup() {
      for (const p of [bare, ...scratch]) rmSync(p, { recursive: true, force: true });
    },
  };
  return { repo, remote };
}
