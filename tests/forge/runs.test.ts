import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createForge, type Forge, type Project } from "../../src/forge/forge.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote, git, type TempRemote, type TempRepo } from "../harness/git.js";

let forge: Forge;
let drop: () => Promise<void>;
let worktrees: string;
const runner = createFakeRunner();
const codeHost = createFakeCodeHost();
const cleanups: Array<() => void> = [];
let counter = 0;

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-worktrees-"));
  forge = createForge({ pool: db.pool, runner, codeHost, worktreesRoot: worktrees });
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
  codeHost.failWith(null);
  cleanups.splice(0).forEach((c) => c());
});

/** A registered Project whose `origin` is a real (bare) remote. */
async function projectWithRemote(): Promise<{ project: Project; repo: TempRepo; remote: TempRemote }> {
  const { repo, remote } = createRepoWithBareRemote({ remote: `git@github.com:acme/game-${++counter}.git` });
  cleanups.push(repo.cleanup, remote.cleanup);
  const project = await forge.registerProject({ path: repo.path });
  remote.pointOriginAtBare();
  return { project, repo, remote };
}

describe("starting a Run", () => {
  it("works in its own worktree and waits at the final Gate", async () => {
    const { project } = await projectWithRemote();

    const started = await forge.startRun({ projectId: project.id, title: "Add jump", task: "Make the player jump." });
    await forge.whenIdle();

    const run = await forge.getRun(started.id);
    expect(run.state).toBe("waiting");
    expect(run.title).toBe("Add jump");
    expect(run.branch).toMatch(/^forgequor\/.*add-jump/);
    expect(git(run.worktreePath!, "rev-parse", "--abbrev-ref", "HEAD")).toBe(run.branch);
    expect(runner.steps).toHaveLength(1);
    expect(runner.steps[0]!.cwd).toBe(run.worktreePath);
    expect(runner.steps[0]!.prompt).toContain("Make the player jump.");
    expect(run.attempts).toMatchObject([{ step: "developer", attempt: 1, status: "succeeded" }]);
    expect(run.gates).toMatchObject([{ kind: "final", actions: ["approve", "abandon"], decision: null }]);
  });
});

async function runToEnd(project: Project, input: { task?: string; title?: string; trackerRef?: string } = {}) {
  const started = await forge.startRun({ projectId: project.id, task: input.task ?? "Do the thing.", ...input });
  await forge.whenIdle();
  return forge.getRun(started.id);
}

describe("the Run's starting point", () => {
  it("derives a title from the task and keeps the tracker reference", async () => {
    const { project } = await projectWithRemote();

    const run = await runToEnd(project, { task: "Add a double jump\nwith a short cooldown", trackerRef: "$12a" });

    expect(run.title).toBe("Add a double jump");
    expect(run.trackerRef).toBe("$12a");
  });

  it("starts from the freshly fetched default branch, not from the local checkout", async () => {
    const { project, remote } = await projectWithRemote();
    remote.advance("level-2.txt", "new level\n");

    const run = await runToEnd(project);

    expect(readFileSync(join(run.worktreePath!, "level-2.txt"), "utf8")).toBe("new level\n");
  });

  it("follows the remote's default branch when it changed since registration", async () => {
    const { project, remote } = await projectWithRemote();
    remote.setDefaultBranch("trunk");
    remote.advance("only-on-trunk.txt", "trunk\n", { branch: "trunk" });

    const run = await runToEnd(project);

    expect(existsSync(join(run.worktreePath!, "only-on-trunk.txt"))).toBe(true);
    expect((await forge.listProjects()).find((p) => p.id === project.id)?.defaultBranch).toBe("trunk");
  });

  it("gives each Run its own worktree and branch", async () => {
    const { project } = await projectWithRemote();

    const a = await runToEnd(project, { task: "First" });
    const b = await runToEnd(project, { task: "First" });

    expect(a.worktreePath).not.toBe(b.worktreePath);
    expect(a.branch).not.toBe(b.branch);
    expect(existsSync(a.worktreePath!)).toBe(true);
    expect(existsSync(b.worktreePath!)).toBe(true);
  });
});

