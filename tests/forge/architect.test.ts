import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createForge, GateError, InvalidInputError, type Forge, type Gate, type Project, type RunDetail } from "../../src/forge/forge.js";
import { specPathOf } from "../../src/forge/spec.js";
import type { StepRequest, StepResult } from "../../src/runner/runner.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote, type TempRemote, type TempRepo } from "../harness/git.js";

/** The Architect of the `feature` Workflow, through the Forge core: real git and PostgreSQL, scripted Runners. */

let pool: pg.Pool;
let drop: () => Promise<void>;
let worktrees: string;
let forge: Forge;
const claude = createFakeRunner();
const codex = createFakeRunner();
const codeHost = createFakeCodeHost();
const cleanups: Array<() => void> = [];
let counter = 0;

const SPEC = "docs/specs/let-the-player-jump-twice.md";
const isGriller = (s: StepRequest) => s.instructions.includes("You are the Griller");
const isSpecWriter = (s: StepRequest) => s.instructions.includes("You are the Spec Writer");
const isArchitect = (s: StepRequest) => s.instructions.includes("You are the Architect");
const isReviewer = (s: StepRequest) => s.instructions.includes("You are the Reviewer") || s.instructions.includes("You are the Consolidator");
const passing: StepResult = { status: "succeeded", summary: "Summary: Fine.\n\nFindings:\n- None.\n\nDoubts: None.\n\nVerdict: pass" };
const specWriters = () => claude.steps.filter(isSpecWriter);
const developers = () => claude.steps.filter((s) => !isGriller(s) && !isSpecWriter(s) && !isArchitect(s) && !isReviewer(s));

const write = (step: StepRequest, path: string, text: string) => {
  mkdirSync(dirname(join(step.cwd, path)), { recursive: true });
  writeFileSync(join(step.cwd, path), text);
};
/** The Spec Writer writes version `n` of the spec (the `n`th time it is asked) unless `specWriting` says otherwise. */
let specWriting: (step: StepRequest, n: number) => StepResult | void = (step, n) => write(step, SPEC, `# Double jump\n\nSpec, version ${n}.\n`);

/** What the Architect does: writes the Implementation Plan to the Run Notes (`architecting` is replaced by tests that script it). */
let architecting: (step: StepRequest) => StepResult | void = (step) => write(step, ".forgequor/implementation-plan.md", "# Plan\n\nModule: jump.\n");

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  pool = db.pool;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-architect-"));
  claude.use(play);
  codex.use(() => passing);
  forge = createForge({ pool, runner: claude, artistRunner: codex, codeHost, worktreesRoot: worktrees });
});
afterAll(async () => {
  await forge.whenIdle();
  await drop();
  rmSync(worktrees, { recursive: true, force: true });
});
afterEach(() => {
  architecting = (step) => write(step, ".forgequor/implementation-plan.md", "# Plan\n\nModule: jump.\n");
  specWriting = (step, n) => write(step, SPEC, `# Double jump\n\nSpec, version ${n}.\n`);
  claude.use(play);
  claude.steps.length = 0;
  claude.sessions.clear();
  codex.use(() => passing);
  codex.steps.length = 0;
  codeHost.pullRequests.length = 0;
  cleanups.splice(0).forEach((c) => c());
});

let specs = 0;
/** The Griller proposes its summary at once; the Spec Writer writes what `specWriting` says; the Developer and the Reviewers do their parts. */
function play(step: StepRequest): StepResult | void {
  if (isReviewer(step)) return passing;
  if (isGriller(step)) return { status: "succeeded", summary: "Kind: summary\n\nBuild a double jump: once per fall." };
  if (isArchitect(step)) return architecting(step);
  if (isSpecWriter(step)) return specWriting(step, ++specs);
  write(step, "jump.txt", "jump\n");
  write(step, ".forgequor/review-brief.md", "What the Developer did.\n");
}

let remote: TempRemote;
async function project(): Promise<Project> {
  const made = createRepoWithBareRemote({ remote: `git@github.com:acme/architect-${++counter}.git` }) as { repo: TempRepo; remote: TempRemote };
  cleanups.push(made.repo.cleanup, made.remote.cleanup);
  remote = made.remote;
  const registered = await forge.registerProject({ path: made.repo.path });
  made.remote.pointOriginAtBare();
  return registered;
}

