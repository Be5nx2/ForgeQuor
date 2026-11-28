import { existsSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import type { Runner } from "../runner/runner.js";
import { bugfixAgent, bugfixWorkflow, developerAgent, developerWorkflow } from "./developer.js";
import { createDogfoodNotes } from "./dogfood.js";
import { createRunNotes, readRunNotes } from "./run-notes.js";
import { createConversationRecords } from "./conversation-records.js";
import { createConversationGate, conversationStepType, type ConversationAgent } from "./conversation.js";
import { featureWorkflow, grillerAgent } from "./feature.js";
import { architectAgent } from "./architect.js";
import { specGate, specWriterAgent } from "./spec.js";
import { runEngine, type StepTypeModule } from "./engine.js";
import { agentStepType, catalogueOf, checksStepType, gateStepType, publishStepType, type AgentModule } from "./step-types.js";
import { describeInvalid, resolveWorkflows, validateWorkflowText, type ResolvedWorkflow, type WorkflowKit } from "./project-workflows.js";
import { DEFAULT_REVIEW_MODE, REVIEW_MODES, type WorkflowDefinition, type WorkflowInput } from "./workflow-definition.js";
import { publishPullRequest } from "./publish.js";
import { realEvery, type Every } from "./clock.js";
import { silentNotifier, type Notifier } from "./notifier.js";
import { createQuotaKeeper } from "./quota.js";
import { createRunRecords, toReview } from "./run-records.js";
import { reviewStepType } from "./review.js";
import { buildSeats, type RunnerName, type SeatSettings } from "./seats.js";
import { createTeamStore, parseSeatOverrides, settingsOf, withOverrides, type Team, type TeamChange } from "./team.js";
import { builtInExtensions } from "./builtin.js";
import { AssetNotFoundError, DogfoodExportError, DogfoodNoteNotFoundError, DogfoodNoteTransitionError, GateError, InvalidInputError, InvalidSeatError, RunNotFoundError, RunStateError, SeatLockedError } from "./errors.js";
import type { Extension, InputProducer } from "./extension.js";
import { allows, escalationGate, finalGate, offered, refusal, reviewGate, type GateKindModule, type GateOutcome } from "./gates.js";
import { goBackChoices, redoFailedSteps, redoSteps, redoSet, type StepRow } from "./step-states.js";
import type { Publication, RunInput, Workflow, WorkflowContext } from "./workflow.js";
import type { CodeHost } from "../codehost/codehost.js";
import { parseDefaultSize, parseReferences } from "./art-direction.js";
import type {
  ApprovedRun,
  ArtInfo,
  CheckResult,
  DogfoodExport,
  DogfoodNote,
  DogfoodNoteFilter,
  DogfoodNoteInput,
  DogfoodNoteList,
  Gate,
  GateAction,
  GateKind,
  Iteration,
  OpenGate,
  Project,
  QuotaStatus,
  Run,
  RunDetail,
  RunNote,
  RunState,
  RunUpdate,
  ReviewMode,
  StepAttempt,
  StepState,
  Verdict,
  WorkflowList,
  WorkflowValidation,
} from "./types.js";
import { offeredSkillPacks, placeSkillPacks, SHARED_SKILL_PACK, SKILLS_ROOT } from "./skill-pack.js";
import { createRunWorktree, existsInBranch, inspectRepository, listInBranch, readInBranch, RegistrationError, refreshDefaultBranch, remoteHasBranch, removeRunWorktree, repositoryPath, runFoldersUnder, slugify } from "./workspace.js";

export type { SeatSettings };
export { RegistrationError, AssetNotFoundError, DogfoodExportError, DogfoodNoteNotFoundError, DogfoodNoteTransitionError, GateError, InvalidInputError, InvalidSeatError, RunNotFoundError, RunStateError, SeatLockedError };
export type * from "./types.js";

export interface Forge {
  /** Hears every RunUpdate from now on. Returns the function that stops it. A throwing listener never disturbs a Run. */
  subscribe(listener: (update: RunUpdate) => void): () => void;
  registerProject(input: { path: string }): Promise<Project>;
  listProjects(): Promise<Project[]>;
  /**
   * Deletes the Archived Runs of one Project, or of every Project when none is given, whatever their age, with everything that
   * belongs to them; active and finished-but-not-Archived Runs are never touched. Returns how many were deleted. The daily
   * purge is unchanged. Throws "No Project N." for an unknown Project.
   */
  purgeArchivedRuns(projectId?: number): Promise<number>;
  /** Replaces a Project's ordered Check commands (blank ones are dropped). Applies to Runs started afterwards. */
  setChecks(projectId: number, checks: string[]): Promise<Project>;
  /** Replaces a Project's ordered setup commands (blank ones are dropped). A failing one opens an Escalation and the Developer never starts. */
  setSetup(projectId: number, commands: string[]): Promise<Project>;
  /** Sets how many Runs of a Project may work at once (at least 1). Raising it starts Queued Runs that now fit. */
  setMaxConcurrentRuns(projectId: number, max: number): Promise<Project>;
  /** The Skill Packs a Project may pick (besides `shared`, always given). */
  offeredSkillPacks(): string[];
  /** Replaces the Skill Packs of a Project (stored in the order offered, which is the order placed). Applies to Runs started afterwards; throws an InvalidInputError for a pack that is not offered. */
  setSkillPacks(projectId: number, packs: string[]): Promise<Project>;
  /** Sets where a Project keeps its Art Direction document and its Assets (repository paths). Applies to Runs started afterwards; throws an InvalidInputError for a path outside the repository. */
  setArt(projectId: number, art: { artDirectionPath: string; artFolder: string }): Promise<Project>;
  /**
   * What the Run form needs to know about a Project's art, read from its default branch freshly fetched: whether the Art
   * Direction is there, its `Default size`, the reference images it names that exist, and every PNG of the repository.
   */
  artInfo(projectId: number): Promise<ArtInfo>;
  /**
   * The Workflows a Project can launch, for its Run form: the built-in ones and those of the Project's own
   * `forgequor/workflows/*.yaml`, read from its default branch freshly fetched. A Project Workflow named like a built-in
   * replaces it; an invalid one is listed with its errors. If the remote cannot be reached, only the built-in ones are
   * listed, with `problem` saying why.
   */
  listWorkflows(projectId: number): Promise<WorkflowList>;
  /**
   * Whether YAML text is a Workflow this Forgequor can launch, with every error found (empty when valid): the same
   * check as launch, stored nowhere. Given a Project, refuses one the Forge core does not know.
   */
  validateWorkflow(yaml: string, projectId?: number): Promise<WorkflowValidation>;
  /**
   * Creates a Run of the given Workflow (`developer` when omitted; an unknown name or an invalid Project Workflow is refused, the Project's Workflows being read from its freshly fetched default branch) and starts it in the background; follow it with `getRun`. A `developer` Run takes a task, an `assets` Run
   * its Asset Requests; the input is refused with an error saying what is wrong before anything starts. A Project already at its concurrent Runs
   * limit leaves the new Run Queued; it starts by itself, in creation order, when a slot frees up. `seats` overrides
   * seats for this Run only, checked like the Team page (an InvalidSeatError for an unknown seat or Runner, a
   * SeatLockedError for a field the environment holds); the Run freezes its effective seats when it first starts.
   */
  startRun(input: RunInput & { projectId: number; trackerRef?: string; workflow?: string; seats?: SeatSettings }): Promise<Run>;
  getRun(id: number): Promise<RunDetail>;
  /** One of an Archived Run's kept Run Notes, by its path; throws a RunNotFoundError when the Run has no such note. */
  getRunNote(runId: number, path: string): Promise<RunNote>;
  listRuns(filter?: { projectId?: number; state?: RunState }): Promise<Run[]>;
  /** Every Gate still waiting for the human, across all Projects. */
  listOpenGates(): Promise<OpenGate[]>;
  /** The merge list: every Approved Run of every Project, oldest first, until its pull request is merged or closed or the Run is abandoned. */
  listApprovedRuns(): Promise<ApprovedRun[]>;
  /**
   * The human's decision at an open Gate: approve (final Gate) moves the Run to Approved, abandon to Abandoned (the Run is then
   * Archived), reject (final Gate only, with a non-empty `feedback`) starts the Run's next Iteration. An Asset
   * Gate takes `judge` with a verdict for every Asset waiting for one, all at once: when all are approved the Run goes on
   * to its commit and pull request, otherwise the next Iteration redoes the rejected Assets only. Throws a GateError for an
   * unknown or already decided Gate or a choice it does not offer, and an InvalidInputError for a rejection without
   * Feedback or verdicts that do not fit the Assets waiting.
   */
  decideGate(input: { gateId: number; action: GateAction; feedback?: string; verdicts?: Verdict[]; target?: string; message?: string }): Promise<RunDetail>;
  /**
   * Abandons a Run in any state before Merged: closes its pull request if it has one, settles its open Gate, and archives it
   * (worktree and local branch removed, remote branch deleted). Throws a RunStateError when the Run is already over. A pull request merged on GitHub in
   * the meantime makes the Run Merged instead. If the pull request cannot be read or closed, the Run is left as it was.
   */
  abandonRun(runId: number): Promise<RunDetail>;
  /** One pass of merge and close detection: Approved Runs whose pull request was merged or closed on GitHub follow it. */
  checkPullRequests(): Promise<void>;
  /** One pass over Paused Runs: those whose reset time has passed restart their current Step. */
  resumePausedRuns(): Promise<void>;
  /**
   * Call once when Forgequor starts: first, every finished Run not yet archived is archived and the folders of Runs
   * already archived (or gone) are swept from the worktrees root; then every Running Run restarts its current Step, the Queued Runs that fit the free
   * slots start, and Approved Runs have their pull request checked again.
   */
  recoverAfterRestart(): Promise<void>;
  /**
   * The file of an Asset's current image, or of one of its past versions, as an absolute path: only what this Run recorded
   * for that Asset, only a PNG, only inside the Run's worktree. Throws an AssetNotFoundError otherwise; no path ever
   * comes from the caller.
   */
  assetImage(runId: number, assetId: number, which?: number | "replaced"): Promise<string>;
  /** Each vendor's latest Quota Reading with its age (a null reading for one never read), as the Quota bars show them. */
  quota(): Promise<QuotaStatus[]>;
  /**
   * Records a Dogfood Note: a remark about Forgequor itself, with the tab, the Run or Project in view (by name too, as written
   * now), source `internal` and status `new`. Throws InvalidInputError for a blank text, a nature or target out of the lists,
   * or an unknown Run or Project.
   */
  createDogfoodNote(input: DogfoodNoteInput): Promise<DogfoodNote>;
  /** The Dogfood Notes matching the filters (status, nature, target; each optional), newest first, with the count of `new` ones. InvalidInputError for an unknown filter value. */
  listDogfoodNotes(filter?: DogfoodNoteFilter): Promise<DogfoodNoteList>;
  /**
   * Moves a Dogfood Note to `triaged` (with an optional free-text reference), to `dismissed`, or back to `new` (which forgets
   * the reference). Only status and reference change. InvalidInputError for a bad status or a reference that does not fit;
   * DogfoodNoteTransitionError for a move not allowed (triaged to dismissed, or to the same status); DogfoodNoteNotFoundError.
   */
  setDogfoodNoteStatus(id: number, status: string, triageRef?: string | null): Promise<DogfoodNote>;
  /**
   * Writes the chosen Dogfood Notes as one Markdown Dogfood Export, `export_forgequor_<date>_<time>.md`, into the export
   * folder (created when missing) and returns its name, path and content for download. Changes no status. InvalidInputError
   * for an empty selection or a bad ID, DogfoodNoteNotFoundError for an unknown note, DogfoodExportError when the folder cannot be written.
   */
  exportDogfoodNotes(ids: number[]): Promise<DogfoodExport>;
  /** Each seat's effective Runner and model with where each comes from (environment, Team, default), and the model aliases on offer. */
  team(): Promise<Team>;
  /** Saves a seat's Runner and/or model (the Team page). Throws InvalidInputError for an unknown seat or Runner, SeatLockedError for a field the environment holds. */
  changeSeat(seat: string, change: TeamChange): Promise<Team>;
  /**
   * Call once when Forgequor starts: reads the Quota of the Runners that can be asked (Claude), then again every 5 minutes.
   * Every Step a Runner finishes also refreshes it, and each new reading is published to the subscribers. Returns the
   * function that stops the refreshing.
   */
  startQuotaReading(): Promise<() => void>;
  /**
   * Call once when Forgequor starts: deletes the Runs archived more than `archiveDays` days ago, with everything that
   * belongs to them (never a Run that is not Archived), now and then every 24 hours, logging how many it deleted.
   * Returns the function that stops it.
   */
  startPurging(): Promise<() => void>;
  /** Resolves once no Run is being worked on in the background. */
  whenIdle(): Promise<void>;
}

export interface ForgeDeps {
  pool: pg.Pool;
  /** The Claude Code Runner, which the seats of the Griller, Spec Writer, Architect, Developer, first Reviewer and Consolidator work through unless set otherwise. */
  runner: Runner;
  /** The Codex Runner, which the second Reviewer's and the Artist's seats work through unless set otherwise. Without one, a Step that needs a Codex seat opens an Escalation naming it. */
  artistRunner?: Runner;
  /**
   * What the human set per Agent seat (`FORGEQUOR_<SEAT>_RUNNER` and `FORGEQUOR_<SEAT>_MODEL`, see `seatSettingsFromEnv`):
   * which Runner (`claude` or `codex`) and which model. A seat with a Runner Forgequor cannot start opens an Escalation
   * naming it when a Step needs it, not at startup.
   */
  seats?: SeatSettings;
  codeHost: CodeHost;
  /** Folder under which each Run's worktree is created, outside the Projects' checkouts. */
  worktreesRoot: string;
  /** Model of the `developer` seat; the setting in `seats` wins. The Runner's default when omitted. */
  developerModel?: string;
  /** Model of the `artist` seat; the setting in `seats` wins. The Runner's default when omitted. */
  artistModel?: string;
  /** A Step running longer than this is killed and escalated. Default: 60 minutes. */
  stepTimeoutMs?: number;
  /** A Check command running longer than this is killed, which fails the Check. Default: 10 minutes. */
  checkTimeoutMs?: number;
  /** The Step types, Gate kinds and Workflows built on the core besides the Developer's. Default: the built-in ones (Assets). */
  extensions?: Extension[];
  /** Folder of the Skill Pack placed in every Run's worktree. Default: Forgequor's own `skills/shared`. */
  skillPack?: string;
  /** How many days an Archived Run is kept before the purge deletes it. Default: 60. */
  archiveDays?: number;
  /** Folder where Dogfood Exports are written. Default: `docs/dogfood/` of the Forgequor checkout. */
  dogfoodExportFolder?: string;
  /** Folder whose subfolders are the Skill Packs a Project may pick. Default: Forgequor's own `skills/`. */
  skillsRoot?: string;
  /** The clock, so tests can move time. */
  now?: () => Date;
  /** The timer, so tests can move time: runs a task every so many milliseconds. Default: the real one. */
  every?: Every;
  /** Tells the human a Run needs them (Gate, Escalation, Quota Pause) or ended outside Forgequor. Default: a silent one. */
  notifier?: Notifier;
}

const COLUMNS =
  "id, name, local_path, remote_owner, remote_name, default_branch, checks, setup, max_concurrent_runs, art_direction_path, art_folder, skill_packs, " +
  "(SELECT count(*) FROM runs WHERE runs.project_id = projects.id AND runs.archived_at IS NOT NULL) AS archived_runs";

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
    skillPacks: r.skill_packs,
    archivedRuns: Number(r.archived_runs),
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
    review: r.review_mode,
    state: r.state,
    branch: r.branch,
    worktreePath: r.worktree_path,
    prNumber: r.pr_number,
    prUrl: r.pr_url,
    resumeAt: r.resume_at,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  };
}