describe("the Developer's work", () => {
  it("keeps the Developer's own commits", async () => {
    const { project } = await projectWithRemote();
    runner.use((step) => {
      writeFileSync(join(step.cwd, "jump.gd"), "extends Node\n");
      git(step.cwd, "add", ".");
      git(step.cwd, "commit", "-q", "-m", "feat(player): add jump");
    });

    const run = await runToEnd(project);

    expect(git(run.worktreePath!, "log", "--format=%s", "origin/main..HEAD")).toBe("feat(player): add jump");
  });

  it("commits whatever the Developer left uncommitted", async () => {
    const { project } = await projectWithRemote();
    runner.use((step) => writeFileSync(join(step.cwd, "forgotten.gd"), "extends Node\n"));

    const run = await runToEnd(project);

    expect(git(run.worktreePath!, "status", "--porcelain")).toBe("");
    expect(git(run.worktreePath!, "show", "--name-only", "--format=", "HEAD")).toBe("forgotten.gd");
  });

  it("keeps Run Notes out of git without touching the Project's files", async () => {
    const { project, repo } = await projectWithRemote();
    runner.use((step) => {
      mkdirSync(join(step.cwd, ".forgequor"), { recursive: true });
      writeFileSync(join(step.cwd, ".forgequor", "review-brief.md"), "Test the jump.\n");
      writeFileSync(join(step.cwd, "jump.gd"), "extends Node\n");
    });

    const run = await runToEnd(project);

    expect(readFileSync(join(run.worktreePath!, ".forgequor", "review-brief.md"), "utf8")).toBe("Test the jump.\n");
    expect(git(run.worktreePath!, "ls-files")).not.toContain(".forgequor");
    expect(git(run.worktreePath!, "show", "--name-only", "--format=", "HEAD")).toBe("jump.gd");
    expect(git(repo.path, "status", "--porcelain")).toBe("");
    expect(existsSync(join(repo.path, ".gitignore"))).toBe(false);
  });

  it("tells the Developer where to write the Review Brief and how to commit", async () => {
    const { project } = await projectWithRemote();

    await runToEnd(project);

    expect(runner.steps[0]!.instructions).toContain(".forgequor/review-brief.md");
    expect(runner.steps[0]!.instructions).toMatch(/Conventional Commits/);
  });
});

describe("when the Developer cannot finish", () => {
  it("opens an Escalation with the error, which can only be abandoned", async () => {
    const { project } = await projectWithRemote();
    runner.use(() => ({ status: "failed", error: "claude crashed" }));

    const run = await runToEnd(project);

    expect(run.state).toBe("waiting");
    expect(run.attempts).toMatchObject([{ status: "failed", error: "claude crashed" }]);
    expect(run.gates).toMatchObject([{ kind: "escalation", actions: ["abandon"], evidence: "claude crashed" }]);
  });

  it("opens an Escalation when the Run cannot be set up", async () => {
    const { project, remote } = await projectWithRemote();
    rmSync(remote.bare, { recursive: true, force: true });

    const run = await runToEnd(project);

    expect(run.gates).toMatchObject([{ kind: "escalation" }]);
    expect(runner.steps).toHaveLength(0);
  });
});

const BRIEF = ".forgequor/review-brief.md";

function developerCommits(step: { cwd: string }, brief?: string) {
  writeFileSync(join(step.cwd, "jump.gd"), "extends Node\n");
  git(step.cwd, "add", ".");
  git(step.cwd, "commit", "-q", "-m", "feat(player): add jump");
  if (brief !== undefined) writeFileSync(join(step.cwd, BRIEF), brief);
}