const open = (r: RunDetail): Gate => r.gates.find((g) => !g.decidedAt)!;
const stepsOf = (r: RunDetail) => r.steps.map((s) => `${s.id}:${s.status}`);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Starts a feature Run and confirms the Griller's summary: the Run is then at the spec Gate (or escalated). */
async function toArchitect(p: Project): Promise<RunDetail> {
  specs = 0;
  const started = await forge.startRun({ projectId: p.id, workflow: "feature", task: "Let the player jump twice." });
  await forge.whenIdle();
  await forge.decideGate({ gateId: open(await forge.getRun(started.id)).id, action: "confirm" });
  await forge.whenIdle();
  return approveSpec(await forge.getRun(started.id));
}
async function approveSpec(r: RunDetail): Promise<RunDetail> {
  await forge.decideGate({ gateId: open(r).id, action: "approve" });
  await forge.whenIdle();
  return forge.getRun(r.id);
}
async function decide(r: RunDetail, action: "approve" | "reject", feedback?: string): Promise<RunDetail> {
  await forge.decideGate({ gateId: open(r).id, action, feedback });
  await forge.whenIdle();
  return forge.getRun(r.id);
}

const PLAN = ".forgequor/implementation-plan.md";
const architects = () => claude.steps.filter(isArchitect);
const ADR = "docs/adr/0100-double-jump.md";