function toAttempt(r: Record<string, any>): StepAttempt {
  return {
    id: Number(r.id),
    iteration: r.iteration,
    step: r.step,
    stepId: r.step_id,
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

/** How long abandoning waits for a Run's work to stop before removing its worktree anyway. */
const ARCHIVE_WAIT_MS = 2000;
/** States a Run cannot leave. A Run in one of them no longer holds its Project's slot. */
const DAY_MS = 24 * 60 * 60 * 1000;
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
    stepId: r.step,
    kind: r.kind,
    reason: r.reason,
    evidence: r.evidence,
    actions,
    feedback: r.feedback,
    verdicts: [],
    redo: null,
    openedAt: r.opened_at,
    decidedAt: r.decided_at,
    decision: r.decision,
  };
}

const RUN_COLUMNS = "id, project_id, workflow, iteration, title, task, tracker_ref, review_mode, state, branch, worktree_path, pr_number, pr_url, resume_at, created_at, archived_at";
/** The same columns, read through the alias `r` in a query that joins another table. */
const RUN_COLUMNS_OF_R = RUN_COLUMNS.split(", ").map((c) => `r.${c}`).join(", ");

/**
 * How a new Run is reviewed: the mode the human chose, else the Workflow's own default; null for a Workflow that does not
 * take the `review` input. Refuses a mode that does not exist, or one given to a Workflow that has no review.
 */
