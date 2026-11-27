import { existsSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import type { Runner } from "../runner/runner.js";
import { developerWorkflow } from "./developer.js";
import {
  assetsWorkflow,
  assetTargetPath,
  AssetNotFoundError,
  checkAgainstRepository,
  replacedCopyPath,
  checkVerdicts,
  loadAssets,
  loadGateVerdicts,
  recordVerdicts,
  repositoryPath,
  servableAssetFile,
  VerdictError,
  type Asset,
  type AssetRequest,
  type GateVerdict,
  type Verdict,
} from "./assets.js";
import type { AgentSeat, Workflow } from "./workflow.js";
import type { CodeHost } from "../codehost/codehost.js";
import { parseDefaultSize, parseReferences } from "./art-direction.js";
import { createRunWorktree, existsInBranch, inspectRepository, listInBranch, readInBranch, RegistrationError, refreshDefaultBranch, slugify } from "./workspace.js";

export { RegistrationError, AssetNotFoundError };
export type { Asset, AssetRequest, GateVerdict, Verdict };

/** A Gate decision that cannot be made: unknown Gate, already decided, or a choice it does not offer. */
export class GateError extends Error {}

/** An operation the Run's current state does not allow, such as abandoning a Run that is already over. */
export class RunStateError extends Error {}

/** Something the human gave is no good (an empty Feedback, a path outside the repository). */
export class InvalidInputError extends Error {}

/** No such Run. */
export class RunNotFoundError extends Error {}

export type RunState = "queued" | "running" | "waiting" | "paused" | "approved" | "merged" | "closed" | "abandoned";
export type GateKind = "final" | "escalation" | "asset";
/** `judge` is the verdicts of an Asset Gate: its decision is recorded as approve when every Asset was approved, reject when any was not. */
/** What a Gate records as decided. */
export type GateDecision = "approve" | "reject" | "abandon";
export type GateAction = "approve" | "reject" | "abandon" | "judge";

export interface Run {
  id: number;
  projectId: number;
  /** Name of the Workflow the Run follows. */
  workflow: string;
  /** The Run's current Iteration, from 1; each rejection of the final Gate with Feedback starts the next. */
  iteration: number;
  title: string;
  task: string;
  trackerRef: string | null;
  state: RunState;
  branch: string | null;
  worktreePath: string | null;
  prNumber: number | null;
  prUrl: string | null;
  /** When a Paused Run restarts its current Step (the Runner's Quota reset time); null otherwise. */
  resumeAt: Date | null;
  createdAt: Date;
}

export interface StepAttempt {
  id: number;
  iteration: number;
  step: string;
  attempt: number;
  runner: string;
  model: string | null;
  /** The Asset an Artist attempt worked on. */
  assetId: number | null;
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
  iteration: number;
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
  /** What the human can do here. A final Gate may be approved or rejected with Feedback; an Asset Gate approved; an Escalation can only be abandoned. */
  actions: GateAction[];
  /** The human's written reason, when the Gate was rejected. */
  feedback: string | null;
  /** The verdict on each Asset, once an Asset Gate was judged. */
  verdicts: GateVerdict[];
  openedAt: Date;
  decidedAt: Date | null;
  /** What was decided: approve or reject (an Asset Gate judged by verdicts is approve when all were approved), or abandon. */
  decision: GateDecision | null;
}

/** One pass through the produce → review loop; the Feedback is what started it (null for the first). */
export interface Iteration {
  number: number;
  feedback: string | null;
}

export interface RunDetail extends Run {
  /** The Asset Requests of an `assets` Run and where each stands; empty for other Workflows. */
  assets: Asset[];
  iterations: Iteration[];
  attempts: StepAttempt[];
  checks: CheckResult[];
  gates: Gate[];
}

/** The Art Direction facts of a Project and the images a Run form can offer as references. */
export interface ArtInfo {
  present: boolean;
  defaultSize: { width: number; height: number } | null;
  references: string[];
  images: string[];
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
  /** Commands run in a Run's new worktree, in order, before the Developer. */
  setup: string[];
  maxConcurrentRuns: number;
  /** The Art Direction document, relative to the repository. */
  artDirectionPath: string;
  /** Where an `assets` Run commits its Assets, relative to the repository. */
  artFolder: string;
}

/** What a subscriber hears about live: a Step's progress, or that a Run changed (state, Steps, Checks, Gates, pull request). */
export type RunUpdate =
  | { type: "progress"; runId: number; attemptId: number; kind: "text" | "tool" | "other"; summary: string }
  | { type: "changed"; runId: number };

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
  startRun(input: { projectId: number; task?: string; title?: string; trackerRef?: string; workflow?: string; assets?: AssetRequest[] }): Promise<Run>;
  getRun(id: number): Promise<RunDetail>;
  listRuns(filter?: { projectId?: number; state?: RunState }): Promise<Run[]>;
  /** Every Gate still waiting for the human, across all Projects. */
  listOpenGates(): Promise<OpenGate[]>;
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

/** The Workflows a Run can follow, by name. */
const workflows = new Map<string, Workflow>([developerWorkflow, assetsWorkflow].map((w) => [w.name, w]));

/** States a Run cannot leave. A Run in one of them no longer holds its Project's slot. */
const OVER: RunState[] = ["merged", "closed", "abandoned"];
const ACTIVE: RunState[] = ["queued", "running", "waiting", "paused", "approved"];
/** States that hold one of their Project's slots. A Queued Run does not. */
const HOLDING_A_SLOT: RunState[] = ["running", "waiting", "paused", "approved"];

/** What the human can do at each kind of Gate. */
const GATE_ACTIONS: Record<GateKind, GateAction[]> = {
  final: ["approve", "reject", "abandon"],
  asset: ["judge", "abandon"],
  escalation: ["abandon"],
};
const GATE_NAMES: Record<GateKind, string> = { final: "A final Gate", asset: "An Asset Gate", escalation: "An Escalation" };

/** Why a Gate does not offer `action`. */
function refusal(kind: GateKind, action: GateAction): string {
  const past: Record<GateAction, string> = { approve: "approved", reject: "rejected", abandon: "abandoned", judge: "judged" };
  return `${GATE_NAMES[kind]} cannot be ${past[action]}; it can only be ${GATE_ACTIONS[kind].map((a) => past[a]).join(" or ")}.`;
}

function toGate(r: Record<string, any>): Gate {
  return {
    id: Number(r.id),
    runId: Number(r.run_id),
    kind: r.kind,
    reason: r.reason,
    evidence: r.evidence,
    actions: GATE_ACTIONS[r.kind as GateKind],
    feedback: r.feedback,
    verdicts: [],
    openedAt: r.opened_at,
    decidedAt: r.decided_at,
    decision: r.decision,
  };
}

const RUN_COLUMNS = "id, project_id, workflow, iteration, title, task, tracker_ref, state, branch, worktree_path, pr_number, pr_url, resume_at, created_at";

export function createForge(deps: ForgeDeps): Forge {
  const { pool } = deps;
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
      `WITH r AS (UPDATE runs SET state = 'waiting', updated_at = now() WHERE id = $1 AND state = 'running' RETURNING id)
       INSERT INTO gates (run_id, kind, reason, evidence) SELECT id, $2, $3, $4 FROM r`,
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
    decision: { action: "approve" | "reject"; feedback?: string; nextIteration: boolean; record?: (client: pg.PoolClient) => Promise<void> },
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
            [gate.id, decision.action, decision.feedback ?? null],
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

  /** The Run's work is done and its pull request is open: Approved, unless it was abandoned meanwhile. */
  async function approveRun(runId: number) {
    await pool.query("UPDATE runs SET state = 'approved', updated_at = now() WHERE id = $1 AND state = 'running'", [runId]);
    changed(runId);
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
      await workflow.run({
        run,
        project,
        branch,
        worktreePath,
        defaultBranch,
        stop,
        pool,
        agents,
        codeHost: deps.codeHost,
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

    async startRun({ projectId, task, title, trackerRef, workflow = "developer", assets }) {
      const flow = workflows.get(workflow);
      if (!flow) throw new Error(`Unknown Workflow "${workflow}".`);
      const { rows: found } = await pool.query(`SELECT art_folder, local_path, default_branch FROM projects WHERE id = $1`, [projectId]);
      if (!found[0]) throw new Error(`No Project ${projectId}.`);
      const plan = flow.plan({ task, title, assets });
      // What is checked below is what the Run will start from: the default branch as it is on the remote now.
      const branch = plan.assets.length ? await freshDefaultBranch(projectId, found[0].local_path) : found[0].default_branch;
      // Refused now, not after a Quota-costly generation: what the Asset Requests would overwrite or lean on must be right.
      await checkAgainstRepository(plan.assets, found[0].art_folder, (path) => existsInBranch(found[0].local_path, branch, path));
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
        for (const [position, a] of plan.assets.entries()) {
          await client.query(
            `INSERT INTO assets (run_id, position, name, kind, description, width, height, fill, frames, style_references, replace, target_path)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [runId, position, a.name, a.kind, a.description, a.width, a.height, a.fill === true, a.frames ?? 1, JSON.stringify(a.references ?? []), a.replace === true, assetTargetPath(found[0].art_folder, a.kind, a.name)],
          );
        }
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
      const iterations: Iteration[] = [{ number: 1, feedback: null }];
      for (const g of gates.rows.filter((g) => g.decision === "reject")) iterations.push({ number: iterations.length + 1, feedback: g.feedback });
      const verdicts = await loadGateVerdicts(pool, gates.rows.map((g) => Number(g.id)));
      return {
        ...toRun(rows[0]),
        assets: await loadAssets(pool, id),
        iterations,
        attempts: attempts.rows.map(toAttempt),
        checks: checks.rows.map(toCheck),
        gates: gates.rows.map((g) => ({ ...toGate(g), verdicts: verdicts.get(Number(g.id)) ?? [] })),
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
      return rows.map((r) => ({ ...toGate(r), runTitle: r.run_title, projectName: r.project_name }));
    },

    async decideGate({ gateId, action, feedback, verdicts }) {
      const { rows } = await pool.query("SELECT * FROM gates WHERE id = $1", [gateId]);
      if (!rows[0]) throw new GateError(`No Gate ${gateId}.`);
      const gate = toGate(rows[0]);
      if (gate.decidedAt) throw new GateError(`Gate ${gateId} is already decided.`);
      if (!gate.actions.includes(action)) throw new GateError(refusal(gate.kind, action));
      if (action === "reject") {
        const reason = feedback?.trim();
        if (!reason) throw new InvalidInputError("Rejecting a Gate needs a Feedback saying what to change.");
        return decideAndContinue(gate, { action: "reject", feedback: reason, nextIteration: true });
      }
      if (action === "judge") {
        let given: Verdict[];
        try {
          given = await checkVerdicts(pool, gate.runId, verdicts);
        } catch (e) {
          throw e instanceof VerdictError ? new InvalidInputError(e.message) : e;
        }
        // The Asset Gate is not the end of its Run: approved Assets are still to be committed and sent as a pull request.
        const rejected = given.some((v) => v.action === "reject");
        return decideAndContinue(gate, {
          action: rejected ? "reject" : "approve",
          nextIteration: rejected,
          record: (client) => recordVerdicts(client, gate.id, given),
        });
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
        // The Run row first, as in `settle`, so that approving while the human abandons cannot deadlock; guarded on the Run
        // still waiting and the Gate undecided, so two decisions racing for the same Gate cannot both win.
        const moved = await client.query("UPDATE runs SET state = 'approved', updated_at = now() WHERE id = $1 AND state = 'waiting'", [gate.runId]);
        const decided = moved.rowCount
          ? await client.query("UPDATE gates SET decided_at = now(), decision = $2 WHERE id = $1 AND decided_at IS NULL RETURNING run_id", [gateId, action])
          : null;
        if (!decided?.rowCount) {
          await client.query("ROLLBACK");
          throw new GateError(`Gate ${gateId} is already decided.`);
        }
        await client.query("COMMIT");
      } catch (e) {
        if (!(e instanceof GateError)) await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      changed(gate.runId);
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
      const versionId = which === "replaced" ? undefined : which;
      const { rows } = which === "replaced"
        ? await pool.query(
            "SELECT $3::text AS path, r.worktree_path FROM assets a JOIN runs r ON r.id = a.run_id WHERE a.id = $1 AND a.run_id = $2 AND a.replace",
            [assetId, runId, replacedCopyPath(assetId)],
          )
        : versionId === undefined
        ? await pool.query(
            "SELECT a.target_path AS path, r.worktree_path FROM assets a JOIN runs r ON r.id = a.run_id WHERE a.id = $1 AND a.run_id = $2",
            [assetId, runId],
          )
        : await pool.query(
            `SELECT v.image_path AS path, r.worktree_path FROM asset_versions v JOIN assets a ON a.id = v.asset_id JOIN runs r ON r.id = a.run_id
             WHERE v.id = $3 AND a.id = $1 AND a.run_id = $2`,
            [assetId, runId, versionId],
          );
      const file = rows[0]?.path && rows[0].worktree_path && servableAssetFile(rows[0].worktree_path, rows[0].path);
      if (!file) throw new AssetNotFoundError(`No such Asset ${assetId} in Run ${runId}, or it has no image yet.`);
      return file;
    },

    async whenIdle() {
      while (inFlight.size) await Promise.all([...inFlight]);
    },
  };
  return forge;
}
