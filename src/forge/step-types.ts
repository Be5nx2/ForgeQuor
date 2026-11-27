import type { StepOutcome, StepTypeModule } from "./engine.js";
import { headOf, sweepForbiddenChanges, type MayChange } from "./deliverables.js";
import { describeFailure, passed, runChecks } from "./checks.js";
import { reviewSection } from "./review.js";
import { requireSeat, type SeatName } from "./seats.js";
import { runAgentStep } from "./step.js";
import type { GateKindModule } from "./gates.js";
import type { GateKind } from "./types.js";
import { readReviewBrief, runNotesInBranch } from "./workspace.js";
import type { StepCatalogue, WorkflowInput } from "./workflow-definition.js";
import type { Publication, WorkflowContext } from "./workflow.js";

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
  /** How Escalations name it when its name does not read well capitalised ("Spec Writer"); by default the name capitalised. */
  label?: string;
  /** Whose Runner and model it works through. */
  seat: SeatName;
  instructions: string;
  /** The inputs it produces for the Steps after it, which `when` can then test. */
  produces?: readonly WorkflowInput[];
  /** Runs before each attempt; false means the Step cannot start (it opened an Escalation, or the Run was abandoned). */
  before?(ctx: WorkflowContext, attempt: AttemptInfo): Promise<boolean>;
  prompt(ctx: WorkflowContext, attempt: AttemptInfo): Promise<string>;
  /**
   * The Project files it may change, when it may change only some. Anything else it changes (or commits) is put back as it
   * was, silently when the attempt failed, and with an Escalation naming the files when it succeeded.
   */
  mayChange?(ctx: WorkflowContext): MayChange;
  /** Runs after a successful attempt, such as committing what it left behind. */
  after?(ctx: WorkflowContext): Promise<void>;
  /**
   * Reads the inputs a successful attempt produced and validates them as launch input is validated. A reason sends the
   * Step back to the Agent (it counts as an attempt); otherwise the inputs it says it produced are the Run's from then on.
   */
  harvest?(ctx: WorkflowContext): Promise<{ invalid: string } | { produced: WorkflowInput[] }>;
}

/** What a Workflow definition can name of the Agents. */
export function catalogueOf(agents: Iterable<AgentModule>, conversations: Iterable<string> = []): StepCatalogue {
  return { agents: Object.fromEntries([...agents].map((a) => [a.name, { produces: a.produces ?? [] }])), conversations: [...conversations] };
}

const capitalised = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
const stop: StepOutcome = { next: "stop" };
const done: StepOutcome = { next: "done" };

/** The Agent Step type: one Agent attempt through the one Agent Step executor. */
export function agentStepType(agents: ReadonlyMap<string, AgentModule>): StepTypeModule {
  return {
    type: "agent",
    exhausted: (step, attempts) => `The ${step.type === "agent" ? (agents.get(step.agent)?.label ?? capitalised(step.agent)) : capitalised(step.id)} still gives invalid input after ${attempts} ${attempts === 1 ? "attempt" : "attempts"}.`,
    async execute({ ctx, step, state }) {
      if (step.type !== "agent") throw new Error(`Step "${step.id}" is not an Agent Step.`);
      const agent = agents.get(step.agent);
      if (!agent) throw new Error(`Step "${step.id}" names an unknown Agent "${step.agent}".`);
      const seat = await requireSeat(ctx, agent.seat, (agent.label ?? capitalised(agent.name)));
      if (!seat) return stop;
      const attempt: AttemptInfo = { number: state.attempts + 1, sentBack: state.sentBack };
      if (agent.before && !(await agent.before(ctx, attempt))) return stop;
      const mayChange = agent.mayChange?.(ctx);
      // Whatever an earlier attempt (or a crash) left outside what the Agent may change goes first, so it cannot escape later.
      if (mayChange) await sweepForbiddenChanges(ctx.worktreePath, mayChange);
      const head = mayChange ? await headOf(ctx.worktreePath) : undefined;
      let result;
      try {
        result = await runAgentStep(ctx, seat, {
          name: agent.name,
          stepId: step.id,
          attempt: attempt.number,
          instructions: agent.instructions,
          title: agent.label ? `The ${agent.label}` : undefined,
          prompt: await agent.prompt(ctx, attempt),
        });
      } catch (e) {
        if (mayChange) await sweepForbiddenChanges(ctx.worktreePath, mayChange, head).catch(() => {});
        throw e;
      }
      if (mayChange) {
        // An attempt that did not succeed (failed, timed out, paused, abandoned) is swept silently: it is not used anyway.
        const forbidden = await sweepForbiddenChanges(ctx.worktreePath, mayChange, head).catch((e) => {
          if (result) throw e;
          return [] as string[];
        });
        if (result && forbidden.length) {
          await ctx.openGate("escalation", `The ${(agent.label ?? capitalised(agent.name))} changed files it may not change, so they were put back as they were.`, forbidden.join("\n"));
          return stop;
        }
      }
      if (!result) return stop;
      await agent.after?.(ctx);
      if (agent.harvest) {
        const harvest = await agent.harvest(ctx);
        if ("invalid" in harvest) return { next: "reject", reason: harvest.invalid, to: step.id };
        for (const input of harvest.produced) await ctx.records.giveInput(input, step.id);
      }
      return done;
    },
  };
}

/** The Checks Step type: the Project's Checks in order; the first that fails sends the Run back to the Step it names. */
export const checksStepType: StepTypeModule = {
  type: "checks",
  exhausted: (_step, attempts) => `A Check still fails after ${attempts} ${attempts === 1 ? "attempt" : "attempts"}.`,
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
export function publishStepType(publicationOf: (run: WorkflowContext["run"]) => Promise<Publication | undefined>): StepTypeModule {
  return {
  type: "publish",
  async execute({ ctx }) {
    if (!(await ctx.stillRunning())) return stop;
    const publication = await publicationOf(ctx.run);
    await publication?.prepare?.(ctx);
    const notes = await runNotesInBranch(ctx.worktreePath, ctx.defaultBranch);
    if (notes.length) {
      await ctx.openGate("escalation", "A commit adds Run Notes, so the branch was not pushed.", notes.join("\n"));
      return stop;
    }
    const written = publication ? await publication.brief(ctx) : (readReviewBrief(ctx.worktreePath) ?? "The Developer wrote no Review Brief for this pull request.");
    // A Run that was reviewed says what the Review found, after what the Developer wrote.
    const section = reviewSection(await ctx.records.finalReview());
    const brief = section ? `${written.trimEnd()}\n\n${section}` : written;
    const pr = await ctx.publishPullRequest(() => brief);
    return pr ? done : stop;
  },
  };
}

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
      const module = kinds.get(step.gate);
      const reason = module?.reason;
      await ctx.openGate(step.gate, (typeof reason === "function" ? await reason(ctx) : reason) ?? "A decision is needed.", await module?.evidence?.(ctx));
      return stop;
    },
  };
}
