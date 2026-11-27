/**
 * The shapes the Forge interface takes and returns, and so the shapes of the HTTP API. This module imports nothing: the
 * web UI type-checks against it too, so the server and the UI can never disagree (over JSON, a Date arrives as a string).
 */

export interface Project {
  id: number;
  name: string;
  localPath: string;
  remoteOwner: string;
  remoteName: string;
  defaultBranch: string;
  checks: string[];
  /** Commands run in a Run's new worktree, in order, before the Developer. */
  setup: string[];
  maxConcurrentRuns: number;
  /** The Art Direction document, relative to the repository. */
  artDirectionPath: string;
  /** Where an `assets` Run commits its Assets, relative to the repository. */
  artFolder: string;
}

/** The Art Direction facts of a Project and the images a Run form can offer as references. */
export interface ArtInfo {
  present: boolean;
  defaultSize: { width: number; height: number } | null;
  references: string[];
  images: string[];
}

export type RunState = "queued" | "running" | "waiting" | "paused" | "approved" | "merged" | "closed" | "abandoned";
export type GateKind = "final" | "escalation" | "asset";
/** What a Gate records as decided. */
export type GateDecision = "approve" | "reject" | "abandon";
/** `judge` is the verdicts of an Asset Gate: its decision is recorded as approve when every Asset was approved, reject when any was not. */
export type GateAction = "approve" | "reject" | "abandon" | "judge";

export interface Run {
  id: number;
  projectId: number;
  /** Name of the Workflow the Run follows. */
  workflow: string;
  /** The Run's current Iteration, from 1; each rejection at a Gate starts the next. */
  iteration: number;
  title: string;
  task: string;
  trackerRef: string | null;
  state: RunState;
  branch: string | null;
  worktreePath: string | null;
  prNumber: number | null;
  prUrl: string | null;
  /** When a Paused Run restarts its current Step (the Runner's Quota reset time); null otherwise. */
  resumeAt: Date | null;
  createdAt: Date;
}

export interface StepAttempt {
  id: number;
  iteration: number;
  step: string;
  /** The Workflow Step the attempt belongs to; null for a Run from before Workflows were frozen. */
  stepId: string | null;
  attempt: number;
  runner: string;
  model: string | null;
  /** The Asset an Artist attempt worked on. */
  assetId: number | null;
  status: "running" | "succeeded" | "failed" | "quota_exhausted";
  startedAt: Date;
  endedAt: Date | null;
  summary: string | null;
  error: string | null;
  quotaResetsAt: Date | null;
  eventLog: string;
}

export interface CheckResult {
  id: number;
  iteration: number;
  /** The Developer attempt whose work this Check validated. */
  attempt: number;
  command: string;
  /** Null when the command was killed. */
  exitStatus: number | null;
  output: string;
  ranAt: Date;
}

export interface Gate {
  id: number;
  runId: number;
  /** The Iteration of its Run the Gate was opened in. */
  iteration: number;
  /** The Workflow Step that opened it; null for a Run from before Workflows were frozen. */
  stepId: string | null;
  kind: GateKind;
  reason: string;
  evidence: string | null;
  /** What the human can do here. A final Gate may be approved or rejected with Feedback; an Asset Gate judged; an Escalation can only be abandoned. */
  actions: GateAction[];
  /** The human's written reason, when the Gate was rejected. */
  feedback: string | null;
  /** The verdict on each Asset, once an Asset Gate was judged. */
  verdicts: GateVerdict[];
  openedAt: Date;
  decidedAt: Date | null;
  /** What was decided: approve or reject (an Asset Gate judged by verdicts is approve when all were approved), or abandon. */
  decision: GateDecision | null;
}

/** One pass through the produce → review loop; the Feedback is what started it (null for the first). */
export interface Iteration {
  number: number;
  /** At a final Gate, the human's Feedback; at an Asset Gate, each rejected Asset's Feedback, one line each, as `name: Feedback`. */
  feedback: string | null;
}

/** Where a Step of a Run stands: waiting for what it needs, running, done, skipped (its `when` input was missing), or failed (it opened an Escalation). */
export type StepStatus = "waiting" | "running" | "done" | "skipped" | "failed";

