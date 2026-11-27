import type pg from "pg";
import { InvalidInputError } from "./errors.js";
import type { WorkflowContext } from "./workflow.js";
import type { Gate, GateAction, GateKind, Verdict } from "./types.js";

/** What the human gave at a Gate; each kind reads the part that concerns it. */
export interface GateDecisionInput {
  action: GateAction;
  feedback?: string;
  verdicts?: Verdict[];
  /** What the human wrote at a Conversation Gate. */
  message?: string;
  /** The Step an Escalation is asked to go back to. */
  target?: string;
}

/** Where the Run goes once a Gate is decided. */
export type GateOutcome =
  /** The Run is abandoned (its pull request closed, its branch kept). */
  | { next: "abandon" }
  /** The Run is Approved: its pull request waits for the human's merge. */
  | { next: "approve" }
  /**
   * The Run goes on in the same Iteration, its worktree as it is: the failed Step runs again (`goBackTo` absent) or the
   * Run goes back to that earlier done Step and replays it and what follows. Either way with a fresh attempt budget.
   * The core checks the Step against what the Run's Steps allow.
   */
  | { next: "redo"; decision: "retry" | "go_back"; goBackTo?: string; feedback?: string }
  /**
   * The Run goes on working in the same worktree. `nextIteration` starts the next Iteration (a rejection), otherwise it
   * carries on from where it was. `record` writes what else the decision stores, in the decision's transaction.
   */
  | { next: "continue"; decision: "approve" | "reject" | "answer" | "confirm"; feedback?: string; nextIteration: boolean; record?: (client: pg.PoolClient) => Promise<void> };

/**
 * One kind of Gate, as a module of its own: it knows the choices it offers, validates a decision and says where the
 * Run goes next. The Forge core keeps the mechanism (the transaction, the Run's state, the slot) and delegates the rest.
 */
export interface GateKindModule {
  kind: GateKind;
  /** How a refusal names it: "A final Gate". */
  label: string;
  /** What the human can do at it. */
  actions: GateAction[];
  /** The actions a particular Gate offers, when that depends on the Gate (a Conversation Gate offers `confirm` only for a summary); `actions` otherwise. */
  offers?(gate: Gate): GateAction[];
  /** Whether the human can also retry the Step that failed or go back to an earlier one (an Escalation). */
  redo?: boolean;
  /** Why a Gate Step of this kind opens it, as the human reads it. */
  reason?: string | ((ctx: WorkflowContext) => Promise<string>);
  /**
   * Validates a decision the Gate offers (the core already refused the others) and says where the Run goes. Throws an
   * InvalidInputError for a decision that does not fit, such as a rejection without Feedback.
   */
  decide(gate: Gate, input: GateDecisionInput): Promise<GateOutcome>;
}

/** Why a Gate does not offer `action`. */
export function refusal(gate: GateKindModule, action: GateAction, at?: Gate): string {
  const past: Record<GateAction, string> = { approve: "approved", reject: "rejected", abandon: "abandoned", judge: "judged", retry: "retried", go_back: "gone back from", answer: "answered", confirm: "confirmed" };
  return `${gate.label} cannot be ${past[action]}; it can only be ${(at ? offered(gate, at) : gate.actions).map((a) => past[a]).join(" or ")}.`;
}

/** The Developer finished: the human approves the pull request, sends it back with Feedback, or abandons the Run. */
export const finalGate: GateKindModule = {
  kind: "final",
  label: "A final Gate",
  actions: ["approve", "reject", "abandon"],
  reason: "The Developer finished.",
  async decide(_gate, { action, feedback }) {
    if (action === "abandon") return { next: "abandon" };
    if (action === "approve") return { next: "approve" };
    const reason = feedback?.trim();
    if (!reason) throw new InvalidInputError("Rejecting a Gate needs a Feedback saying what to change.");
    return { next: "continue", decision: "reject", feedback: reason, nextIteration: true };
  },
};

/** What a particular Gate of this kind offers. */
export function offered(kind: GateKindModule, gate: Gate): GateAction[] {
  return kind.offers?.(gate) ?? kind.actions;
}

/** Whether the human can decide a Gate of this kind with `action`: what it lists, and for an Escalation retrying and going back. */
export function allows(gate: GateKindModule, action: GateAction, at?: Gate): boolean {
  return (at ? offered(gate, at) : gate.actions).includes(action) || (!!gate.redo && (action === "retry" || action === "go_back"));
}

/**
 * Something went wrong and needs a human: retry the Step that failed (the Feedback is optional), go back to an earlier
 * done Step (the Feedback is required), or abandon the Run. `actions` lists what every Escalation offers; retrying and
 * going back depend on the Steps the Run has, so the Gate carries them as `redo`.
 */
export const escalationGate: GateKindModule = {
  kind: "escalation",
  label: "An Escalation",
  actions: ["abandon"],
  redo: true,
  async decide(_gate, { action, feedback, target }) {
    if (action === "retry") return { next: "redo", decision: "retry", feedback: feedback?.trim() || undefined };
    if (action === "go_back") {
      const reason = feedback?.trim();
      if (!target) throw new InvalidInputError("Going back needs the Step to go back to.");
      if (!reason) throw new InvalidInputError("Going back needs a Feedback saying what to change.");
      return { next: "redo", decision: "go_back", goBackTo: target, feedback: reason };
    }
    return { next: "abandon" };
  },
};
