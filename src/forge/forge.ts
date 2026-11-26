import { join } from "node:path";
import type pg from "pg";
import type { Runner, StepResult } from "../runner/runner.js";
import { describeFailure, passed, runChecks } from "./checks.js";
import { DEVELOPER_INSTRUCTIONS, developerPrompt } from "./developer.js";
import type { CodeHost } from "../codehost/codehost.js";
import {
  commitLeftovers,
  createRunWorktree,
  inspectRepository,
  RegistrationError,
  pushBranch,
  readReviewBrief,
  refreshDefaultBranch,
  runNotesInBranch,
  slugify,
} from "./workspace.js";

export { RegistrationError };

/** A Gate decision that cannot be made: unknown Gate, already decided, or a choice it does not offer. */
export class GateError extends Error {}

/** An operation the Run's current state does not allow, such as abandoning a Run that is already over. */
export class RunStateError extends Error {}

/** No such Run. */
export class RunNotFoundError extends Error {}

export type RunState = "queued" | "running" | "waiting" | "paused" | "approved" | "merged" | "closed" | "abandoned";
export type GateKind = "final" | "escalation";
export type GateAction = "approve" | "abandon";

export interface Run {
  id: number;
  projectId: number;
  title: string;
  task: string;
  trackerRef: string | null;
  state: RunState;
  branch: string | null;
  worktreePath: string | null;
  prNumber: number | null;
  prUrl: string | null;
  createdAt: Date;
}

export interface StepAttempt {
  id: number;
  step: string;
  attempt: number;
  runner: string;
  model: string | null;
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
  kind: GateKind;
  reason: string;
  evidence: string | null;
  /** What the human can do here. A final Gate may be approved; an Escalation can only be abandoned. */
  actions: GateAction[];
  openedAt: Date;
  decidedAt: Date | null;
  decision: GateAction | null;
}

export interface RunDetail extends Run {
  attempts: StepAttempt[];
  checks: CheckResult[];
  gates: Gate[];
}

/** An open Gate with enough of its Run and Project to be listed on its own. */
export interface OpenGate extends Gate {
  runTitle: string;
  projectName: string;
}

export interface Project {
  id: number;
  name: string;
  localPath: string;
  remoteOwner: string;
  remoteName: string;
  defaultBranch: string;
  checks: string[];
  maxConcurrentRuns: number;
}

export interface Forge {
  registerProject(input: { path: string }): Promise<Project>;
  listProjects(): Promise<Project[]>;
  /** Replaces a Project's ordered Check commands (blank ones are dropped). Applies to Runs started afterwards. */
  setChecks(projectId: number, checks: string[]): Promise<Project>;
  /** Creates a Run and starts it in the background; follow it with `getRun`. */
  startRun(input: { projectId: number; task: string; title?: string; trackerRef?: string }): Promise<Run>;
  getRun(id: number): Promise<RunDetail>;
  listRuns(filter?: { projectId?: number; state?: RunState }): Promise<Run[]>;
  /** Every Gate still waiting for the human, across all Projects. */
  listOpenGates(): Promise<OpenGate[]>;
  /**
   * The human's decision at an open Gate: approve moves the Run to Approved, abandon to Abandoned (its branch and
   * worktree are kept). Throws a GateError for an unknown or already decided Gate, or a choice it does not offer.
   */
  decideGate(input: { gateId: number; action: GateAction }): Promise<RunDetail>;
  /**
   * Abandons a Run in any state before Merged: closes its pull request if it has one, settles its open Gate, and keeps
   * its branch and worktree. Throws a RunStateError when the Run is already over. A pull request merged on GitHub in
   * the meantime makes the Run Merged instead. If the pull request cannot be read or closed, the Run is left as it was.
   */
  abandonRun(runId: number): Promise<RunDetail>;
  /** One pass of merge and close detection: Approved Runs whose pull request was merged or closed on GitHub follow it. */
  checkPullRequests(): Promise<void>;
  /** Resolves once no Run is being worked on in the background. */
  whenIdle(): Promise<void>;
}

