import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { createForge, RunStateError, type Forge, type Project } from "../../src/forge/forge.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote, git, type TempRepo } from "../harness/git.js";

let pool: pg.Pool;
let drop: () => Promise<void>;
let worktrees: string;
let counter = 0;
const runner = createFakeRunner();
const codeHost = createFakeCodeHost();
const cleanups: Array<() => void> = [];
let forge: Forge;

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  pool = db.pool;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-remove-"));
  forge = createForge({ pool, runner, codeHost, worktreesRoot: worktrees });
});
afterAll(async () => {
  await forge.whenIdle();
  await drop();
  rmSync(worktrees, { recursive: true, force: true });
});
afterEach(async () => {
  await forge.whenIdle();
  cleanups.splice(0).forEach((c) => c());
});

async function newProject(): Promise<{ project: Project; repo: TempRepo }> {
  const { repo, remote } = createRepoWithBareRemote({ remote: `git@github.com:acme/remove-${++counter}.git` });
  cleanups.push(repo.cleanup, remote.cleanup);
  const project = await forge.registerProject({ path: repo.path });
  remote.pointOriginAtBare();
  return { project, repo };
}

/** A Run waiting at its final Gate (worktree, pull request, Gate, attempt), then set to `state`. */
async function runIn(project: Project, state: string, archived = false) {
  runner.use((step) => {
    writeFileSync(join(step.cwd, "jump.gd"), "extends Node\n");
    git(step.cwd, "add", ".");
    git(step.cwd, "commit", "-q", "-m", "feat(player): add jump");
  });
  const started = await forge.startRun({ projectId: project.id, task: "Do it." });
  await forge.whenIdle();
  const run = await forge.getRun(started.id);
  await pool.query("UPDATE runs SET state = $2 WHERE id = $1", [run.id, state]);
  if (archived) await pool.query("UPDATE runs SET archived_at = now() WHERE id = $1", [run.id]);
  return run;
}

const rowsOf = async (sql: string, ...params: unknown[]) => Number((await pool.query(sql, params)).rows[0].n);
const projectExists = (id: number) => rowsOf("SELECT count(*) AS n FROM projects WHERE id = $1", id).then((n) => n === 1);
const runsOf = (projectId: number) => rowsOf("SELECT count(*) AS n FROM runs WHERE project_id = $1", projectId);
const markOf = async (id: number) => (await forge.listProjects()).find((p) => p.id === id)?.removingSince;

