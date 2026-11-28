import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { createForge, type Forge, type Project } from "../../src/forge/forge.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote, git } from "../harness/git.js";

const DAY = 24 * 60 * 60 * 1000;
let pool: pg.Pool;
let drop: () => Promise<void>;
let worktrees: string;
let counter = 0;
const clock = new Date("2026-06-01T10:00:00Z");
const runner = createFakeRunner();
const codeHost = createFakeCodeHost();
const cleanups: Array<() => void> = [];
let forge: Forge;

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  pool = db.pool;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-purge-now-"));
  forge = createForge({ pool, runner, codeHost, worktreesRoot: worktrees, now: () => clock });
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

async function newProject(): Promise<Project> {
  const { repo, remote } = createRepoWithBareRemote({ remote: `git@github.com:acme/purge-now-${++counter}.git` });
  cleanups.push(repo.cleanup, remote.cleanup);
  const project = await forge.registerProject({ path: repo.path });
  remote.pointOriginAtBare();
  return project;
}

/** A Run waiting at its final Gate (with a Gate and an attempt), then set to `state`, Archived that many days ago or not at all. */
async function runIn(project: Project, state: string, archivedDaysAgo: number | null) {
  runner.use((step) => {
    writeFileSync(join(step.cwd, "jump.gd"), "extends Node\n");
    git(step.cwd, "add", ".");
    git(step.cwd, "commit", "-q", "-m", "feat(player): add jump");
  });
  const started = await forge.startRun({ projectId: project.id, task: "Do it." });
  await forge.whenIdle();
  const archivedAt = archivedDaysAgo === null ? null : new Date(clock.getTime() - archivedDaysAgo * DAY);
  await pool.query("UPDATE runs SET state = $2, archived_at = $3 WHERE id = $1", [started.id, state, archivedAt]);
  return started.id;
}

const exists = async (runId: number) => Number((await pool.query("SELECT count(*) FROM runs WHERE id = $1", [runId])).rows[0].count) === 1;
const children = async (runId: number) =>
  Number((await pool.query("SELECT (SELECT count(*) FROM gates WHERE run_id = $1) + (SELECT count(*) FROM step_attempts WHERE run_id = $1) AS n", [runId])).rows[0].n);
const archivedOf = async (project: Project) => (await forge.listProjects()).find((p) => p.id === project.id)?.archivedRuns;

describe("purging Archived Runs now", () => {
  it("deletes the Archived Runs of every Project whatever their age, with what belongs to them, and returns how many", async () => {
    const a = await newProject();
    const b = await newProject();
    const fresh = await runIn(a, "abandoned", 0);
    const old = await runIn(b, "merged", 400);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const deleted = await forge.purgeArchivedRuns();

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Purge: \d+ archived Runs deleted/));
    log.mockRestore();
    expect(deleted).toBeGreaterThanOrEqual(2);
    for (const id of [fresh, old]) {
      expect(await exists(id)).toBe(false);
      expect(await children(id)).toBe(0);
    }
  });

  it("deletes only the Archived Runs of the named Project", async () => {
    const a = await newProject();
    const b = await newProject();
    const mine = await runIn(a, "abandoned", 1);
    const theirs = await runIn(b, "abandoned", 1);

    expect(await forge.purgeArchivedRuns(a.id)).toBe(1);

    expect(await exists(mine)).toBe(false);
    expect(await exists(theirs)).toBe(true);
    expect(await archivedOf(b)).toBe(1);
    expect(await forge.purgeArchivedRuns(a.id)).toBe(0);
  });

  it("never touches a Run that is not Archived, active or finished", async () => {
    const project = await newProject();
    const waiting = await runIn(project, "waiting", null);
    const approved = await runIn(project, "approved", null);
    const merged = await runIn(project, "merged", null);
    const archived = await runIn(project, "abandoned", 2);

    expect(await forge.purgeArchivedRuns(project.id)).toBe(1);

    for (const id of [waiting, approved, merged]) {
      expect(await exists(id)).toBe(true);
      expect(await children(id)).toBeGreaterThan(0);
    }
    expect(await exists(archived)).toBe(false);
  });

  it("reads the Archived count on the Project", async () => {
    const project = await newProject();
    expect(await archivedOf(project)).toBe(0);
    await runIn(project, "abandoned", 1);
    await runIn(project, "merged", null);
    expect(await archivedOf(project)).toBe(1);
  });

  it("refuses an unknown Project", async () => {
    await expect(forge.purgeArchivedRuns(999999)).rejects.toThrow("No Project 999999.");
  });
});
