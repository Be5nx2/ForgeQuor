import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeRunner } from "../../src/runner/claude.js";
import type { StepRequest } from "../../src/runner/runner.js";
import { createFakeCli, type FakeCliScript } from "../harness/fake-cli.js";

const line = (o: unknown) => JSON.stringify(o);
const init = line({ type: "system", subtype: "init", session_id: "s1" });
const resultOk = line({ type: "result", subtype: "success", is_error: false, result: "Done." });
const RESET_EPOCH = 1900000000;
const RESET_DATE = new Date("2030-03-17T17:46:40Z");
const READ_AT = new Date("2026-11-27T10:00:00Z");

// The text `claude -p "/usage" --output-format json` answered, captured from the real CLI.
const REAL_USAGE =
  "You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 0% used · resets Nov 28 at 4am (Europe/Paris)\nCurrent week (all models): 6% used · resets Nov 28 at 4pm (Europe/Paris)\n\nWhat's contributing to your limits usage?\n...";
const usageOutput = (result: string) => line({ type: "result", subtype: "success", is_error: false, result, num_turns: 0, total_cost_usd: 0 });
const UNKNOWN = { fiveHour: { percentUsed: null, resetsAt: null }, weekly: { percentUsed: null, resetsAt: null }, exhausted: false, readAt: READ_AT };

function step(): StepRequest {
  return { instructions: "You are the Developer.", prompt: "Add a jump button.", cwd: realpathSync(mkdtempSync(join(tmpdir(), "forgequor-step-"))), model: "sonnet" };
}

async function read(script: FakeCliScript) {
  const fake = createFakeCli(script);
  const reading = await createClaudeRunner({ env: fake.env, now: () => READ_AT }).readQuota!();
  return { reading, fake };
}

async function runStep(script: FakeCliScript) {
  const fake = createFakeCli(script);
  return createClaudeRunner({ env: fake.env, now: () => READ_AT }).run(step(), () => {});
}

describe("Claude Runner Quota readings", () => {
  it("reads both windows from the real /usage text, resets in the named time zone", async () => {
    const { reading, fake } = await read({ stdout: [usageOutput(REAL_USAGE)] });

    expect(reading).toEqual({
      fiveHour: { percentUsed: 0, resetsAt: new Date("2026-11-28T03:00:00Z") },
      weekly: { percentUsed: 6, resetsAt: new Date("2026-11-28T15:00:00Z") },
      exhausted: false,
      readAt: READ_AT,
    });
    expect(fake.lastInvocation().args).toEqual(["-p", "/usage", "--output-format", "json"]);
  });

  it("picks the next occurrence of a reset, with or without a date, and flags a window at 100%", async () => {
    const { reading } = await read({
      stdout: [usageOutput("Current session: 100% used · resets 2pm (Europe/Paris)\nCurrent week (all models): 40% used · resets Jan 2 at 9:30am (Europe/Paris)")],
    });

    expect(reading).toEqual({
      fiveHour: { percentUsed: 100, resetsAt: new Date("2026-11-27T13:00:00Z") },
      weekly: { percentUsed: 40, resetsAt: new Date("2027-01-02T08:30:00Z") },
      exhausted: true,
      readAt: READ_AT,
    });
  });

  it("takes a time of day already past as tomorrow's", async () => {
    const { reading } = await read({ stdout: [usageOutput("Current session: 10% used · resets 9am (Europe/Paris)")] });

    expect(reading?.fiveHour.resetsAt).toEqual(new Date("2026-11-28T08:00:00Z"));
  });

  it("gives an unknown reading, not an error, for text it cannot parse", async () => {
    expect((await read({ stdout: [usageOutput("The usage screen changed and says something else.")] })).reading).toEqual(UNKNOWN);
    expect((await read({ stdout: ["not json at all"] })).reading).toEqual(UNKNOWN);
    expect((await read({ stdout: [], exitCode: 1, stderr: "boom" })).reading).toEqual(UNKNOWN);
  });

  it("keeps a percent whose reset it cannot read", async () => {
    const { reading } = await read({ stdout: [usageOutput("Current session: 12% used · resets whenever (Europe/Paris)\nCurrent week (all models): 3% used")] });

    expect(reading).toMatchObject({ fiveHour: { percentUsed: 12, resetsAt: null }, weekly: { percentUsed: 3, resetsAt: null } });
  });

  it("gives nothing when claude cannot be started", async () => {
    expect(await createClaudeRunner({ env: { PATH: "/nonexistent" } }).readQuota!()).toBeNull();
  });

  it("turns a Step's rate_limit_events into a partial reading", async () => {
    const event = (info: object) => line({ type: "rate_limit_event", rate_limit_info: info });
    const result = await runStep({
      stdout: [init, event({ status: "allowed", resetsAt: RESET_EPOCH, rateLimitType: "five_hour" }), event({ status: "allowed", resetsAt: RESET_EPOCH + 3600, rateLimitType: "seven_day" }), resultOk],
    });

    expect(result).toEqual({
      status: "succeeded",
      summary: "Done.",
      quota: { fiveHour: { percentUsed: null, resetsAt: RESET_DATE }, weekly: { percentUsed: null, resetsAt: new Date(RESET_DATE.getTime() + 3600_000) }, exhausted: false, readAt: READ_AT },
    });
  });

  it("marks the reading exhausted when a window was rejected", async () => {
    const result = await runStep({
      stdout: [init, line({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: RESET_EPOCH, rateLimitType: "five_hour" } }), line({ type: "result", subtype: "success", is_error: true, result: "5-hour limit reached" })],
    });

    expect(result).toMatchObject({ status: "quota_exhausted", resetsAt: RESET_DATE, quota: { exhausted: true, fiveHour: { resetsAt: RESET_DATE } } });
  });

  it("carries no reading on a Step that said nothing about the Quota", async () => {
    expect(await runStep({ stdout: [init, resultOk] })).not.toHaveProperty("quota");
  });
});
