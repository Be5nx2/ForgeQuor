import type { StepOutcome, StepTypeModule } from "./engine.js";
import { describeFailure, passed, runChecks } from "./checks.js";
import { runAgentStep } from "./step.js";
import type { GateKindModule } from "./gates.js";
import type { GateKind } from "./types.js";
import { readReviewBrief, runNotesInBranch } from "./workspace.js";
import type { StepCatalogue, WorkflowInput } from "./workflow-definition.js";
import type { WorkflowContext } from "./workflow.js";

/** What an Agent attempt is told about itself. */
export interface AttemptInfo {
  /** This Step's attempt number in the Iteration, from 1. A restarted attempt keeps its number. */
  number: number;
  /** Why the Step is being redone: the Check that failed, or what was invalid in the input it produced. */
  sentBack: string | null;
}

/** One Agent a Workflow can name in an Agent Step: its instructions and prompt, and what it does around its Runner's Step. */
export interface AgentModule {
  /** The name a Workflow gives in `agent:`, and the Step's name in the Run's record. */
  name: string;
  /** Whose Runner and model it works through. */
  seat: keyof WorkflowContext["agents"];
  instructions: string;
  /** The inputs it produces for the Steps after it, which `when` can then test. */
  produces?: readonly WorkflowInput[];
  /** Runs before each attempt; false means the Step cannot start (it opened an Escalation, or the Run was abandoned). */
  before?(ctx: WorkflowContext, attempt: AttemptInfo): Promise<boolean>;
  prompt(ctx: WorkflowContext, attempt: AttemptInfo): Promise<string>;
  /** Runs after a successful attempt, such as committing what it left behind. */
  after?(ctx: WorkflowContext): Promise<void>;
  /**
   * Reads the inputs a successful attempt produced and validates them as launch input is validated. A reason sends the
   * Step back to the Agent (it counts as an attempt); otherwise the inputs it says it produced are the Run's from then on.
   */
  harvest?(ctx: WorkflowContext): Promise<{ invalid: string } | { produced: WorkflowInput[] }>;
}

/** What a Workflow definition can name of the Agents. */
export function catalogueOf(agents: Iterable<AgentModule>): StepCatalogue {
  return { agents: Object.fromEntries([...agents].map((a) => [a.name, { produces: a.produces ?? [] }])) };
}

const capitalised = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
const stop: StepOutcome = { next: "stop" };
const done: StepOutcome = { next: "done" };

/** The Agent Step type: one Agent attempt through the one Agent Step executor. */
export function agentStepType(agents: ReadonlyMap<string, AgentModule>): StepTypeModule {
  return {
    type: "agent",
    exhausted: (step, attempts) => `The ${capitalised(step.type === "agent" ? step.agent : step.id)} still gives invalid input after ${attempts} attempts.`,
    async execute({ ctx, step, state }) {
      if (step.type !== "agent") throw new Error(`Step "${step.id}" is not an Agent Step.`);
      const agent = agents.get(step.agent);
      if (!agent) throw new Error(`Step "${step.id}" names an unknown Agent "${step.agent}".`);
      const seat = ctx.agents[agent.seat];
      if (!seat) {
        await ctx.openGate("escalation", `The ${capitalised(agent.name)} has no Runner, so nothing was generated.`);
        return stop;
      }
      const attempt: AttemptInfo = { number: state.attempts + 1, sentBack: state.sentBack };
      if (agent.before && !(await agent.before(ctx, attempt))) return stop;
      const result = await runAgentStep(ctx, seat, {
        name: agent.name,
        stepId: step.id,
        attempt: attempt.number,
        instructions: agent.instructions,
        prompt: await agent.prompt(ctx, attempt),
      });
      if (!result) return stop;
      await agent.after?.(ctx);
      if (agent.harvest) {
        const harvest = await agent.harvest(ctx);
        if ("invalid" in harvest) return { next: "reject", reason: harvest.invalid, to: step.id };
        for (const input of harvest.produced) await ctx.records.giveInput(input);
      }
      return done;
    },
  };
}

/** The Checks Step type: the Project's Checks in order; the first that fails sends the Run back to the Step it names. */
export const checksStepType: StepTypeModule = {
  type: "checks",
  exhausted: (_step, attempts) => `A Check still fails after ${attempts} attempts.`,
  async execute({ ctx, state }) {
    const attempt = state.attempts + 1;
    // What an interrupted run of the Checks left is forgotten: they all run again.
    await ctx.records.clearChecks(attempt);
    const outcomes = await runChecks(ctx.project.checks, ctx.worktreePath, { timeoutMs: ctx.checkTimeoutMs, signal: ctx.stop });
    if (!(await ctx.stillRunning())) return stop;
    await ctx.records.recordChecks(attempt, outcomes);
    ctx.changed();
    const failed = outcomes.find((c) => !passed(c));
    return failed ? { next: "reject", reason: describeFailure(failed) } : done;
  },
};

/** The Publish Step type: pushes the branch, opens the pull request and posts the Review Brief. */
export const publishStepType: StepTypeModule = {
  type: "publish",
  async execute({ ctx }) {
    if (!(await ctx.stillRunning())) return stop;
    const notes = await runNotesInBranch(ctx.worktreePath, ctx.defaultBranch);
    if (notes.length) {
      await ctx.openGate("escalation", "A commit adds Run Notes, so the branch was not pushed.", notes.join("\n"));
      return stop;
    }
    const pr = await ctx.publishPullRequest(() => readReviewBrief(ctx.worktreePath) ?? "The Developer wrote no Review Brief for this pull request.");
    return pr ? done : stop;
  },
};

/**
 * The Gate Step type: opens a Gate of the Step's kind and waits for the human. A Gate approved in this Iteration is done;
 * one rejected starts the next Iteration, which the engine begins afresh (so a Gate has no cap and its `max_attempts` is ignored).
 */
export function gateStepType(kinds: ReadonlyMap<GateKind, GateKindModule>): StepTypeModule {
  return {
    type: "gate",
    async execute({ ctx, step }) {
      if (step.type !== "gate") throw new Error(`Step "${step.id}" is not a Gate.`);
      const decision = await ctx.records.gateDecision(step.id);
      if (decision === "approve") return done;
      // Still open: nothing to do but wait for the human.
      if (decision === null) return stop;
      await ctx.openGate(step.gate, kinds.get(step.gate)?.reason ?? "A decision is needed.");
      return stop;
    },
  };
}