describe("the Architect", () => {
  it("writes the plan to the Run Notes, which reaches the Developer; no Gate follows it", async () => {
    const p = await project();

    const run = await toArchitect(p);

    expect(run.state).toBe("waiting");
    expect(stepsOf(run)).toEqual(["griller:done", "spec-writer:done", "spec:done", "architect:done", "artist:skipped", "asset-gate:skipped", "developer:done", "checks:done", "review:done", "publish:done", "final:running"]);
    expect(run.gates.map((g) => g.stepId)).toEqual(["griller", "spec", "final"]);
    expect(run.attempts.filter((a) => a.step === "architect").map((a) => [a.stepId, a.runner, a.status])).toEqual([["architect", "claude", "succeeded"]]);
    const [step] = architects();
    expect(step!.prompt).toContain("Let the player jump twice.");
    expect(step!.prompt).toContain("Build a double jump: once per fall.");
    expect(step!.prompt).toContain("# Double jump\n\nSpec, version 1.");
    expect(step!.prompt).toContain(`Write the Implementation Plan to ${PLAN}.`);
    expect(step!.instructions).toContain("codebase-design");
    expect(step!.instructions).toMatch(/NEVER ask the human/);
    expect(developers()).toHaveLength(1);
    expect(developers()[0]!.prompt).toContain("The Architect wrote this Implementation Plan");
    expect(developers()[0]!.prompt).toContain("# Plan\n\nModule: jump.");
    // The plan is a Run Note: it never reaches the branch.
    expect(git(run.worktreePath!, "diff", "--name-only", "origin/main", "HEAD")).not.toContain("implementation-plan");
    expect(codeHost.pullRequests).toHaveLength(1);
  });

  it("is sent back when it wrote no plan (or an empty one), and escalates after three tries; the Developer does not start", async () => {
    const p = await project();
    architecting = (step) => write(step, PLAN, "  \n");

    const run = await toArchitect(p);

    expect(architects()).toHaveLength(3);
    expect(architects()[1]!.prompt).toContain(`No Implementation Plan was written: ${PLAN} is missing or empty`);
    expect(open(run)).toMatchObject({ kind: "escalation", stepId: "architect", reason: "The Architect still gives invalid input after 3 attempts." });
    expect(developers()).toHaveLength(0);
    expect(run.steps.find((s) => s.id === "architect")!.status).toBe("failed");
  });

  it("does not take the plan of an earlier pass for the new one when gone back to", async () => {
    const p = await project();
    await pool.query("UPDATE projects SET setup = $2 WHERE id = $1", [p.id, JSON.stringify(["false"])]);
    let run = await toArchitect(p);
    await pool.query("UPDATE projects SET setup = '[]' WHERE id = $1", [p.id]);
    architecting = () => {};

    await forge.decideGate({ gateId: open(run).id, action: "go_back", target: "architect", feedback: "Plan again." });
    await forge.whenIdle();
    run = await forge.getRun(run.id);

    expect(architects()).toHaveLength(4);
    expect(open(run)).toMatchObject({ kind: "escalation", stepId: "architect" });
  });

  it("commits the ADRs it wrote, and only them", async () => {
    const p = await project();
    architecting = (step) => {
      write(step, PLAN, "# Plan\n\nSee the ADR.\n");
      write(step, ADR, "# Double jump is a state\n");
    };

    const run = await toArchitect(p);

    expect(stepsOf(run)).toContain("architect:done");
    const commits = git(run.worktreePath!, "log", "--format=%s", "origin/main..HEAD").split("\n");
    expect(commits.some((c) => c.startsWith("docs(adr): "))).toBe(true);
    expect(git(run.worktreePath!, "diff", "--name-only", "origin/main", "HEAD").split("\n")).toContain(ADR);
    expect(readFileSync(join(run.worktreePath!, ADR), "utf8")).toBe("# Double jump is a state\n");
    expect(git(run.worktreePath!, "status", "--porcelain")).toBe("");
  });

  it("may change nothing but ADRs: other files are put back and an Escalation names them", async () => {
    const p = await project();
    architecting = (step) => {
      write(step, PLAN, "# Plan\n");
      write(step, ADR, "# An ADR\n");
      write(step, "src/jump.ts", "export {};\n");
      write(step, "docs/specs/other.md", "another spec\n");
      write(step, "GLOSSARY.md", "# Glossary\n");
    };

    const run = await toArchitect(p);

    expect(open(run)).toMatchObject({ kind: "escalation", stepId: "architect", reason: "The Architect changed files it may not change, so they were put back as they were." });
    expect(open(run).evidence!.split("\n").sort()).toEqual(["GLOSSARY.md", "docs/specs/other.md", "src/jump.ts"]);
    for (const path of ["GLOSSARY.md", "docs/specs/other.md", "src/jump.ts"]) expect(existsSync(join(run.worktreePath!, path))).toBe(false);
    expect(developers()).toHaveLength(0);
    // The attempt is not used: not even its ADR is committed.
    expect(git(run.worktreePath!, "log", "--format=%s", "origin/main..HEAD")).not.toContain("docs(adr)");
  });

  it("fails like any Agent when its Runner fails", async () => {
    const p = await project();
    architecting = (step) => {
      write(step, "src/x.ts", "export {};\n");
      return { status: "failed", error: "The Runner died." };
    };

    const run = await toArchitect(p);

    expect(open(run)).toMatchObject({ kind: "escalation", reason: "The Architect failed." });
    expect(existsSync(join(run.worktreePath!, "src/x.ts"))).toBe(false);
  });

  it("can be gone back to from an Escalation at the Developer, and then writes its plan again", async () => {
    const p = await project();
    await pool.query("UPDATE projects SET setup = $2 WHERE id = $1", [p.id, JSON.stringify(["false"])]);
    let run = await toArchitect(p);
    expect(open(run)).toMatchObject({ kind: "escalation", stepId: "developer" });
    expect(open(run).redo!.goBack.map((s) => s.stepId)).toEqual(["griller", "spec-writer", "spec", "architect"]);
    await pool.query("UPDATE projects SET setup = '[]' WHERE id = $1", [p.id]);
    architecting = (step) => write(step, PLAN, "# Plan\n\nSecond plan.\n");

    await forge.decideGate({ gateId: open(run).id, action: "go_back", target: "architect", feedback: "Plan it differently." });
    await forge.whenIdle();
    run = await forge.getRun(run.id);

    expect(architects()).toHaveLength(2);
    expect(stepsOf(run)).toContain("architect:done");
    expect(stepsOf(run).at(-1)).toBe("final:running");
    expect(developers().at(-1)!.prompt).toContain("Second plan.");
    expect(developers().at(-1)!.prompt).not.toContain("Module: jump.");
  });

  it("keeps the plan for the Developer when the final Gate sends the work back", async () => {
    const p = await project();
    let run = await toArchitect(p);
    expect(architects()).toHaveLength(1);
    await forge.decideGate({ gateId: open(run).id, action: "reject", feedback: "Make it higher." });
    await forge.whenIdle();
    run = await forge.getRun(run.id);

    expect(architects()).toHaveLength(1);
    expect(developers()).toHaveLength(2);
    expect(developers()[1]!.prompt).toContain("# Plan\n\nModule: jump.");
  });
});
