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

/** One thing wrong with a Workflow file, and where: a path such as `steps[1].needs[0]`, and the 1-based line and column. */
export interface WorkflowError {
  path: string;
  line?: number;
  column?: number;
  message: string;
}

/** How a Run's change is reviewed: by one Reviewer (solo), or by two whose Reviews a Consolidator merges (duo). */
export type ReviewMode = "solo" | "duo";

/** A Workflow a Run form can offer, from Forgequor or from the Project's own `forgequor/workflows/` folder. */
export interface WorkflowOption {
  name: string;
  description: string;
  /** What the human gives at launch: the Run form asks for each. Empty for an invalid Workflow. */
  inputs: ("task" | "assets" | "review")[];
  /** The review mode the Run form preselects, when the Workflow takes the `review` input. */
  reviewDefault?: ReviewMode | null;
  origin: "built-in" | "project";
  /** Why the Workflow cannot be launched; empty when it can. */
  errors: WorkflowError[];
  /** The Project file it comes from, or null for a built-in. */
  file: string | null;
}

/** The Workflows a Project can launch. `problem` says why the Project's own could not be read (then only built-ins are listed). */
export interface WorkflowList {
  workflows: WorkflowOption[];
  problem: string | null;
}

export type RunState = "queued" | "running" | "waiting" | "paused" | "approved" | "merged" | "closed" | "abandoned";
export type GateKind = "final" | "escalation" | "asset" | "review" | "conversation";
/** What a Gate records as decided. */
export type GateDecision = "approve" | "reject" | "abandon" | "retry" | "go_back" | "answer" | "confirm";
/** `judge` is the verdicts of an Asset Gate: its decision is recorded as approve when every Asset was approved, reject when any was not. */
/** `answer` replies to the questions at a Conversation Gate (the message is its Feedback); `confirm` accepts the summary the Agent proposed there. */
export type GateAction = "approve" | "reject" | "abandon" | "judge" | "retry" | "go_back" | "answer" | "confirm";

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
  /** How the Run is reviewed; null when its Workflow has no review. */
  review: ReviewMode | null;
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
  /** What the human can do here. A final Gate may be approved or rejected with Feedback; an Asset Gate judged; an Escalation abandoned (and retried or gone back from, see `redo`). */
  actions: GateAction[];
  /**
   * What an open Escalation also offers besides what `actions` lists: `retry` (the Step that failed runs again, or the Run
   * goes on from where it stands when no Step is named) and, when `goBack` lists a Step, `go_back` to it. Null for
   * every other Gate, and once decided.
   */
  redo: { goBack: GoBackChoice[] } | null;
  /** The human's written reason, when the Gate was rejected, or the Feedback given to a retry or a go back. */
  feedback: string | null;
  /** The verdict on each Asset, once an Asset Gate was judged. */
  verdicts: GateVerdict[];
  openedAt: Date;
  decidedAt: Date | null;
  /** What was decided: approve or reject (an Asset Gate judged by verdicts is approve when all were approved), or abandon. */
  decision: GateDecision | null;
}

/** A done Step an Escalation can go back to. */
export interface GoBackChoice {
  stepId: string;
  type: StepState["type"];
  /** The Agent's name for an Agent Step, the Gate kind for a Gate; null for the others. */
  detail: string | null;
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
  type: "agent" | "conversation" | "checks" | "gate" | "publish" | "artist" | "review";
  /** The Agent's name for an Agent Step, the Gate kind for a Gate; null for the others. */
  detail: string | null;
  /** The ids of the Steps that must be done or skipped before this one starts. */
  needs: string[];
  iteration: number;
  status: StepStatus;
  /** How many passes the Step has finished in this Iteration; automatic loop-backs count against its `max_attempts`. */
  attempts: number;
}

/** A Review's verdict: the change passes, or the Developer must rework it; only the Consolidator can find a disagreement it cannot settle. */
export type ReviewVerdict = "pass" | "changes requested" | "disagreement";

/** One Review written during a Run, as kept in its Run Notes. */
export interface Review {
  id: number;
  iteration: number;
  /** The `review` Step that asked for it. */
  stepId: string;
  /** The attempt of that Step. */
  attempt: number;
  /** Who wrote it: the seat of the Reviewer ("reviewer-a"). */
  author: string;
  verdict: ReviewVerdict;
  /** The Review's text, without its verdict line. */
  body: string;
  /** The Review the Run acts on, as opposed to one that only went into it. */
  final: boolean;
  createdAt: Date;
}

/** One message of a Conversation Gate's chat: the Agent's questions or proposed summary, or the human's reply. */
export interface ConversationTurn {
  id: number;
  /** The conversation Step it belongs to. */
  stepId: string;
  author: "agent" | "human";
  /** What the Agent said (a round of questions, or a proposed summary), or what the human did (answered, confirmed, or reopened it with Feedback). */
  kind: "questions" | "summary" | "answer" | "confirm" | "feedback";
  body: string;
  createdAt: Date;
}

export interface RunDetail extends Run {
  /** The Run's Steps in Workflow order, as they stand in its current Iteration. */
  steps: StepState[];
  /** The Asset Requests of an `assets` Run and where each stands; empty for other Workflows. */
  assets: Asset[];
  iterations: Iteration[];
  /** Every Review of the Run, oldest first. */
  reviews: Review[];
  /** What was said at the Run's Conversation Gates, oldest first. */
  conversation: ConversationTurn[];
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
