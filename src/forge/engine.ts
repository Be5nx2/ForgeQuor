import { replaySet, type StepRow } from "./step-states.js";
import type { StepDefinition, StepType, WorkflowDefinition } from "./workflow-definition.js";
import type { WorkflowContext } from "./workflow.js";

/** What a Step type is handed to run one Step. */
export interface StepRun {
  /** The Run's context, whose `openGate` opens Gates for this Step. */
  ctx: WorkflowContext;
  step: StepDefinition;
  /** Where the Step stands: `attempts + 1` is this pass's attempt number, `sentBack` is why it is being redone. */
  state: StepRow;
}

/** What came of running a Step. */
export type StepOutcome =
  /** The Step finished. */
  | { next: "done" }
  /**
   * The Step rejects its work: the Run goes back to `to` (default: the Step's `on_reject`) and replays what follows, with
   * `reason` handed to it. Counts as an attempt of this Step; past its `max_attempts` an Escalation opens instead.
   */
  | { next: "reject"; reason: string; to?: string }
  /** The Run cannot go on now: it waits at a Gate (an Escalation included), is Paused, or was abandoned. */
  | { next: "stop" };

/** One coded Step type: what the engine runs for the Steps of that type. */
export interface StepTypeModule {
  type: StepType;
  execute(run: StepRun): Promise<StepOutcome>;
  /** The Escalation's reason when a Step of this type has rejected as many times as its `max_attempts` allow. */
  exhausted?(step: StepDefinition, attempts: number): string;
}

export type StepTypes = ReadonlyMap<StepType, StepTypeModule>;

/**
 * The Workflow engine: works a Run from its frozen definition until it waits at a Gate, is Paused or abandoned, or is
 * done. A Step starts when everything it needs is done or skipped. `when` is evaluated then, on the inputs the Run has
 * by that time. A Step that rejects sends the Run back to its `on_reject` Step, which replays with what follows it. What
 * the engine has done is recorded Step by Step, so a restarted Run starts again only the Steps that were running.
 */
export async function runEngine(ctx: WorkflowContext, definition: WorkflowDefinition, types: StepTypes): Promise<void> {
  const { steps } = ctx.records;
  await steps.begin(definition, ctx.project.checks.length);
  for (;;) {
    if (!(await ctx.stillRunning())) return;
    const states = await steps.load();
    const status = (step: StepDefinition) => states.get(step.id)?.status ?? "waiting";
    const finished = (id: string) => ["done", "skipped"].includes(states.get(id)?.status ?? "waiting");
    const ready = definition.steps.filter((s) => status(s) === "waiting" && s.needs.every(finished));
    if (!ready.length) {
      if (definition.steps.every((s) => finished(s.id))) return ctx.approve();
      const stuck = definition.steps.filter((s) => !finished(s.id)).map((s) => `${s.id}: ${status(s)}`);
      return ctx.openGate("escalation", "The Run cannot go on: no Step is ready to start.", stuck.join("\n"));
    }

    // One Step at a time for now: starting the ready read-only Steps together is a matter of taking more of `ready` here.
    const batch = ready.slice(0, 1);
    const results = await Promise.all(batch.map((step) => runStep(ctx, definition, types, step, states.get(step.id)!)));
    if (results.includes("stop")) return;
  }
}

/** Runs one ready Step and records how it went. */
async function runStep(ctx: WorkflowContext, definition: WorkflowDefinition, types: StepTypes, step: StepDefinition, state: StepRow): Promise<"go on" | "stop"> {
  const { steps } = ctx.records;
  if (step.when && !(await ctx.records.inputs()).includes(step.when)) {
    await steps.set(step.id, { status: "skipped" });
    ctx.changed();
    return "go on";
  }
  const module = types.get(step.type);
  if (!module) throw new Error(`Step "${step.id}" has a type, ${step.type}, that Forgequor has no code for.`);

  await steps.set(step.id, { status: "running" });
  ctx.changed();
  let escalated = false;
  const forStep: WorkflowContext = {
    ...ctx,
    openGate: async (kind, reason, evidence) => {
      if (kind === "escalation") escalated = true;
      await ctx.openGate(kind, reason, evidence, step.id);
    },
  };
  let outcome: StepOutcome;
  try {
    outcome = await module.execute({ ctx: forStep, step, state });
  } catch (e: any) {
    // A Step that throws fails, and its Escalation names it, so the Run detail shows which Step broke.
    await steps.set(step.id, { status: "failed" });
    await ctx.openGate("escalation", "The Run could not continue.", String(e?.message ?? e), step.id);
    return "stop";
  }

  if (outcome.next === "done") {
    await steps.set(step.id, { status: "done", attempts: state.attempts + 1, sentBack: null });
    ctx.changed();
    return "go on";
  }
  if (outcome.next === "stop") {
    // A Step that opened an Escalation failed; one waiting at a Gate, paused or cut short by an abandon is still running.
    if (escalated) await steps.set(step.id, { status: "failed" });
    ctx.changed();
    return "stop";
  }

  const attempts = state.attempts + 1;
  const to = outcome.to ?? step.onReject;
  if (!to || attempts >= step.maxAttempts) {
    await steps.set(step.id, { status: "failed", attempts });
    const reason = to ? (module.exhausted?.(step, attempts) ?? `Step "${step.id}" still rejects after ${attempts} attempts.`) : `Step "${step.id}" rejected, but it names no Step to go back to.`;
    await ctx.openGate("escalation", reason, outcome.reason, step.id);
    return "stop";
  }
  await steps.set(step.id, { attempts });
  await steps.sendBack([...new Set([step.id, ...replaySet(definition, to)])], to, outcome.reason);
  ctx.changed();
  return "go on";
}
