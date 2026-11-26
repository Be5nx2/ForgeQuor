import type { Runner, RunnerEvent, StepRequest, StepResult } from "../../src/runner/runner.js";

export type Script = (step: StepRequest, emit: (e: RunnerEvent) => void) => Promise<StepResult | void> | StepResult | void;

/** A scripted Runner: the script plays the Agent (edits files, commits...) and may return a result. */
export function createFakeRunner(script: Script = () => {}): Runner & { steps: StepRequest[]; use: (s: Script) => void } {
  let current = script;
  const steps: StepRequest[] = [];
  return {
    steps,
    use: (s) => {
      current = s;
    },
    async run(step, onEvent) {
      steps.push(step);
      try {
        return (await current(step, onEvent)) ?? { status: "succeeded", summary: "done" };
      } catch (e: any) {
        return { status: "failed", error: String(e?.message ?? e) };
      }
    },
  };
}
