import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** Read-only Steps that run side by side, through the Forge core, with small test Workflows. */

let invalidOnce = new Set<string>();

/** A read-only Agent. Its Step is sent back once when `invalidOnce` holds its name. */
const looker = (name: string): AgentModule => ({
  name,
  seat: "developer",
  instructions: `You are the ${name}.`,
  async prompt(ctx) {
    return `Look for: ${ctx.run.task}`;
  },
  async harvest() {
    if (invalidOnce.delete(name)) return { invalid: `The ${name} saw nothing.` };
    return { produced: [] };
  },
});
const lookers = [looker("lookerA"), looker("lookerB")];

function workflowOf(yaml: string): Workflow {
  const parsed = parseWorkflow(yaml, catalogueOf([developerAgent, ...lookers]));
  if (!parsed.ok) throw new Error(`Test Workflow is invalid: ${JSON.stringify(parsed.errors)}`);
  const { definition } = parsed;
  return { name: definition.name, inputs: definition.inputs, definition, plan: ({ task, title }) => ({ task: task!, title: title ?? "A test Run" }) };
}

const FANOUT = workflowOf(`
name: fanout
inputs: [task]
steps:
  - id: a
    type: agent
    agent: lookerA
    readonly: true
  - id: b
    type: agent
    agent: lookerB
    readonly: true
  - id: review
    type: gate
    gate: final
    needs: [a, b]
`);

const LONE = workflowOf(`
name: lone
inputs: [task]
steps:
  - id: a
    type: agent
    agent: lookerA
    readonly: true
  - id: review
    type: gate
    gate: final
    needs: [a]
`);

const BESIDE_CHECKS = workflowOf(`
name: beside-checks
inputs: [task]
steps:
  - id: build
    type: agent
    agent: developer
  - id: a
    type: agent
    agent: lookerA
    needs: [build]
    readonly: true
  - id: verify
    type: checks
    needs: [build]
    readonly: true
    on_reject: build
  - id: review
    type: gate
    gate: final
    needs: [a, verify]
`);

const TEAM: Extension = {
  workflows: [FANOUT, LONE, BESIDE_CHECKS],
  gateKinds: [],
  agents: lookers,
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
const runner = createFakeRunner();
const codeHost = createFakeCodeHost();
const cleanups: Array<() => void> = [];
const others: Forge[] = [];
let counter = 0;

function forgeWith(overrides: Partial<ForgeDeps> = {}): Forge {
  const created = createForge({ pool, runner, codeHost, worktreesRoot: worktrees, extensions: [TEAM], ...overrides });
  others.push(created);
  return created;
}

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  pool = db.pool;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-parallel-"));
  forge = forgeWith();
});
afterAll(async () => {
  await Promise.all(others.map((f) => f.whenIdle()));
  await drop();
  rmSync(worktrees, { recursive: true, force: true });
});
afterEach(() => {
  runner.use(() => {});
  runner.steps.length = 0;
  invalidOnce = new Set();
  cleanups.splice(0).forEach((c) => c());
});

async function projectWithRemote(): Promise<Project> {
  const { repo, remote } = createRepoWithBareRemote({ remote: `git@github.com:acme/parallel-${++counter}.git` }) as { repo: TempRepo; remote: TempRemote };
  cleanups.push(repo.cleanup, remote.cleanup);
  const project = await forge.registerProject({ path: repo.path });
  remote.pointOriginAtBare();
  return project;
}

async function run(project: Project, workflow = "fanout"): Promise<RunDetail> {
  const started = await forge.startRun({ projectId: project.id, workflow, task: "Look around." });
  await forge.whenIdle();
  return forge.getRun(started.id);
}

const stepsOf = (r: RunDetail) => r.steps.map((s) => `${s.id}:${s.status}:${s.attempts}`);
const escalations = (r: RunDetail) => r.gates.filter((g) => g.kind === "escalation");
const instructionsOf = (step: { instructions: string }) => step.instructions.replace(/^You are the |\.$/g, "");

