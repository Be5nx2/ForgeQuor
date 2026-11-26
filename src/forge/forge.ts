import { join } from "node:path";
import type pg from "pg";
import type { Runner, StepResult } from "../runner/runner.js";
import { DEVELOPER_INSTRUCTIONS, developerPrompt } from "./developer.js";
import {
  commitLeftovers,
  createRunWorktree,
  inspectRepository,
  RegistrationError,
  refreshDefaultBranch,
  slugify,
} from "./workspace.js";

export { RegistrationError };

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
  /** Creates a Run and starts it in the background; follow it with `getRun`. */
  startRun(input: { projectId: number; task: string; title?: string; trackerRef?: string }): Promise<Run>;
  getRun(id: number): Promise<RunDetail>;
  listRuns(filter?: { projectId?: number; state?: RunState }): Promise<Run[]>;
  /** Every Gate still waiting for the human, across all Projects. */
  listOpenGates(): Promise<OpenGate[]>;
  /** Resolves once no Run is being worked on in the background. */
  whenIdle(): Promise<void>;
}

export interface ForgeDeps {
  pool: pg.Pool;
  runner: Runner;
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

const RUN_COLUMNS = "id, project_id, title, task, tracker_ref, state, branch, worktree_path, created_at";

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

  async function openGate(runId: number, kind: GateKind, reason: string, evidence?: string) {
    await pool.query("INSERT INTO gates (run_id, kind, reason, evidence) VALUES ($1, $2, $3, $4)", [
      runId,
      kind,
      reason,
      evidence ?? null,
    ]);
    await setState(runId, "waiting");
  }

  /** The fixed M1 Workflow so far: Developer, then the final Gate. Any failure opens an Escalation. */
  async function execute(run: Run, project: Project) {
    try {
      const defaultBranch = await refreshDefaultBranch(project.localPath);
      await pool.query("UPDATE projects SET default_branch = $2 WHERE id = $1", [project.id, defaultBranch]);

      const branch = `forgequor/${run.id}-${slugify(run.title) || "run"}`;
      const worktreePath = join(deps.worktreesRoot, `${slugify(project.name)}-${project.id}`, `run-${run.id}`);
      await createRunWorktree({ repoRoot: project.localPath, defaultBranch, branch, worktreePath });
      await pool.query("UPDATE runs SET branch = $2, worktree_path = $3 WHERE id = $1", [run.id, branch, worktreePath]);

      const { rows } = await pool.query(
        `INSERT INTO step_attempts (run_id, step, attempt, runner, model, status)
         VALUES ($1, 'developer', 1, 'claude', $2, 'running') RETURNING id`,
        [run.id, deps.developerModel ?? null],
      );
      const attemptId = rows[0].id;
      const log: string[] = [];
      const result: StepResult = await runner.run(
        { instructions: DEVELOPER_INSTRUCTIONS, prompt: developerPrompt(run.task), cwd: worktreePath, model: deps.developerModel },
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

      if (result.status === "failed") return openGate(run.id, "escalation", "The Developer failed.", result.error);
      if (result.status === "quota_exhausted") {
        // Pause and resume arrive with m1-08; until then the human sees it.
        return openGate(run.id, "escalation", "The Runner's Quota is exhausted.", result.resetsAt?.toISOString());
      }

      await commitLeftovers(worktreePath, "chore: commit work left by the Developer");
      await openGate(run.id, "final", "The Developer finished.");
    } catch (e: any) {
      // If even the Escalation cannot be recorded (database down), the Run stays Running and restart recovery (m1-08) picks it up.
      await openGate(run.id, "escalation", "The Run could not continue.", String(e?.message ?? e)).catch((err) =>
        console.error(`Run ${run.id}: could not record its failure:`, err),
      );
    }
  }

  return {
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
      const gates = await pool.query("SELECT * FROM gates WHERE run_id = $1 ORDER BY id", [id]);
      return { ...toRun(rows[0]), attempts: attempts.rows.map(toAttempt), gates: gates.rows.map(toGate) };
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

    async whenIdle() {
      while (inFlight.size) await Promise.all([...inFlight]);
    },
  };
}
