import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createForge, GateError, InvalidInputError, type Forge, type GateAction, type Project, type RunDetail } from "../../src/forge/forge.js";
import { developerAgent } from "../../src/forge/developer.js";
import { AssetNotFoundError } from "../../src/forge/errors.js";
import type { Extension } from "../../src/forge/extension.js";
import { catalogueOf } from "../../src/forge/step-types.js";
import { parseWorkflow } from "../../src/forge/workflow-definition.js";
import type { Workflow } from "../../src/forge/workflow.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote, type TempRemote, type TempRepo } from "../harness/git.js";

/** Escalations with choices, through the Forge core: retry, go back, abandon. */

const parsed = parseWorkflow(
  `
name: pipeline
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
`,
  catalogueOf([developerAgent]),
);
if (!parsed.ok) throw new Error(`Test Workflow is invalid: ${JSON.stringify(parsed.errors)}`);
const PIPELINE: Workflow = {
  name: "pipeline",
  inputs: parsed.definition.inputs,
  definition: parsed.definition,
  plan: ({ task, title }) => ({ task: task!, title: title ?? "A test Run" }),
};
const TEAM: Extension = {
  workflows: [PIPELINE],
  gateKinds: [],
  async detail() {
    return { assets: [], gates: new Map() };
  },
  async assetImage() {
    throw new AssetNotFoundError("No assets here.");
  },
};

const CHECK = "test -f fixed.txt || { echo missing fixed.txt; exit 2; }";

let forge: Forge;
let pool: pg.Pool;
let drop: () => Promise<void>;
let worktrees: string;
const runner = createFakeRunner();
const codeHost = createFakeCodeHost();
const cleanups: Array<() => void> = [];
let counter = 0;

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  pool = db.pool;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-escalations-"));
  forge = createForge({ pool, runner, codeHost, worktreesRoot: worktrees, extensions: [TEAM] });
});
afterAll(async () => {
  await forge.whenIdle();
  await drop();
  rmSync(worktrees, { recursive: true, force: true });
});
afterEach(() => {
  runner.use(() => {});
  runner.steps.length = 0;
  codeHost.pullRequests.length = 0;
  cleanups.splice(0).forEach((c) => c());
});

async function projectWithChecks(): Promise<Project> {
  const { repo, remote } = createRepoWithBareRemote({ remote: `git@github.com:acme/escalation-${++counter}.git` }) as { repo: TempRepo; remote: TempRemote };
  cleanups.push(repo.cleanup, remote.cleanup);
  const project = await forge.registerProject({ path: repo.path });
  remote.pointOriginAtBare();
  return forge.setChecks(project.id, [CHECK]);
}

/** A Run whose Checks never pass: after draft, refine, verify, draft, refine, verify it escalates at `verify`. */
async function escalatedAtChecks(): Promise<RunDetail> {
  const project = await projectWithChecks();
  const started = await forge.startRun({ projectId: project.id, workflow: "pipeline", task: "Do the thing." });
  await forge.whenIdle();
  return forge.getRun(started.id);
}

const openEscalation = (r: RunDetail) => r.gates.find((g) => g.kind === "escalation" && !g.decidedAt)!;
const decide = async (gateId: number, input: { action: GateAction; feedback?: string; target?: string }) => {
  const result = await forge.decideGate({ gateId, ...input });
  await forge.whenIdle();
  return forge.getRun(result.id);
};
const stepsOf = (r: RunDetail) => r.steps.map((s) => `${s.id}:${s.status}:${s.attempts}`);

describe("an Escalation", () => {
  it("offers abandon, retrying the failed Step, and going back to the done Steps before it", async () => {
    const r = await escalatedAtChecks();

    expect(r.state).toBe("waiting");
    expect(openEscalation(r)).toMatchObject({ stepId: "verify", reason: "A Check still fails after 2 attempts.", actions: ["abandon"] });
    expect(openEscalation(r).redo).toEqual({
      goBack: [
        { stepId: "draft", type: "agent", detail: "developer" },
        { stepId: "refine", type: "agent", detail: "developer" },
      ],
    });
    expect(stepsOf(r)).toEqual(["draft:done:2", "refine:done:2", "verify:failed:2", "review:waiting:0"]);
  });

  it("is listed with its choices among the Gates waiting for the human", async () => {
    const r = await escalatedAtChecks();

    const listed = (await forge.listOpenGates()).find((g) => g.id === openEscalation(r).id)!;

    expect(listed.redo?.goBack.map((s) => s.stepId)).toEqual(["draft", "refine"]);
  });
});

