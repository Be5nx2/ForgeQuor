import type { Runner, RunnerEvent, StepRequest, StepResult } from "../../src/runner/runner.js";

export type Script = (step: StepRequest, emit: (e: RunnerEvent) => void) => Promise<StepResult | void> | StepResult | void;

export interface FakeRunner extends Runner {
  steps: StepRequest[];
  use: (s: Script) => void;
  /** The sessions it keeps, by id: a Step that resumes one it does not have fails as a lost session. */
  sessions: Set<string>;
  /** Forgets every session, as a CLI that lost its history. */
  forgetSessions: () => void;
}

/** A scripted Runner: the script plays the Agent (edits files, commits...) and may return a result. It keeps sessions for the Steps that ask for them. */
export function createFakeRunner(script: Script = () => {}): FakeRunner {
  let current = script;
  const steps: StepRequest[] = [];
  const sessions = new Set<string>();
  let started = 0;
  return {
    steps,
    sessions,
    forgetSessions: () => sessions.clear(),
    use: (s) => {
      current = s;
    },
    async run(step, onEvent) {
      steps.push(step);
      let session: string | undefined;
      if (step.session) {
        if ("resume" in step.session && !sessions.has(step.session.resume)) {
          return { status: "failed", error: `No conversation found with session ID: ${step.session.resume}`, sessionLost: true };
        }
        session = "resume" in step.session ? step.session.resume : `fake-session-${++started}`;
        sessions.add(session);
      }
      try {
        const result = (await current(step, onEvent)) ?? { status: "succeeded", summary: "done" };
        return session && result.status === "succeeded" ? { ...result, sessionId: session } : result;
      } catch (e: any) {
        return { status: "failed", error: String(e?.message ?? e) };
      }
    },
  };
}
