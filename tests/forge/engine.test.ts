import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createForge, type Forge, type ForgeDeps, type Project, type RunDetail } from "../../src/forge/forge.js";
import { developerAgent } from "../../src/forge/developer.js";
import { AssetNotFoundError } from "../../src/forge/errors.js";
import type { Extension } from "../../src/forge/extension.js";
import { catalogueOf, type AgentModule } from "../../src/forge/step-types.js";
import { parseWorkflow } from "../../src/forge/workflow-definition.js";
import type { Workflow } from "../../src/forge/workflow.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote, type TempRemote, type TempRepo } from "../harness/git.js";

/**
 * The engine, through the Forge core, with small test Workflows. Their Agents all work through the one fake Runner; the
 * script tells them apart by their instructions.
 */

const PRODUCED = ".forgequor/produced.txt";

/** An Agent that writes what it produced to a Run Note; "assets" in it means it produced the `assets` input, "bad" an invalid one. */
const scribe: AgentModule = {
  name: "scribe",
  seat: "developer",
  instructions: "You are the Scribe.",
  produces: ["assets"],
  async prompt(ctx, attempt) {
    return `Scribe for: ${ctx.run.task}${attempt.sentBack ? `\nSent back: ${attempt.sentBack}` : ""}`;
  },
  async harvest(ctx) {
    const text = readFileSync(join(ctx.worktreePath, PRODUCED), "utf8");
    if (text.includes("bad")) return { invalid: "The produced Asset Requests have no names." };
    return { produced: text.includes("assets") ? ["assets"] : [] };
  },
};

function workflowOf(yaml: string): Workflow {
  const parsed = parseWorkflow(yaml, catalogueOf([developerAgent, scribe]));
  if (!parsed.ok) throw new Error(`Test Workflow is invalid: ${JSON.stringify(parsed.errors)}`);
  const { definition } = parsed;
  return {
    name: definition.name,
    inputs: definition.inputs,
    definition,
    plan: ({ task, title }) => ({ task: task!, title: title ?? "A test Run" }),
  };
}

const SKIPPING = workflowOf(`
name: skipping
inputs: [task]
steps:
  - id: notes
    type: agent
    agent: scribe
  - id: draw
    type: agent
    agent: developer
    needs: [notes]
    when: assets
  - id: verify
    type: checks
    needs: [draw]
  - id: review
    type: gate
    gate: final
    needs: [verify]
    on_reject: notes
`);

const LOOPING = workflowOf(`
name: looping
inputs: [task]
steps:
  - id: draft
    type: agent
    agent: developer
  - id: refine
    type: agent
    agent: developer
    needs: [draft]
  - id: verify
    type: checks
    needs: [refine]
    on_reject: draft
    max_attempts: 2
  - id: review
    type: gate
    gate: final
    needs: [verify]
    on_reject: draft
    max_attempts: 1
`);

const TEAM: Extension = {
  workflows: [SKIPPING, LOOPING],
  gateKinds: [],
  agents: [scribe],
  async detail() {
    return { assets: [], gates: new Map() };
  },
  async assetImage() {
    throw new AssetNotFoundError("No assets here.");
  },
};

let forge: Forge;
let pool: pg.Pool;
let drop: () => Promise<void>;
let worktrees: string;
let fakeNow: Date | null = null;
const runner = createFakeRunner();
const codeHost = createFakeCodeHost();
const cleanups: Array<() => void> = [];
const others: Forge[] = [];
let counter = 0;

function forgeWith(overrides: Partial<ForgeDeps> = {}): Forge {
  const created = createForge({ pool, runner, codeHost, worktreesRoot: worktrees, extensions: [TEAM], now: () => fakeNow ?? new Date(), ...overrides });
  others.push(created);
  return created;
}

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  pool = db.pool;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-engine-"));
  forge = forgeWith();
});
afterAll(async () => {
  await Promise.all(others.map((f) => f.whenIdle()));
  await drop();
  rmSync(worktrees, { recursive: true, force: true });
});
afterEach(async () => {
  for (const run of await forge.listRuns({ state: "paused" })) await forge.abandonRun(run.id);
  fakeNow = null;
  runner.use(() => {});
  runner.steps.length = 0;
  codeHost.pullRequests.length = 0;
  cleanups.splice(0).forEach((c) => c());
});

async function projectWithRemote(checks: string[] = []): Promise<Project> {
  const { repo, remote } = createRepoWithBareRemote({ remote: `git@github.com:acme/engine-${++counter}.git` }) as { repo: TempRepo; remote: TempRemote };
  cleanups.push(repo.cleanup, remote.cleanup);
  const project = await forge.registerProject({ path: repo.path });
  remote.pointOriginAtBare();
  return checks.length ? forge.setChecks(project.id, checks) : project;
}

async function run(project: Project, workflow: string, task = "Do the thing."): Promise<RunDetail> {
  const started = await forge.startRun({ projectId: project.id, workflow, task });
  await forge.whenIdle();
  return forge.getRun(started.id);
}

