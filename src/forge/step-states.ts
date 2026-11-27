import type pg from "pg";
import { describeFailure } from "./checks.js";
import type { StepStatus } from "./types.js";
import type { WorkflowDefinition } from "./workflow-definition.js";

/** Where one Step of a Run stands in an Iteration. */
export interface StepRow {
  stepId: string;
  status: StepStatus;
  /** Passes the Step has finished in this Iteration; the next pass is attempt `attempts + 1`. */
  attempts: number;
  /** Why the Step was sent back to (the Check that failed, an invalid input), until it finishes again. */
  sentBack: string | null;
}

/** The persisted state of a Run's Steps in its current Iteration: the only place the engine keeps what it has done. */
export interface StepStates {
  /**
   * Makes sure the Iteration's Steps are recorded, and puts the Steps that were running back to waiting: after a restart
   * or a Pause, only they start again. A new Iteration keeps what the rejection did not send back; a Run recorded before
   * Steps were (a Run from before M3a) is rebuilt from its Step attempts and Check results.
   */
  begin(definition: WorkflowDefinition, checkCount: number): Promise<void>;
  load(): Promise<Map<string, StepRow>>;
  set(stepId: string, patch: { status?: StepStatus; attempts?: number; sentBack?: string | null }): Promise<void>;
  /** Sends Steps back to waiting, dropping the inputs they produced and the Gates they opened so far; `reason` is handed to `target`, the Step that does the work again. */
  sendBack(stepIds: string[], target: string, reason: string): Promise<void>;
}

/**
 * The Steps a rejection sends back: the Step it loops back to and every Step after it, meaning every Step that needs it,
 * directly or indirectly.
 */
export function replaySet(definition: WorkflowDefinition, target: string): string[] {
  const replay = new Set([target]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const step of definition.steps) {
      if (!replay.has(step.id) && step.needs.some((n) => replay.has(n))) {
        replay.add(step.id);
        grew = true;
      }
    }
  }
  return definition.steps.filter((s) => replay.has(s.id)).map((s) => s.id);
}

const fresh = (stepId: string): StepRow => ({ stepId, status: "waiting", attempts: 0, sentBack: null });