export interface ForgeDeps {
  pool: pg.Pool;
  runner: Runner;
  codeHost: CodeHost;
  /** Folder under which each Run's worktree is created, outside the Projects' checkouts. */
  worktreesRoot: string;
  /** Model the Developer's Runner is set to; the Runner's default when omitted. */
  developerModel?: string;
}

const COLUMNS = "id, name, local_path, remote_owner, remote_name, default_branch, checks, max_concurrent_runs";

function toProject(r: Record<string, any>): Project {
  return {
    id: Number(r.id),
    name: r.name,
    localPath: r.local_path,
    remoteOwner: r.remote_owner,
    remoteName: r.remote_name,
    defaultBranch: r.default_branch,
    checks: r.checks,
    maxConcurrentRuns: r.max_concurrent_runs,
  };
}

function toRun(r: Record<string, any>): Run {
  return {
    id: Number(r.id),
    projectId: Number(r.project_id),
    title: r.title,
    task: r.task,
    trackerRef: r.tracker_ref,
    state: r.state,
    branch: r.branch,
    worktreePath: r.worktree_path,
    prNumber: r.pr_number,
    prUrl: r.pr_url,
    createdAt: r.created_at,
  };
}

function toAttempt(r: Record<string, any>): StepAttempt {
  return {
    id: Number(r.id),
    step: r.step,
    attempt: r.attempt,
    runner: r.runner,
    model: r.model,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    summary: r.summary,
    error: r.error,
    quotaResetsAt: r.quota_resets_at,
    eventLog: r.event_log,
  };
}

function toCheck(r: Record<string, any>): CheckResult {
  return {
    id: Number(r.id),
    attempt: r.attempt,
    command: r.command,
    exitStatus: r.exit_status,
    output: r.output,
    ranAt: r.ran_at,
  };
}

/** After this many failed Checks the Developer's extra attempts are used up (1 try + 2 extra). */
const MAX_DEVELOPER_ATTEMPTS = 3;

/** States a Run cannot leave. A Run in one of them no longer holds its Project's slot. */
const OVER: RunState[] = ["merged", "closed", "abandoned"];
const ACTIVE: RunState[] = ["queued", "running", "waiting", "paused", "approved"];

function toGate(r: Record<string, any>): Gate {
  return {
    id: Number(r.id),
    runId: Number(r.run_id),
    kind: r.kind,
    reason: r.reason,
    evidence: r.evidence,
    actions: r.kind === "final" ? ["approve", "abandon"] : ["abandon"],
    openedAt: r.opened_at,
    decidedAt: r.decided_at,
    decision: r.decision,
  };
}

const RUN_COLUMNS = "id, project_id, title, task, tracker_ref, state, branch, worktree_path, pr_number, pr_url, created_at";