/** A script that holds each Agent until `n` of them have started, then lets them all go: it only gets through if they overlap. */
function meetingOf(n: number, then: (step: { cwd: string; instructions: string }) => ReturnType<Parameters<typeof runner.use>[0]> = () => {}) {
  let release!: () => void;
  const together = new Promise<void>((r) => (release = r));
  const timedOut = new Promise<"never met">((r) => setTimeout(() => r("never met"), 4000));
  return async (step: { cwd: string; instructions: string }) => {
    if (runner.steps.length >= n) release();
    if ((await Promise.race([together.then(() => "met"), timedOut])) !== "met") return { status: "failed" as const, error: "The Steps never ran at the same time." };
    return then(step);
  };
}

describe("read-only Steps whose needs are met", () => {
  it("start together and really overlap", async () => {
    const project = await projectWithRemote();
    // Each Agent waits for the other to start: a Run that did one Step at a time would never get past the first.
    runner.use(
      meetingOf(2, (step) => {
        mkdirSync(join(step.cwd, ".forgequor"), { recursive: true });
        writeFileSync(join(step.cwd, ".forgequor", `${instructionsOf(step)}.md`), "Run Notes are free to write.\n");
      }),
    );

    const r = await run(project);

    expect(runner.steps.map(instructionsOf).sort()).toEqual(["lookerA", "lookerB"]);
    expect(stepsOf(r)).toEqual(["a:done:1", "b:done:1", "review:running:0"]);
    expect(r.gates).toMatchObject([{ kind: "final", stepId: "review" }]);
    expect(r.attempts.map((a) => [a.stepId, a.status])).toEqual([["a", "succeeded"], ["b", "succeeded"]]);
  });

  it("send back only the Step that rejects, never its running sibling", async () => {
    const project = await projectWithRemote();
    invalidOnce.add("lookerB");
    runner.use(meetingOf(2));

    const r = await run(project);

    // B was sent back to itself once; A, which ran beside it, was left alone.
    expect(runner.steps.map(instructionsOf).sort()).toEqual(["lookerA", "lookerB", "lookerB"]);
    expect(stepsOf(r)).toEqual(["a:done:1", "b:done:2", "review:running:0"]);
    expect(escalations(r)).toHaveLength(0);
  });

  it("replay a finished sibling when the other rejects back to their common ancestor", async () => {
    const project = await projectWithRemote();
    await forge.setChecks(project.id, ["test -f fixed.txt || { echo missing fixed.txt; exit 2; }"]);
    let developed = 0;
    runner.use((step) => {
      // The Developer's second pass fixes what the Check wanted.
      if (!step.instructions.startsWith("You are the looker") && ++developed === 2) writeFileSync(join(step.cwd, "fixed.txt"), "ok\n");
    });

    const r = await run(project, "beside-checks");

    expect(escalations(r)).toHaveLength(0);
    expect(r.checks.map((c) => [c.attempt, c.exitStatus])).toEqual([[1, 2], [2, 0]]);
    // Looker A ran beside the failing Checks, was replayed with the Developer, and ran beside the passing Checks.
    expect(r.attempts.filter((a) => a.stepId === "a")).toHaveLength(2);
    expect(stepsOf(r)).toEqual(["build:done:2", "a:done:2", "verify:done:2", "review:running:0"]);
  });

  it("open exactly one Escalation when both fail, for the first in definition order", async () => {
    const project = await projectWithRemote();
    runner.use(meetingOf(2, () => ({ status: "failed", error: "boom" })));

    const r = await run(project);

    expect(r.state).toBe("waiting");
    expect(r.gates).toHaveLength(1);
    expect(r.gates).toMatchObject([{ kind: "escalation", stepId: "a", reason: "The LookerA failed.", evidence: "boom" }]);
    // The other one failed all the same; it just did not open a second Gate.
    expect(stepsOf(r)).toEqual(["a:failed:0", "b:failed:0", "review:waiting:0"]);
  });

  it("open one Escalation, and let the other Step finish, when only one fails", async () => {
    const project = await projectWithRemote();
    runner.use(meetingOf(2, (step) => (instructionsOf(step) === "lookerB" ? { status: "failed", error: "boom" } : undefined)));

    const r = await run(project);

    expect(r.gates).toMatchObject([{ kind: "escalation", stepId: "b", reason: "The LookerB failed." }]);
    expect(stepsOf(r)).toEqual(["a:done:1", "b:failed:0", "review:waiting:0"]);
  });

  it("stop together when the Run is abandoned", async () => {
    const project = await projectWithRemote();
    let killed = 0;
    runner.use(async (step) => {
      await new Promise<void>((resolve) => step.signal?.addEventListener("abort", () => resolve(), { once: true }));
      killed++;
      return { status: "failed", error: "killed" };
    });
    const started = await forge.startRun({ projectId: project.id, workflow: "fanout", task: "Look around." });
    for (let i = 0; i < 200 && runner.steps.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(runner.steps).toHaveLength(2);

    await forge.abandonRun(started.id);
    await forge.whenIdle();

    const r = await forge.getRun(started.id);
    expect(killed).toBe(2);
    expect(r.state).toBe("abandoned");
    expect(r.gates).toHaveLength(0);
  });
});

describe("a read-only Step that changed the worktree", () => {
  it("fails with an Escalation naming the file written outside the Run Notes", async () => {
    const project = await projectWithRemote();
    runner.use(
      meetingOf(2, (step) => {
        if (instructionsOf(step) === "lookerB") writeFileSync(join(step.cwd, "stray.txt"), "I was only to look.\n");
      }),
    );

    const r = await run(project);

    expect(r.state).toBe("waiting");
    expect(r.gates).toHaveLength(1);
    expect(r.gates[0]).toMatchObject({ kind: "escalation", evidence: "stray.txt", reason: expect.stringContaining("outside the Run Notes") });
    expect(stepsOf(r).slice(0, 2).every((s) => s.includes(":failed:"))).toBe(true);
    expect(stepsOf(r)[2]).toBe("review:waiting:0");
  });

  it("fails a lone read-only Step that edited a tracked file or committed", async () => {
    const project = await projectWithRemote();
    runner.use((step) => {
      writeFileSync(join(step.cwd, "README.md"), "# changed\n");
    });
    const edited = await run(project, "lone");
    expect(edited.gates).toMatchObject([{ kind: "escalation", stepId: "a", evidence: "README.md" }]);
    expect(stepsOf(edited)).toEqual(["a:failed:0", "review:waiting:0"]);

    runner.use(async (step) => {
      const { execFileSync } = await import("node:child_process");
      writeFileSync(join(step.cwd, "added.txt"), "x\n");
      execFileSync("git", ["add", "."], { cwd: step.cwd });
      execFileSync("git", ["-c", "user.email=t@e.st", "-c", "user.name=T", "commit", "-q", "-m", "sneaky"], { cwd: step.cwd });
    });
    const committed = await run(project, "lone");
    expect(committed.gates).toMatchObject([{ kind: "escalation", stepId: "a", evidence: "added.txt" }]);
  });

  it("passes a lone read-only Step that only wrote Run Notes", async () => {
    const project = await projectWithRemote();
    runner.use((step) => {
      mkdirSync(join(step.cwd, ".forgequor"), { recursive: true });
      writeFileSync(join(step.cwd, ".forgequor", "notes.md"), "Seen.\n");
    });

    const r = await run(project, "lone");

    expect(stepsOf(r)).toEqual(["a:done:1", "review:running:0"]);
    expect(escalations(r)).toHaveLength(0);
  });
});

describe("a Run's slot", () => {
  it("counts once however many of its Steps run at the same time", async () => {
    const project = await projectWithRemote();
    await forge.setMaxConcurrentRuns(project.id, 2);
    let open!: () => void;
    const hold = new Promise<void>((r) => (open = r));
    runner.use(async () => {
      await hold;
    });

    const first = await forge.startRun({ projectId: project.id, workflow: "fanout", task: "First." });
    for (let i = 0; i < 200 && runner.steps.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(runner.steps).toHaveLength(2);
    // Two Steps of one Run are in flight, yet a second Run still has a slot, and only the third has to queue.
    const second = await forge.startRun({ projectId: project.id, workflow: "fanout", task: "Second." });
    const third = await forge.startRun({ projectId: project.id, workflow: "fanout", task: "Third." });

    expect([first.state, second.state, third.state]).toEqual(["running", "running", "queued"]);
    open();
    await forge.whenIdle();
  });
});
