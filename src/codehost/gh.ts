import { spawn } from "node:child_process";
import type { CodeHost } from "./codehost.js";

/** Runs `gh`, feeding `input` on stdin. Resolves with stdout; rejects with gh's own message. */
function gh(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
    child.on("error", (e: NodeJS.ErrnoException) =>
      reject(new Error(e.code === "ENOENT" ? "gh CLI not found on PATH" : `could not start gh: ${e.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolve(stdout.trim()) : reject(new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${stderr.trim() || `exit ${code}`}`)));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

/** GitHub through the user's authenticated `gh` CLI. Text goes through stdin, never the command line. */
export function createGhCodeHost(): CodeHost {
  return {
    async openPullRequest({ owner, repo, base, head, title, body }) {
      const out = await gh(
        ["pr", "create", "--repo", `${owner}/${repo}`, "--base", base, "--head", head, "--title", title, "--body-file", "-"],
        body,
      );
      const match = /(https:\/\/\S+\/pull\/(\d+))\s*$/.exec(out);
      if (!match) throw new Error(`gh pr create returned an unexpected result: ${out}`);
      return { number: Number(match[2]), url: match[1]! };
    },
    async comment({ owner, repo, number, body }) {
      await gh(["pr", "comment", String(number), "--repo", `${owner}/${repo}`, "--body-file", "-"], body);
    },
  };
}
