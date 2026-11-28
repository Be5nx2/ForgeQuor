import type pg from "pg";
import type { Runner } from "../runner/runner.js";
import type { AssetRequest, GateKind, Project, Run, RunUpdate } from "./types.js";
import type { RunRecords } from "./run-records.js";
import type { SeatName } from "./seats.js";
import type { ReviewMode, WorkflowDefinition, WorkflowInput } from "./workflow-definition.js";

/** The Runner an Agent works through, and the model it is set to. */
export interface AgentSeat {
  runner: Runner;
  /** Which tool the Runner drives ("claude", "codex"), recorded on each Step attempt. */
  runnerName: string;
  /** The Runner's default model when omitted. */
  model?: string;
  /** The Runner's effort level; the Runner's own default when omitted. */
  effort?: string;
}

/** What a human gives to start a Run; each Workflow reads the part that concerns it. */
export interface RunInput {
  task?: string;
  title?: string;
  assets?: AssetRequest[];
  /** How a Workflow with a `review` Step is reviewed; the Workflow's own default when omitted. */
  review?: ReviewMode;
}

/** The repository a Run is being launched against, as its launch checks see it. */
export interface LaunchRepository {
  project: Project;
  /** Whether a repository path exists on the Project's default branch, freshly fetched from the remote (fetched once, on first use). */
  exists(path: string): Promise<boolean>;
}

/**
 * What a Workflow makes of a Run's input: the Run's task and title, and what the Step types that use an input do with it
 * at launch. The core never reads an input itself.
 */
export interface RunPlan {
  task: string;
  title: string;
  /** The inputs the human gave, when not every input the Workflow declares (the others are produced by a Step, or missing). Default: all of them. */
  given?: WorkflowInput[];
  /** Refuses the launch (by throwing a clear error) when what the input leans on is not right in the repository. Runs before anything is stored. */
  check?(repo: LaunchRepository): Promise<void>;
  /** Stores the input with the new Run, inside the core's launch transaction. */
  store?(client: pg.PoolClient, runId: number, project: Project): Promise<void>;
}

/**
 * What the Forge core hands a Workflow for one Run: the Run, its prepared worktree, and the few core operations a
 * Workflow needs. The Run lifecycle (slots, queue, Pause, restart, Gates, pull-request follow-up) stays behind this seam.
 */
export interface WorkflowContext {
  run: Run;
  project: Project;
  branch: string;
  worktreePath: string;
  defaultBranch: string;
  /** Aborted when the human abandons the Run: whatever is running must stop. */
  stop: AbortSignal;
  /** The Runner and model of each Agent seat. A seat is missing when it has no usable Runner (see `seatProblems`). */
  agents: Partial<Record<SeatName, AgentSeat>>;
  /** Why each missing seat has no Runner, as the Escalation tells the human. */
  seatProblems?: Partial<Record<SeatName, string>>;
  stepTimeoutMs: number;
  checkTimeoutMs?: number;
  /** Tells subscribers the Run changed. */
  changed(): void;
  emit(update: RunUpdate): void;
  /** The Run's own records: Step attempts, Checks, Feedback and its pull request's bookkeeping. */
  records: RunRecords;
  /**
   * Pushes the Run's branch, opens its pull request unless it has one, and posts the Review Brief once. Returns the pull
   * request, or null when the human abandoned the Run meanwhile (the pull request is then closed). Safe to run again
   * after a restart.
   */
  publishPullRequest(brief: () => string): Promise<{ number: number; url: string } | null>;
  /** Opens a Gate (for the Workflow Step `step`, if any) and makes the Run Waiting, unless the Run was abandoned meanwhile. */
  openGate(kind: GateKind, reason: string, evidence?: string, step?: string): Promise<void>;
  /** The Runner's Quota ran out: the Run waits for the reset, keeping its slot. */
  pause(resetsAt: Date | null): Promise<void>;
  /** The Run's work is done and its pull request is open: the Run becomes Approved, unless it was abandoned meanwhile. */
  approve(): Promise<void>;
  /** False once the human abandoned the Run while it was being worked on. */
  stillRunning(): Promise<boolean>;
}

/**
 * A named sequence of Steps. `plan` checks what the human gave (the Step types that use an input validate it) and says
 * what the Run is called; it throws a clear error when the input is no good. A Run freezes the `definition` it starts
 * with, and the engine works the Run from it until it waits at a Gate, pauses or is abandoned, starting over from what is
 * recorded when the Run was worked on before. An error it throws opens an Escalation.
 */
export interface Workflow {
  name: string;
  /** The inputs the Workflow takes at launch. */
  inputs: readonly WorkflowInput[];
  /** The Steps of the Workflow, as a Run starts with them. */
  definition: WorkflowDefinition;
  plan(input: RunInput): RunPlan;
  /** What its Publish Step does around opening the pull request; by default the Developer's Review Brief file is posted. */
  publication?: Publication;
}

/** How a Workflow's pull request is made. */
export interface Publication {
  /** Runs before the branch is pushed, such as committing what the Workflow produced. */
  prepare?(ctx: WorkflowContext): Promise<void>;
  /** The Review Brief to post on the pull request. */
  brief(ctx: WorkflowContext): Promise<string>;
}