describe("removing a Project without active Runs", () => {
  it("cleans finished Runs on disk, deletes every Run with what belongs to it and the Project, and leaves the repository alone", async () => {
    const { project, repo } = await newProject();
    const merged = await runIn(project, "merged");
    const abandoned = await runIn(project, "abandoned");
    const archived = await runIn(project, "closed", true);
    git(repo.path, "branch", "keep-me");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await forge.removeProject(project.id);

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Removal: .* removed, 3 Runs deleted/));
    log.mockRestore();
    expect(await projectExists(project.id)).toBe(false);
    for (const run of [merged, abandoned]) {
      expect(existsSync(run.worktreePath!)).toBe(false);
      expect(git(repo.path, "branch", "--list")).not.toContain(run.branch);
    }
    for (const run of [merged, abandoned, archived]) {
      expect(await rowsOf("SELECT count(*) AS n FROM runs WHERE id = $1", run.id)).toBe(0);
      expect(await rowsOf("SELECT (SELECT count(*) FROM gates WHERE run_id = $1) + (SELECT count(*) FROM step_attempts WHERE run_id = $1) AS n", run.id)).toBe(0);
    }
    expect(existsSync(repo.path)).toBe(true);
    expect(git(repo.path, "branch", "--list")).toContain("keep-me");
    expect(git(repo.path, "status", "--porcelain")).toBe("");
    // The remote branch of an abandoned Run goes with its Archive; a merged one's stays.
    expect(codeHost.deletedBranches.map((b) => b.branch)).toContain(abandoned.branch);
    expect(codeHost.deletedBranches.map((b) => b.branch)).not.toContain(merged.branch);
  });

  it("leaves the other Projects alone", async () => {
    const mine = await newProject();
    const theirs = await newProject();
    await runIn(mine.project, "merged");
    const kept = await runIn(theirs.project, "waiting");

    await forge.removeProject(mine.project.id);

    expect(await projectExists(theirs.project.id)).toBe(true);
    expect((await forge.getRun(kept.id)).state).toBe("waiting");
    expect(existsSync(kept.worktreePath!)).toBe(true);
  });

  it("removes a Project that has no Run", async () => {
    const { project } = await newProject();
    await forge.removeProject(project.id);
    expect((await forge.listProjects()).some((p) => p.id === project.id)).toBe(false);
  });

  it("keeps Dogfood Notes that mention the Project and its Runs as they are", async () => {
    const { project } = await newProject();
    const run = await runIn(project, "merged");
    const note = await forge.createDogfoodNote({ nature: "feedback", target: "other", text: "Odd.", tab: "runs", runId: run.id });
    const before = await pool.query("SELECT * FROM dogfood_notes WHERE id = $1", [note.id]);

    await forge.removeProject(project.id);

    expect((await pool.query("SELECT * FROM dogfood_notes WHERE id = $1", [note.id])).rows).toEqual(before.rows);
    expect(before.rows[0].run_id).not.toBeNull();
  });

  it("lets the same folder be registered again, as a fresh Project", async () => {
    const { project, repo } = await newProject();
    await runIn(project, "merged");
    await forge.removeProject(project.id);
    git(repo.path, "remote", "set-url", "origin", "git@github.com:acme/again.git");

    const again = await forge.registerProject({ path: repo.path });

    expect(again.id).not.toBe(project.id);
    expect(again.archivedRuns).toBe(0);
    expect(again.removingSince).toBeNull();
    expect(await runsOf(again.id)).toBe(0);
  });

  it.each(["queued", "running", "waiting", "paused", "approved"])("refuses a Project with a %s Run and changes nothing", async (state) => {
    const { project } = await newProject();
    const finished = await runIn(project, "merged");
    const active = await runIn(project, state);

    const attempt = forge.removeProject(project.id);

    await expect(attempt).rejects.toBeInstanceOf(RunStateError);
    await expect(attempt).rejects.toThrow(/1 active Run/);
    expect(await projectExists(project.id)).toBe(true);
    expect(await runsOf(project.id)).toBe(2);
    expect(await markOf(project.id)).toBeNull();
    expect(existsSync(finished.worktreePath!)).toBe(true);
    expect((await forge.getRun(active.id)).state).toBe(state);
  });

  it("refuses an unknown Project", async () => {
    await expect(forge.removeProject(999999)).rejects.toThrow("No Project 999999.");
  });

  it("is its own retry: a removal stopped after the mark finishes when called again", async () => {
    const { project } = await newProject();
    const run = await runIn(project, "merged");
    // A previous attempt marked the Project, archived the Run, and stopped.
    await pool.query("UPDATE projects SET removing_since = now() WHERE id = $1", [project.id]);
    await pool.query("UPDATE runs SET archived_at = now() WHERE id = $1", [run.id]);
    expect(await markOf(project.id)).toBeInstanceOf(Date);

    await forge.removeProject(project.id);

    expect(await projectExists(project.id)).toBe(false);
  });

  it("launches nothing on a Project being removed", async () => {
    const { project } = await newProject();
    await pool.query("UPDATE projects SET removing_since = now() WHERE id = $1", [project.id]);

    await expect(forge.startRun({ projectId: project.id, task: "Do it." })).rejects.toBeInstanceOf(RunStateError);

    expect(await runsOf(project.id)).toBe(0);
  });

  it("does not start a Queued Run of a Project being removed when a slot frees", async () => {
    const { project } = await newProject();
    const other = await runIn(project, "waiting");
    const queued = await runIn(project, "waiting");
    await pool.query("UPDATE runs SET state = 'queued' WHERE id = $1", [queued.id]);
    await pool.query("UPDATE projects SET removing_since = now() WHERE id = $1", [project.id]);

    await forge.abandonRun(other.id);
    await forge.whenIdle();

    expect((await forge.getRun(queued.id)).state).toBe("queued");
  });
});

describe("the removal preview", () => {
  it("counts the Runs, lists the active ones with their pull request, and counts the Archived ones", async () => {
    const { project } = await newProject();
    await runIn(project, "merged");
    await runIn(project, "abandoned", true);
    const approved = await runIn(project, "approved");
    const queued = await runIn(project, "queued");

    const preview = await forge.removalPreview(project.id);

    expect(preview.runs).toBe(4);
    expect(preview.archivedRuns).toBe(1);
    expect(preview.activeRuns.map((r) => r.id)).toEqual([approved.id, queued.id]);
    expect(preview.activeRuns[0]).toMatchObject({ state: "approved", prNumber: approved.prNumber, prUrl: approved.prUrl });
    expect(preview.activeRuns[0]!.prNumber).not.toBeNull();
  });

  it("refuses an unknown Project", async () => {
    await expect(forge.removalPreview(999999)).rejects.toThrow("No Project 999999.");
  });
});
