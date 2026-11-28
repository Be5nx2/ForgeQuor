import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { killAllProcessGroups } from "../../src/process-group.js";
import { createCodexRunner } from "../../src/runner/codex.js";
import type { RunnerEvent, StepRequest } from "../../src/runner/runner.js";
import { createFakeCli, type FakeCliScript } from "../harness/fake-cli.js";
import { eventually } from "../harness/wait.js";

const line = (o: unknown) => JSON.stringify(o);
const THREAD = "01a-thread";
const started = line({ type: "thread.started", thread_id: THREAD });
const turnStarted = line({ type: "turn.started" });
const message = (text: string) => line({ type: "item.completed", item: { id: "i", type: "agent_message", text } });
const fileChange = line({ type: "item.started", item: { id: "f", type: "file_change", changes: [], status: "in_progress" } });
const completed = line({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
const failed = (text: string) => line({ type: "turn.failed", error: { message: text } });

function step(): StepRequest {
  return {
    instructions: "You are the Artist.",
    prompt: "Draw a 16x16 slime.",
    cwd: realpathSync(mkdtempSync(join(tmpdir(), "forgequor-step-"))),
    model: "gpt-test",
  };
}

/** A fake `codex` plus a temporary CODEX_HOME to put generated images in. */
function setup(script: Omit<FakeCliScript, "files">, images: string[] = []) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "forgequor-codex-home-")));
  const files = images.map((name) => ({ path: join(home, "generated_images", THREAD, name), content: `png:${name}` }));
  const fake = createFakeCli({ ...script, files }, "codex");
  const env = { ...fake.env, CODEX_HOME: home };
  return { fake, env, home, paths: files.map((f) => f.path) };
}

async function runStep(script: Omit<FakeCliScript, "files">, images: string[] = []) {
  const s = setup(script, images);
  const events: RunnerEvent[] = [];
  const request = step();
  const result = await createCodexRunner({ env: s.env }).run(request, (e) => events.push(e));
  return { ...s, result, events, request };
}

