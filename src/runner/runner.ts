/** One Step handed to a Runner. */
export interface StepRequest {
  /** The Agent's standing instructions (appended to the Runner's system prompt). */
  instructions: string;
  /** What to do in this Step. */
  prompt: string;
  /** Directory the Agent works in (the Run's worktree). */
  cwd: string;
  model?: string;
}

/**
 * One progress event. `raw` is the Runner's own output line, kept verbatim for the Step attempt's log;
 * when one line yields several events only the first carries it (the others have ""), so joining `raw` rebuilds the log.
 */
export interface RunnerEvent {
  kind: "text" | "tool" | "other";
  summary: string;
  raw: string;
}

export type StepResult =
  | { status: "succeeded"; summary: string }
  | { status: "failed"; error: string }
  /** The Runner's Quota is used up; `resetsAt` is null when the Runner did not say when. */
  | { status: "quota_exhausted"; resetsAt: Date | null };

/** The seam between Forge core and an AI tool (Claude Code, later Codex). */
export interface Runner {
  /** Runs one Step in a fresh session, reporting progress as it goes. Never rejects: failures are results. */
  run(step: StepRequest, onEvent: (event: RunnerEvent) => void): Promise<StepResult>;
}