describe("the pull request", () => {
  it("pushes the branch and opens a ready pull request with the task and a Run reference, before the final Gate", async () => {
    const { project, remote } = await projectWithRemote();
    runner.use((step) => developerCommits(step, "Test the jump on level 1.\n"));

    const run = await runToEnd(project, { title: "Add jump", task: "Make the player jump." });

    expect(git(remote.bare, "branch", "--list", run.branch!)).toContain(run.branch);
    expect(codeHost.pullRequests).toHaveLength(1);
    const pr = codeHost.pullRequests[0]!;
    expect(pr).toMatchObject({ owner: "acme", base: "main", head: run.branch, title: "Add jump" });
    expect(pr.repo).toBe(project.remoteName);
    expect(pr.body).toContain("Make the player jump.");
    expect(pr.body).toContain(`Forgequor Run #${run.id}`);
    expect(run).toMatchObject({ state: "waiting", prNumber: pr.number, prUrl: pr.url });
    expect(run.gates).toMatchObject([{ kind: "final" }]);
  });

  it("posts the Review Brief as a comment", async () => {
    const { project } = await projectWithRemote();
    runner.use((step) => developerCommits(step, "Test the jump on level 1.\n"));

    await runToEnd(project);

    expect(codeHost.pullRequests[0]!.comments).toEqual(["Test the jump on level 1.\n"]);
  });

  it("says no brief was written when the Developer left none", async () => {
    const { project } = await projectWithRemote();
    runner.use((step) => developerCommits(step));

    const run = await runToEnd(project);

    expect(run.state).toBe("waiting");
    expect(codeHost.pullRequests[0]!.comments).toHaveLength(1);
    expect(codeHost.pullRequests[0]!.comments[0]).toMatch(/no Review Brief/i);
  });

  it("refuses to push, and opens an Escalation, when a commit adds Run Notes", async () => {
    const { project, remote } = await projectWithRemote();
    runner.use((step) => {
      developerCommits(step, "Brief.\n");
      git(step.cwd, "add", "-f", BRIEF);
      git(step.cwd, "commit", "-q", "-m", "chore: oops");
    });

    const run = await runToEnd(project);

    expect(run.state).toBe("waiting");
    expect(run.gates).toMatchObject([{ kind: "escalation", actions: ["abandon"], reason: expect.stringMatching(/Run Notes/) }]);
    expect(git(remote.bare, "branch", "--list", run.branch!)).toBe("");
    expect(codeHost.pullRequests).toHaveLength(0);
  });

  it("opens an Escalation when the pull request cannot be opened", async () => {
    const { project } = await projectWithRemote();
    runner.use((step) => developerCommits(step));
    codeHost.failWith("gh: not authenticated");

    const run = await runToEnd(project);

    expect(run.gates).toMatchObject([{ kind: "escalation", evidence: expect.stringContaining("not authenticated") }]);
    expect(run.prUrl).toBeNull();
  });
});

describe("deciding a Gate", () => {
  it("approving the final Gate makes the Run Approved and clears it from the open Gates", async () => {
    const { project } = await projectWithRemote();
    const waiting = await runToEnd(project);

    const run = await forge.decideGate({ gateId: waiting.gates[0]!.id, action: "approve" });

    expect(run.state).toBe("approved");
    expect(run.gates).toMatchObject([{ kind: "final", decision: "approve" }]);
    expect(run.gates[0]!.decidedAt).not.toBeNull();
    expect((await forge.listOpenGates()).map((g) => g.runId)).not.toContain(run.id);
  });

  it("abandoning a Gate makes the Run Abandoned and keeps its branch and worktree", async () => {
    const { project } = await projectWithRemote();
    runner.use(() => ({ status: "failed", error: "claude crashed" }));
    const waiting = await runToEnd(project);

    const run = await forge.decideGate({ gateId: waiting.gates[0]!.id, action: "abandon" });

    expect(run.state).toBe("abandoned");
    expect(run.gates).toMatchObject([{ kind: "escalation", decision: "abandon" }]);
    expect(git(run.worktreePath!, "rev-parse", "--abbrev-ref", "HEAD")).toBe(run.branch);
  });

  it("refuses a choice the Gate does not offer, and a Gate already decided", async () => {
    const { project } = await projectWithRemote();
    runner.use(() => ({ status: "failed", error: "claude crashed" }));
    const escalated = await runToEnd(project);
    runner.use(() => {});
    const finished = await runToEnd(project);
    await forge.decideGate({ gateId: finished.gates[0]!.id, action: "approve" });

    await expect(forge.decideGate({ gateId: escalated.gates[0]!.id, action: "approve" })).rejects.toThrow(/cannot be approved/);
    await expect(forge.decideGate({ gateId: finished.gates[0]!.id, action: "abandon" })).rejects.toThrow(/already decided/);
    expect((await forge.getRun(escalated.id)).state).toBe("waiting");
    expect((await forge.getRun(finished.id)).state).toBe("approved");
  });
});

describe("finding Runs", () => {
  it("lists Runs by Project and state, and every open Gate with its Run's title", async () => {
    const one = await projectWithRemote();
    const two = await projectWithRemote();
    await runToEnd(one.project, { title: "In one" });
    await runToEnd(two.project, { title: "In two" });

    expect((await forge.listRuns({ projectId: one.project.id })).map((r) => r.title)).toEqual(["In one"]);
    expect((await forge.listRuns({ projectId: two.project.id, state: "running" }))).toEqual([]);
    expect((await forge.listRuns({ projectId: two.project.id, state: "waiting" })).map((r) => r.title)).toEqual(["In two"]);
    const gates = await forge.listOpenGates();
    expect(gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runTitle: "In one", projectName: one.project.name, kind: "final" }),
        expect.objectContaining({ runTitle: "In two", projectName: two.project.name, kind: "final" }),
      ]),
    );
  });
});