/** One Step of a Run's Workflow in its current Iteration, as the Run detail lists it, in Workflow order. */
export interface StepState {
  /** The Step's id in the Workflow. */
  id: string;
  type: "agent" | "checks" | "gate" | "publish" | "artist";
  /** The Agent's name for an Agent Step, the Gate kind for a Gate; null for the others. */
  detail: string | null;
  /** The ids of the Steps that must be done or skipped before this one starts. */
  needs: string[];
  iteration: number;
  status: StepStatus;
  /** How many passes the Step has finished in this Iteration; automatic loop-backs count against its `max_attempts`. */
  attempts: number;
}

export interface RunDetail extends Run {
  /** The Run's Steps in Workflow order, as they stand in its current Iteration; empty for a Workflow that runs as code. */
  steps: StepState[];
  /** The Asset Requests of an `assets` Run and where each stands; empty for other Workflows. */
  assets: Asset[];
  iterations: Iteration[];
  attempts: StepAttempt[];
  checks: CheckResult[];
  gates: Gate[];
}

/** An Approved Run, with its Project's name, as the merge list shows it: its pull request awaits the human's merge. */
export interface ApprovedRun extends Run {
  projectName: string;
}

/** An open Gate with enough of its Run and Project to be listed on its own. */
export interface OpenGate extends Gate {
  runTitle: string;
  projectName: string;
}

/** What a subscriber hears about live: a Step's progress, or that a Run changed (state, Steps, Checks, Gates, pull request). */
export type RunUpdate =
  | { type: "progress"; runId: number; attemptId: number; kind: "text" | "tool" | "other"; summary: string }
  | { type: "changed"; runId: number };

export type AssetKind = "sprite" | "tile" | "animation";
/** Where an Asset is: not drawn yet, being drawn, drawn and waiting for the human's verdict, approved, or rejected (to be redone in the next Iteration). */
export type AssetStatus = "pending" | "generating" | "waiting" | "approved" | "rejected";

/** The human's description of one Asset to produce. */
export interface AssetRequest {
  name: string;
  kind: AssetKind;
  description: string;
  width: number;
  height: number;
  /** The Asset fills its whole square, fully opaque (a ground tile). Off by default; any transparent pixel then fails the Asset Checks. */
  fill?: boolean;
  /** For an Animation Strip: how many frames of the chosen size sit side by side in the image. 1 for other kinds. */
  frames?: number;
  /** Existing repository images (PNG paths) to match the style of, besides those the Art Direction names. */
  references?: string[];
  /** The Asset replaces the file already at its target path. Without it, an existing file is never overwritten. */
  replace?: boolean;
}

/** One version of an Asset that reached the human: the Artist's last passing attempt of an Iteration, and the Feedback it got. */
export interface AssetVersion {
  id: number;
  iteration: number;
  attempt: number;
  feedback: string | null;
}

/** One Artist attempt at an Asset and what the Asset Checks found in it, so the human sees why the Artist tried again. */
export interface AssetAttempt {
  iteration: number;
  attempt: number;
  /** False when the Artist left nothing at the target path. */
  written: boolean;
  /** Why the Asset Checks failed this attempt; empty when it passed or wrote nothing. */
  failures: string[];
  /** Colours outside the palette in this attempt. */
  warnings: string[];
}

/** The human's verdict on one Asset. */
export interface Verdict {
  assetId: number;
  action: "approve" | "reject";
  /** Required, and non-empty, to reject. */
  feedback?: string;
}

/** A recorded verdict, as the Gate it was given at shows it. */
export interface GateVerdict {
  assetId: number;
  verdict: "approve" | "reject";
  feedback: string | null;
}

export interface Asset extends AssetRequest {
  id: number;
  fill: boolean;
  frames: number;
  references: string[];
  replace: boolean;
  /** Order in which the Artist handles the Run's Assets, from 0. */
  position: number;
  /** Where the Artist writes the final Asset, relative to the Run's worktree. */
  targetPath: string;
  status: AssetStatus;
  /** What the Asset Checks warned about in its current version (colours outside the palette). Warnings never fail an Asset. */
  warnings: string[];
  /** The versions the human saw, oldest first; the last is the current one once the Asset has been drawn. */
  versions: AssetVersion[];
  /** Every Artist attempt at the Asset that ended with a result to check, oldest first, across Iterations. */
  attempts: AssetAttempt[];
}
