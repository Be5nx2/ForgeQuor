import { replaySet, type StepRow } from "./step-states.js";
import type { GateKind } from "./types.js";
import { changesBetween, snapshotWorktree, type WorktreeSnapshot } from "./workspace.js";
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
 *
 * Read-only Steps that are ready together run together (the definition only lets read-only Steps run side by side).
 * Such a batch is settled as a whole: its Steps do not open Gates or pause while it runs, the outcomes are collected,
 * and once all have finished they are applied in definition order. The first Step that needs the human opens the one
 * Gate (or Pause) of the batch; the others' outcomes are recorded all the same. A rejection never resets a Step that is
 * still running, since nothing is reset until the batch is over. After a read-only Step, whatever changed in the
 * worktree outside the Run Notes fails it and opens an Escalation naming the files.
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

    // Read-only Steps start together; anything else starts alone.
    const batch = ready[0]!.readonly ? ready.filter((s) => s.readonly) : ready.slice(0, 1);
    const before = batch.some((s) => s.readonly) ? await snapshotWorktree(ctx.worktreePath) : null;
    const settled = await Promise.all(batch.map((step) => runStep(ctx, types, step, states.get(step.id)!, batch.length > 1)));
    if (before) await checkReadOnly(ctx, before, settled);
    if (await applyBatch(ctx, definition, types, settled)) return;
  }
}

/** What a Step asked of the Run while a batch ran: done, if it is the one chosen, once the batch has settled. */
type Request = { gate: { kind: GateKind; reason: string; evidence?: string } } | { pause: Date | null };

/** How one Step of a batch went, before anything of it is applied to the Run. */
interface Settled {
  step: StepDefinition;
  state: StepRow;
  result:
    | { is: "skipped" }
    | { is: "threw"; message: string }
    | { is: "outcome"; outcome: StepOutcome; escalated: boolean; request: Request | null }
    /** A read-only Step that finished while `files` outside the Run Notes had changed. */
    | { is: "changed"; files: string[] };
}

/** Starts one ready Step and runs it to its outcome. Records that it started and nothing else of how it went. */
async function runStep(ctx: WorkflowContext, types: StepTypes, step: StepDefinition, state: StepRow, inBatch: boolean): Promise<Settled> {
  const { steps } = ctx.records;
  if (step.when && !(await ctx.records.inputs()).includes(step.when)) {
    await steps.set(step.id, { status: "skipped" });
    ctx.changed();
    return { step, state, result: { is: "skipped" } };
  }
  const module = types.get(step.type);
  if (!module) throw new Error(`Step "${step.id}" has a type, ${step.type}, that Forgequor has no code for.`);

  await steps.set(step.id, { status: "running" });
  ctx.changed();
  let escalated = false;
  let request: Request | null = null;
  const forStep: WorkflowContext = {
    ...ctx,
    openGate: async (kind, reason, evidence) => {
      if (kind === "escalation") escalated = true;
      // In a batch only one Step may stop the Run, so the request waits for the batch to settle.
      if (inBatch) request ??= { gate: { kind, reason, evidence } };
      else await ctx.openGate(kind, reason, evidence, step.id);
    },
    pause: async (resetsAt) => {
      if (inBatch) request ??= { pause: resetsAt };
      else await ctx.pause(resetsAt);
    },
  };
  try {
    const outcome = await module.execute({ ctx: forStep, step, state });
    return { step, state, result: { is: "outcome", outcome, escalated, request } };
  } catch (e: any) {
    return { step, state, result: { is: "threw", message: String(e?.message ?? e) } };
  }
}

/** After a batch with read-only Steps, holds the ones that finished to account if anything outside the Run Notes changed meanwhile. */
async function checkReadOnly(ctx: WorkflowContext, before: WorktreeSnapshot, settled: Settled[]): Promise<void> {
  const finished = settled.filter((s) => s.step.readonly && s.result.is === "outcome" && s.result.outcome.next !== "stop");
  if (!finished.length) return;
  const files = await changesBetween(ctx.worktreePath, before, await snapshotWorktree(ctx.worktreePath));
  if (!files.length) return;
  // Steps that ran side by side cannot be told apart: every read-only Step that finished in the batch is held to account.
  for (const s of finished) s.result = { is: "changed", files };
}

/** Applies what a batch settled to the Run, in definition order. Returns true when the Run cannot go on. */
async function applyBatch(ctx: WorkflowContext, definition: WorkflowDefinition, types: StepTypes, settled: Settled[]): Promise<boolean> {
  const { steps } = ctx.records;
  let stopped = false;
  /** Opens the batch's one Gate (or Pause) for the first Step that asks, and only that one. */
  const stopRun = async (open: () => Promise<void>) => {
    if (!stopped) await open();
    stopped = true;
  };

  // What finished is recorded first, so that a rejection that follows can still send a finished sibling back.
  for (const { step, state, result } of settled) {
    if (result.is === "outcome" && result.outcome.next === "done") {
      await steps.set(step.id, { status: "done", attempts: state.attempts + 1, sentBack: null });
    }
  }

  for (const { step, state, result } of settled) {
    if (result.is === "skipped") continue;
    if (result.is === "threw") {
      // A Step that throws fails, and its Escalation names it, so the Run detail shows which Step broke.
      await steps.set(step.id, { status: "failed" });
      await stopRun(() => ctx.openGate("escalation", "The Run could not continue.", result.message, step.id));
      continue;
    }
    if (result.is === "changed") {
      await steps.set(step.id, { status: "failed" });
      await stopRun(() => ctx.openGate("escalation", `The read-only Step "${step.id}" changed files outside the Run Notes.`, result.files.join("\n"), step.id));
      continue;
    }
    const { outcome, escalated, request } = result;
    if (outcome.next === "done") continue;
    if (outcome.next === "stop") {
      // A Step that opened an Escalation failed; one waiting at a Gate, paused or cut short by an abandon is still running.
      if (escalated) await steps.set(step.id, { status: "failed" });
      await stopRun(async () => {
        if (request && "gate" in request) await ctx.openGate(request.gate.kind, request.gate.reason, request.gate.evidence, step.id);
        else if (request) await ctx.pause(request.pause);
      });
      continue;
    }

    const attempts = state.attempts + 1;
    const to = outcome.to ?? step.onReject;
    const tried = attempts - state.budgetFrom;
    if (!to || tried >= step.maxAttempts) {
      await steps.set(step.id, { status: "failed", attempts });
      const reason = to ? (types.get(step.type)?.exhausted?.(step, tried) ?? `Step "${step.id}" still rejects after ${tried} attempts.`) : `Step "${step.id}" rejected, but it names no Step to go back to.`;
      await stopRun(() => ctx.openGate("escalation", reason, outcome.reason, step.id));
      continue;
    }
    await steps.set(step.id, { attempts });
    await steps.sendBack([...new Set([step.id, ...replaySet(definition, to)])], to, outcome.reason);
  }
  ctx.changed();
  return stopped;
}
