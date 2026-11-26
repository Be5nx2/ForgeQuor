import { existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createForge, type Forge, type ForgeDeps, type Project } from "../../src/forge/forge.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote, git, type TempRemote, type TempRepo } from "../harness/git.js";

let forge: Forge;
let pool: pg.Pool;
let drop: () => Promise<void>;
/** The Forge's clock; the real time when null. */
let fakeNow: Date | null = null;
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
  forge = forgeWith({});
});
/** Another Forge on the same database, such as the one a restart creates, or one with other timeouts. */
function forgeWith(overrides: Partial<ForgeDeps>): Forge {
  const created = createForge({ pool, runner, codeHost, worktreesRoot: worktrees, now: () => fakeNow ?? new Date(), ...overrides });
  others.push(created);
  return created;
}
const others: Forge[] = [];
afterAll(async () => {
  await Promise.all(others.map((f) => f.whenIdle()));
  await forge.whenIdle();
  await drop();
  rmSync(worktrees, { recursive: true, force: true });
});
afterEach(async () => {
  // Paused Runs of one test must not be resumed by another test's clock.
  await pool.query("UPDATE runs SET state = 'abandoned' WHERE state = 'paused'");
  fakeNow = null;
  runner.use(() => {});
  runner.steps.length = 0;
  codeHost.pullRequests.length = 0;
  codeHost.failWith(null);
  codeHost.failStateReads(null);
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

describe("Checks", () => {
  it("a Project with no Checks goes straight to the pull request", async () => {
    const { project } = await projectWithRemote();

    const run = await runToEnd(project);

    expect(run.checks).toEqual([]);
    expect(run.gates).toMatchObject([{ kind: "final" }]);
  });

  it("runs the Checks in order in the worktree, and records each command's status and output", async () => {
    const { project } = await projectWithRemote();
    await forge.setChecks(project.id, ["pwd", "echo built; echo warn >&2"]);

    const run = await runToEnd(project);

    expect(run.gates).toMatchObject([{ kind: "final" }]);
    expect(run.checks).toMatchObject([
      { attempt: 1, command: "pwd", exitStatus: 0 },
      { attempt: 1, command: "echo built; echo warn >&2", exitStatus: 0 },
    ]);
    expect(realpathSync(run.checks[0]!.output.trim())).toBe(realpathSync(run.worktreePath!));
    expect(run.checks[1]!.output).toContain("built");
    expect(run.checks[1]!.output).toContain("warn");
    expect(codeHost.pullRequests).toHaveLength(1);
  });

  it("stops at the first failing Check", async () => {
    const { project } = await projectWithRemote();
    await forge.setChecks(project.id, ["exit 1", "touch second-ran"]);

    const run = await runToEnd(project);

    expect(run.checks.map((c) => c.command)).toEqual(["exit 1", "exit 1", "exit 1"]);
    expect(existsSync(join(run.worktreePath!, "second-ran"))).toBe(false);
  });

  it("sends a failure's output back to the Developer, who gets a second try", async () => {
    const { project } = await projectWithRemote();
    await forge.setChecks(project.id, ["test -f fixed.txt || { echo missing fixed.txt; exit 2; }"]);
    runner.use((step) => {
      if (runner.steps.length === 2) writeFileSync(join(step.cwd, "fixed.txt"), "ok\n");
    });

    const run = await runToEnd(project);

    expect(runner.steps).toHaveLength(2);
    expect(runner.steps[1]!.prompt).toContain("missing fixed.txt");
    expect(run.attempts).toMatchObject([
      { step: "developer", attempt: 1, status: "succeeded" },
      { step: "developer", attempt: 2, status: "succeeded" },
    ]);
    expect(run.checks).toMatchObject([
      { attempt: 1, exitStatus: 2, output: expect.stringContaining("missing fixed.txt") },
      { attempt: 2, exitStatus: 0 },
    ]);
    expect(run.gates).toMatchObject([{ kind: "final" }]);
    expect(codeHost.pullRequests).toHaveLength(1);
  });

  it("gives up after 2 extra attempts: an Escalation names the failing Check and its output, and nothing is pushed", async () => {
    const { project, remote } = await projectWithRemote();
    await forge.setChecks(project.id, ["true", "echo boom; exit 3"]);

    const run = await runToEnd(project);

    expect(runner.steps).toHaveLength(3);
    expect(run.state).toBe("waiting");
    expect(run.gates).toMatchObject([
      { kind: "escalation", actions: ["abandon"], evidence: expect.stringContaining("echo boom; exit 3") },
    ]);
    expect(run.gates[0]!.evidence).toContain("boom");
    expect(run.checks.filter((c) => c.exitStatus !== 0)).toHaveLength(3);
    expect(codeHost.pullRequests).toHaveLength(0);
    expect(git(remote.bare, "branch", "--list", run.branch!)).toBe("");
  });

  it("can be edited, and an empty list clears them", async () => {
    const { project } = await projectWithRemote();

    const edited = await forge.setChecks(project.id, ["npm test", "  ", "npm run lint"]);
    expect(edited.checks).toEqual(["npm test", "npm run lint"]);
    expect((await forge.listProjects()).find((p) => p.id === project.id)?.checks).toEqual(["npm test", "npm run lint"]);

    expect((await forge.setChecks(project.id, [])).checks).toEqual([]);
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

/** Starts a Run whose Developer commits real work, and approves it so it waits for the merge. */
async function approvedRun(project: Project) {
  runner.use((step) => developerCommits(step));
  const waiting = await runToEnd(project);
  return forge.decideGate({ gateId: waiting.gates[0]!.id, action: "approve" });
}

describe("abandoning a Run", () => {
  it("closes the pull request, keeps the branch and the worktree, and settles the open Gate", async () => {
    const { project, remote } = await projectWithRemote();
    runner.use((step) => developerCommits(step));
    const waiting = await runToEnd(project);

    const run = await forge.abandonRun(waiting.id);

    expect(run.state).toBe("abandoned");
    expect(codeHost.pullRequests.map((p) => p.state)).toEqual(["closed"]);
    expect(git(remote.bare, "branch", "--list", run.branch!)).toContain(run.branch);
    expect(existsSync(run.worktreePath!)).toBe(true);
    expect(run.gates).toMatchObject([{ decision: "abandon" }]);
    expect((await forge.listOpenGates()).map((g) => g.runId)).not.toContain(run.id);
  });

  it("also closes the pull request when abandoning through the final Gate", async () => {
    const { project } = await projectWithRemote();
    runner.use((step) => developerCommits(step));
    const waiting = await runToEnd(project);

    await forge.decideGate({ gateId: waiting.gates[0]!.id, action: "abandon" });

    expect(codeHost.pullRequests.map((p) => p.state)).toEqual(["closed"]);
  });

  it("works on an Approved Run", async () => {
    const { project } = await projectWithRemote();
    const approved = await approvedRun(project);

    expect((await forge.abandonRun(approved.id)).state).toBe("abandoned");
    expect(codeHost.pullRequests.map((p) => p.state)).toEqual(["closed"]);
  });

  it("works on a Run with no pull request yet", async () => {
    const { project } = await projectWithRemote();
    runner.use(() => ({ status: "failed", error: "claude crashed" }));
    const escalated = await runToEnd(project);

    expect((await forge.abandonRun(escalated.id)).state).toBe("abandoned");
    expect(codeHost.pullRequests).toEqual([]);
  });

  it("works while the Developer is still running, and the Run never reaches a pull request", async () => {
    const { project, remote } = await projectWithRemote();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const inStep = new Promise<void>((r) => (started = r));
    runner.use(async (step) => {
      started();
      await hold;
      developerCommits(step);
    });
    const { id } = await forge.startRun({ projectId: project.id, task: "Slow work." });
    await inStep;

    const abandoned = await forge.abandonRun(id);
    release();
    await forge.whenIdle();

    expect(abandoned.state).toBe("abandoned");
    const run = await forge.getRun(id);
    expect(run.state).toBe("abandoned");
    expect(run.gates).toEqual([]);
    expect(codeHost.pullRequests).toEqual([]);
    expect(git(remote.bare, "branch", "--list", run.branch!)).toBe("");
  });

  it("cannot abandon a Run that is already over", async () => {
    const { project } = await projectWithRemote();
    const approved = await approvedRun(project);
    codeHost.setState(1, "merged");
    await forge.checkPullRequests();

    await expect(forge.abandonRun(approved.id)).rejects.toThrow(/already merged/);
    await forge.abandonRun((await runToEnd(project)).id);
    const [abandoned] = await forge.listRuns({ state: "abandoned" });
    await expect(forge.abandonRun(abandoned!.id)).rejects.toThrow(/already abandoned/);
  });

  it("records a pull request merged on GitHub in the meantime as Merged instead", async () => {
    const { project } = await projectWithRemote();
    const approved = await approvedRun(project);
    codeHost.setState(1, "merged");

    const run = await forge.abandonRun(approved.id);

    expect(run.state).toBe("merged");
  });

  it("stays as it was when the pull request cannot be closed, so the human can try again", async () => {
    const { project } = await projectWithRemote();
    const approved = await approvedRun(project);
    codeHost.failStateReads("gh is down");

    await expect(forge.abandonRun(approved.id)).rejects.toThrow(/gh is down/);
    expect((await forge.getRun(approved.id)).state).toBe("approved");
  });
});

describe("detecting a merge or close", () => {
  it("moves Approved Runs to Merged or Closed, and leaves the others alone", async () => {
    const { project } = await projectWithRemote();
    await forge.setMaxConcurrentRuns(project.id, 4);
    const merged = await approvedRun(project);
    const closed = await approvedRun(project);
    const open = await approvedRun(project);
    runner.use(() => {});
    const waiting = await runToEnd(project);
    codeHost.setState(1, "merged");
    codeHost.setState(2, "closed");

    await forge.checkPullRequests();

    expect((await forge.getRun(merged.id)).state).toBe("merged");
    expect((await forge.getRun(closed.id)).state).toBe("closed");
    expect((await forge.getRun(open.id)).state).toBe("approved");
    expect((await forge.getRun(waiting.id)).state).toBe("waiting");
  });

  it("keeps going when one pull request cannot be read", async () => {
    const { project } = await projectWithRemote();
    const first = await approvedRun(project);
    const second = await approvedRun(project);
    codeHost.setState(2, "merged");
    codeHost.failStateReads("rate limited");

    await expect(forge.checkPullRequests()).resolves.toBeUndefined();
    expect((await forge.getRun(first.id)).state).toBe("approved");
    expect((await forge.getRun(second.id)).state).toBe("approved");

    codeHost.failStateReads(null);
    await forge.checkPullRequests();
    expect((await forge.getRun(second.id)).state).toBe("merged");
  });
});

/** A Developer that blocks until released, so Runs can be held in the Running state. */
function gatedDeveloper() {
  const waiters: Array<() => void> = [];
  const listeners: Array<{ n: number; resolve: () => void }> = [];
  runner.use(async (step) => {
    const released = new Promise<void>((r) => waiters.push(r));
    listeners.filter((l) => waiters.length >= l.n).forEach((l) => l.resolve());
    await released;
    developerCommits(step);
  });
  return {
    releaseAll: () => waiters.splice(0).forEach((r) => r()),
    /** Resolves once `n` Developers are blocked, signalled by the Runner itself rather than polled. */
    started: (n: number) =>
      waiters.length >= n ? Promise.resolve() : new Promise<void>((resolve) => listeners.push({ n, resolve })),
  };
}

describe("the concurrency limit and the queue", () => {
  it("queues a Run over the Project's limit and starts it when a slot frees up", async () => {
    const { project } = await projectWithRemote();
    const gate = gatedDeveloper();
    const a = await forge.startRun({ projectId: project.id, task: "A" });
    const b = await forge.startRun({ projectId: project.id, task: "B" });
    const c = await forge.startRun({ projectId: project.id, task: "C" });
    await gate.started(2);

    expect(a.state).toBe("running");
    expect(b.state).toBe("running");
    expect(c.state).toBe("queued");
    expect((await forge.getRun(c.id)).worktreePath).toBeNull();

    gate.releaseAll();
    await forge.whenIdle();
    expect((await forge.getRun(c.id)).state).toBe("queued");
    await forge.abandonRun(a.id);
    await gate.started(1);
    gate.releaseAll();
    await forge.whenIdle();

    expect((await forge.getRun(c.id)).state).toBe("waiting");
  });

  it.each([
    ["Merged", async (id: number) => (codeHost.setState(id, "merged"), forge.checkPullRequests())],
    ["Closed", async (id: number) => (codeHost.setState(id, "closed"), forge.checkPullRequests())],
    ["Abandoned", async (id: number, runId: number) => void (await forge.abandonRun(runId))],
  ])("a Run becoming %s frees its slot and starts the next Queued Run", async (_name, free) => {
    const { project } = await projectWithRemote();
    await forge.setMaxConcurrentRuns(project.id, 1);
    const first = await approvedRun(project);
    runner.use(() => {});
    const next = await forge.startRun({ projectId: project.id, task: "Next" });
    await forge.whenIdle();
    expect((await forge.getRun(next.id)).state).toBe("queued");

    await free(first.prNumber!, first.id);
    await forge.whenIdle();

    expect((await forge.getRun(next.id)).state).toBe("waiting");
  });

  it("starts Queued Runs in creation order", async () => {
    const { project } = await projectWithRemote();
    await forge.setMaxConcurrentRuns(project.id, 1);
    const first = await approvedRun(project);
    runner.use(() => {});
    const second = await forge.startRun({ projectId: project.id, task: "Second" });
    const third = await forge.startRun({ projectId: project.id, task: "Third" });

    await forge.abandonRun(first.id);
    await forge.whenIdle();

    expect((await forge.getRun(second.id)).state).toBe("waiting");
    expect((await forge.getRun(third.id)).state).toBe("queued");
  });

  it("does not count Queued Runs, and keeps each Project's slots apart", async () => {
    const one = await projectWithRemote();
    const two = await projectWithRemote();
    await forge.setMaxConcurrentRuns(one.project.id, 1);
    await runToEnd(one.project);

    const queued = await forge.startRun({ projectId: one.project.id, task: "Waits" });
    const other = await runToEnd(two.project);

    expect(queued.state).toBe("queued");
    expect(other.state).toBe("waiting");
  });

  it("can abandon a Queued Run, which never starts", async () => {
    const { project } = await projectWithRemote();
    await forge.setMaxConcurrentRuns(project.id, 1);
    const first = await runToEnd(project);
    const queued = await forge.startRun({ projectId: project.id, task: "Never" });

    expect((await forge.abandonRun(queued.id)).state).toBe("abandoned");
    await forge.abandonRun(first.id);
    await forge.whenIdle();

    expect((await forge.getRun(queued.id)).state).toBe("abandoned");
    expect((await forge.getRun(queued.id)).attempts).toEqual([]);
  });

  it("starts Queued Runs when the limit is raised, and rejects a limit below 1", async () => {
    const { project } = await projectWithRemote();
    await forge.setMaxConcurrentRuns(project.id, 1);
    await runToEnd(project);
    const queued = await forge.startRun({ projectId: project.id, task: "Later" });

    const saved = await forge.setMaxConcurrentRuns(project.id, 2);
    await forge.whenIdle();

    expect(saved.maxConcurrentRuns).toBe(2);
    expect((await forge.getRun(queued.id)).state).toBe("waiting");
    await expect(forge.setMaxConcurrentRuns(project.id, 0)).rejects.toThrow(/at least 1/);
    await expect(forge.setMaxConcurrentRuns(project.id, 1.5)).rejects.toThrow(/at least 1/);
  });

  it("never starts more Runs than the limit when many are created at once", async () => {
    const { project } = await projectWithRemote();
    const gate = gatedDeveloper();

    await Promise.all([1, 2, 3, 4, 5].map((n) => forge.startRun({ projectId: project.id, task: `Run ${n}` })));
    await gate.started(2);

    expect((await forge.listRuns({ projectId: project.id, state: "running" })).length).toBe(2);
    // Runs of one Project preparing their worktrees together must not trip over git's locks.
    expect((await forge.listOpenGates()).filter((g) => g.projectName === project.name)).toEqual([]);
    expect((await forge.listRuns({ projectId: project.id, state: "queued" })).length).toBe(3);
    gate.releaseAll();
    await forge.whenIdle();
  });
});

/** Waits until `read` returns something truthy (a file written by a child process, a process gone...). */
async function eventually<T>(read: () => T | null | false | undefined): Promise<T> {
  for (let i = 0; i < 250; i++) {
    const value = read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting");
}
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** A Developer that waits to be cancelled, like a Runner whose process gets killed. */
const waitsForCancel = (onCancel: () => void = () => {}) => async (step: { signal?: AbortSignal }) => {
  await new Promise<void>((r) => (step.signal!.aborted ? r() : step.signal!.addEventListener("abort", () => r(), { once: true })));
  onCancel();
  return { status: "failed" as const, error: "cancelled" };
};

describe("a Runner whose Quota is exhausted", () => {
  const RESET = new Date("2030-01-01T12:00:00Z");

  it("pauses the Run with the reset time, then restarts the Step once the reset has passed", async () => {
    const { project } = await projectWithRemote();
    fakeNow = new Date("2030-01-01T10:00:00Z");
    runner.use(() => ({ status: "quota_exhausted", resetsAt: RESET }));
    const started = await forge.startRun({ projectId: project.id, task: "Do the thing." });
    await forge.whenIdle();

    const paused = await forge.getRun(started.id);
    expect(paused.state).toBe("paused");
    expect(paused.resumeAt).toEqual(RESET);
    expect(paused.gates).toEqual([]);
    expect(paused.attempts).toMatchObject([{ step: "developer", attempt: 1, status: "quota_exhausted", quotaResetsAt: RESET }]);

    await forge.resumePausedRuns();
    await forge.whenIdle();
    expect((await forge.getRun(started.id)).state).toBe("paused");
    expect(runner.steps).toHaveLength(1);

    fakeNow = new Date("2030-01-01T12:00:01Z");
    runner.use(() => {});
    await forge.resumePausedRuns();
    await forge.whenIdle();

    const resumed = await forge.getRun(started.id);
    expect(resumed.state).toBe("waiting");
    expect(resumed.resumeAt).toBeNull();
    expect(runner.steps).toHaveLength(2);
    expect(runner.steps[1]!.cwd).toBe(resumed.worktreePath);
    expect(resumed.gates).toMatchObject([{ kind: "final" }]);
  });

  it("tries again after a while when the Runner did not say when the Quota comes back", async () => {
    const { project } = await projectWithRemote();
    fakeNow = new Date("2030-01-01T10:00:00Z");
    runner.use(() => ({ status: "quota_exhausted", resetsAt: null }));
    const started = await forge.startRun({ projectId: project.id, task: "Do the thing." });
    await forge.whenIdle();

    const paused = await forge.getRun(started.id);
    expect(paused.state).toBe("paused");
    expect(paused.resumeAt!.getTime()).toBeGreaterThan(fakeNow.getTime());
    expect(paused.resumeAt!.getTime() - fakeNow.getTime()).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it("restarts the Step it was in, with the failed Check's output, not the first one", async () => {
    const { project } = await projectWithRemote();
    await forge.setChecks(project.id, ["test -f jump.txt || { echo missing-jump >&2; exit 1; }"]);
    fakeNow = new Date("2030-01-01T10:00:00Z");
    runner.use(() => (runner.steps.length === 2 ? { status: "quota_exhausted", resetsAt: RESET } : undefined));
    const started = await forge.startRun({ projectId: project.id, task: "Do the thing." });
    await forge.whenIdle();
    expect((await forge.getRun(started.id)).state).toBe("paused");

    fakeNow = new Date("2030-01-01T12:00:01Z");
    runner.use((step) => void writeFileSync(join(step.cwd, "jump.txt"), "jump\n"));
    await forge.resumePausedRuns();
    await forge.whenIdle();

    const run = await forge.getRun(started.id);
    expect(runner.steps[2]!.prompt).toContain("missing-jump");
    expect(run.attempts.map((a) => [a.attempt, a.status])).toEqual([
      [1, "succeeded"],
      [2, "quota_exhausted"],
      [2, "succeeded"],
    ]);
  });

  it("keeps its Project slot while Paused", async () => {
    const { project } = await projectWithRemote();
    await forge.setMaxConcurrentRuns(project.id, 1);
    runner.use(() => ({ status: "quota_exhausted", resetsAt: RESET }));
    const paused = await forge.startRun({ projectId: project.id, task: "First" });
    const queued = await forge.startRun({ projectId: project.id, task: "Second" });
    await forge.whenIdle();

    expect((await forge.getRun(paused.id)).state).toBe("paused");
    expect((await forge.getRun(queued.id)).state).toBe("queued");
  });

  it("can be abandoned while Paused, and then never resumes", async () => {
    const { project } = await projectWithRemote();
    fakeNow = new Date("2030-01-01T10:00:00Z");
    runner.use(() => ({ status: "quota_exhausted", resetsAt: RESET }));
    const started = await forge.startRun({ projectId: project.id, task: "Do the thing." });
    await forge.whenIdle();
    await forge.abandonRun(started.id);

    fakeNow = new Date("2030-01-02T00:00:00Z");
    await forge.resumePausedRuns();
    await forge.whenIdle();

    expect((await forge.getRun(started.id)).state).toBe("abandoned");
    expect(runner.steps).toHaveLength(1);
  });
});

describe("a Developer that fails or takes too long", () => {
  it("opens an Escalation with the Runner's error", async () => {
    const { project } = await projectWithRemote();
    runner.use(() => ({ status: "failed", error: "claude exited with code 1: out of memory" }));

    const run = await runToEnd(project);

    expect(run.state).toBe("waiting");
    expect(run.gates).toMatchObject([{ kind: "escalation", actions: ["abandon"], evidence: "claude exited with code 1: out of memory" }]);
  });

  it("kills a Step that runs past the timeout and opens an Escalation saying so", async () => {
    const { project } = await projectWithRemote();
    const patient = forgeWith({ stepTimeoutMs: 150 });
    let cancelled = false;
    runner.use(waitsForCancel(() => (cancelled = true)));

    const started = await patient.startRun({ projectId: project.id, task: "Takes forever." });
    await patient.whenIdle();

    const run = await patient.getRun(started.id);
    expect(cancelled).toBe(true);
    expect(run.state).toBe("waiting");
    expect(run.gates).toMatchObject([{ kind: "escalation", actions: ["abandon"], reason: expect.stringMatching(/timed out/i) }]);
  });
});

describe("killing what a Run started", () => {
  const pidFile = () => join(worktrees, `pids-${++counter}.txt`);
  const pidsIn = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number) : []);
  /** A Check that leaves a background process behind, like a build tool's child. */
  const checkWithChild = (file: string) => `sleep 60 & echo $! >> ${file}; wait`;

  it("ends a timed out Check's whole process group", async () => {
    const { project } = await projectWithRemote();
    const file = pidFile();
    await forge.setChecks(project.id, [checkWithChild(file)]);
    const quick = forgeWith({ checkTimeoutMs: 300 });

    const started = await quick.startRun({ projectId: project.id, task: "Do the thing." });
    await quick.whenIdle();

    const run = await quick.getRun(started.id);
    expect(run.gates).toMatchObject([{ kind: "escalation", reason: expect.stringMatching(/Check still fails/) }]);
    expect(run.checks.every((c) => c.exitStatus === null)).toBe(true);
    const pids = pidsIn(file);
    expect(pids).toHaveLength(3);
    for (const pid of pids) await eventually(() => !isAlive(pid));
  });

  it("kills the Developer as soon as the Run is abandoned", async () => {
    const { project } = await projectWithRemote();
    let cancelled!: () => void;
    const wasCancelled = new Promise<void>((r) => (cancelled = r));
    let started!: () => void;
    const inStep = new Promise<void>((r) => (started = r));
    const wait = waitsForCancel(cancelled);
    runner.use((step) => {
      started();
      return wait(step);
    });
    const { id } = await forge.startRun({ projectId: project.id, task: "Slow work." });
    await inStep;

    await forge.abandonRun(id);

    await wasCancelled;
    await forge.whenIdle();
    const run = await forge.getRun(id);
    expect(run.state).toBe("abandoned");
    expect(run.gates).toEqual([]);
  });

  it("kills a running Check, and everything it started, when the Run is abandoned", async () => {
    const { project } = await projectWithRemote();
    const file = pidFile();
    await forge.setChecks(project.id, [checkWithChild(file)]);
    const { id } = await forge.startRun({ projectId: project.id, task: "Do the thing." });
    const pid = await eventually(() => pidsIn(file)[0]);
    expect(isAlive(pid)).toBe(true);

    await forge.abandonRun(id);

    await eventually(() => !isAlive(pid));
    await forge.whenIdle();
    const run = await forge.getRun(id);
    expect(run.state).toBe("abandoned");
    expect(run.checks).toEqual([]);
    expect(runner.steps).toHaveLength(1);
  });
});

describe("after Forgequor restarts", () => {
  /** What a crash leaves behind: a Run recorded in `state`, with whatever the Step had written so far. */
  async function crashedRun(project: Project, state: string, interruptedStep = false): Promise<number> {
    const { rows } = await pool.query(
      "INSERT INTO runs (project_id, title, task, state) VALUES ($1, 'Crashed', 'Finish the job.', $2) RETURNING id",
      [project.id, state],
    );
    if (interruptedStep) {
      await pool.query("INSERT INTO step_attempts (run_id, step, attempt, runner, status) VALUES ($1, 'developer', 1, 'claude', 'running')", [
        rows[0].id,
      ]);
    }
    return Number(rows[0].id);
  }

  it("restarts the current Step of every Running Run, keeping a note of the interrupted attempt", async () => {
    const { project } = await projectWithRemote();
    const id = await crashedRun(project, "running", true);
    const restarted = forgeWith({});

    await restarted.recoverAfterRestart();
    await restarted.whenIdle();

    const run = await restarted.getRun(id);
    expect(run.state).toBe("waiting");
    expect(run.attempts.map((a) => a.status)).toEqual(["failed", "succeeded"]);
    expect(run.attempts[0]!.error).toMatch(/restart/i);
    expect(run.gates).toMatchObject([{ kind: "final" }]);
  });

  it("starts the Queued Runs that fit the free slots", async () => {
    const { project } = await projectWithRemote();
    const first = await crashedRun(project, "queued");
    const second = await crashedRun(project, "queued");
    const third = await crashedRun(project, "queued");
    const restarted = forgeWith({});

    await restarted.recoverAfterRestart();
    await restarted.whenIdle();

    expect((await restarted.getRun(first)).state).toBe("waiting");
    expect((await restarted.getRun(second)).state).toBe("waiting");
    expect((await restarted.getRun(third)).state).toBe("queued");
  });

  it("follows the pull request of Approved Runs again", async () => {
    const { project } = await projectWithRemote();
    const approved = await approvedRun(project);
    codeHost.setState(approved.prNumber!, "merged");
    const restarted = forgeWith({});

    await restarted.recoverAfterRestart();

    expect((await restarted.getRun(approved.id)).state).toBe("merged");
  });

  it("leaves Waiting and Paused Runs as they are", async () => {
    const { project } = await projectWithRemote();
    const waiting = await runToEnd(project);
    const paused = await crashedRun(project, "paused");
    const restarted = forgeWith({});

    await restarted.recoverAfterRestart();
    await restarted.whenIdle();

    expect((await restarted.getRun(waiting.id)).state).toBe("waiting");
    expect((await restarted.getRun(paused)).state).toBe("paused");
    expect(runner.steps).toHaveLength(1);
  });
});
