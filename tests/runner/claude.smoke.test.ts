import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCatalog } from "../../src/runner/catalog.js";
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

  it("keeps a conversation across two turns in one session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forgequor-smoke-"));
    const runner = createClaudeRunner();
    const base = { instructions: "You are a test Agent. Be brief.", cwd, model: "haiku" };
    const first = await runner.run({ ...base, prompt: "Remember the word 'pelican'. Reply with OK.", session: { start: true } }, () => {});
    expect(first.status).toBe("succeeded");
    const sessionId = first.status === "succeeded" ? first.sessionId : undefined;
    expect(sessionId).toBeTruthy();

    const second = await runner.run({ ...base, prompt: "What was the word? Reply with only the word.", session: { resume: sessionId! } }, () => {});
    expect(second.status).toBe("succeeded");
    expect(second.status === "succeeded" ? second.summary.toLowerCase() : "").toContain("pelican");

    const lost = await runner.run({ ...base, prompt: "hi", session: { resume: "00000000-0000-4000-8000-000000000000" } }, () => {});
    expect(lost).toMatchObject({ status: "failed", sessionLost: true });
  }, 240_000);

  it("reads the effort levels from its help, at no cost", async () => {
    const { claude } = await readCatalog();
    expect(claude.fallback).toBe(false);
    expect(claude.efforts.length).toBeGreaterThan(0);
  }, 30_000);

  it("reads the Quota with /usage, which costs none", async () => {
    const reading = await createClaudeRunner().readQuota!();
    expect(reading).not.toBeNull();
    // A real subscription answers with both percentages; an unknown reading means the screen's wording changed.
    expect(reading!.fiveHour.percentUsed).toBeTypeOf("number");
    expect(reading!.weekly.percentUsed).toBeTypeOf("number");
  }, 60_000);
});
