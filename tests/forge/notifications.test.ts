import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createForge, type Forge, type Project } from "../../src/forge/forge.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeNotifier } from "../harness/fake-notifier.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote, git } from "../harness/git.js";

let forge: Forge;
let pool: pg.Pool;
let drop: () => Promise<void>;
let worktrees: string;
const runner = createFakeRunner();
const codeHost = createFakeCodeHost();
const notifier = createFakeNotifier();
const cleanups: Array<() => void> = [];
let counter = 0;

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  pool = db.pool;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-worktrees-"));
  forge = createForge({ pool, runner, codeHost, worktreesRoot: worktrees, notifier });
});
afterAll(async () => {
  await forge.whenIdle();
  await drop();
  rmSync(worktrees, { recursive: true, force: true });
});
afterEach(async () => {
  for (const run of await forge.listRuns({ state: "paused" })) await forge.abandonRun(run.id);
  runner.use(() => {});
  runner.steps.length = 0;
  codeHost.pullRequests.length = 0;
  notifier.sent.length = 0;
  notifier.failWith(null);
  cleanups.splice(0).forEach((c) => c());
});

async function projectWithRemote(): Promise<Project> {
  const { repo, remote } = createRepoWithBareRemote({ remote: `git@github.com:acme/notify-${++counter}.git` });
  cleanups.push(repo.cleanup, remote.cleanup);
  const project = await forge.registerProject({ path: repo.path });
  remote.pointOriginAtBare();
  return project;
}

function developerCommits(step: { cwd: string }) {
  writeFileSync(join(step.cwd, "jump.gd"), "extends Node\n");
  git(step.cwd, "add", ".");
  git(step.cwd, "commit", "-q", "-m", "feat(player): add jump");
}

async function runToEnd(project: Project, title = "Add jump") {
  const started = await forge.startRun({ projectId: project.id, title, task: "Do the thing." });
  await forge.whenIdle();
  return forge.getRun(started.id);
}

describe("notifying the human", () => {
  it("names the Run and the Gate when a human Gate opens, and says nothing when a Step merely finishes", async () => {
    const project = await projectWithRemote();
    runner.use((step) => developerCommits(step));

    const run = await runToEnd(project);

    expect(run.state).toBe("waiting");
    expect(notifier.sent).toEqual([{ title: "Forgequor", message: `Run #${run.id} "Add jump": final Gate open` }]);
  });

  it("notifies once for an Escalation, with its reason", async () => {
    const project = await projectWithRemote();
    runner.use(() => ({ status: "failed", error: "claude crashed" }));

    const run = await runToEnd(project);

    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]!.message).toBe(`Run #${run.id} "Add jump": Escalation: ${run.gates[0]!.reason}`);
  });

  it("says when a Run paused on an exhausted Quota, with the reset time when known", async () => {
    const project = await projectWithRemote();
    const resetsAt = new Date("2030-01-01T12:00:00Z");
    runner.use(() => ({ status: "quota_exhausted", resetsAt }));
    const run = await runToEnd(project);
    const time = resetsAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

    expect(run.state).toBe("paused");
    expect(notifier.sent.map((n) => n.message)).toEqual([`Run #${run.id} "Add jump": paused on an exhausted Quota until ${time}`]);

    notifier.sent.length = 0;
    runner.use(() => ({ status: "quota_exhausted", resetsAt: null }));
    const unknown = await runToEnd(project, "Other");
    expect(notifier.sent.map((n) => n.message)).toEqual([`Run #${unknown.id} "Other": paused on an exhausted Quota`]);
  });

  it("says when the pull request poller finds the pull request merged, once", async () => {
    const project = await projectWithRemote();
    runner.use((step) => developerCommits(step));
    const waiting = await runToEnd(project);
    const approved = await forge.decideGate({ gateId: waiting.gates[0]!.id, action: "approve" });
    notifier.sent.length = 0;

    codeHost.setState(1, "merged");
    await forge.checkPullRequests();
    await forge.checkPullRequests();

    expect(notifier.sent.map((n) => n.message)).toEqual([`Run #${approved.id} "Add jump": pull request merged`]);
  });

  it("never lets a failing Notifier change a Run", async () => {
    const project = await projectWithRemote();
    runner.use((step) => developerCommits(step));
    notifier.failWith(new Error("no osascript"));
    const throwing = await runToEnd(project);
    notifier.failWith(new Error("no osascript"), { async: true });
    const rejecting = await runToEnd(project, "Second");

    expect(throwing.state).toBe("waiting");
    expect(throwing.gates).toMatchObject([{ kind: "final", decision: null }]);
    expect(rejecting.state).toBe("waiting");
  });
});
