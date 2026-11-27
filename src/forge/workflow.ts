import type pg from "pg";
import type { CodeHost } from "../codehost/codehost.js";
import type { Runner } from "../runner/runner.js";
import type { AssetRequest } from "./assets.js";
import type { GateKind, Project, Run, RunUpdate } from "./forge.js";

/** The Runner an Agent works through, and the model it is set to. */
export interface AgentSeat {
  runner: Runner;
  /** Which tool the Runner drives ("claude", "codex"), recorded on each Step attempt. */
  runnerName: string;
  /** The Runner's default model when omitted. */
  model?: string;
}

/** What a human gives to start a Run; each Workflow reads the part that concerns it. */
export interface RunInput {
  task?: string;
  title?: string;
  assets?: AssetRequest[];
}

/** What a Workflow makes of a Run's input: the Run's task and title, and its validated Asset Requests (none for most). */
export interface RunPlan {
  task: string;
  title: string;
  assets: AssetRequest[];
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
  pool: pg.Pool;
  /** The Runner and model of each Agent. The Artist's is missing when Forgequor has no Runner for it. */
  agents: { developer: AgentSeat; artist?: AgentSeat };
  codeHost: CodeHost;
  stepTimeoutMs: number;
  checkTimeoutMs?: number;
  /** Tells subscribers the Run changed. */
  changed(): void;
  emit(update: RunUpdate): void;
  /** Opens a Gate and makes the Run Waiting, unless the Run was abandoned meanwhile. */
  openGate(kind: GateKind, reason: string, evidence?: string): Promise<void>;
  /** The Runner's Quota ran out: the Run waits for the reset, keeping its slot. */
  pause(resetsAt: Date | null): Promise<void>;
  /** The Run's work is done and its pull request is open: the Run becomes Approved, unless it was abandoned meanwhile. */
  approve(): Promise<void>;
  /** False once the human abandoned the Run while it was being worked on. */
  stillRunning(): Promise<boolean>;
}

/**
 * A named sequence of Steps. `plan` checks what the human gave and says what the Run is called; it throws a clear error
 * when the input is no good. `run` works the Run until it waits at a Gate, pauses or is abandoned, starting over from
 * what is recorded when the Run was worked on before. An error it throws opens an Escalation.
 */
export interface Workflow {
  name: string;
  plan(input: RunInput): RunPlan;
  run(ctx: WorkflowContext): Promise<void>;
}