describe("retrying the failed Step", () => {
  it("runs it again with a fresh attempt budget: a Checks loop that ran out can loop again", async () => {
    const r = await escalatedAtChecks();
    expect(runner.steps).toHaveLength(4);

    const again = await decide(openEscalation(r).id, { action: "retry" });

    // verify fails again (attempt 3), draft and refine run again, verify fails (attempt 4): the budget of 2 starts over, then the next Escalation.
    expect(runner.steps).toHaveLength(6);
    expect(again.iteration).toBe(1);
    expect(again.state).toBe("waiting");
    expect(again.checks.map((c) => c.attempt)).toEqual([1, 2, 3, 4]);
    expect(again.gates).toMatchObject([
      { kind: "escalation", decision: "retry", feedback: null },
      { kind: "escalation", decision: null, stepId: "verify", reason: "A Check still fails after 2 attempts." },
    ]);
    expect(stepsOf(again)).toEqual(["draft:done:3", "refine:done:3", "verify:failed:4", "review:waiting:0"]);
  });

  it("goes on to the final Gate once what failed is fixed", async () => {
    const r = await escalatedAtChecks();
    writeFileSync(join(r.worktreePath!, "fixed.txt"), "ok\n");

    const again = await decide(openEscalation(r).id, { action: "retry" });

    expect(runner.steps).toHaveLength(4);
    expect(again.gates.map((g) => [g.kind, g.decision])).toEqual([["escalation", "retry"], ["final", null]]);
    expect(stepsOf(again)).toEqual(["draft:done:2", "refine:done:2", "verify:done:3", "review:running:0"]);
  });

  it("hands the optional Feedback to the Agent Steps it replays, like a Gate's Feedback", async () => {
    const r = await escalatedAtChecks();

    await decide(openEscalation(r).id, { action: "retry", feedback: "  Mind the fixed.txt file.  " });

    const prompts = runner.steps.slice(4).map((s) => s.prompt);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) expect(prompt).toContain("Feedback so far, oldest first:\n1. Mind the fixed.txt file.");
    expect(runner.steps[0]!.prompt).not.toContain("Feedback so far");
  });

  it("keeps the Feedback on the Escalation, without starting a new Iteration", async () => {
    const r = await escalatedAtChecks();

    const again = await decide(openEscalation(r).id, { action: "retry", feedback: "Try again." });

    expect(again.gates[0]).toMatchObject({ decision: "retry", feedback: "Try again." });
    expect(again.iterations).toEqual([{ number: 1, feedback: null }]);
  });

  it("refuses an Escalation that is already decided", async () => {
    const r = await escalatedAtChecks();
    const gateId = openEscalation(r).id;
    await decide(gateId, { action: "retry" });

    await expect(forge.decideGate({ gateId, action: "retry" })).rejects.toBeInstanceOf(GateError);
  });

  it("is not offered at a final Gate", async () => {
    const r = await escalatedAtChecks();
    writeFileSync(join(r.worktreePath!, "fixed.txt"), "ok\n");
    const atFinal = await decide(openEscalation(r).id, { action: "retry" });
    const final = atFinal.gates.find((g) => g.kind === "final")!;

    expect(final.redo).toBeNull();
    await expect(forge.decideGate({ gateId: final.id, action: "retry" })).rejects.toThrow(/cannot be retried/);
    await expect(forge.decideGate({ gateId: final.id, action: "go_back", target: "draft", feedback: "No." })).rejects.toBeInstanceOf(GateError);
  });
});

