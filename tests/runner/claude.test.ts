import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { killAllProcessGroups } from "../../src/process-group.js";
import { createClaudeRunner } from "../../src/runner/claude.js";
import type { RunnerEvent, StepRequest } from "../../src/runner/runner.js";
import { createFakeCli, type FakeCliScript } from "../harness/fake-cli.js";
import { eventually } from "../harness/wait.js";

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

async function runStep(script: FakeCliScript) {
  const fake = createFakeCli(script);
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

  it("hands the effort to the CLI as its own option, and adds none when there is no effort", async () => {
    const fake = createFakeCli({ stdout: [resultOk] });
    const runner = createClaudeRunner({ env: fake.env });

    await runner.run({ ...step(), effort: "xhigh" }, () => {});
    const args = fake.lastInvocation().args;
    expect(args[args.indexOf("--effort") + 1]).toBe("xhigh");
    await runner.run(step(), () => {});
    expect(fake.lastInvocation().args).not.toContain("--effort");
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
    const fake = createFakeCli({ stdout: [init, resultOk] });
    const result = await createClaudeRunner({ env: fake.env }).run(step(), () => {
      throw new Error("listener bug");
    });
    expect(result).toEqual({ status: "succeeded", summary: "Done." });
  });

  it("says so when the working directory does not exist, not that claude is missing", async () => {
    const fake = createFakeCli({ stdout: [resultOk] });
    const result = await createClaudeRunner({ env: fake.env }).run({ ...step(), cwd: "/nonexistent/worktree" }, () => {});
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("working directory") });
  });

  describe("cancelling a Step", () => {
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    it("kills claude and everything it started, then reports a failure", async () => {
      const fake = createFakeCli({ stdout: [], hang: true });
      const controller = new AbortController();
      const running = createClaudeRunner({ env: fake.env }).run({ ...step(), signal: controller.signal }, () => {});
      const grandchild = await eventually(() => fake.grandchildPid());
      expect(alive(grandchild)).toBe(true);

      controller.abort();
      const result = await running;

      expect(result.status).toBe("failed");
      await eventually(() => !alive(grandchild));
    });

    it("is ended with Forgequor: a detached claude does not get Forgequor's Ctrl-C", async () => {
      const fake = createFakeCli({ stdout: [], hang: true });
      const running = createClaudeRunner({ env: fake.env }).run(step(), () => {});
      const grandchild = await eventually(() => fake.grandchildPid());

      killAllProcessGroups();

      expect((await running).status).toBe("failed");
      await eventually(() => !alive(grandchild));
    });

    it("does not start claude at all when already cancelled", async () => {
      const fake = createFakeCli({ stdout: [], hang: true });
      const controller = new AbortController();
      controller.abort();

      const result = await createClaudeRunner({ env: fake.env }).run({ ...step(), signal: controller.signal }, () => {});

      expect(result.status).toBe("failed");
      expect(fake.grandchildPid()).toBeNull();
    });
  });
  describe("sessions", () => {
    const resultIn = (session: string) => line({ type: "result", subtype: "success", is_error: false, result: "Round.", session_id: session });
    const sessionOf = (args: string[]) => args[args.indexOf("--session-id") + 1];

    it("keeps nothing for a Step that asks for no session", async () => {
      const { fake } = await runStep({ stdout: [init, resultOk] });

      expect(fake.lastInvocation().args).toContain("--no-session-persistence");
      expect(fake.lastInvocation().args).not.toContain("--session-id");
    });

    it("starts a session with an id of its own and returns the one the CLI reports", async () => {
      const fake = createFakeCli({ stdout: [init, resultIn("s-from-cli")] });

      const result = await createClaudeRunner({ env: fake.env }).run({ ...step(), session: { start: true } }, () => {});

      const args = fake.lastInvocation().args;
      expect(args).not.toContain("--no-session-persistence");
      expect(sessionOf(args)).toMatch(/^[0-9a-f-]{36}$/);
      expect(args).not.toContain("--resume");
      expect(result).toEqual({ status: "succeeded", summary: "Round.", sessionId: "s-from-cli" });
    });

    it("resumes a session with the new message as the prompt", async () => {
      const fake = createFakeCli({ stdout: [init, resultIn("s1")] });

      const result = await createClaudeRunner({ env: fake.env }).run({ ...step(), prompt: "My answers.", session: { resume: "s1" } }, () => {});

      const call = fake.lastInvocation();
      expect(call.args.slice(call.args.indexOf("--resume"), call.args.indexOf("--resume") + 2)).toEqual(["--resume", "s1"]);
      expect(call.args).not.toContain("--session-id");
      expect(call.args).not.toContain("--no-session-persistence");
      expect(call.stdin).toBe("My answers.");
      expect(result).toMatchObject({ status: "succeeded", sessionId: "s1" });
    });

    it("reports a session the CLI no longer has as lost", async () => {
      const fake = createFakeCli({
        stdout: [line({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["No conversation found with session ID: gone"], session_id: "gone" })],
        stderr: "No conversation found with session ID: gone",
        exitCode: 1,
      });

      const result = await createClaudeRunner({ env: fake.env }).run({ ...step(), session: { resume: "gone" } }, () => {});

      expect(result).toMatchObject({ status: "failed", sessionLost: true, error: expect.stringContaining("No conversation found") });
    });

    it("does not call another failure a lost session", async () => {
      const fake = createFakeCli({ stdout: [line({ type: "result", subtype: "error_during_execution", is_error: true, result: "Tool exploded" })], exitCode: 1 });

      const result = await createClaudeRunner({ env: fake.env }).run({ ...step(), session: { resume: "s1" } }, () => {});

      expect(result).toEqual({ status: "failed", error: "Tool exploded" });
    });
  });
});