function deriveTitle(task: string): string {
  const first = task.trim().split("\n")[0]!.trim();
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}...` : first;
}

export function createForge(deps: ForgeDeps): Forge {
  const { pool, runner } = deps;
  const inFlight = new Set<Promise<void>>();

  async function setState(runId: number, state: RunState) {
    await pool.query("UPDATE runs SET state = $2, updated_at = now() WHERE id = $1", [runId, state]);
  }

  /** Opens a Gate and makes the Run Waiting, unless the Run was abandoned meanwhile. */
  async function openGate(runId: number, kind: GateKind, reason: string, evidence?: string) {
    await pool.query(
      `WITH r AS (UPDATE runs SET state = 'waiting', updated_at = now() WHERE id = $1 AND state = 'running' RETURNING id)
       INSERT INTO gates (run_id, kind, reason, evidence) SELECT id, $2, $3, $4 FROM r`,
      [runId, kind, reason, evidence ?? null],
    );
  }

  /** False once the human abandoned the Run while it was being worked on. */
  async function stillRunning(runId: number): Promise<boolean> {
    const { rows } = await pool.query("SELECT state FROM runs WHERE id = $1", [runId]);
    return rows[0]?.state === "running";
  }

  async function settle(runId: number, state: "abandoned" | "merged" | "closed", from: RunState[]): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const moved = await client.query("UPDATE runs SET state = $2, updated_at = now() WHERE id = $1 AND state = ANY($3) RETURNING id", [
        runId,
        state,
        from,
      ]);
      if (!moved.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      if (state === "abandoned") {
        await client.query("UPDATE gates SET decided_at = now(), decision = 'abandon' WHERE run_id = $1 AND decided_at IS NULL", [runId]);
      }
      await client.query("COMMIT");
      return true;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async function abandon(runId: number): Promise<RunDetail> {
    const { rows } = await pool.query(
      `SELECT r.id, r.state, r.pr_number, p.remote_owner, p.remote_name FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.id = $1`,
      [runId],
    );
    const row = rows[0];
    if (!row) throw new RunNotFoundError(`No Run ${runId}.`);
    if (OVER.includes(row.state)) throw new RunStateError(`Run ${runId} is already ${row.state}.`);
    let state: "abandoned" | "merged" = "abandoned";
    if (row.pr_number) {
      const pr = { owner: row.remote_owner, repo: row.remote_name, number: row.pr_number };
      const current = await deps.codeHost.pullRequestState(pr);
      if (current === "merged") state = "merged";
      else if (current === "open") await deps.codeHost.closePullRequest(pr);
    }
    if (!(await settle(runId, state, ACTIVE))) throw new RunStateError(`Run ${runId} changed state while it was being abandoned.`);
    return forge.getRun(runId);
  }

  /** One Developer attempt, recorded as a Step attempt. */
  async function developerStep(run: Run, worktreePath: string, attempt: number, failedCheck?: string): Promise<StepResult> {
    const { rows } = await pool.query(
      `INSERT INTO step_attempts (run_id, step, attempt, runner, model, status)
       VALUES ($1, 'developer', $2, 'claude', $3, 'running') RETURNING id`,
      [run.id, attempt, deps.developerModel ?? null],
    );
    const attemptId = rows[0].id;
    const log: string[] = [];
    const result = await runner.run(
      { instructions: DEVELOPER_INSTRUCTIONS, prompt: developerPrompt(run.task, failedCheck), cwd: worktreePath, model: deps.developerModel },
      (e) => {
        if (e.raw) log.push(e.raw);
      },
    );
    await pool.query(
      `UPDATE step_attempts SET status = $2, ended_at = now(), summary = $3, error = $4, quota_resets_at = $5, event_log = $6
       WHERE id = $1`,
      [
        attemptId,
        result.status,
        result.status === "succeeded" ? result.summary : null,
        result.status === "failed" ? result.error : null,
        result.status === "quota_exhausted" ? result.resetsAt : null,
        log.join("\n"),
      ],
    );
    return result;
  }

  /** The fixed M1 Workflow so far: Developer, Checks (retrying the Developer), pull request, then the final Gate. Any failure opens an Escalation. */
  async function execute(run: Run, project: Project) {
    try {
      const defaultBranch = await refreshDefaultBranch(project.localPath);
      await pool.query("UPDATE projects SET default_branch = $2 WHERE id = $1", [project.id, defaultBranch]);

      const branch = `forgequor/${run.id}-${slugify(run.title) || "run"}`;
      const worktreePath = join(deps.worktreesRoot, `${slugify(project.name)}-${project.id}`, `run-${run.id}`);
      await createRunWorktree({ repoRoot: project.localPath, defaultBranch, branch, worktreePath });
      await pool.query("UPDATE runs SET branch = $2, worktree_path = $3 WHERE id = $1", [run.id, branch, worktreePath]);

      let failedCheck: string | undefined;
      for (let attempt = 1; attempt <= MAX_DEVELOPER_ATTEMPTS; attempt++) {
        const result = await developerStep(run, worktreePath, attempt, failedCheck);
        if (!(await stillRunning(run.id))) return;
        if (result.status === "failed") return openGate(run.id, "escalation", "The Developer failed.", result.error);
        if (result.status === "quota_exhausted") {
          // Pause and resume arrive with m1-08; until then the human sees it.
          return openGate(run.id, "escalation", "The Runner's Quota is exhausted.", result.resetsAt?.toISOString());
        }

        await commitLeftovers(worktreePath, "chore: commit work left by the Developer");

        const outcomes = await runChecks(project.checks, worktreePath);
        for (const c of outcomes) {
          await pool.query(
            "INSERT INTO check_results (run_id, attempt, command, exit_status, output) VALUES ($1, $2, $3, $4, $5)",
            [run.id, attempt, c.command, c.exitStatus, c.output],
          );
        }
        const failed = outcomes.find((c) => !passed(c));
        if (!failed) break;
        failedCheck = describeFailure(failed);
        if (attempt === MAX_DEVELOPER_ATTEMPTS) {
          return openGate(run.id, "escalation", `A Check still fails after ${attempt} attempts.`, failedCheck);
        }
      }

      if (!(await stillRunning(run.id))) return;
      const notes = await runNotesInBranch(worktreePath, defaultBranch);
      if (notes.length) {
        return openGate(run.id, "escalation", "A commit adds Run Notes, so the branch was not pushed.", notes.join("\n"));
      }
      await pushBranch(worktreePath, branch);
      const pr = await deps.codeHost.openPullRequest({
        owner: project.remoteOwner,
        repo: project.remoteName,
        base: defaultBranch,
        head: branch,
        title: run.title,
        body: `${run.task}\n\n---\nForgequor Run #${run.id}`,
      });
      await pool.query("UPDATE runs SET pr_number = $2, pr_url = $3 WHERE id = $1", [run.id, pr.number, pr.url]);
      if (!(await stillRunning(run.id))) {
        // Abandoned while the pull request was being opened: it may not have seen it, so close it here.
        await deps.codeHost.closePullRequest({ owner: project.remoteOwner, repo: project.remoteName, number: pr.number }).catch(() => {});
        return;
      }
      await deps.codeHost.comment({
        owner: project.remoteOwner,
        repo: project.remoteName,
        number: pr.number,
        body: readReviewBrief(worktreePath) ?? "The Developer wrote no Review Brief for this pull request.",
      });
      await openGate(run.id, "final", "The Developer finished.");
    } catch (e: any) {
      // If even the Escalation cannot be recorded (database down), the Run stays Running and restart recovery (m1-08) picks it up.
      await openGate(run.id, "escalation", "The Run could not continue.", String(e?.message ?? e)).catch((err) =>
        console.error(`Run ${run.id}: could not record its failure:`, err),
      );
    }
  }

  const forge: Forge = {
    async registerProject({ path }) {
      const repo = await inspectRepository(path);
      try {
        const { rows } = await pool.query(
          `INSERT INTO projects (name, local_path, remote_owner, remote_name, default_branch)
           VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
          [repo.remoteName, repo.root, repo.remoteOwner, repo.remoteName, repo.defaultBranch],
        );
        return toProject(rows[0]);
      } catch (e: any) {
        if (e.code === "23505") throw new RegistrationError(`${repo.root} is already registered.`);
        throw e;
      }
    },

    async listProjects() {
      const { rows } = await pool.query(`SELECT ${COLUMNS} FROM projects ORDER BY id`);
      return rows.map(toProject);
    },

    async setChecks(projectId, checks) {
      const clean = checks.map((c) => c.trim()).filter(Boolean);
      const { rows } = await pool.query(`UPDATE projects SET checks = $2 WHERE id = $1 RETURNING ${COLUMNS}`, [
        projectId,
        JSON.stringify(clean),
      ]);
      if (!rows[0]) throw new Error(`No Project ${projectId}.`);
      return toProject(rows[0]);
    },

    async startRun({ projectId, task, title, trackerRef }) {
      const { rows: found } = await pool.query(`SELECT ${COLUMNS} FROM projects WHERE id = $1`, [projectId]);
      if (!found[0]) throw new Error(`No Project ${projectId}.`);
      if (!task.trim()) throw new Error("A Run needs a task.");
      const { rows } = await pool.query(
        `INSERT INTO runs (project_id, title, task, tracker_ref, state)
         VALUES ($1, $2, $3, $4, 'running') RETURNING ${RUN_COLUMNS}`,
        [projectId, title?.trim() || deriveTitle(task), task.trim(), trackerRef?.trim() || null],
      );
      const run = toRun(rows[0]);
      const work = execute(run, toProject(found[0])).finally(() => inFlight.delete(work));
      inFlight.add(work);
      return run;
    },

    async getRun(id) {
      const { rows } = await pool.query(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = $1`, [id]);
      if (!rows[0]) throw new Error(`No Run ${id}.`);
      const attempts = await pool.query("SELECT * FROM step_attempts WHERE run_id = $1 ORDER BY id", [id]);
      const checks = await pool.query("SELECT * FROM check_results WHERE run_id = $1 ORDER BY id", [id]);
      const gates = await pool.query("SELECT * FROM gates WHERE run_id = $1 ORDER BY id", [id]);
      return { ...toRun(rows[0]), attempts: attempts.rows.map(toAttempt), checks: checks.rows.map(toCheck), gates: gates.rows.map(toGate) };
    },

    async listRuns(filter = {}) {
      const { rows } = await pool.query(
        `SELECT ${RUN_COLUMNS} FROM runs
         WHERE ($1::bigint IS NULL OR project_id = $1) AND ($2::text IS NULL OR state = $2)
         ORDER BY id DESC`,
        [filter.projectId ?? null, filter.state ?? null],
      );
      return rows.map(toRun);
    },

    async listOpenGates() {
      const { rows } = await pool.query(
        `SELECT g.*, r.title AS run_title, p.name AS project_name
         FROM gates g JOIN runs r ON r.id = g.run_id JOIN projects p ON p.id = r.project_id
         WHERE g.decided_at IS NULL ORDER BY g.id`,
      );
      return rows.map((r) => ({ ...toGate(r), runTitle: r.run_title, projectName: r.project_name }));
    },

    async decideGate({ gateId, action }) {
      const { rows } = await pool.query("SELECT * FROM gates WHERE id = $1", [gateId]);
      if (!rows[0]) throw new GateError(`No Gate ${gateId}.`);
      const gate = toGate(rows[0]);
      if (gate.decidedAt) throw new GateError(`Gate ${gateId} is already decided.`);
      if (!gate.actions.includes(action)) {
        throw new GateError(`An Escalation cannot be ${action === "approve" ? "approved" : action}; it can only be abandoned.`);
      }

      if (action === "abandon") {
        try {
          return await abandon(gate.runId);
        } catch (e) {
          if (e instanceof RunStateError) throw new GateError(e.message);
          throw e;
        }
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Guarded on decided_at so two decisions racing for the same Gate cannot both win.
        const decided = await client.query(
          "UPDATE gates SET decided_at = now(), decision = $2 WHERE id = $1 AND decided_at IS NULL RETURNING run_id",
          [gateId, action],
        );
        if (!decided.rowCount) {
          await client.query("ROLLBACK");
          throw new GateError(`Gate ${gateId} is already decided.`);
        }
        await client.query("UPDATE runs SET state = $2, updated_at = now() WHERE id = $1", [
          gate.runId,
          action === "approve" ? "approved" : "abandoned",
        ]);
        await client.query("COMMIT");
      } catch (e) {
        if (!(e instanceof GateError)) await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      return forge.getRun(gate.runId);
    },

    abandonRun: abandon,

    async checkPullRequests() {
      const { rows } = await pool.query(
        `SELECT r.id, r.pr_number, p.remote_owner, p.remote_name FROM runs r JOIN projects p ON p.id = r.project_id
         WHERE r.state = 'approved' AND r.pr_number IS NOT NULL ORDER BY r.id`,
      );
      for (const r of rows) {
        try {
          const state = await deps.codeHost.pullRequestState({ owner: r.remote_owner, repo: r.remote_name, number: r.pr_number });
          if (state !== "open") await settle(Number(r.id), state, ["approved"]);
        } catch (e: any) {
          console.error(`Run ${r.id}: could not read its pull request:`, e?.message ?? e);
        }
      }
    },

    async whenIdle() {
      while (inFlight.size) await Promise.all([...inFlight]);
    },
  };
  return forge;
}
