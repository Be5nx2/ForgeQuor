import type pg from "pg";
import { InvalidInputError } from "./errors.js";
import type { Gate, GateAction, GateKind, Verdict } from "./types.js";

/** What the human gave at a Gate; each kind reads the part that concerns it. */
export interface GateDecisionInput {
  action: GateAction;
  feedback?: string;
  verdicts?: Verdict[];
}

/** Where the Run goes once a Gate is decided. */
export type GateOutcome =
  /** The Run is abandoned (its pull request closed, its branch kept). */
  | { next: "abandon" }
  /** The Run is Approved: its pull request waits for the human's merge. */
  | { next: "approve" }
  /**
   * The Run goes on working in the same worktree. `nextIteration` starts the next Iteration (a rejection), otherwise it
   * carries on from where it was. `record` writes what else the decision stores, in the decision's transaction.
   */
  | { next: "continue"; decision: "approve" | "reject"; feedback?: string; nextIteration: boolean; record?: (client: pg.PoolClient) => Promise<void> };

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
  /**
   * Validates a decision the Gate offers (the core already refused the others) and says where the Run goes. Throws an
   * InvalidInputError for a decision that does not fit, such as a rejection without Feedback.
   */
  decide(gate: Gate, input: GateDecisionInput): Promise<GateOutcome>;
}

/** Why a Gate does not offer `action`. */
export function refusal(gate: GateKindModule, action: GateAction): string {
  const past: Record<GateAction, string> = { approve: "approved", reject: "rejected", abandon: "abandoned", judge: "judged" };
  return `${gate.label} cannot be ${past[action]}; it can only be ${gate.actions.map((a) => past[a]).join(" or ")}.`;
}

/** The Developer finished: the human approves the pull request, sends it back with Feedback, or abandons the Run. */
export const finalGate: GateKindModule = {
  kind: "final",
  label: "A final Gate",
  actions: ["approve", "reject", "abandon"],
  async decide(_gate, { action, feedback }) {
    if (action === "abandon") return { next: "abandon" };
    if (action === "approve") return { next: "approve" };
    const reason = feedback?.trim();
    if (!reason) throw new InvalidInputError("Rejecting a Gate needs a Feedback saying what to change.");
    return { next: "continue", decision: "reject", feedback: reason, nextIteration: true };
  },
};

/** Something went wrong and needs a human: the only choice is to abandon the Run. */
export const escalationGate: GateKindModule = {
  kind: "escalation",
  label: "An Escalation",
  actions: ["abandon"],
  async decide() {
    return { next: "abandon" };
  },
};
