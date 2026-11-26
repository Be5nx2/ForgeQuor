import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeRunner } from "../../src/runner/claude.js";
import type { RunnerEvent, StepRequest } from "../../src/runner/runner.js";
import { createFakeClaude, type FakeClaudeScript } from "../harness/fake-claude.js";

const line = (o: unknown) => JSON.stringify(o);
const init = line({ type: "system", subtype: "init", session_id: "s1" });
const assistantText = (text: string) =>
  line({ type: "assistant", message: { content: [{ type: "text", text }] } });
const assistantTool = (name: string) =>
  line({ type: "assistant", message: { content: [{ type: "tool_use", name, input: {} }] } });
const RESET_EPOCH = 1900000000;
const RESET_DATE = new Date("2030-03-17T17:46:40Z");
const resultOk = line({ type: "result", subtype: "success", is_error: false, result: "Done." });

function step(): StepRequest {
  return {
    instructions: "You are the Developer.",
    prompt: "Add a jump button.",
    cwd: realpathSync(mkdtempSync(join(tmpdir(), "forgequor-step-"))),
    model: "sonnet",
  };
}

async function runStep(script: FakeClaudeScript) {
  const fake = createFakeClaude(script);
  const runner = createClaudeRunner({ env: fake.env });
  const events: RunnerEvent[] = [];
  const request = step();
  const result = await runner.run(request, (e) => events.push(e));
  return { result, events, fake, request };
}

describe("Claude Runner", () => {
  it("streams progress events then reports success, in the Step's working directory", async () => {
    const { result, events, fake, request } = await runStep({
      stdout: [init, assistantText("Looking at the scene."), assistantTool("Edit"), resultOk],
    });

    expect(result).toEqual({ status: "succeeded", summary: "Done." });
    expect(events.map((e) => [e.kind, e.summary])).toEqual([
      ["other", "system init"],
      ["text", "Looking at the scene."],
      ["tool", "Edit"],
      ["other", "result success"],
    ]);
    expect(events.map((e) => e.raw)).toEqual([init, assistantText("Looking at the scene."), assistantTool("Edit"), resultOk]);
    const call = fake.lastInvocation();
    expect(call.cwd).toBe(request.cwd);
    expect(call.stdin).toContain("Add a jump button.");
  });

  it("reports an error result as failed with the error", async () => {
    const { result } = await runStep({
      stdout: [init, line({ type: "result", subtype: "error_during_execution", is_error: true, result: "Tool exploded" })],
    });
    expect(result).toEqual({ status: "failed", error: "Tool exploded" });
  });

  it("reports unreadable output as failed", async () => {
    const { result } = await runStep({ stdout: ["%%% not json %%%", "<html>"] });
    expect(result.status).toBe("failed");
    expect(result).toMatchObject({ error: expect.stringContaining("unreadable") });
  });

  it("reports a crash as failed with the exit code and stderr", async () => {
    const { result } = await runStep({ stdout: [init, assistantText("Working")], stderr: "segfault\n", exitCode: 139 });
    expect(result.status).toBe("failed");
    expect(result).toMatchObject({ error: expect.stringMatching(/139[\s\S]*segfault/) });
  });

  it("reports a missing claude CLI as failed", async () => {
    const runner = createClaudeRunner({ env: { PATH: "/nonexistent" } });
    const result = await runner.run(step(), () => {});
    expect(result.status).toBe("failed");
    expect(result).toMatchObject({ error: expect.stringContaining("not found") });
  });

  it("reports an exhausted Quota with its reset time (rate limit event)", async () => {
    const { result } = await runStep({
      stdout: [
        init,
        line({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: RESET_EPOCH } }),
        line({ type: "result", subtype: "success", is_error: true, result: "5-hour limit reached" }),
      ],
      exitCode: 1,
    });
    expect(result).toEqual({ status: "quota_exhausted", resetsAt: RESET_DATE });
  });

  it("reports an exhausted Quota from the legacy limit message", async () => {
    const { result } = await runStep({
      stdout: [line({ type: "result", subtype: "success", is_error: true, result: `Claude AI usage limit reached|${RESET_EPOCH}` })],
      exitCode: 1,
    });
    expect(result).toEqual({ status: "quota_exhausted", resetsAt: RESET_DATE });
  });

  it("reports an exhausted Quota without a reset time when none is given", async () => {
    const { result } = await runStep({
      stdout: [line({ type: "result", subtype: "success", is_error: true, result: "Claude usage limit reached" })],
      exitCode: 1,
    });
    expect(result).toEqual({ status: "quota_exhausted", resetsAt: null });
  });

  it("hands the Agent's instructions and the model to the CLI", async () => {
    const { fake } = await runStep({ stdout: [resultOk] });
    const args = fake.lastInvocation().args;
    expect(args).toContain("You are the Developer.");
    expect(args).toContain("sonnet");
  });

  it("denies the tools that wait for a human, so a headless Step never stalls", async () => {
    const { fake } = await runStep({ stdout: [resultOk] });
    const args = fake.lastInvocation().args;
    const i = args.indexOf("--disallowedTools");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toContain("AskUserQuestion");
  });

  it("reports a process killed by a signal as failed, naming the signal", async () => {
    const { result } = await runStep({ stdout: [init], killWith: "SIGKILL" });
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("SIGKILL") });
  });

  it("still succeeds when a rate-limit rejection was reported but the Step completed", async () => {
    const { result } = await runStep({
      stdout: [line({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: RESET_EPOCH } }), resultOk],
    });
    expect(result).toEqual({ status: "succeeded", summary: "Done." });
  });

  it("does not mistake an ordinary error mentioning a limit for an exhausted Quota", async () => {
    const { result } = await runStep({
      stdout: [line({ type: "result", subtype: "error_during_execution", is_error: true, result: "Token limit reached in file read" })],
      exitCode: 1,
    });
    expect(result).toEqual({ status: "failed", error: "Token limit reached in file read" });
  });

  it("keeps every raw output line in the event stream, including unreadable ones", async () => {
    const thinking = line({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } });
    const { events } = await runStep({ stdout: [init, "%%% garbage %%%", thinking, resultOk] });
    expect(events.map((e) => e.raw)).toEqual([init, "%%% garbage %%%", thinking, resultOk]);
  });

  it("survives a progress listener that throws", async () => {
    const fake = createFakeClaude({ stdout: [init, resultOk] });
    const result = await createClaudeRunner({ env: fake.env }).run(step(), () => {
      throw new Error("listener bug");
    });
    expect(result).toEqual({ status: "succeeded", summary: "Done." });
  });

  it("says so when the working directory does not exist, not that claude is missing", async () => {
    const fake = createFakeClaude({ stdout: [resultOk] });
    const result = await createClaudeRunner({ env: fake.env }).run({ ...step(), cwd: "/nonexistent/worktree" }, () => {});
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("working directory") });
  });
});
