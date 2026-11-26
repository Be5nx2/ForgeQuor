import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGhCodeHost } from "../../src/codehost/gh.js";

// Opt-in: opens and closes a real pull request on a sandbox repository you own (needs `gh` signed in, and a "main" branch).
// Runs only through `npm run smoke:gh` (which sets FORGEQUOR_SMOKE_GH), never in a plain `npm test`, even when
// FORGEQUOR_SMOKE_REPO=owner/name is set in .env.
const sandbox = process.env.FORGEQUOR_SMOKE_REPO;

describe.skipIf(!process.env.FORGEQUOR_SMOKE_GH)("real gh (smoke)", () => {
  it("opens a pull request, comments on it, then closes it", async () => {
    if (!sandbox) throw new Error("Set FORGEQUOR_SMOKE_REPO=owner/name (in .env or the shell) to the sandbox repository.");
    const [owner, repo] = sandbox!.split("/") as [string, string];
    const branch = `forgequor-smoke-${Date.now()}`;
    const dir = mkdtempSync(join(tmpdir(), "forgequor-gh-smoke-"));
    const sh = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
    try {
      execFileSync("gh", ["repo", "clone", sandbox!, dir, "--", "--depth", "1"]);
      sh("checkout", "-q", "-b", branch);
      writeFileSync(join(dir, `smoke-${Date.now()}.txt`), "smoke\n");
      sh("add", ".");
      sh("commit", "-q", "-m", "chore: smoke test");
      sh("push", "-q", "origin", branch);

      const host = createGhCodeHost();
      const pr = await host.openPullRequest({ owner, repo, base: "main", head: branch, title: "Forgequor smoke test", body: "Task\n\n---\nForgequor Run #0" });
      expect(pr.url).toContain(`/pull/${pr.number}`);
      await host.comment({ owner, repo, number: pr.number, body: "Review Brief: nothing to test." });
      execFileSync("gh", ["pr", "close", String(pr.number), "--repo", sandbox!, "--delete-branch"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
