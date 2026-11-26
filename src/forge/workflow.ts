import type pg from "pg";
import type { CodeHost } from "../codehost/codehost.js";
import type { Runner } from "../runner/runner.js";
import type { GateKind, Project, Run, RunUpdate } from "./forge.js";

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
  runner: Runner;
  codeHost: CodeHost;
  developerModel?: string;
  stepTimeoutMs: number;
  checkTimeoutMs?: number;
  /** Tells subscribers the Run changed. */
  changed(): void;
  emit(update: RunUpdate): void;
  /** Opens a Gate and makes the Run Waiting, unless the Run was abandoned meanwhile. */
  openGate(kind: GateKind, reason: string, evidence?: string): Promise<void>;
  /** The Runner's Quota ran out: the Run waits for the reset, keeping its slot. */
  pause(resetsAt: Date | null): Promise<void>;
  /** False once the human abandoned the Run while it was being worked on. */
  stillRunning(): Promise<boolean>;
}

/**
 * A named sequence of Steps. `run` works the Run until it waits at a Gate, pauses or is abandoned, starting over from
 * what is recorded when the Run was worked on before. An error it throws opens an Escalation.
 */
export interface Workflow {
  name: string;
  run(ctx: WorkflowContext): Promise<void>;
}
