// The one status vocabulary of the UI: every Run state, Step state, Gate decision, Review verdict, Check result and
// Asset state the server can send maps to one of the spec's statuses (colour + glyph + label, never colour alone), as in
// the mockups' `.chip`. Green and red are for results only: something finished well, or failed.
import type { AssetStatus, GateDecision, ReviewVerdict, RunState, StepAttempt, StepStatus } from "../../src/forge/types.js";

/** `kind` picks the colour (`data-s` of `.chip`), `glyph` the shape (`data-g`), `label` the words. */
export interface Status {
  kind: "running" | "waiting" | "ok" | "bad" | "idle";
  glyph: "●" | "✓" | "✕" | "○" | "‖" | "–";
  label: string;
}

const running = (label = "Running"): Status => ({ kind: "running", glyph: "●", label });
const waiting = (label = "Waiting for you"): Status => ({ kind: "waiting", glyph: "●", label });
const ok = (label: string): Status => ({ kind: "ok", glyph: "✓", label });
const bad = (label: string): Status => ({ kind: "bad", glyph: "✕", label });
const idle = (label: string): Status => ({ kind: "idle", glyph: "○", label });
const paused = (label = "Paused"): Status => ({ kind: "idle", glyph: "‖", label });
const dropped = (label: string): Status => ({ kind: "idle", glyph: "–", label });

const RUN: Record<RunState, Status> = {
  queued: idle("Queued"),
  running: running(),
  waiting: waiting(),
  paused: paused(),
  approved: ok("Approved"),
  merged: ok("Merged"),
  closed: dropped("Closed"),
  abandoned: dropped("Abandoned"),
};

// A Step that "waits" has not started (its needs are not done): it is not waiting for the human.
const STEP: Record<StepStatus, Status> = {
  waiting: idle("Not started"),
  running: running(),
  done: ok("Done"),
  skipped: dropped("Skipped"),
  failed: bad("Failed"),
};

const ATTEMPT: Record<StepAttempt["status"], Status> = {
  running: running(),
  succeeded: ok("Succeeded"),
  failed: bad("Failed"),
  quota_exhausted: paused("Quota used up"),
};

const ASSET: Record<AssetStatus, Status> = {
  pending: idle("Pending"),
  generating: running("Drawing"),
  waiting: waiting(),
  approved: ok("Approved"),
  rejected: bad("Rejected"),
};

const VERDICT: Record<ReviewVerdict, Status> = {
  pass: ok("Pass"),
  "changes requested": bad("Changes requested"),
  disagreement: waiting("Disagreement"),
};

const DECISION: Record<GateDecision, Status> = {
  approve: ok("Approved"),
  reject: bad("Rejected"),
  abandon: dropped("Abandoned"),
  retry: idle("Retried"),
  go_back: idle("Went back"),
  answer: ok("Answered"),
  confirm: ok("Confirmed"),
};

export const runStatus = (state: RunState): Status => RUN[state]!;
export const stepStatus = (status: StepStatus): Status => STEP[status]!;
export const attemptStatus = (status: StepAttempt["status"]): Status => ATTEMPT[status]!;
export const assetStatus = (status: AssetStatus): Status => ASSET[status]!;
export const verdictStatus = (verdict: ReviewVerdict): Status => VERDICT[verdict]!;
/** An open Gate waits for the human; a decided one shows what was decided. */
export const gateStatus = (decision: GateDecision | null): Status => (decision ? DECISION[decision]! : waiting());
/** A Check passes on exit status 0; null means it was killed (timeout or stopped Run). */
export const checkStatus = (exitStatus: number | null): Status =>
  exitStatus === 0 ? ok("Passed") : bad(exitStatus === null ? "Killed" : `Exit ${exitStatus}`);