export function createStepStates(pool: pg.Pool, runId: number, iteration: number): StepStates {
  const toRow = (r: Record<string, any>): StepRow => ({ stepId: r.step, status: r.status, attempts: r.attempts, sentBack: r.sent_back });

  async function insert(rows: (StepRow & { produced?: string[] })[], at: number) {
    for (const r of rows) {
      await pool.query(
        "INSERT INTO step_states (run_id, iteration, step, status, attempts, sent_back, produced) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING",
        [runId, at, r.stepId, r.status, r.attempts, r.sentBack, JSON.stringify(r.produced ?? [])],
      );
    }
  }

  /** Takes the inputs produced by the Steps being replayed out of the Run's inputs, unless a Step that is not replayed produced them too. */
  async function dropProduced(before: number, replayed: string[]) {
    const { rows } = await pool.query("SELECT step, produced FROM step_states WHERE run_id = $1 AND iteration = $2", [runId, before]);
    const kept = new Set(rows.filter((r) => !replayed.includes(r.step)).flatMap((r) => r.produced as string[]));
    const gone = new Set(rows.filter((r) => replayed.includes(r.step)).flatMap((r) => r.produced as string[]));
    for (const input of gone) if (!kept.has(input)) await pool.query("UPDATE runs SET inputs = inputs - $2::text WHERE id = $1", [runId, input]);
  }

  /** The Steps of the Iteration after a rejection: what the rejected Gate sent back starts over, the rest stays as it was. */
  async function afterRejection(definition: WorkflowDefinition, previous: number): Promise<StepRow[]> {
    const { rows: before } = await pool.query("SELECT * FROM step_states WHERE run_id = $1 AND iteration = $2", [runId, previous]);
    const kept = new Map(before.map((r) => [r.step as string, { ...toRow(r), produced: r.produced as string[] }]));
    const { rows: gates } = await pool.query(
      "SELECT step FROM gates WHERE run_id = $1 AND iteration = $2 AND decision = 'reject' AND step IS NOT NULL ORDER BY id DESC LIMIT 1",
      [runId, previous],
    );
    const gateStep = gates[0]?.step as string | undefined;
    const target = definition.steps.find((s) => s.id === gateStep)?.onReject;
    const replay = new Set(target ? replaySet(definition, target) : definition.steps.map((s) => s.id));
    await dropProduced(previous, [...replay]);
    // The rejected Gate has done its part in the Iteration it ended.
    if (gateStep) await pool.query("UPDATE step_states SET status = 'done', attempts = attempts + 1 WHERE run_id = $1 AND iteration = $2 AND step = $3 AND status = 'running'", [runId, previous, gateStep]);
    return definition.steps.map((s) => {
      const row = kept.get(s.id);
      if (replay.has(s.id) || !row) return fresh(s.id);
      return { ...row, status: row.status === "running" || row.status === "failed" ? "waiting" : row.status };
    });
  }

  /**
   * A Run recorded before Steps were: its Steps are what its attempts and Check results say. The Developer and Checks loop
   * picks up where it was: after a Quota pause or a restart the Step it was in starts again from scratch, with the earlier
   * failed Check's output when there was one.
   */
  async function fromRecords(definition: WorkflowDefinition, checkCount: number): Promise<StepRow[]> {
    const { rows: worked } = await pool.query(
      "SELECT step, max(attempt) AS attempt FROM step_attempts WHERE run_id = $1 AND iteration = $2 AND status = 'succeeded' GROUP BY step",
      [runId, iteration],
    );
    const rows = new Map(definition.steps.map((s) => [s.id, fresh(s.id)]));
    for (const s of definition.steps) {
      const done = s.type === "agent" ? worked.find((w) => w.step === s.agent) : undefined;
      if (done) rows.set(s.id, { ...fresh(s.id), status: "done", attempts: done.attempt });
    }
    for (const s of definition.steps) {
      const target = s.type === "checks" && s.onReject ? rows.get(s.onReject) : undefined;
      if (!target?.attempts) continue;
      const attempt = target.attempts;
      const { rows: checks } = await pool.query("SELECT * FROM check_results WHERE run_id = $1 AND iteration = $2 AND attempt = $3 ORDER BY id", [
        runId,
        iteration,
        attempt,
      ]);
      const failed = checks.find((c) => c.exit_status !== 0);
      if (failed) {
        const sentBack = describeFailure({ command: failed.command, exitStatus: failed.exit_status, output: failed.output });
        rows.set(target.stepId, { stepId: target.stepId, status: "waiting", attempts: attempt, sentBack });
        rows.set(s.id, { ...fresh(s.id), attempts: attempt });
      } else if (checks.length === checkCount) {
        rows.set(s.id, { ...fresh(s.id), status: "done", attempts: attempt });
      } else {
        // The Checks were interrupted part way: run them all again on the Developer's work.
        await pool.query("DELETE FROM check_results WHERE run_id = $1 AND iteration = $2 AND attempt = $3", [runId, iteration, attempt]);
        rows.set(s.id, { ...fresh(s.id), attempts: attempt - 1 });
      }
    }
    return [...rows.values()];
  }

  return {
    async begin(definition, checkCount) {
      await pool.query("UPDATE step_states SET status = 'waiting' WHERE run_id = $1 AND iteration = $2 AND status = 'running'", [runId, iteration]);
      const { rows: recorded } = await pool.query("SELECT 1 FROM step_states WHERE run_id = $1 AND iteration = $2 LIMIT 1", [runId, iteration]);
      if (recorded.length) return;
      const { rows: earlier } = await pool.query("SELECT max(iteration) AS iteration FROM step_states WHERE run_id = $1 AND iteration < $2", [runId, iteration]);
      const previous: number | null = earlier[0].iteration;
      await insert(previous === null ? await fromRecords(definition, checkCount) : await afterRejection(definition, previous), iteration);
    },

    async load() {
      const { rows } = await pool.query("SELECT * FROM step_states WHERE run_id = $1 AND iteration = $2", [runId, iteration]);
      return new Map(rows.map((r) => [r.step as string, toRow(r)]));
    },

    async set(stepId, patch) {
      await pool.query(
        `UPDATE step_states SET status = COALESCE($4, status), attempts = COALESCE($5, attempts),
           sent_back = CASE WHEN $6::boolean THEN $7 ELSE sent_back END
         WHERE run_id = $1 AND iteration = $2 AND step = $3`,
        [runId, iteration, stepId, patch.status ?? null, patch.attempts ?? null, patch.sentBack !== undefined, patch.sentBack ?? null],
      );
    },

    async sendBack(stepIds, target, reason) {
      await dropProduced(iteration, stepIds);
      await pool.query(
        `UPDATE step_states SET status = 'waiting', sent_back = CASE WHEN step = $4 THEN $5 ELSE NULL END, produced = '[]',
           since_gate = (SELECT COALESCE(max(id), 0) FROM gates WHERE run_id = $1)
         WHERE run_id = $1 AND iteration = $2 AND step = ANY($3)`,
        [runId, iteration, stepIds, target, reason],
      );
    },
  };
}
