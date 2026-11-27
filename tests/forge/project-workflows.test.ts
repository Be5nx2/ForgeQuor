import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createForge, type Forge, type Project } from "../../src/forge/forge.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote, git, type TempRemote, type TempRepo } from "../harness/git.js";

/** A Project's own Workflows (`forgequor/workflows/*.yaml` on its default branch), through the Forge core, with a real git remote. */

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
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-worktrees-"));
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
  const { repo, remote } = createRepoWithBareRemote({ remote: `git@github.com:acme/pw-${++counter}.git` });
  cleanups.push(repo.cleanup, remote.cleanup);
  const project = await forge.registerProject({ path: repo.path });
  remote.pointOriginAtBare();
  return { project, repo, remote };
}

const workflowFile = (name: string) => `forgequor/workflows/${name}.yaml`;

/** A Workflow of the Project that just codes a task and asks for a review: no Checks, no pull request step. */
const HOTFIX = `
name: hotfix
description: A quick fix, reviewed at once.
inputs: [task]
steps:
  - id: fix
    type: agent
    agent: developer
  - id: publish
    type: publish
    needs: [fix]
  - id: review
    type: gate
    gate: final
    needs: [publish]
    on_reject: fix
`;

describe("listing a Project's Workflows", () => {
  it("lists the built-in ones, each marked built-in, when the Project brings none", async () => {
    const { project } = await projectWithRemote();

    const { workflows, problem } = await forge.listWorkflows(project.id);

    expect(problem).toBeNull();
    expect(workflows).toMatchObject([
      { name: "developer", origin: "built-in", inputs: ["task"], errors: [], file: null },
      { name: "bugfix", origin: "built-in", inputs: ["task", "review"], reviewDefault: "solo", errors: [], file: null },
      { name: "feature", origin: "built-in", inputs: ["task", "review"], reviewDefault: "duo", errors: [], file: null },
      { name: "assets", origin: "built-in", inputs: ["assets"], errors: [], file: null },
    ]);
  });

  it("adds the Workflows of forgequor/workflows/*.yaml on the freshly fetched default branch, marked Project", async () => {
    const { project, remote } = await projectWithRemote();
    remote.advance(workflowFile("hotfix"), HOTFIX);
    remote.advance("forgequor/workflows/notes.txt", "not a Workflow");

    const { workflows } = await forge.listWorkflows(project.id);

    expect(workflows.map((w) => `${w.name}:${w.origin}`)).toEqual(["developer:built-in", "bugfix:built-in", "feature:built-in", "assets:built-in", "hotfix:project"]);
    expect(workflows[4]).toMatchObject({ description: "A quick fix, reviewed at once.", inputs: ["task"], errors: [], file: workflowFile("hotfix") });
  });

  it("lets a Project Workflow named like a built-in one replace it for that Project only", async () => {
    const { project, remote } = await projectWithRemote();
    const other = await projectWithRemote();
    remote.advance(workflowFile("developer"), HOTFIX.replace("name: hotfix", "name: developer"));

    const mine = (await forge.listWorkflows(project.id)).workflows.filter((w) => w.name === "developer");
    const theirs = (await forge.listWorkflows(other.project.id)).workflows.filter((w) => w.name === "developer");

    expect(mine).toMatchObject([{ origin: "project", description: "A quick fix, reviewed at once." }]);
    expect(theirs).toMatchObject([{ origin: "built-in" }]);
  });

  it("lists an invalid Workflow with its errors, and the one that does not fit Forgequor too", async () => {
    const { project, remote } = await projectWithRemote();
    remote.advance(workflowFile("broken"), "name: broken\ninputs: [task]\nsteps:\n  - id: a\n    type: nonsense\n");
    remote.advance(workflowFile("both"), HOTFIX.replace("name: hotfix", "name: both").replace("[task]", "[task, assets]"));
    remote.advance(workflowFile("misnamed"), HOTFIX);
    remote.advance(workflowFile("silent"), HOTFIX.replace("name: hotfix", "name: silent").replace("inputs: [task]", ""));
    remote.advance(workflowFile("moods"), HOTFIX.replace("name: hotfix", "name: moods").replace("[task]", "[task, mood]"));

    const listed = new Map((await forge.listWorkflows(project.id)).workflows.map((w) => [w.name, w]));

    expect(listed.get("broken")).toMatchObject({ origin: "project", inputs: [], file: workflowFile("broken") });
    expect(listed.get("broken")!.errors[0]).toMatchObject({ line: 5, message: expect.stringContaining("unknown type") });
    expect(listed.get("both")!.errors[0]!.message).toContain("no way to launch");
    expect(listed.get("misnamed")!.errors[0]!.message).toContain("must match");
    expect(listed.get("silent")!.errors[0]!.message).toContain("at least one launch input");
    expect(listed.get("moods")!.errors[0]!.message).toContain("Unknown input");
  });

  it("lists only the built-in Workflows, saying why, when the remote cannot be read", async () => {
    const { project, repo } = await projectWithRemote();
    git(repo.path, "remote", "set-url", "origin", join(repo.path, "nowhere"));

    const { workflows, problem } = await forge.listWorkflows(project.id);

    expect(workflows.map((w) => w.name)).toEqual(["developer", "bugfix", "feature", "assets"]);
    expect(problem).toContain("could not be read");
  });
});