describe("going back to an earlier Step", () => {
  it("replays that Step and every Step after it, in order, with the Feedback, without reverting files", async () => {
    const r = await escalatedAtChecks();
    // What the Run's earlier work left in the worktree stays.
    writeFileSync(join(r.worktreePath!, "kept.txt"), "work in progress\n");

    const again = await decide(openEscalation(r).id, { action: "go_back", target: "refine", feedback: "Refine it differently." });

    // refine again, then the Checks fail (attempt 3), the loop goes back to draft and refine, then the Checks fail again.
    expect(runner.steps.slice(4).map((s) => s.prompt.includes("Task:"))).toEqual([true, true, true]);
    expect(runner.steps[4]!.prompt).toContain("1. Refine it differently.");
    expect(existsSync(join(r.worktreePath!, "kept.txt"))).toBe(true);
    expect(again.iteration).toBe(1);
    expect(again.gates[0]).toMatchObject({ decision: "go_back", feedback: "Refine it differently." });
    expect(again.attempts.map((a) => [a.stepId, a.attempt]).slice(4)).toEqual([["refine", 3], ["draft", 3], ["refine", 4]]);
  });

  it("replays everything from the first Step when it is the one chosen, in Workflow order", async () => {
    const r = await escalatedAtChecks();
    writeFileSync(join(r.worktreePath!, "fixed.txt"), "ok\n");

    const again = await decide(openEscalation(r).id, { action: "go_back", target: "draft", feedback: "Start over." });

    expect(runner.steps.slice(4)).toHaveLength(2);
    expect(again.attempts.map((a) => a.stepId).slice(4)).toEqual(["draft", "refine"]);
    expect(runner.steps[4]!.prompt).toContain("1. Start over.");
    expect(again.checks.map((c) => [c.attempt, c.exitStatus]).slice(-1)).toEqual([[3, 0]]);
    expect(again.gates.map((g) => [g.kind, g.decision])).toEqual([["escalation", "go_back"], ["final", null]]);
    expect(stepsOf(again)).toEqual(["draft:done:3", "refine:done:3", "verify:done:3", "review:running:0"]);
  });

  it("refuses a Step that is not done, one after the failed Step, an unknown one and a missing Feedback, leaving the Escalation open", async () => {
    const r = await escalatedAtChecks();
    const gateId = openEscalation(r).id;
    const goBack = (target: string | undefined, feedback?: string) => forge.decideGate({ gateId, action: "go_back", target, feedback });

    await expect(goBack("verify", "Again.")).rejects.toBeInstanceOf(InvalidInputError);
    await expect(goBack("review", "Again.")).rejects.toBeInstanceOf(InvalidInputError);
    await expect(goBack("nowhere", "Again.")).rejects.toBeInstanceOf(InvalidInputError);
    await expect(goBack(undefined, "Again.")).rejects.toBeInstanceOf(InvalidInputError);
    await expect(goBack("draft")).rejects.toThrow(/Feedback/);
    await expect(goBack("draft", "   ")).rejects.toBeInstanceOf(InvalidInputError);

    const still = await forge.getRun(r.id);
    expect(still.state).toBe("waiting");
    expect(openEscalation(still).id).toBe(gateId);
    expect(runner.steps).toHaveLength(4);
  });
});

describe("abandoning an Escalation", () => {
  it("stays available", async () => {
    const r = await escalatedAtChecks();

    const done = await decide(openEscalation(r).id, { action: "abandon" });

    expect(done.state).toBe("abandoned");
  });
});

describe("an Escalation that names no Step", () => {
  /** The Escalation the Run is at, as a Run from before M3a (or a Run that failed outside any Step) leaves it. */
  async function withoutStep(): Promise<RunDetail> {
    const r = await escalatedAtChecks();
    await pool.query("UPDATE gates SET step = NULL WHERE id = $1", [openEscalation(r).id]);
    return forge.getRun(r.id);
  }

  it("offers retry and abandon, and no Step to go back to", async () => {
    const r = await withoutStep();

    expect(openEscalation(r)).toMatchObject({ stepId: null, redo: { goBack: [] } });
    await expect(forge.decideGate({ gateId: openEscalation(r).id, action: "go_back", target: "draft", feedback: "No." })).rejects.toBeInstanceOf(GateError);
  });

  it("retries the Run from where it stands: every Step that failed starts again with a fresh budget", async () => {
    const r = await withoutStep();
    writeFileSync(join(r.worktreePath!, "fixed.txt"), "ok\n");

    const again = await decide(openEscalation(r).id, { action: "retry" });

    expect(runner.steps).toHaveLength(4);
    expect(again.gates.map((g) => [g.kind, g.decision])).toEqual([["escalation", "retry"], ["final", null]]);
    expect(stepsOf(again)).toEqual(["draft:done:2", "refine:done:2", "verify:done:3", "review:running:0"]);
  });

  it("can still be abandoned", async () => {
    const r = await withoutStep();

    expect((await decide(openEscalation(r).id, { action: "abandon" })).state).toBe("abandoned");
  });
});