function reviewModeOf(flow: Workflow, chosen: string | undefined): ReviewMode | null {
  if (!flow.definition.inputs.includes("review")) {
    if (chosen !== undefined) throw new InvalidInputError(`The ${flow.name} Workflow has no review to choose a mode for.`);
    return null;
  }
  if (chosen === undefined || chosen === "") return flow.definition.review ?? DEFAULT_REVIEW_MODE;
  if (!REVIEW_MODES.includes(chosen as ReviewMode)) throw new InvalidInputError(`The review is ${REVIEW_MODES.join(" or ")}, not "${chosen}".`);
  return chosen as ReviewMode;
}

/** Where Dogfood Exports go unless told otherwise: `docs/dogfood/` of the Forgequor checkout. */
const DEFAULT_DOGFOOD_EXPORT_FOLDER = join(dirname(SKILLS_ROOT), "docs", "dogfood");

export function createForge(deps: ForgeDeps): Forge {
  const { pool } = deps;
  const skillsRoot = deps.skillsRoot ?? SKILLS_ROOT;
  /** The Workflows a Run can follow, by name. */
  const extensions = deps.extensions ?? builtInExtensions(pool);
  const runNotes = createRunNotes(pool);
  const dogfood = createDogfoodNotes(pool, { exportFolder: deps.dogfoodExportFolder ?? DEFAULT_DOGFOOD_EXPORT_FOLDER, now: deps.now });
  const workflows = new Map<string, Workflow>([developerWorkflow, bugfixWorkflow, featureWorkflow, ...extensions.flatMap((e) => e.workflows)].map((w) => [w.name, w]));
  /** How each built-in Workflow's pull request is made, when it is not the default. */
  const publications = new Map<string, Publication>([...workflows.values()].flatMap((w) => (w.publication ? [[w.name, w.publication] as const] : [])));
  /**
   * The Run's pull request rules: its Workflow's when the Run follows the built-in Workflow of its name, else (a Project
   * Workflow) those of the built-in Workflow that takes the same launch inputs.
   */
  async function publicationOf(run: Run): Promise<Publication | undefined> {
    const { rows } = await pool.query("SELECT definition FROM runs WHERE id = $1", [run.id]);
    const frozen: WorkflowDefinition | null = rows[0]?.definition ?? null;
    const own = workflows.get(run.workflow);
    if (!frozen || (own && isDeepStrictEqual(frozen, own.definition))) return publications.get(run.workflow);
    return [...workflows.values()].find((w) => w.inputs.length === frozen.inputs.length && frozen.inputs.every((i) => w.inputs.includes(i)))?.publication;
  }
  /** The Gate kinds, by kind: each decides its own Gates. */
  const gateKinds = new Map<GateKind, GateKindModule>([finalGate, escalationGate, reviewGate, specGate, createConversationGate(pool), ...extensions.flatMap((e) => e.gateKinds)].map((k) => [k.kind, k]));
  const gateOf = async (r: Record<string, any>): Promise<Gate> => {
    const kind = gateKinds.get(r.kind);
    const gate = toGate(r, kind?.actions ?? []);
    return kind ? { ...gate, actions: await offered(kind, gate) } : gate;
  };
  /** The Agents a Workflow's Agent Step can name. */
  const agentModules = new Map<string, AgentModule>([developerAgent, bugfixAgent, specWriterAgent, architectAgent, ...extensions.flatMap((e) => e.agents ?? [])].map((a) => [a.name, a]));
  /** The Agents a conversation Step can name. */
  const conversationAgents = new Map<string, ConversationAgent>([grillerAgent].map((a) => [a.name, a]));
  /** How each input an Agent produces is read and validated. */
  const inputProducers = new Map<WorkflowInput, InputProducer>(extensions.flatMap((e) => Object.entries(e.inputProducers ?? {}) as [WorkflowInput, InputProducer][]));
  /** What the engine runs, by Step type. */
  const stepTypes = new Map<StepTypeModule["type"], StepTypeModule>(
    [agentStepType(agentModules), checksStepType, publishStepType(publicationOf), gateStepType(gateKinds), reviewStepType, conversationStepType(conversationAgents, inputProducers), ...extensions.flatMap((e) => e.stepTypes ?? [])].map((t) => [t.type, t]),
  );
  /** Each Agent seat's Runner and model: its setting, else its default (Claude Code for most, Codex for the second Reviewer and the Artist). */
  const now = deps.now ?? (() => new Date());
  const quotas = createQuotaKeeper({ pool, now, every: deps.every ?? realEvery, emit: (u) => emit(u) });
  const runners: Partial<Record<RunnerName, Runner>> = { claude: quotas.watch("claude", deps.runner), codex: deps.artistRunner && quotas.watch("codex", deps.artistRunner) };
  const envSettings: SeatSettings = { ...deps.seats };
  for (const [seat, model] of [["developer", deps.developerModel], ["artist", deps.artistModel]] as const) {
    if (model && !envSettings[seat]?.model) envSettings[seat] = { ...envSettings[seat], model };
  }
  const teamStore = createTeamStore(pool, envSettings);
  /**
   * The seats a Run works through: its frozen ones, else (its first start) the Team's as they are now with the Run's
   * overrides laid over them, frozen from then on. So a Team change applies to the next Runs without a restart, and not
   * to a Run in progress or restarted.
   */
  async function seatsOfRun(runId: number) {
    const { rows } = await pool.query("SELECT seats, seat_overrides FROM runs WHERE id = $1", [runId]);
    let frozen: SeatSettings | null = rows[0]?.seats ?? null;
    if (!frozen) {
      const settings = withOverrides(settingsOf(await teamStore.effective()), (rows[0]?.seat_overrides as SeatSettings | null) ?? {});
      // Several starts at once keep the first freeze.
      const { rows: kept } = await pool.query("UPDATE runs SET seats = COALESCE(seats, $2) WHERE id = $1 RETURNING seats", [runId, JSON.stringify(settings)]);
      frozen = kept[0]?.seats ?? settings;
    }
    return buildSeats(runners, frozen ?? {});
  }
  const stepTimeoutMs = deps.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const inFlight = new Set<Promise<void>>();
  /** What each Run is being worked on by right now, so that archiving waits for it to let go. */
  const working = new Map<number, Promise<void>>();
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
  const notifier = deps.notifier ?? silentNotifier;
  /** Notifies the human of what happened to a Run, naming it. Fire-and-forget: a failing Notifier never changes a Run. */
  async function notifyRun(runId: number, what: string) {
    try {
      const { rows } = await pool.query("SELECT title FROM runs WHERE id = $1", [runId]);
      if (!rows[0]) return;
      await notifier.notify("Forgequor", `Run #${runId} "${rows[0].title}": ${what}`);
    } catch (e: any) {
      console.error(`Run ${runId}: could not notify:`, e?.message ?? e);
    }
  }
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
  async function openGate(runId: number, kind: GateKind, reason: string, evidence?: string, step?: string) {
    const opened = await pool.query(
      `WITH r AS (UPDATE runs SET state = 'waiting', updated_at = now() WHERE id = $1 AND state = 'running' RETURNING id, iteration)
       INSERT INTO gates (run_id, iteration, kind, reason, evidence, step) SELECT id, iteration, $2, $3, $4, $5 FROM r`,
      [runId, kind, reason, evidence ?? null, step ?? null],
    );
    changed(runId);
    if (opened.rowCount) await notifyRun(runId, kind === "escalation" ? `Escalation: ${reason}` : `${kind} Gate open`);
  }

  /** False once the human abandoned the Run while it was being worked on. */
  async function stillRunning(runId: number): Promise<boolean> {
    const { rows } = await pool.query("SELECT state FROM runs WHERE id = $1", [runId]);
    return rows[0]?.state === "running";
  }

  /** Starts `run` in the background. */
  function launch(run: Run, project: Project) {
    const work = execute(run, project).finally(() => {
      inFlight.delete(work);
      if (working.get(run.id) === work) working.delete(run.id);
    });
    inFlight.add(work);
    working.set(run.id, work);
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
        // What was running (a Step at work, a Gate waiting) did not finish.
        await client.query("UPDATE step_states SET status = 'failed' WHERE run_id = $1 AND status = 'running'", [runId]);
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
   * Archives a Run that is over: removes its worktree and local branch, deletes its remote branch when it was abandoned or
   * its pull request closed unmerged, and records when. Every target already gone counts as done; a step that fails is
   * logged and the others still run, and the Run is archived anyway (what is left is a stray folder or branch).
   * Does nothing for a Run that is not over or already archived. Never throws.
   */
  async function archive(runId: number): Promise<void> {
    try {
      const { rows } = await pool.query(
        `SELECT r.state, r.branch, r.worktree_path, r.pr_number, r.archived_at, p.local_path, p.remote_owner, p.remote_name
         FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.id = $1`,
        [runId],
      );
      const row = rows[0];
      if (!row || !OVER.includes(row.state) || row.archived_at) return;
      const log = (what: string, e: unknown) => console.error(`Run ${runId}: could not archive (${what}):`, (e as Error)?.message ?? e);
      // Only a folder Forgequor made for this Run is ever deleted.
      const worktreePath: string | null = row.worktree_path && basename(row.worktree_path) === `run-${runId}` ? row.worktree_path : null;
      if (row.worktree_path && !worktreePath) log("worktree", new Error(`${row.worktree_path} is not a Run folder, left alone`));
      if (worktreePath) {
        try {
          // The worktree is the only place most Run Notes live, so they are copied before it goes.
          const { notes, skipped } = await readRunNotes(worktreePath);
          await runNotes.keep(runId, notes);
          if (skipped.length) console.warn(`Run ${runId}: Run Notes not kept: ${skipped.join(", ")}.`);
        } catch (e) {
          log("Run Notes", e);
        }
      }
      try {
        for (const problem of await removeRunWorktree({ repoRoot: row.local_path, worktreePath, branch: row.branch })) log("local files", new Error(problem));
      } catch (e) {
        log("local files", e);
      }
      if (row.branch && row.state !== "merged") {
        try {
          // Forgequor pushed the branch when it opened a pull request; before that, only the remote can say.
          if (row.pr_number || (await remoteHasBranch(row.local_path, row.branch))) {
            await deps.codeHost.deleteBranch({ owner: row.remote_owner, repo: row.remote_name, branch: row.branch });
          }
        } catch (e) {
          log("remote branch", e);
        }
      }
      await pool.query("UPDATE runs SET archived_at = $2 WHERE id = $1 AND archived_at IS NULL", [runId, now()]);
      changed(runId);
    } catch (e) {
      console.error(`Run ${runId}: could not archive:`, (e as Error)?.message ?? e);
    }
  }

  /** Archives every finished Run that is not yet, then sweeps the Run folders of Runs archived or gone. Never throws. */
  async function catchUpArchiving(): Promise<void> {
    try {
      const { rows } = await pool.query("SELECT id FROM runs WHERE state = ANY($1) AND archived_at IS NULL ORDER BY id", [OVER]);
      for (const r of rows) await archive(Number(r.id));
      // Only `run-<id>` folders under the worktrees root, and only those of a Run archived or no longer there.
      for (const folder of runFoldersUnder(deps.worktreesRoot)) {
        const { rows: found } = await pool.query("SELECT archived_at IS NOT NULL AS archived FROM runs WHERE id = $1", [folder.runId]);
        if (found[0] && !found[0].archived) continue;
        const { rows: owner } = await pool.query("SELECT local_path FROM projects WHERE id = $1", [folder.projectId]);
        try {
          if (owner[0]) await removeRunWorktree({ repoRoot: owner[0].local_path, worktreePath: folder.path, branch: null });
          rmSync(folder.path, { recursive: true, force: true });
        } catch (e) {
          console.error(`Run ${folder.runId}: could not remove its stray folder ${folder.path}:`, (e as Error)?.message ?? e);
        }
      }
    } catch (e) {
      console.error("Archiving the finished Runs at startup failed:", (e as Error)?.message ?? e);
    }
  }

  /** Deletes the Runs archived more than `archiveDays` ago, with everything that belongs to them. Never throws. */
  async function purge(): Promise<void> {
    try {
      const days = deps.archiveDays ?? 60;
      const { rowCount } = await pool.query("DELETE FROM runs WHERE archived_at IS NOT NULL AND archived_at < $1", [new Date(now().getTime() - days * DAY_MS)]);
      console.log(`Purge: ${rowCount} archived Run${rowCount === 1 ? "" : "s"} deleted (archived more than ${days} days ago).`);
    } catch (e) {
      console.error("Purging the archived Runs failed:", (e as Error)?.message ?? e);
    }
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

  /**
   * An Escalation's retry or go back: the Steps it puts back to waiting start again with a fresh attempt budget, in the
   * same Iteration and worktree (files are not reverted). The Feedback is kept on the Gate, where the Agents read it.
   */
  async function redoEscalation(gate: Gate, outcome: Extract<GateOutcome, { next: "redo" }>): Promise<RunDetail> {
    const open = await withRedo(gate);
    let steps: string[] | null = null;
    if (outcome.goBackTo) {
      if (!open.redo?.goBack.length) throw new GateError("This Escalation has no earlier Step to go back to.");
      if (!open.redo.goBack.some((s) => s.stepId === outcome.goBackTo)) {
        throw new InvalidInputError(`Cannot go back to "${outcome.goBackTo}"; the Steps to go back to are: ${open.redo.goBack.map((s) => s.stepId).join(", ")}.`);
      }
      steps = redoSet((await definitionOf(gate.runId))!, gate.stepId!, outcome.goBackTo);
    } else if (gate.stepId) {
      steps = redoSet((await definitionOf(gate.runId))!, gate.stepId);
    }
    const client = await pool.connect();
    let run: Run;
    try {
      await client.query("BEGIN");
      // As in `decideAndContinue`: the Run row first, guarded on the Run still waiting and the Gate undecided.
      const moved = await client.query(`UPDATE runs SET state = 'running', updated_at = now() WHERE id = $1 AND state = 'waiting' RETURNING ${RUN_COLUMNS}`, [gate.runId]);
      const decided = moved.rowCount
        ? await client.query("UPDATE gates SET decided_at = now(), decision = $2, feedback = $3 WHERE id = $1 AND decided_at IS NULL RETURNING run_id", [
            gate.id,
            outcome.decision,
            outcome.feedback ?? null,
          ])
        : null;
      if (!decided?.rowCount) {
        await client.query("ROLLBACK");
        throw new GateError(`Gate ${gate.id} is already decided.`);
      }
      // Steps that failed beside it (in a batch of parallel Steps) start again too; an Escalation that names no Step is retried as a whole.
      if (steps) await redoSteps(client, gate.runId, gate.iteration, steps);
      await redoFailedSteps(client, gate.runId, gate.iteration);
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
    // Its worktree goes once the Run's own work has let go of it (bounded: an Agent that ignores the stop must not hold the human up).
    await Promise.race([working.get(runId)?.catch(() => {}), new Promise((r) => setTimeout(r, ARCHIVE_WAIT_MS).unref())]);
    await archive(runId);
    return forge.getRun(runId);
  }

  /** The Runner's Quota ran out: the Run waits for the reset, keeping its slot. */
  async function pause(runId: number, resetsAt: Date | null) {
    const resumeAt = resetsAt ?? new Date(now().getTime() + QUOTA_RETRY_MS);
    const paused = await pool.query("UPDATE runs SET state = 'paused', resume_at = $2, updated_at = now() WHERE id = $1 AND state = 'running'", [
      runId,
      resumeAt,
    ]);
    changed(runId);
    if (paused.rowCount) {
      const until = resetsAt ? ` until ${resetsAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : "";
      await notifyRun(runId, `paused on an exhausted Quota${until}`);
    }
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

  /** The Run's Steps in Workflow order with where each stands in the Run's current Iteration. */
  /** The Steps of a Run's Workflow: the definition it froze (or its Workflow's current one, for a Run that froze none). */
  async function definitionOf(runId: number): Promise<WorkflowDefinition | undefined> {
    const { rows } = await pool.query("SELECT definition, workflow FROM runs WHERE id = $1", [runId]);
    return rows[0]?.definition ?? workflows.get(rows[0]?.workflow)?.definition;
  }

  async function statesOf(runId: number, iteration: number): Promise<Map<string, StepRow>> {
    const { rows } = await pool.query("SELECT * FROM step_states WHERE run_id = $1 AND iteration = $2", [runId, iteration]);
    return new Map(rows.map((r) => [r.step as string, { stepId: r.step, status: r.status, attempts: r.attempts, sentBack: r.sent_back, budgetFrom: r.budget_from, retriedAt: r.retried_at }]));
  }

  /** What an open Escalation offers besides abandoning: the done Steps before the Step that failed it can go back to (none when it names no Step). */
  async function withRedo(gate: Gate): Promise<Gate> {
    if (gate.decidedAt || !gateKinds.get(gate.kind)?.redo) return gate;
    const definition = gate.stepId ? await definitionOf(gate.runId) : undefined;
    const choices = definition && gate.stepId ? goBackChoices(definition, await statesOf(gate.runId, gate.iteration), gate.stepId) : [];
    const goBack = choices.map((s) => ({ stepId: s.id, type: s.type, detail: s.type === "agent" || s.type === "conversation" ? s.agent : s.type === "gate" ? s.gate : null }));
    return { ...gate, redo: { goBack } };
  }

  async function stepsOf(run: Run): Promise<StepState[]> {
    const { rows: frozen } = await pool.query("SELECT definition FROM runs WHERE id = $1", [run.id]);
    const definition: WorkflowDefinition | undefined = frozen[0]?.definition ?? workflows.get(run.workflow)?.definition;
    if (!definition) return [];
    const { rows } = await pool.query("SELECT step, status, attempts FROM step_states WHERE run_id = $1 AND iteration = $2", [run.id, run.iteration]);
    const recorded = new Map(rows.map((r) => [r.step as string, r]));
    // A Run from before M3a has no recorded Steps; once approved, merged or closed it went through all of them.
    const wentThrough = !rows.length && ["approved", "merged", "closed"].includes(run.state);
    return definition.steps.map((s) => ({
      id: s.id,
      type: s.type,
      detail: s.type === "agent" || s.type === "conversation" ? s.agent : s.type === "gate" ? s.gate : null,
      needs: s.needs,
      iteration: run.iteration,
      status: recorded.get(s.id)?.status ?? (wentThrough ? "done" : "waiting"),
      attempts: recorded.get(s.id)?.attempts ?? 0,
    }));
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

  /** The Workflows the Project can launch, its own read from `branch` (its default branch, fetched now when not given; null: none is read). */
  async function projectWorkflows(project: Project, branch?: string | null): Promise<ResolvedWorkflow[]> {
    return resolveWorkflows(project.localPath, branch === undefined ? await freshDefaultBranch(project.id, project.localPath) : branch, workflowKit());
  }

  /** What this Forgequor has code for, which a Workflow can only compose. */
  function workflowKit(): WorkflowKit {
    return {
      builtIn: [...workflows.values()],
      catalogue: catalogueOf(agentModules.values(), conversationAgents.values()),
      stepTypes: new Set(stepTypes.keys()),
      gateKinds: new Set(gateKinds.keys()),
    };
  }

  /** The Skill Packs the Run starts with: the Project's choice read at its first start, then kept. A pack gone from disk is skipped. */
  async function packsOfRun(runId: number, projectId: number): Promise<string[]> {
    const { rows } = await pool.query(
      `UPDATE runs SET skill_packs = COALESCE(skill_packs, (SELECT skill_packs FROM projects WHERE id = $2)) WHERE id = $1 RETURNING skill_packs`,
      [runId, projectId],
    );
    const offered = new Set(offeredSkillPacks(skillsRoot));
    return ((rows[0]?.skill_packs as string[] | undefined) ?? []).filter((n) => offered.has(n));
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
      // Every start and restart: a Skill that went missing is put back.
      await placeSkillPacks([deps.skillPack ?? SHARED_SKILL_PACK, ...(await packsOfRun(run.id, project.id)).map((n) => join(skillsRoot, n))], worktreePath);
      await pool.query("UPDATE runs SET branch = $2, worktree_path = $3 WHERE id = $1", [run.id, branch, worktreePath]);
      changed(run.id);

      // Abandoned between being restarted and getting here: nothing to work on, no Quota to spend.
      if (!(await stillRunning(run.id))) return;
      const records = createRunRecords(pool, run.id, run.iteration);
      // The definition the Run started with, not the Workflow's as it is now (a Project Workflow is not in the code, and may be gone from the repository).
      const { rows: frozen } = await pool.query("SELECT definition FROM runs WHERE id = $1", [run.id]);
      const definition: WorkflowDefinition | undefined = frozen[0]?.definition ?? workflows.get(run.workflow)?.definition;
      if (!definition) throw new Error(`Unknown Workflow "${run.workflow}".`);
      const { agents, problems: seatProblems } = await seatsOfRun(run.id);
      const context: WorkflowContext = {
        run,
        project,
        branch,
        worktreePath,
        defaultBranch,
        stop,
        agents,
        seatProblems,
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
        openGate: (kind, reason, evidence, step) => openGate(run.id, kind, reason, evidence, step),
        pause: (resetsAt) => pause(run.id, resetsAt),
        approve: () => approveRun(run.id),
        stillRunning: () => stillRunning(run.id),
      };
      await runEngine(context, definition, stepTypes);
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

    async purgeArchivedRuns(projectId) {
      if (projectId !== undefined) {
        const { rows } = await pool.query("SELECT 1 FROM projects WHERE id = $1", [projectId]);
        if (!rows[0]) throw new Error(`No Project ${projectId}.`);
      }
      const { rowCount } = await pool.query("DELETE FROM runs WHERE archived_at IS NOT NULL AND ($1::int IS NULL OR project_id = $1)", [projectId ?? null]);
      const n = rowCount ?? 0;
      console.log(`Purge: ${n} archived Run${n === 1 ? "" : "s"} deleted (requested${projectId === undefined ? "" : ` for Project ${projectId}`}).`);
      return n;
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

    async listWorkflows(projectId) {
      const { rows: found } = await pool.query(`SELECT ${COLUMNS} FROM projects WHERE id = $1`, [projectId]);
      if (!found[0]) throw new Error(`No Project ${projectId}.`);
      const project = toProject(found[0]);
      try {
        const resolved = await projectWorkflows(project);
        return { workflows: resolved.map((r) => r.option), problem: null };
      } catch (e: any) {
        const builtIn = await projectWorkflows(project, null);
        return { workflows: builtIn.map((r) => r.option), problem: `The Project's own Workflows could not be read: ${e?.message ?? e}` };
      }
    },

    async validateWorkflow(yaml, projectId) {
      if (projectId !== undefined) {
        const { rows } = await pool.query("SELECT 1 FROM projects WHERE id = $1", [projectId]);
        if (!rows[0]) throw new Error(`No Project ${projectId}.`);
      }
      return validateWorkflowText(yaml, workflowKit());
    },

    async startRun({ projectId, trackerRef, workflow = "developer", seats, ...input }) {
      // Refused before anything else, as the Team page refuses a bad change.
      const seatOverrides = parseSeatOverrides(envSettings, seats);
      const { rows: found } = await pool.query(`SELECT ${COLUMNS} FROM projects WHERE id = $1`, [projectId]);
      if (!found[0]) throw new Error(`No Project ${projectId}.`);
      const project = toProject(found[0]);
      // What a Run starts from is the default branch as it is on the remote now: fetched once, here, for the Project's
      // Workflows and for whatever the launch checks ask of the repository. A remote out of reach leaves the Project's
      // Workflows unread; the Run is still created and opens an Escalation when its worktree cannot be made.
      let fresh: Promise<string> | undefined;
      const freshBranch = () => (fresh ??= freshDefaultBranch(projectId, project.localPath));
      let unreadable = "";
      const branch = await freshBranch().catch((e) => {
        unreadable = ` (the Project's own Workflows could not be read: ${e?.message ?? e})`;
        return null;
      });
      const chosen = (await projectWorkflows(project, branch)).find((r) => r.option.name === workflow);
      if (!chosen) throw new Error(`Unknown Workflow "${workflow}"${unreadable}.`);
      if (!chosen.workflow) throw new Error(describeInvalid(chosen.option));
      const flow = chosen.workflow;
      const plan = flow.plan(input);
      const review = reviewModeOf(flow, input.review);
      // Refused now, not after a Quota-costly generation.
      await plan.check?.({ project, exists: async (path) => existsInBranch(project.localPath, await freshBranch(), path) });
      const client = await pool.connect();
      let runId: number;
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(
          `INSERT INTO runs (project_id, workflow, title, task, tracker_ref, state, definition, inputs, review_mode, seat_overrides)
           VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, $8, $9) RETURNING id`,
          [projectId, workflow, plan.title, plan.task, trackerRef?.trim() || null, JSON.stringify(flow.definition), JSON.stringify(plan.given ?? flow.inputs), review, Object.keys(seatOverrides).length ? JSON.stringify(seatOverrides) : null],
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

    offeredSkillPacks: () => offeredSkillPacks(skillsRoot),

    async setSkillPacks(projectId, packs) {
      const offered = offeredSkillPacks(skillsRoot);
      const unknown = packs.filter((p) => typeof p !== "string" || !offered.includes(p));
      if (unknown.length) throw new InvalidInputError(`Unknown Skill Pack: ${unknown.join(", ")}. Offered: ${offered.join(", ") || "none"}.`);
      const { rows } = await pool.query(`UPDATE projects SET skill_packs = $2 WHERE id = $1 RETURNING ${COLUMNS}`, [projectId, offered.filter((p) => packs.includes(p))]);
      if (!rows[0]) throw new Error(`No Project ${projectId}.`);
      return toProject(rows[0]);
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
        steps: await stepsOf(toRun(rows[0])),
        assets,
        iterations,
        attempts: attempts.rows.map(toAttempt),
        checks: checks.rows.map(toCheck),
        runNotes: await runNotes.list(id),
        reviews: (await pool.query("SELECT * FROM reviews WHERE run_id = $1 ORDER BY id", [id])).rows.map(toReview),
        conversation: await createConversationRecords(pool, id).all(),
        gates: await Promise.all(gates.rows.map(async (g) => withRedo({ ...(await gateOf(g)), verdicts: verdictsOf(Number(g.id)) }))),
      };
    },

    async getRunNote(runId, path) {
      const note = await runNotes.get(runId, path);
      if (!note) throw new RunNotFoundError(`Run ${runId} has no kept Run Note ${path}.`);
      return note;
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
        `SELECT g.*, r.title AS run_title, p.name AS project_name, r.project_id
         FROM gates g JOIN runs r ON r.id = g.run_id JOIN projects p ON p.id = r.project_id
         WHERE g.decided_at IS NULL ORDER BY g.id`,
      );
      return Promise.all(rows.map(async (r) => ({ ...(await withRedo(await gateOf(r))), runTitle: r.run_title, projectId: Number(r.project_id), projectName: r.project_name })));
    },

    async listApprovedRuns() {
      const { rows } = await pool.query(
        `SELECT ${RUN_COLUMNS_OF_R}, p.name AS project_name
         FROM runs r JOIN projects p ON p.id = r.project_id
         WHERE r.state = 'approved' ORDER BY r.id`,
      );
      return rows.map((r) => ({ ...toRun(r), projectName: r.project_name }));
    },

    async decideGate({ gateId, action, feedback, verdicts, target, message }) {
      const { rows } = await pool.query("SELECT * FROM gates WHERE id = $1", [gateId]);
      if (!rows[0]) throw new GateError(`No Gate ${gateId}.`);
      const gate = await gateOf(rows[0]);
      if (gate.decidedAt) throw new GateError(`Gate ${gateId} is already decided.`);
      const kind = gateKinds.get(gate.kind)!;
      if (!allows(kind, action, gate.actions)) throw new GateError(refusal(kind, action, gate.actions));
      // The kind validates the decision and says where the Run goes; the core carries it out.
      const outcome = await kind.decide(gate, { action, feedback, verdicts, target, message });
      if (outcome.next === "redo") return redoEscalation(gate, outcome);
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
        // The Gate Step is done with its Gate approved: the Run is over, no engine will mark it.
        await client.query(
          "UPDATE step_states SET status = 'done', attempts = attempts + 1 WHERE run_id = $1 AND iteration = $2 AND step = $3 AND status = 'running'",
          [gate.runId, gate.iteration, gate.stepId],
        );
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
          if (state !== "open" && (await settle(Number(r.id), state, ["approved"]))) {
            await notifyRun(Number(r.id), `pull request ${state}`);
            await archive(Number(r.id));
          }
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
      await catchUpArchiving();
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

    quota: () => quotas.status(),
    createDogfoodNote: (input) => dogfood.create(input),
    listDogfoodNotes: (filter) => dogfood.list(filter),
    setDogfoodNoteStatus: (id, status, triageRef) => dogfood.setStatus(id, status, triageRef),
    exportDogfoodNotes: (ids) => dogfood.export(ids),
    team: () => teamStore.team(),
    changeSeat: (seat, change) => teamStore.change(seat, change),
    startQuotaReading: () => quotas.start(),

    async startPurging() {
      await purge();
      return (deps.every ?? realEvery)(() => void purge(), DAY_MS);
    },

    async whenIdle() {
      do {
        while (inFlight.size) await Promise.all([...inFlight]);
        await quotas.whenIdle();
      } while (inFlight.size);
    },
  };
  return forge;
}