const isScribe = (step: { instructions: string }) => step.instructions.startsWith("You are the Scribe");
const scribeWrites = (text: string) => (step: { cwd: string; instructions: string }) => {
  if (!isScribe(step)) return;
  mkdirSync(join(step.cwd, ".forgequor"), { recursive: true });
  writeFileSync(join(step.cwd, PRODUCED), text);
};
const stepsOf = (r: RunDetail) => r.steps.map((s) => `${s.id}:${s.status}:${s.attempts}`);

describe("a Run follows the definition it started with", () => {
  it("lists its Steps in Workflow order with their state", async () => {
    const project = await projectWithRemote();
    runner.use(scribeWrites("assets: hero"));

    const r = await run(project, "skipping");

    expect(r.state).toBe("waiting");
    expect(r.steps.map((s) => [s.id, s.type, s.detail])).toEqual([
      ["notes", "agent", "scribe"],
      ["draw", "agent", "developer"],
      ["verify", "checks", null],
      ["review", "gate", "final"],
    ]);
    expect(stepsOf(r)).toEqual(["notes:done:1", "draw:done:1", "verify:done:1", "review:running:0"]);
    expect(r.gates).toMatchObject([{ kind: "final", stepId: "review", reason: "The Developer finished." }]);
    expect(r.attempts.map((a) => [a.stepId, a.step])).toEqual([["notes", "scribe"], ["draw", "developer"]]);
  });

  it("keeps the Steps it started with after the Workflow changes", async () => {
    const project = await projectWithRemote();
    runner.use(scribeWrites("assets: hero"));
    const first = await run(project, "skipping");

    // Someone edits the Workflow: the Run already started does not follow.
    const original = SKIPPING.definition.steps;
    SKIPPING.definition.steps = SKIPPING.definition.steps.filter((s) => s.id !== "draw");
    try {
      await forge.decideGate({ gateId: first.gates[0]!.id, action: "reject", feedback: "Again." });
      await forge.whenIdle();
    } finally {
      SKIPPING.definition.steps = original;
    }

    const again = await forge.getRun(first.id);
    expect(again.iteration).toBe(2);
    expect(again.steps.map((s) => s.id)).toEqual(["notes", "draw", "verify", "review"]);
    expect(stepsOf(again)).toEqual(["notes:done:1", "draw:done:1", "verify:done:1", "review:running:0"]);
  });
});

describe("a Step's condition", () => {
  it("skips a Step whose input was not produced, and starts the Steps after it", async () => {
    const project = await projectWithRemote();
    runner.use(scribeWrites("nothing to draw"));

    const r = await run(project, "skipping");

    expect(runner.steps).toHaveLength(1);
    expect(stepsOf(r)).toEqual(["notes:done:1", "draw:skipped:0", "verify:done:1", "review:running:0"]);
    expect(r.gates).toMatchObject([{ kind: "final" }]);
  });

  it("runs the Step once an earlier Step produced the input, evaluated when it is ready", async () => {
    const project = await projectWithRemote();
    runner.use(scribeWrites("assets: hero"));

    const r = await run(project, "skipping");

    expect(runner.steps).toHaveLength(2);
    expect(stepsOf(r)).toEqual(["notes:done:1", "draw:done:1", "verify:done:1", "review:running:0"]);
  });

  it("sends a produced input that is invalid back to the Step with the reason, like a Run input refused at launch", async () => {
    const project = await projectWithRemote();
    runner.use((step) => scribeWrites(runner.steps.length === 1 ? "bad assets" : "assets: hero")(step));

    const r = await run(project, "skipping");

    expect(runner.steps.map((s) => isScribe(s))).toEqual([true, true, false]);
    expect(runner.steps[1]!.prompt).toContain("The produced Asset Requests have no names.");
    expect(r.attempts.map((a) => [a.step, a.attempt, a.status])).toEqual([
      ["scribe", 1, "succeeded"],
      ["scribe", 2, "succeeded"],
      ["developer", 1, "succeeded"],
    ]);
    expect(stepsOf(r)).toEqual(["notes:done:2", "draw:done:1", "verify:done:1", "review:running:0"]);
  });

  it("opens an Escalation when the input stays invalid past the Step's max_attempts", async () => {
    const project = await projectWithRemote();
    runner.use(scribeWrites("bad"));

    const r = await run(project, "skipping");

    expect(runner.steps).toHaveLength(3);
    expect(r.gates).toMatchObject([{ kind: "escalation", stepId: "notes", reason: "The Scribe still gives invalid input after 3 attempts.", evidence: "The produced Asset Requests have no names." }]);
    expect(stepsOf(r)).toEqual(["notes:failed:3", "draw:waiting:0", "verify:waiting:0", "review:waiting:0"]);
  });
});