describe("launching a Project Workflow", () => {
  it("runs the Workflow of the file as it is on the default branch now, with the built-in launch rules", async () => {
    const { project, remote } = await projectWithRemote();
    await forge.listWorkflows(project.id);
    remote.advance(workflowFile("hotfix"), HOTFIX);

    const started = await forge.startRun({ projectId: project.id, workflow: "hotfix", task: "Fix the crash." });
    await forge.whenIdle();

    const run = await forge.getRun(started.id);
    expect(run).toMatchObject({ workflow: "hotfix", state: "waiting" });
    expect(run.steps.map((s) => `${s.id}:${s.status}`).slice(0, 2)).toEqual(["fix:done", "publish:done"]);
    expect(runner.steps[0]!.prompt).toContain("Fix the crash.");
    expect(codeHost.pullRequests).toHaveLength(1);
    expect(run.gates).toMatchObject([{ kind: "final", decision: null }]);
    await expect(forge.startRun({ projectId: project.id, workflow: "hotfix" })).rejects.toThrow("A Run needs a task");
  });

  it("runs a Project Workflow that replaces a built-in one", async () => {
    const { project, remote } = await projectWithRemote();
    remote.advance(workflowFile("developer"), HOTFIX.replace("name: hotfix", "name: developer"));

    const started = await forge.startRun({ projectId: project.id, task: "Do it." });
    await forge.whenIdle();

    const run = await forge.getRun(started.id);
    expect(run.workflow).toBe("developer");
    expect(run.steps.map((s) => s.id)).toEqual(["fix", "publish", "review"]);
  });

  it("refuses an invalid Workflow, listing its errors, and creates no Run", async () => {
    const { project, remote } = await projectWithRemote();
    remote.advance(workflowFile("broken"), "name: broken\ninputs: [task]\nsteps:\n  - id: a\n    type: nonsense\n");

    await expect(forge.startRun({ projectId: project.id, workflow: "broken", task: "x" })).rejects.toThrow(/broken.*invalid[\s\S]*line 5: .*unknown type/);

    expect(await forge.listRuns({ projectId: project.id })).toEqual([]);
  });

  it("refuses an invalid Project Workflow named like a built-in one instead of falling back to the built-in", async () => {
    const { project, remote } = await projectWithRemote();
    remote.advance(workflowFile("developer"), "name: developer\nsteps: []\n");

    await expect(forge.startRun({ projectId: project.id, task: "x" })).rejects.toThrow(/developer.*invalid/);

    expect(await forge.listRuns({ projectId: project.id })).toEqual([]);
  });

  it("gives a Project Workflow of Asset Requests the launch rules of the assets Workflow", async () => {
    const { project, remote } = await projectWithRemote();
    remote.advance(
      workflowFile("gallery"),
      "name: gallery\ninputs: [assets]\nsteps:\n  - id: draw\n    type: artist\n  - id: review\n    type: gate\n    gate: asset\n    needs: [draw]\n    on_reject: draw\n  - id: publish\n    type: publish\n    needs: [review]\n",
    );

    expect((await forge.listWorkflows(project.id)).workflows.find((w) => w.name === "gallery")).toMatchObject({ origin: "project", inputs: ["assets"], errors: [] });
    await expect(forge.startRun({ projectId: project.id, workflow: "gallery", assets: [] })).rejects.toThrow("at least one Asset Request");
  });

  it("refuses an unknown Workflow", async () => {
    const { project } = await projectWithRemote();

    await expect(forge.startRun({ projectId: project.id, workflow: "ghost", task: "x" })).rejects.toThrow('Unknown Workflow "ghost"');
  });
});

describe("a Run's frozen Workflow", () => {
  it("keeps the Steps it started with after the file changes or goes away, through a rejection and a restart", async () => {
    const { project, remote } = await projectWithRemote();
    remote.advance(workflowFile("hotfix"), HOTFIX);
    const started = await forge.startRun({ projectId: project.id, workflow: "hotfix", task: "Fix the crash." });
    await forge.whenIdle();
    remote.advance(
      workflowFile("hotfix"),
      HOTFIX.replace("  - id: publish\n    type: publish\n    needs: [fix]\n", "  - id: verify\n    type: checks\n    needs: [fix]\n  - id: publish\n    type: publish\n    needs: [verify]\n").replace("needs: [publish]", "needs: [publish]"),
    );
    const changed = (await forge.listWorkflows(project.id)).workflows.find((w) => w.name === "hotfix");
    expect(changed!.errors).toEqual([]);

    const gate = (await forge.getRun(started.id)).gates[0]!;
    await forge.decideGate({ gateId: gate.id, action: "reject", feedback: "Again." });
    await forge.whenIdle();

    const run = await forge.getRun(started.id);
    expect(run.iteration).toBe(2);
    expect(run.steps.map((s) => s.id)).toEqual(["fix", "publish", "review"]);
    expect(run.state).toBe("waiting");

    remote.advance(workflowFile("hotfix"), "not: [a workflow");
    const restarted = createForge({ pool, runner, codeHost, worktreesRoot: worktrees });
    await restarted.recoverAfterRestart();
    await restarted.whenIdle();
    await forge.decideGate({ gateId: (await forge.getRun(started.id)).gates.at(-1)!.id, action: "reject", feedback: "Once more." });
    await forge.whenIdle();

    expect(await forge.getRun(started.id)).toMatchObject({ iteration: 3, state: "waiting" });
    expect((await forge.getRun(started.id)).steps.map((s) => s.id)).toEqual(["fix", "publish", "review"]);
  });
});
