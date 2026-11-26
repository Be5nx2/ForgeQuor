import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ToolReport {
  tool: "git" | "gh" | "claude";
  status: "ok" | "missing" | "unauthenticated";
  detail: string;
}

async function probe(cmd: string, args: string[]): Promise<{ ok: boolean; missing: boolean; out: string }> {
  try {
    const { stdout } = await run(cmd, args);
    return { ok: true, missing: false, out: stdout };
  } catch (e: any) {
    return { ok: false, missing: e.code === "ENOENT", out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** Checks that `git`, `gh` and `claude` are installed and (for gh and claude) signed in. */
export async function checkTools(): Promise<ToolReport[]> {
  const reports: ToolReport[] = [];

  const git = await probe("git", ["--version"]);
  reports.push(
    git.ok
      ? { tool: "git", status: "ok", detail: git.out.trim() }
      : { tool: "git", status: "missing", detail: "git is not installed." },
  );

  const gh = await probe("gh", ["auth", "status"]);
  reports.push(
    gh.ok
      ? { tool: "gh", status: "ok", detail: "GitHub CLI authenticated." }
      : gh.missing
        ? { tool: "gh", status: "missing", detail: "gh is not installed: brew install gh" }
        : { tool: "gh", status: "unauthenticated", detail: "gh is not signed in: run `gh auth login`." },
  );

  const claude = await probe("claude", ["auth", "status"]);
  let loggedIn = claude.ok;
  if (claude.ok) {
    try {
      loggedIn = JSON.parse(claude.out).loggedIn === true;
    } catch {
      loggedIn = true; // unknown format: do not block on it
    }
  }
  reports.push(
    loggedIn
      ? { tool: "claude", status: "ok", detail: "Claude Code authenticated." }
      : claude.missing
        ? { tool: "claude", status: "missing", detail: "claude is not installed." }
        : { tool: "claude", status: "unauthenticated", detail: "claude is not signed in: run `claude` then /login." },
  );

  return reports;
}
