/**
 * A Step that keeps or resumes a conversation, for the Steps that talk with the human over several turns (the Griller).
 * `start` begins a session whose id the result carries; `resume` continues the one with that id, the prompt being the next
 * message in it. A Runner that cannot keep sessions refuses the request (the Step fails).
 */
export type SessionRequest = { start: true } | { resume: string };

/** One Step handed to a Runner. */
export interface StepRequest {
  /** The Agent's standing instructions (appended to the Runner's system prompt). */
  instructions: string;
  /** What to do in this Step. */
  prompt: string;
  /** Directory the Agent works in (the Run's worktree). */
  cwd: string;
  model?: string;
  /** Images to show the Agent with the prompt (absolute paths), for Runners that can take them (Codex); others ignore them. */
  images?: string[];
  /**
   * The Step must not change the worktree. Codex then runs in its read-only sandbox; Claude Code keeps its permissions
   * (ADR 0005), so for it the engine's after-Step check is what enforces it.
   */
  readonly?: boolean;
  /** Keeps or resumes a session; absent for the Steps that run in a fresh, forgotten one. */
  session?: SessionRequest;
  /** Aborting it kills the Runner's process and everything it started; the Step then ends as a failure. */
  signal?: AbortSignal;
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
  /** `files` are the files the Runner itself produced outside the worktree (Codex's generated images), as absolute paths in creation order; empty for Runners that produce none. */
  | { status: "succeeded"; summary: string; files?: string[]; /** The session the Step ran in, when it asked for one. */ sessionId?: string }
  /** `sessionLost` says the failure is that the Runner no longer has the session a `resume` named. */
  | { status: "failed"; error: string; sessionLost?: true }
  /** The Runner's Quota is used up; `resetsAt` is null when the Runner did not say when. */
  | { status: "quota_exhausted"; resetsAt: Date | null };

/** The seam between Forge core and an AI tool (Claude Code, Codex). */
export interface Runner {
  /** Runs one Step in a fresh session (or the one it asks to keep or resume), reporting progress as it goes. Never rejects: failures are results. */
  run(step: StepRequest, onEvent: (event: RunnerEvent) => void): Promise<StepResult>;
}