describe("Codex Runner", () => {
  it("streams progress, then reports success with the last message, in the Step's directory", async () => {
    const { result, events, fake, request } = await runStep({
      stdout: [started, turnStarted, message("On it."), fileChange, message("All done."), completed],
    });

    expect(result).toEqual({ status: "succeeded", summary: "All done.", files: [] });
    expect(events.map((e) => e.kind)).toEqual(["other", "other", "text", "tool", "text", "other"]);
    expect(events.map((e) => e.raw)).toEqual([started, turnStarted, message("On it."), fileChange, message("All done."), completed]);
    expect(events.find((e) => e.kind === "text")!.summary).toBe("On it.");
    const call = fake.lastInvocation();
    expect(call.cwd).toBe(request.cwd);
    expect(call.stdin).toContain("Draw a 16x16 slime.");
  });

  it("runs sandboxed in the workspace, with approval prompts off, one fresh session, JSON output", async () => {
    const { fake } = await runStep({ stdout: [started, message("ok"), completed] });
    const args = fake.lastInvocation().args;

    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--skip-git-repo-check");
    expect(args[args.indexOf("-s") + 1]).toBe("workspace-write");
    expect(args).toContain('approval_policy="never"');
    expect(args).not.toContain("--ephemeral");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args.at(-1)).toBe("-");
  });

  it("runs a read-only Step in Codex's read-only sandbox", async () => {
    const s = setup({ stdout: [started, message("Reviewed."), completed] });
    const result = await createCodexRunner({ env: s.env }).run({ ...step(), readonly: true }, () => {});

    expect(result).toMatchObject({ status: "succeeded", summary: "Reviewed." });
    const args = s.fake.lastInvocation().args;
    expect(args[args.indexOf("-s") + 1]).toBe("read-only");
    expect(args).toContain('approval_policy="never"');
  });

  it("hands the Agent's instructions and the model to Codex", async () => {
    const { fake } = await runStep({ stdout: [started, message("ok"), completed] });
    const args = fake.lastInvocation().args;

    expect(args[args.indexOf("-m") + 1]).toBe("gpt-test");
    expect(args).toContain('developer_instructions="You are the Artist."');
  });

  it("attaches the reference images to the prompt, one flag each, before the prompt marker", async () => {
    const s = setup({ stdout: [started, message("ok"), completed] });
    const runner = createCodexRunner({ env: s.env });

    await runner.run({ ...step(), images: ["/w/ref-a.png", "/w/ref-b.png"] }, () => {});
    const args = s.fake.lastInvocation().args;

    expect(args.filter((a) => a === "-i")).toHaveLength(2);
    expect(args[args.indexOf("-i") + 1]).toBe("/w/ref-a.png");
    expect(args[args.lastIndexOf("-i") + 1]).toBe("/w/ref-b.png");
    expect(args.at(-1)).toBe("-");
    await runner.run(step(), () => {});
    expect(s.fake.lastInvocation().args).not.toContain("-i");
  });

  it("quotes instructions with quotes and newlines so Codex reads them as one TOML string", async () => {
    const s = setup({ stdout: [started, message("ok"), completed] });
    await createCodexRunner({ env: s.env }).run({ ...step(), instructions: 'Say "hi"\nthen stop' }, () => {});

    expect(s.fake.lastInvocation().args).toContain('developer_instructions="Say \\"hi\\"\\nthen stop"');
  });

  it("collects the images of its thread from the Codex home folder, in creation order", async () => {
    const { result, paths, events } = await runStep(
      { stdout: [started, message("Drew it."), completed] },
      ["exec-a.png", "exec-b.png"],
    );

    expect(result).toEqual({ status: "succeeded", summary: "Drew it.", files: paths });
    expect(events.filter((e) => e.summary.startsWith("image generated")).map((e) => e.summary)).toEqual([
      "image generated: exec-a.png",
      "image generated: exec-b.png",
    ]);
  });

  it("collects no image from another thread", async () => {
    const s = setup({ stdout: [line({ type: "thread.started", thread_id: "other-thread" }), message("ok"), completed] }, ["exec-a.png"]);

    const result = await createCodexRunner({ env: s.env }).run(step(), () => {});

    expect(result).toMatchObject({ status: "succeeded", files: [] });
  });

  it("reports a usage limit turn failure with a retry time as an exhausted Quota with that reset time", async () => {
    const { result } = await runStep({
      stdout: [started, failed("You've hit your usage limit. Try again at Mar 17th, 2030 5:46 PM.")],
      exitCode: 1,
    });

    expect(result).toEqual({ status: "quota_exhausted", resetsAt: new Date("Mar 17, 2030 5:46 PM") });
  });

  it("reports a usage limit without a readable retry time as an exhausted Quota without a reset time", async () => {
    const { result } = await runStep({ stdout: [started, failed("You've hit your usage limit.")], exitCode: 1 });

    expect(result).toEqual({ status: "quota_exhausted", resetsAt: null });
  });

  it("reports an image limit mentioned in the final message, with no image, as an exhausted Quota without a reset time", async () => {
    const { result } = await runStep({
      stdout: [started, message("I could not draw it: the image generation usage limit was reached."), completed],
    });

    expect(result).toEqual({ status: "quota_exhausted", resetsAt: null });
  });

  it("does not mistake a finished image Step that talks about a limit for an exhausted Quota", async () => {
    const { result } = await runStep({ stdout: [started, message("Done, within the usage limit."), completed] }, ["exec-a.png"]);

    expect(result.status).toBe("succeeded");
  });

  it("ignores a transient error event when the turn still completes", async () => {
    const { result } = await runStep({
      stdout: [started, line({ type: "error", message: "Reconnecting... 1/5" }), message("Done."), completed],
    });

    expect(result).toMatchObject({ status: "succeeded", summary: "Done." });
  });

  it("reports an error event as the failure when the turn never completes", async () => {
    const { result } = await runStep({ stdout: [started, line({ type: "error", message: "stream closed" })], exitCode: 1 });

    expect(result).toEqual({ status: "failed", error: "stream closed" });
  });

  it("reports a bare error event on an unfinished turn as a failure, even when it mentions a usage limit", async () => {
    const { result } = await runStep({
      stdout: [started, line({ type: "error", message: "You've hit your usage limit. Try again at Mar 17th, 2030 5:46 PM." })],
      exitCode: 1,
    });

    expect(result).toEqual({ status: "failed", error: "You've hit your usage limit. Try again at Mar 17th, 2030 5:46 PM." });
  });

  it("does not treat a plain rate-limit failure as an exhausted Quota", async () => {
    const { result } = await runStep({ stdout: [started, failed("429 rate limit exceeded")], exitCode: 1 });

    expect(result.status).toBe("failed");
  });

  it("reports any other turn failure as failed with its message", async () => {
    const { result } = await runStep({ stdout: [started, failed("The model exploded")], exitCode: 1 });

    expect(result).toEqual({ status: "failed", error: "The model exploded" });
  });

  it("reports unreadable output as failed", async () => {
    const { result } = await runStep({ stdout: ["%%% not json %%%", "<html>"] });

    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("unreadable") });
  });

  it("reports a crash as failed with the exit code and stderr", async () => {
    const { result } = await runStep({ stdout: [started, message("Working")], stderr: "segfault\n", exitCode: 139 });

    expect(result).toMatchObject({ status: "failed", error: expect.stringMatching(/139[\s\S]*segfault/) });
  });

  it("reports a process killed by a signal as failed, naming the signal", async () => {
    const { result } = await runStep({ stdout: [started], killWith: "SIGKILL" });

    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("SIGKILL") });
  });

  it("reports a missing codex CLI as failed", async () => {
    const result = await createCodexRunner({ env: { PATH: "/nonexistent" } }).run(step(), () => {});

    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("not found") });
  });

  it("survives a progress listener that throws", async () => {
    const s = setup({ stdout: [started, message("ok"), completed] });
    const result = await createCodexRunner({ env: s.env }).run(step(), () => {
      throw new Error("listener bug");
    });

    expect(result.status).toBe("succeeded");
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

    it("kills codex and everything it started, then reports a failure", async () => {
      const s = setup({ stdout: [], hang: true });
      const controller = new AbortController();
      const running = createCodexRunner({ env: s.env }).run({ ...step(), signal: controller.signal }, () => {});
      const grandchild = await eventually(() => s.fake.grandchildPid());
      expect(alive(grandchild)).toBe(true);

      controller.abort();
      const result = await running;

      expect(result.status).toBe("failed");
      await eventually(() => !alive(grandchild));
    });

    it("is ended with Forgequor: a detached codex does not get Forgequor's Ctrl-C", async () => {
      const s = setup({ stdout: [], hang: true });
      const running = createCodexRunner({ env: s.env }).run(step(), () => {});
      const grandchild = await eventually(() => s.fake.grandchildPid());

      killAllProcessGroups();
      await running;

      await eventually(() => !alive(grandchild));
    });

    it("does not start when already cancelled", async () => {
      const s = setup({ stdout: [started, message("ok"), completed] });
      const controller = new AbortController();
      controller.abort();

      const result = await createCodexRunner({ env: s.env }).run({ ...step(), signal: controller.signal }, () => {});

      expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("cancelled") });
    });
  });

  it("refuses a Step that asks for a session, which it cannot keep", async () => {
    const fake = createFakeCli({ stdout: [] }, "codex");

    const result = await createCodexRunner({ env: fake.env }).run({ ...step(), session: { start: true } }, () => {});

    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("cannot keep a session") });
  });

  describe("Quota reading", () => {
    const limits = (primary: number, secondary: number) => ({
      limit_id: "codex",
      primary: { used_percent: primary, window_minutes: 300, resets_at: 1795832327 },
      secondary: { used_percent: secondary, window_minutes: 10080, resets_at: 1796118612 },
      rate_limit_reached_type: null,
    });
    const tokenCount = (rate_limits: unknown) => line({ type: "event_msg", payload: { type: "token_count", info: null, rate_limits } });
    const rollout = (home: string, ...lines: string[]) => {
      const dir = join(home, "sessions", "2026", "11", "27");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `rollout-2026-11-27T10-00-00-${THREAD}.jsonl`), lines.join("\n") + "\n");
    };
    const stdout = [started, message("ok"), completed];
    const now = () => new Date("2026-11-27T10:00:00Z");

    async function runWith(prepare: (home: string) => void, script = stdout) {
      const home = realpathSync(mkdtempSync(join(tmpdir(), "forgequor-codex-home-")));
      prepare(home);
      const fake = createFakeCli({ stdout: script }, "codex");
      return createCodexRunner({ env: { ...fake.env, CODEX_HOME: home }, now }).run(step(), () => {});
    }

    it("reads the last token_count of the thread's session file: primary is five-hour, secondary weekly", async () => {
      const result = await runWith((home) => rollout(home, tokenCount(limits(1, 5)), line({ type: "event_msg", payload: { type: "agent_message" } }), tokenCount(limits(3, 11))));

      expect(result.status).toBe("succeeded");
      expect(result.quota).toEqual({
        fiveHour: { percentUsed: 3, resetsAt: new Date(1795832327 * 1000) },
        weekly: { percentUsed: 11, resetsAt: new Date(1796118612 * 1000) },
        exhausted: false,
        readAt: now(),
      });
    });

    it("says exhausted when a window is full", async () => {
      const result = await runWith((home) => rollout(home, tokenCount(limits(100, 40))));
      expect(result.quota?.exhausted).toBe(true);
    });

    it("gives no reading without a session file, with an unreadable one, or without rate limits", async () => {
      expect((await runWith(() => {})).quota).toBeUndefined();
      expect((await runWith((home) => rollout(home, "not json", "{"))).quota).toBeUndefined();
      expect((await runWith((home) => rollout(home, tokenCount(null)))).quota).toBeUndefined();
      expect((await runWith((home) => rollout(home, tokenCount(limits(1, 2))), [message("no thread")])).quota).toBeUndefined();
    });

    it("also carries the reading when the Step ran out of Quota", async () => {
      const result = await runWith((home) => rollout(home, tokenCount(limits(100, 20))), [started, failed("You've hit your usage limit. Try again later.")]);
      expect(result.status).toBe("quota_exhausted");
      expect(result.quota?.fiveHour.percentUsed).toBe(100);
    });
  });
});
