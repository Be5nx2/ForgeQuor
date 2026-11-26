import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeRunner } from "../../src/runner/claude.js";

// Opt-in: uses the real `claude` and a little of the subscription's Quota.
//   FORGEQUOR_SMOKE_CLAUDE=1 npx vitest run tests/runner/claude.smoke.test.ts
describe.skipIf(!process.env.FORGEQUOR_SMOKE_CLAUDE)("real claude (smoke)", () => {
  it("runs a trivial task in a scratch directory", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forgequor-smoke-"));
    const events: string[] = [];
    const result = await createClaudeRunner().run(
      {
        instructions: "You are a test Agent. Be brief.",
        prompt: "Create a file named hello.txt containing exactly the word hello.",
        cwd,
        model: "haiku",
      },
      (e) => events.push(e.kind),
    );
    expect(result.status).toBe("succeeded");
    expect(events.length).toBeGreaterThan(0);
    expect(readFileSync(join(cwd, "hello.txt"), "utf8")).toContain("hello");
  }, 120_000);
});
