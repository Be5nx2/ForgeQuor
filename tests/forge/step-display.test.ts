import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createForge, type Forge, type Project } from "../../src/forge/forge.js";
import { createTestDatabase } from "../harness/database.js";
import { checksStepType } from "../../src/forge/step-types.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote, type TempRemote, type TempRepo } from "../harness/git.js";

/** What the Run detail shows of a Run's Steps once the Run is over. */

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
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-step-display-"));
  forge = createForge({ pool, runner, codeHost, worktreesRoot: worktrees });
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

async function projectWithRemote(): Promise<{ project: Project; repo: TempRepo; remote: TempRemote }> {
  const { repo, remote } = createRepoWithBareRemote({ remote: `git@github.com:acme/display-${++counter}.git` });
  cleanups.push(repo.cleanup, remote.cleanup);
  const project = await forge.registerProject({ path: repo.path });
  remote.pointOriginAtBare();
  return { project, repo, remote };
}

describe("the Steps of a Run recorded before Steps were", () => {
  it.each(["approved", "merged", "closed"])("all read done when the Run is %s", async (state) => {
    const { project } = await projectWithRemote();
    const { rows } = await pool.query("INSERT INTO runs (project_id, title, task, state) VALUES ($1, 'Old', 'Old task', $2) RETURNING id", [project.id, state]);

    const run = await forge.getRun(Number(rows[0].id));

    expect(run.steps.length).toBeGreaterThan(0);
    expect(run.steps.map((s) => s.status)).toEqual(run.steps.map(() => "done"));
  });
});

describe("the Steps of an abandoned Run", () => {
  it("none reads running when the Run is abandoned while it works", async () => {
    const { project } = await projectWithRemote();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // The Developer has really started once the Runner is called: wait for that, not for a fixed time.
    let working!: () => void;
    const developerStarted = new Promise<void>((r) => (working = r));
    runner.use(async () => {
      working();
      await gate;
    });
    const started = await forge.startRun({ projectId: project.id, task: "Make the player jump." });
    await developerStarted;
    expect((await forge.getRun(started.id)).steps.some((s) => s.status === "running")).toBe(true);

    const abandoned = await forge.abandonRun(started.id);
    release();
    await forge.whenIdle();

    expect(abandoned.steps.some((s) => s.status === "running")).toBe(false);
    expect((await forge.getRun(started.id)).steps.some((s) => s.status === "running")).toBe(false);
    expect((await forge.getRun(started.id)).steps.find((s) => s.type === "agent")).toMatchObject({ status: "failed" });
  });

  it("none reads running when the Run is abandoned at its Gate", async () => {
    const { project } = await projectWithRemote();
    const started = await forge.startRun({ projectId: project.id, task: "Make the player jump." });
    await forge.whenIdle();
    const waiting = await forge.getRun(started.id);
    expect(waiting.steps.find((s) => s.type === "gate")).toMatchObject({ status: "running" });

    const gateId = waiting.gates.find((g) => !g.decision)!.id;
    const after = await forge.decideGate({ gateId, action: "abandon" });

    expect(after.state).toBe("abandoned");
    expect(after.steps.some((s) => s.status === "running")).toBe(false);
    expect(after.steps.find((s) => s.type === "gate")).toMatchObject({ status: "failed" });
  });
});

describe("the reason of an exhausted Step", () => {
  it.each([
    [1, "attempt"],
    [3, "attempts"],
  ])("counts %i %s", (n, word) => {
    expect(checksStepType.exhausted!({ id: "verify", type: "checks", needs: [] } as never, n)).toBe(`A Check still fails after ${n} ${word}.`);
  });
});
