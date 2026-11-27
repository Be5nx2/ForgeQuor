import { existsSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import type { Runner } from "../runner/runner.js";
import { developerWorkflow } from "./developer.js";
import { publishPullRequest } from "./publish.js";
import { createRunRecords } from "./run-records.js";
import { builtInExtensions } from "./builtin.js";
import { AssetNotFoundError, GateError, InvalidInputError, RunNotFoundError, RunStateError } from "./errors.js";
import type { Extension } from "./extension.js";
import { escalationGate, finalGate, refusal, type GateKindModule, type GateOutcome } from "./gates.js";
import type { AgentSeat, RunInput, Workflow } from "./workflow.js";
import type { CodeHost } from "../codehost/codehost.js";
import { parseDefaultSize, parseReferences } from "./art-direction.js";
import type {
  ApprovedRun,
  ArtInfo,
  CheckResult,
  Gate,
  GateAction,
  GateKind,
  Iteration,
  OpenGate,
  Project,
  Run,
  RunDetail,
  RunState,
  RunUpdate,
  StepAttempt,
  Verdict,
} from "./types.js";
import { createRunWorktree, existsInBranch, inspectRepository, listInBranch, readInBranch, RegistrationError, refreshDefaultBranch, repositoryPath, slugify } from "./workspace.js";

export { RegistrationError, AssetNotFoundError, GateError, InvalidInputError, RunNotFoundError, RunStateError };
export type * from "./types.js";

export interface Forge {
  /** Hears every RunUpdate from now on. Returns the function that stops it. A throwing listener never disturbs a Run. */
  subscribe(listener: (update: RunUpdate) => void): () => void;
  registerProject(input: { path: string }): Promise<Project>;
  listProjects(): Promise<Project[]>;
  /** Replaces a Project's ordered Check commands (blank ones are dropped). Applies to Runs started afterwards. */
  setChecks(projectId: number, checks: string[]): Promise<Project>;
  /** Replaces a Project's ordered setup commands (blank ones are dropped). A failing one opens an Escalation and the Developer never starts. */
  setSetup(projectId: number, commands: string[]): Promise<Project>;
  /** Sets how many Runs of a Project may work at once (at least 1). Raising it starts Queued Runs that now fit. */
  setMaxConcurrentRuns(projectId: number, max: number): Promise<Project>;
  /** Sets where a Project keeps its Art Direction document and its Assets (repository paths). Applies to Runs started afterwards; throws an InvalidInputError for a path outside the repository. */
  setArt(projectId: number, art: { artDirectionPath: string; artFolder: string }): Promise<Project>;
  /**
   * What the Run form needs to know about a Project's art, read from its default branch freshly fetched: whether the Art
   * Direction is there, its `Default size`, the reference images it names that exist, and every PNG of the repository.
   */
  artInfo(projectId: number): Promise<ArtInfo>;
  /**
   * Creates a Run of the given Workflow (`developer` when omitted; an unknown name is refused) and starts it in the background; follow it with `getRun`. A `developer` Run takes a task, an `assets` Run
   * its Asset Requests; the input is refused with an error saying what is wrong before anything starts. A Project already at its concurrent Runs
   * limit leaves the new Run Queued; it starts by itself, in creation order, when a slot frees up.
   */
  startRun(input: RunInput & { projectId: number; trackerRef?: string; workflow?: string }): Promise<Run>;
  getRun(id: number): Promise<RunDetail>;
  listRuns(filter?: { projectId?: number; state?: RunState }): Promise<Run[]>;
  /** Every Gate still waiting for the human, across all Projects. */
  listOpenGates(): Promise<OpenGate[]>;
  /** The merge list: every Approved Run of every Project, oldest first, until its pull request is merged or closed or the Run is abandoned. */
  listApprovedRuns(): Promise<ApprovedRun[]>;
  /**
   * The human's decision at an open Gate: approve (final Gate) moves the Run to Approved, abandon to Abandoned (its branch
   * and worktree are kept), reject (final Gate only, with a non-empty `feedback`) starts the Run's next Iteration. An Asset
   * Gate takes `judge` with a verdict for every Asset waiting for one, all at once: when all are approved the Run goes on
   * to its commit and pull request, otherwise the next Iteration redoes the rejected Assets only. Throws a GateError for an
   * unknown or already decided Gate or a choice it does not offer, and an InvalidInputError for a rejection without
   * Feedback or verdicts that do not fit the Assets waiting.
   */
  decideGate(input: { gateId: number; action: GateAction; feedback?: string; verdicts?: Verdict[] }): Promise<RunDetail>;
  /**
   * Abandons a Run in any state before Merged: closes its pull request if it has one, settles its open Gate, and keeps
   * its branch and worktree. Throws a RunStateError when the Run is already over. A pull request merged on GitHub in
   * the meantime makes the Run Merged instead. If the pull request cannot be read or closed, the Run is left as it was.
   */
  abandonRun(runId: number): Promise<RunDetail>;
  /** One pass of merge and close detection: Approved Runs whose pull request was merged or closed on GitHub follow it. */
  checkPullRequests(): Promise<void>;
  /** One pass over Paused Runs: those whose reset time has passed restart their current Step. */
  resumePausedRuns(): Promise<void>;
  /**
   * Call once when Forgequor starts: every Running Run restarts its current Step, the Queued Runs that fit the free
   * slots start, and Approved Runs have their pull request checked again.
   */
  recoverAfterRestart(): Promise<void>;
  /**
   * The file of an Asset's current image, or of one of its past versions, as an absolute path: only what this Run recorded
   * for that Asset, only a PNG, only inside the Run's worktree. Throws an AssetNotFoundError otherwise; no path ever
   * comes from the caller.
   */
  assetImage(runId: number, assetId: number, which?: number | "replaced"): Promise<string>;
  /** Resolves once no Run is being worked on in the background. */
  whenIdle(): Promise<void>;
}

export interface ForgeDeps {
  pool: pg.Pool;
  /** The Developer's Runner (Claude Code). */
  runner: Runner;
  /** The Artist's Runner (Codex). Without one, an `assets` Run opens an Escalation when it reaches the Artist. */
  artistRunner?: Runner;
  codeHost: CodeHost;
  /** Folder under which each Run's worktree is created, outside the Projects' checkouts. */
  worktreesRoot: string;
  /** Model the Developer's Runner is set to; the Runner's default when omitted. */
  developerModel?: string;
  /** Model the Artist's Runner is set to; the Runner's default when omitted. */
  artistModel?: string;
  /** A Step running longer than this is killed and escalated. Default: 60 minutes. */
  stepTimeoutMs?: number;
  /** A Check command running longer than this is killed, which fails the Check. Default: 10 minutes. */
  checkTimeoutMs?: number;
  /** The Step types, Gate kinds and Workflows built on the core besides the Developer's. Default: the built-in ones (Assets). */
  extensions?: Extension[];
  /** The clock, so tests can move time. */
  now?: () => Date;
}

const COLUMNS =
  "id, name, local_path, remote_owner, remote_name, default_branch, checks, setup, max_concurrent_runs, art_direction_path, art_folder";

function toProject(r: Record<string, any>): Project {
  return {
    id: Number(r.id),
    name: r.name,
    localPath: r.local_path,
    remoteOwner: r.remote_owner,
    remoteName: r.remote_name,
    defaultBranch: r.default_branch,
    checks: r.checks,
    setup: r.setup,
    maxConcurrentRuns: r.max_concurrent_runs,
    artDirectionPath: r.art_direction_path,
    artFolder: r.art_folder,
  };
}

function toRun(r: Record<string, any>): Run {
  return {
    id: Number(r.id),
    projectId: Number(r.project_id),
    workflow: r.workflow,
    iteration: r.iteration,
    title: r.title,
    task: r.task,
    trackerRef: r.tracker_ref,
    state: r.state,
    branch: r.branch,
    worktreePath: r.worktree_path,
    prNumber: r.pr_number,
    prUrl: r.pr_url,
    resumeAt: r.resume_at,
    createdAt: r.created_at,
  };
}

function toAttempt(r: Record<string, any>): StepAttempt {
  return {
    id: Number(r.id),
    iteration: r.iteration,
    step: r.step,
    attempt: r.attempt,
    runner: r.runner,
    model: r.model,
    assetId: r.asset_id === null ? null : Number(r.asset_id),
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
    iteration: r.iteration,
    attempt: r.attempt,
    command: r.command,
    exitStatus: r.exit_status,
    output: r.output,
    ranAt: r.ran_at,
  };
}

/** How long a Run stays Paused when the Runner did not say when its Quota comes back. */
const QUOTA_RETRY_MS = 15 * 60 * 1000;
const DEFAULT_STEP_TIMEOUT_MS = 60 * 60 * 1000;

/** States a Run cannot leave. A Run in one of them no longer holds its Project's slot. */
const OVER: RunState[] = ["merged", "closed", "abandoned"];
const ACTIVE: RunState[] = ["queued", "running", "waiting", "paused", "approved"];
/**
 * States that hold one of their Project's slots. A Queued Run does not, nor an Approved one: its pull request waits for
 * the human's merge, not for an Agent.
 */
const HOLDING_A_SLOT: RunState[] = ["running", "waiting", "paused"];

function toGate(r: Record<string, any>, actions: GateAction[]): Gate {
  return {
    id: Number(r.id),
    runId: Number(r.run_id),
    iteration: r.iteration,
    kind: r.kind,
    reason: r.reason,
    evidence: r.evidence,
    actions,
    feedback: r.feedback,
    verdicts: [],
    openedAt: r.opened_at,
    decidedAt: r.decided_at,
    decision: r.decision,
  };
}

const RUN_COLUMNS = "id, project_id, workflow, iteration, title, task, tracker_ref, state, branch, worktree_path, pr_number, pr_url, resume_at, created_at";
/** The same columns, read through the alias `r` in a query that joins another table. */
const RUN_COLUMNS_OF_R = RUN_COLUMNS.split(", ").map((c) => `r.${c}`).join(", ");

export function createForge(deps: ForgeDeps): Forge {
  const { pool } = deps;
  /** The Workflows a Run can follow, by name. */
  const extensions = deps.extensions ?? builtInExtensions(pool);
  const workflows = new Map<string, Workflow>([developerWorkflow, ...extensions.flatMap((e) => e.workflows)].map((w) => [w.name, w]));
  /** The Gate kinds, by kind: each decides its own Gates. */
  const gateKinds = new Map<GateKind, GateKindModule>([finalGate, escalationGate, ...extensions.flatMap((e) => e.gateKinds)].map((k) => [k.kind, k]));
  const gateOf = (r: Record<string, any>): Gate => toGate(r, gateKinds.get(r.kind)?.actions ?? []);
  /** Each Agent's Runner: the Developer works through Claude Code, the Artist through Codex. */
  const agents: { developer: AgentSeat; artist?: AgentSeat } = {
    developer: { runner: deps.runner, runnerName: "claude", model: deps.developerModel },
    artist: deps.artistRunner && { runner: deps.artistRunner, runnerName: "codex", model: deps.artistModel },
  };
  const now = deps.now ?? (() => new Date());
  const stepTimeoutMs = deps.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const inFlight = new Set<Promise<void>>();
  const listeners = new Set<(update: RunUpdate) => void>();
  function emit(update: RunUpdate) {
    for (const l of [...listeners]) {
      try {
        l(update);
      } catch (e) {
        console.error("A Run update listener failed:", e);
      }
    }
  }
  const changed = (runId: number) => emit({ type: "changed", runId });
  /** Cancels what a Run is doing (its Workflow's Step or its Check) when the human abandons it. */
  const stoppers = new Map<number, AbortController>();
  /** The tail of the git setup queue of each repository, by path. */
  const repoQueues = new Map<string, Promise<unknown>>();

  /**
   * Runs `job` once the repository's earlier jobs are done. Git takes locks on a repository's config and refs, so two
   * Runs of one Project preparing their worktrees at the same time would make one of them fail.
   */
  function onePerRepository<T>(repoRoot: string, job: () => Promise<T>): Promise<T> {
    const result = (repoQueues.get(repoRoot) ?? Promise.resolve()).catch(() => {}).then(job);
    const tail = result.catch(() => {});
    repoQueues.set(repoRoot, tail);
    void tail.then(() => {
      if (repoQueues.get(repoRoot) === tail) repoQueues.delete(repoRoot);
    });
    return result;
  }

  async function setState(runId: number, state: RunState) {
    await pool.query("UPDATE runs SET state = $2, updated_at = now() WHERE id = $1", [runId, state]);
    changed(runId);
  }

  /** Opens a Gate and makes the Run Waiting, unless the Run was abandoned meanwhile. */
  async function openGate(runId: number, kind: GateKind, reason: string, evidence?: string) {
    await pool.query(
      `WITH r AS (UPDATE runs SET state = 'waiting', updated_at = now() WHERE id = $1 AND state = 'running' RETURNING id, iteration)
       INSERT INTO gates (run_id, iteration, kind, reason, evidence) SELECT id, iteration, $2, $3, $4 FROM r`,
      [runId, kind, reason, evidence ?? null],
    );
    changed(runId);
  }

  /** False once the human abandoned the Run while it was being worked on. */
  async function stillRunning(runId: number): Promise<boolean> {
    const { rows } = await pool.query("SELECT state FROM runs WHERE id = $1", [runId]);
    return rows[0]?.state === "running";
  }

  /** Starts `run` in the background. */
  function launch(run: Run, project: Project) {
    const work = execute(run, project).finally(() => inFlight.delete(work));
    inFlight.add(work);
  }

  /** Starts an already Running Run's work again, from what is recorded, with its Project as it is now. */
  async function restart(run: Run) {
    const { rows } = await pool.query(`SELECT ${COLUMNS} FROM projects WHERE id = $1`, [run.projectId]);
    launch(run, toProject(rows[0]));
  }

  /**
   * Starts the Project's oldest Queued Runs while it has free slots. The Project row is locked meanwhile, so Runs
   * created or freed at the same time can never push the Project past its limit.
   */
  async function promote(projectId: number) {
    const client = await pool.connect();
    let project: Project;
    let started: Run[];
    try {
      await client.query("BEGIN");
      const found = await client.query(`SELECT ${COLUMNS} FROM projects WHERE id = $1 FOR UPDATE`, [projectId]);
      project = toProject(found.rows[0]);
      const held = await client.query("SELECT count(*)::int AS n FROM runs WHERE project_id = $1 AND state = ANY($2)", [
        projectId,
        HOLDING_A_SLOT,
      ]);
      const free = project.maxConcurrentRuns - held.rows[0].n;
      started = [];
      if (free > 0) {
        const moved = await client.query(
          `UPDATE runs SET state = 'running', updated_at = now()
           WHERE id IN (SELECT id FROM runs WHERE project_id = $1 AND state = 'queued' ORDER BY id LIMIT $2)
           RETURNING ${RUN_COLUMNS}`,
          [projectId, free],
        );
        started = moved.rows.map(toRun).sort((a, b) => a.id - b.id);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    for (const run of started) {
      changed(run.id);
      launch(run, project);
    }
  }

  async function settle(runId: number, state: "abandoned" | "merged" | "closed", from: RunState[]): Promise<boolean> {
    let projectId: number;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const moved = await client.query("UPDATE runs SET state = $2, updated_at = now() WHERE id = $1 AND state = ANY($3) RETURNING project_id", [
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
      projectId = Number(moved.rows[0].project_id);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    changed(runId);
    // The Run is over, so its slot is free for the next Queued Run.
    await promote(projectId);
    return true;
  }

  /**
   * Decides a Gate whose Run then goes on working in the same worktree: a rejection (with its Feedback) or a judgement
   * with a rejected Asset starts the next Iteration; approving all of an Asset Gate sends the Run on to its commit and
   * pull request. `record` writes what else the decision stores, in the same transaction.
   */
  async function decideAndContinue(
    gate: Gate,
    decision: Extract<GateOutcome, { next: "continue" }>,
  ): Promise<RunDetail> {
    const client = await pool.connect();
    let run: Run;
    try {
      await client.query("BEGIN");
      // The Run row is locked before the Gate row, the order `settle` uses too, so a decision racing an abandon cannot
      // deadlock. Guarded on the Run still waiting and the Gate undecided, so a racing decision or abandon cannot also win.
      const moved = await client.query(
        `UPDATE runs SET state = 'running', iteration = iteration + $2::int, brief_posted = brief_posted AND $2::int = 0, updated_at = now()
         WHERE id = $1 AND state = 'waiting' RETURNING ${RUN_COLUMNS}`,
        [gate.runId, decision.nextIteration ? 1 : 0],
      );
      const decided = moved.rowCount
        ? await client.query(
            "UPDATE gates SET decided_at = now(), decision = $2, feedback = $3 WHERE id = $1 AND decided_at IS NULL RETURNING run_id",
            [gate.id, decision.decision, decision.feedback ?? null],
          )
        : null;
      if (!decided?.rowCount) {
        await client.query("ROLLBACK");
        throw new GateError(`Gate ${gate.id} is already decided.`);
      }
      await decision.record?.(client);
      await client.query("COMMIT");
      run = toRun(moved.rows[0]);
    } catch (e) {
      if (!(e instanceof GateError)) await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    changed(run.id);
    await restart(run);
    return forge.getRun(run.id);
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
    // Nothing the Run is still doing matters any more: kill it, process group and all.
    stoppers.get(runId)?.abort();
    return forge.getRun(runId);
  }

  /** The Runner's Quota ran out: the Run waits for the reset, keeping its slot. */
  async function pause(runId: number, resetsAt: Date | null) {
    const resumeAt = resetsAt ?? new Date(now().getTime() + QUOTA_RETRY_MS);
    await pool.query("UPDATE runs SET state = 'paused', resume_at = $2, updated_at = now() WHERE id = $1 AND state = 'running'", [
      runId,
      resumeAt,
    ]);
    changed(runId);
  }

  /** The Run's work is done and its pull request is open: Approved, unless it was abandoned meanwhile. Its slot is then free. */
  async function approveRun(runId: number) {
    const { rows } = await pool.query(
      "UPDATE runs SET state = 'approved', updated_at = now() WHERE id = $1 AND state = 'running' RETURNING project_id",
      [runId],
    );
    changed(runId);
    if (!rows[0]) return;
    // This Run is done: failing to start the next one is not its failure. Restart recovery starts Queued Runs again.
    await promote(Number(rows[0].project_id)).catch((e) => console.error(`Run ${runId}: could not start the next Queued Run:`, e));
  }

  /** Works on a Run until it waits at a Gate, pauses, or is abandoned; starts over from what is recorded if it was worked on before. */
  async function execute(run: Run, project: Project) {
    const stopper = new AbortController();
    stoppers.set(run.id, stopper);
    try {
      await work(run, project, stopper.signal);
    } finally {
      // A rejection may already have restarted the Run with a controller of its own: leave that one.
      if (stoppers.get(run.id) === stopper) stoppers.delete(run.id);
    }
  }

  /** Fetches the Project's remote and returns its default branch, remembered on the Project. */
  async function freshDefaultBranch(projectId: number, localPath: string): Promise<string> {
    const fresh = await onePerRepository(localPath, () => refreshDefaultBranch(localPath));
    await pool.query("UPDATE projects SET default_branch = $2 WHERE id = $1", [projectId, fresh]);
    return fresh;
  }

  /** Prepares the Run's worktree, then hands the Run to its Workflow. Any failure opens an Escalation. */
  async function work(run: Run, project: Project, stop: AbortSignal) {
    try {
      const branch = run.branch ?? `forgequor/${run.id}-${slugify(run.title) || "run"}`;
      const worktreePath = run.worktreePath ?? join(deps.worktreesRoot, `${slugify(project.name)}-${project.id}`, `run-${run.id}`);
      let defaultBranch = project.defaultBranch;
      if (!existsSync(worktreePath)) {
        defaultBranch = await onePerRepository(project.localPath, async () => {
          const fresh = await refreshDefaultBranch(project.localPath);
          await pool.query("UPDATE projects SET default_branch = $2 WHERE id = $1", [project.id, fresh]);
          await createRunWorktree({ repoRoot: project.localPath, defaultBranch: fresh, branch, worktreePath });
          return fresh;
        });
      }
      await pool.query("UPDATE runs SET branch = $2, worktree_path = $3 WHERE id = $1", [run.id, branch, worktreePath]);
      changed(run.id);

      // Abandoned between being restarted and getting here: nothing to work on, no Quota to spend.
      if (!(await stillRunning(run.id))) return;
      const workflow = workflows.get(run.workflow);
      if (!workflow) throw new Error(`Unknown Workflow "${run.workflow}".`);
      const records = createRunRecords(pool, run.id, run.iteration);
      await workflow.run({
        run,
        project,
        branch,
        worktreePath,
        defaultBranch,
        stop,
        agents,
        records,
        publishPullRequest: (brief) =>
          publishPullRequest(
            { run, project, worktreePath, branch, defaultBranch, records, changed: () => changed(run.id), stillRunning: () => stillRunning(run.id), codeHost: deps.codeHost },
            brief,
          ),
        stepTimeoutMs,
        checkTimeoutMs: deps.checkTimeoutMs,
        changed: () => changed(run.id),
        emit,
        openGate: (kind, reason, evidence) => openGate(run.id, kind, reason, evidence),
        pause: (resetsAt) => pause(run.id, resetsAt),
        approve: () => approveRun(run.id),
        stillRunning: () => stillRunning(run.id),
      });
    } catch (e: any) {
      // If even the Escalation cannot be recorded (database down), the Run stays Running and restart recovery picks it up.
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

    async setSetup(projectId, commands) {
      const clean = commands.map((c) => c.trim()).filter(Boolean);
      const { rows } = await pool.query(`UPDATE projects SET setup = $2 WHERE id = $1 RETURNING ${COLUMNS}`, [projectId, JSON.stringify(clean)]);
      if (!rows[0]) throw new Error(`No Project ${projectId}.`);
      return toProject(rows[0]);
    },

    async setArt(projectId, { artDirectionPath, artFolder }) {
      const cleanPath = (value: string) => {
        try {
          return repositoryPath(value);
        } catch (e: any) {
          throw new InvalidInputError(e.message);
        }
      };
      const { rows } = await pool.query(`UPDATE projects SET art_direction_path = $2, art_folder = $3 WHERE id = $1 RETURNING ${COLUMNS}`, [
        projectId,
        cleanPath(artDirectionPath),
        cleanPath(artFolder),
      ]);
      if (!rows[0]) throw new Error(`No Project ${projectId}.`);
      return toProject(rows[0]);
    },

    async artInfo(projectId) {
      const { rows } = await pool.query(`SELECT ${COLUMNS} FROM projects WHERE id = $1`, [projectId]);
      if (!rows[0]) throw new Error(`No Project ${projectId}.`);
      const project = toProject(rows[0]);
      const branch = await freshDefaultBranch(projectId, project.localPath);
      const files = await listInBranch(project.localPath, branch);
      const images = files.filter((f) => f.endsWith(".png"));
      const text = await readInBranch(project.localPath, branch, project.artDirectionPath);
      if (text === null) return { present: false, defaultSize: null, references: [], images };
      return { present: true, defaultSize: parseDefaultSize(text), references: parseReferences(text).filter((p) => images.includes(p)), images };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    async startRun({ projectId, trackerRef, workflow = "developer", ...input }) {
      const flow = workflows.get(workflow);
      if (!flow) throw new Error(`Unknown Workflow "${workflow}".`);
      const { rows: found } = await pool.query(`SELECT ${COLUMNS} FROM projects WHERE id = $1`, [projectId]);
      if (!found[0]) throw new Error(`No Project ${projectId}.`);
      const project = toProject(found[0]);
      const plan = flow.plan(input);
      // Refused now, not after a Quota-costly generation. What is checked is what the Run will start from: the default
      // branch as it is on the remote now, fetched once and only when a check asks.
      let fresh: Promise<string> | undefined;
      await plan.check?.({
        project,
        exists: async (path) => existsInBranch(project.localPath, await (fresh ??= freshDefaultBranch(projectId, project.localPath)), path),
      });
      const client = await pool.connect();
      let runId: number;
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(
          `INSERT INTO runs (project_id, workflow, title, task, tracker_ref, state)
           VALUES ($1, $2, $3, $4, $5, 'queued') RETURNING id`,
          [projectId, workflow, plan.title, plan.task, trackerRef?.trim() || null],
        );
        runId = Number(rows[0].id);
        await plan.store?.(client, runId, project);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      changed(runId);
      await promote(projectId);
      const { rows: current } = await pool.query(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = $1`, [runId]);
      return toRun(current[0]);
    },

    async setMaxConcurrentRuns(projectId, max) {
      if (!Number.isInteger(max) || max < 1) throw new Error("Max concurrent Runs must be a whole number of at least 1.");
      const { rows } = await pool.query(`UPDATE projects SET max_concurrent_runs = $2 WHERE id = $1 RETURNING ${COLUMNS}`, [projectId, max]);
      if (!rows[0]) throw new Error(`No Project ${projectId}.`);
      await promote(projectId);
      return toProject(rows[0]);
    },

    async getRun(id) {
      const { rows } = await pool.query(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = $1`, [id]);
      if (!rows[0]) throw new Error(`No Run ${id}.`);
      const attempts = await pool.query("SELECT * FROM step_attempts WHERE run_id = $1 ORDER BY id", [id]);
      const checks = await pool.query("SELECT * FROM check_results WHERE run_id = $1 ORDER BY id", [id]);
      const gates = await pool.query("SELECT * FROM gates WHERE run_id = $1 ORDER BY id", [id]);
      const parts = await Promise.all(extensions.map((e) => e.detail(id, gates.rows.map((g) => Number(g.id)))));
      const assets = parts.flatMap((p) => p.assets);
      const verdictsOf = (gateId: number) => parts.flatMap((p) => p.gates.get(gateId)?.verdicts ?? []);
      // Each rejected Gate started the Iteration after its own. When it holds no Feedback of its own, its kind's is used.
      const iterations: Iteration[] = [{ number: 1, feedback: null }];
      for (const g of gates.rows.filter((g) => g.decision === "reject")) {
        iterations.push({ number: g.iteration + 1, feedback: g.feedback ?? parts.map((p) => p.gates.get(Number(g.id))?.feedback ?? null).find(Boolean) ?? null });
      }
      return {
        ...toRun(rows[0]),
        assets,
        iterations,
        attempts: attempts.rows.map(toAttempt),
        checks: checks.rows.map(toCheck),
        gates: gates.rows.map((g) => ({ ...gateOf(g), verdicts: verdictsOf(Number(g.id)) })),
      };
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
      return rows.map((r) => ({ ...gateOf(r), runTitle: r.run_title, projectName: r.project_name }));
    },

    async listApprovedRuns() {
      const { rows } = await pool.query(
        `SELECT ${RUN_COLUMNS_OF_R}, p.name AS project_name
         FROM runs r JOIN projects p ON p.id = r.project_id
         WHERE r.state = 'approved' ORDER BY r.id`,
      );
      return rows.map((r) => ({ ...toRun(r), projectName: r.project_name }));
    },

    async decideGate({ gateId, action, feedback, verdicts }) {
      const { rows } = await pool.query("SELECT * FROM gates WHERE id = $1", [gateId]);
      if (!rows[0]) throw new GateError(`No Gate ${gateId}.`);
      const gate = gateOf(rows[0]);
      if (gate.decidedAt) throw new GateError(`Gate ${gateId} is already decided.`);
      const kind = gateKinds.get(gate.kind)!;
      if (!kind.actions.includes(action)) throw new GateError(refusal(kind, action));
      // The kind validates the decision and says where the Run goes; the core carries it out.
      const outcome = await kind.decide(gate, { action, feedback, verdicts });
      if (outcome.next === "continue") return decideAndContinue(gate, outcome);
      if (outcome.next === "abandon") {
        try {
          return await abandon(gate.runId);
        } catch (e) {
          if (e instanceof RunStateError) throw new GateError(e.message);
          throw e;
        }
      }
      const client = await pool.connect();
      let projectId: number;
      try {
        await client.query("BEGIN");
        // The Run row first, as in `settle`, so that approving while the human abandons cannot deadlock; guarded on the Run
        // still waiting and the Gate undecided, so two decisions racing for the same Gate cannot both win.
        const moved = await client.query(
          "UPDATE runs SET state = 'approved', updated_at = now() WHERE id = $1 AND state = 'waiting' RETURNING project_id",
          [gate.runId],
        );
        const decided = moved.rowCount
          ? await client.query("UPDATE gates SET decided_at = now(), decision = 'approve' WHERE id = $1 AND decided_at IS NULL RETURNING run_id", [gateId])
          : null;
        if (!decided?.rowCount) {
          await client.query("ROLLBACK");
          throw new GateError(`Gate ${gateId} is already decided.`);
        }
        await client.query("COMMIT");
        projectId = Number(moved.rows[0].project_id);
      } catch (e) {
        if (!(e instanceof GateError)) await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      changed(gate.runId);
      // Approved: the pull request waits for the human's merge, so the slot is free for the next Queued Run.
      await promote(projectId);
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

    async resumePausedRuns() {
      const { rows } = await pool.query(
        `UPDATE runs SET state = 'running', resume_at = NULL, updated_at = now()
         WHERE state = 'paused' AND resume_at <= $1 RETURNING ${RUN_COLUMNS}`,
        [now()],
      );
      for (const run of rows.map(toRun).sort((a, b) => a.id - b.id)) {
        changed(run.id);
        await restart(run);
      }
    },

    async recoverAfterRestart() {
      // Nothing can be running yet, so any attempt still marked Running was cut short by the restart.
      const interrupted = await pool.query(
        `UPDATE step_attempts SET status = 'failed', ended_at = now(), error = 'Interrupted by a restart of Forgequor.'
         WHERE status = 'running' RETURNING run_id`,
      );
      for (const r of interrupted.rows) changed(Number(r.run_id));
      const { rows } = await pool.query(`SELECT ${RUN_COLUMNS} FROM runs WHERE state = 'running' ORDER BY id`);
      for (const run of rows.map(toRun)) await restart(run);
      const { rows: queued } = await pool.query("SELECT DISTINCT project_id FROM runs WHERE state = 'queued'");
      for (const r of queued) await promote(Number(r.project_id));
      await forge.checkPullRequests();
    },

    async assetImage(runId, assetId, which) {
      // Each extension answers for what it holds; the first that has the file serves it.
      for (const e of extensions) {
        try {
          return await e.assetImage(runId, assetId, which);
        } catch (err) {
          if (!(err instanceof AssetNotFoundError)) throw err;
        }
      }
      throw new AssetNotFoundError(`No such Asset ${assetId} in Run ${runId}, or it has no image yet.`);
    },

    async whenIdle() {
      while (inFlight.size) await Promise.all([...inFlight]);
    },
  };
  return forge;
}
