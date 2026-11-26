import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
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
