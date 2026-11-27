import { describe, expect, it } from "vitest";
import { runAgentStep } from "../../src/forge/step.js";
import type { AgentSeat, WorkflowContext } from "../../src/forge/workflow.js";
import type { StepResult } from "../../src/runner/runner.js";
import { createFakeRunner } from "../harness/fake-runner.js";

/** A context made of the operations the executor uses, recording what it is told. */
function fakeContext(over: { stepTimeoutMs?: number; abandoned?: boolean } = {}) {
  const seen = { gates: [] as unknown[][], pauses: [] as (Date | null)[], finished: [] as { status: string; log: string }[], events: [] as any[], started: [] as any[] };
  const stop = new AbortController();
  const ctx = {
    run: { id: 1, iteration: 1 },
    worktreePath: "/nowhere",
    stop: stop.signal,
    stepTimeoutMs: over.stepTimeoutMs ?? 5000,
    records: {
      async startAttempt(s: unknown) {
        seen.started.push(s);
        return 7;
      },
      async finishAttempt(_id: number, result: StepResult, log: string) {
        seen.finished.push({ status: result.status, log });
      },
    },
    changed() {},
    emit: (u: unknown) => seen.events.push(u),
    openGate: async (...args: unknown[]) => void seen.gates.push(args),
    pause: async (at: Date | null) => void seen.pauses.push(at),
    stillRunning: async () => !over.abandoned,
  } as unknown as WorkflowContext;
  return { ctx, seen, stop };
}

const step = { name: "developer", attempt: 1, instructions: "i", prompt: "p" };
const seatOf = (runner: AgentSeat["runner"]): AgentSeat => ({ runner, runnerName: "claude" });

describe("the Agent Step executor", () => {
  it("returns a success, recording the attempt and streaming progress", async () => {
    const { ctx, seen } = fakeContext();
    const runner = createFakeRunner((_s, emit) => {
      emit({ kind: "text", summary: "working", raw: "raw line" });
      return { status: "succeeded", summary: "done" };
    });
    const result = await runAgentStep(ctx, seatOf(runner), step);
    expect(result).toEqual({ status: "succeeded", summary: "done" });
    expect(seen.started).toEqual([{ step: "developer", attempt: 1, runner: "claude", model: undefined, assetId: undefined }]);
    expect(seen.finished).toEqual([{ status: "succeeded", log: "raw line" }]);
    expect(seen.events).toMatchObject([{ type: "progress", runId: 1, attemptId: 7, summary: "working" }]);
    expect(seen.gates).toEqual([]);
  });

  it("opens an Escalation naming the Agent when the Step fails", async () => {
    const { ctx, seen } = fakeContext();
    const runner = createFakeRunner(() => ({ status: "failed", error: "boom" }));
    expect(await runAgentStep(ctx, seatOf(runner), { ...step, name: "artist" })).toBeNull();
    expect(seen.gates).toEqual([["escalation", "The Artist failed.", "boom"]]);
  });

  it("kills a Step that outlives the timeout and opens an Escalation", async () => {
    const { ctx, seen } = fakeContext({ stepTimeoutMs: 20 });
    const runner = {
      run: (req: { signal?: AbortSignal }) =>
        new Promise<StepResult>((resolve) => req.signal!.addEventListener("abort", () => resolve({ status: "failed", error: "killed" }))),
    };
    expect(await runAgentStep(ctx, seatOf(runner), step)).toBeNull();
    expect(seen.gates[0]?.slice(0, 2)).toEqual(["escalation", "The Developer's Step timed out after 20 ms and was killed."]);
  });

  it("pauses the Run when the Quota is used up", async () => {
    const { ctx, seen } = fakeContext();
    const resetsAt = new Date("2030-01-01T00:00:00Z");
    const runner = createFakeRunner(() => ({ status: "quota_exhausted", resetsAt }));
    expect(await runAgentStep(ctx, seatOf(runner), step)).toBeNull();
    expect(seen.pauses).toEqual([resetsAt]);
    expect(seen.gates).toEqual([]);
  });

  it("does nothing more once the Run was abandoned", async () => {
    const { ctx, seen } = fakeContext({ abandoned: true });
    const runner = createFakeRunner(() => ({ status: "failed", error: "killed" }));
    expect(await runAgentStep(ctx, seatOf(runner), step)).toBeNull();
    expect(seen.gates).toEqual([]);
    expect(seen.finished).toHaveLength(1);
  });

  it("stops the Agent when the human abandons the Run", async () => {
    const { ctx, stop } = fakeContext();
    const runner = {
      run: (req: { signal?: AbortSignal }) =>
        new Promise<StepResult>((resolve) => {
          const done = () => resolve({ status: "failed", error: "stopped" });
          if (req.signal!.aborted) done();
          else req.signal!.addEventListener("abort", done);
        }),
    };
    const running = runAgentStep(ctx, seatOf(runner), step);
    stop.abort();
    expect(await running).toBeNull();
  });
});