describe("a rejecting Step", () => {
  const failsUntil = (n: number) => (step: { cwd: string }) => {
    if (runner.steps.length === n) writeFileSync(join(step.cwd, "fixed.txt"), "ok\n");
  };
  const CHECK = "test -f fixed.txt || { echo missing fixed.txt; exit 2; }";

  it("loops back to its on_reject Step and replays every Step after it, in order", async () => {
    const project = await projectWithRemote([CHECK]);
    runner.use(failsUntil(3));

    const r = await run(project, "looping");

    // draft, refine, the Check fails, draft, refine again, the Check passes.
    expect(runner.steps).toHaveLength(4);
    expect(r.attempts.map((a) => [a.stepId, a.attempt])).toEqual([["draft", 1], ["refine", 1], ["draft", 2], ["refine", 2]]);
    expect(runner.steps[2]!.prompt).toContain("missing fixed.txt");
    expect(r.checks.map((c) => [c.attempt, c.exitStatus])).toEqual([[1, 2], [2, 0]]);
    expect(stepsOf(r)).toEqual(["draft:done:2", "refine:done:2", "verify:done:2", "review:running:0"]);
    expect(r.gates).toMatchObject([{ kind: "final" }]);
  });

  it("opens an Escalation saying so once the loop has used the Step's max_attempts", async () => {
    const project = await projectWithRemote([CHECK]);

    const r = await run(project, "looping");

    expect(runner.steps).toHaveLength(4);
    expect(r.state).toBe("waiting");
    expect(r.gates).toMatchObject([{ kind: "escalation", stepId: "verify", reason: "A Check still fails after 2 attempts.", evidence: expect.stringContaining("missing fixed.txt") }]);
    expect(stepsOf(r)).toEqual(["draft:done:2", "refine:done:2", "verify:failed:2", "review:waiting:0"]);
    expect(codeHost.pullRequests).toHaveLength(0);
  });

  it("starts a new Iteration on every Gate rejection, with no cap, whatever the Gate's max_attempts", async () => {
    const project = await projectWithRemote();
    let r = await run(project, "looping");

    for (const feedback of ["One.", "Two.", "Three."]) {
      await forge.decideGate({ gateId: r.gates.at(-1)!.id, action: "reject", feedback });
      await forge.whenIdle();
      r = await forge.getRun(r.id);
    }

    expect(r).toMatchObject({ state: "waiting", iteration: 4 });
    expect(r.gates.map((g) => [g.kind, g.iteration])).toEqual([["final", 1], ["final", 2], ["final", 3], ["final", 4]]);
    // Each Iteration replays the Steps the rejection sent back, with a fresh budget.
    expect(stepsOf(r)).toEqual(["draft:done:1", "refine:done:1", "verify:done:1", "review:running:0"]);
    expect(r.attempts.filter((a) => a.iteration === 4).map((a) => [a.stepId, a.attempt])).toEqual([["draft", 1], ["refine", 1]]);
  });
});

describe("restarting a Run", () => {
  /** Runs the first Step, then holds the second until released: the process "dies" there. */
  async function interruptedAtRefine() {
    const project = await projectWithRemote();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let inSecond!: () => void;
    const reached = new Promise<void>((r) => (inSecond = r));
    runner.use(async () => {
      if (runner.steps.length < 2) return;
      inSecond();
      await hold;
      return { status: "failed", error: "the old process is gone" };
    });
    const started = await forge.startRun({ projectId: project.id, workflow: "looping", task: "Do the thing." });
    await reached;
    return { id: started.id, release };
  }

  it("starts again only the Steps that were running after a restart of Forgequor", async () => {
    const { id, release } = await interruptedAtRefine();
    expect(stepsOf(await forge.getRun(id)).slice(0, 2)).toEqual(["draft:done:1", "refine:running:0"]);
    runner.steps.length = 0;
    runner.use(() => {});

    const restarted = forgeWith();
    await restarted.recoverAfterRestart();
    await restarted.whenIdle();

    const r = await restarted.getRun(id);
    expect(runner.steps).toHaveLength(1);
    expect(r.attempts.map((a) => [a.stepId, a.attempt, a.status])).toEqual([
      ["draft", 1, "succeeded"],
      ["refine", 1, "failed"],
      ["refine", 1, "succeeded"],
    ]);
    expect(stepsOf(r)).toEqual(["draft:done:1", "refine:done:1", "verify:done:1", "review:running:0"]);
    release();
    await forge.whenIdle();
  });

  it("starts again only the Steps that were running after a Quota pause", async () => {
    const project = await projectWithRemote();
    fakeNow = new Date("2030-01-01T10:00:00Z");
    runner.use(() => (runner.steps.length === 2 ? { status: "quota_exhausted", resetsAt: new Date("2030-01-01T12:00:00Z") } : undefined));
    const started = await forge.startRun({ projectId: project.id, workflow: "looping", task: "Do the thing." });
    await forge.whenIdle();
    expect(await forge.getRun(started.id)).toMatchObject({ state: "paused" });

    fakeNow = new Date("2030-01-01T12:00:01Z");
    runner.use(() => {});
    runner.steps.length = 0;
    await forge.resumePausedRuns();
    await forge.whenIdle();

    const r = await forge.getRun(started.id);
    expect(runner.steps).toHaveLength(1);
    expect(stepsOf(r)).toEqual(["draft:done:1", "refine:done:1", "verify:done:1", "review:running:0"]);
  });
});
