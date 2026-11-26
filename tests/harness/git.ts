import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
