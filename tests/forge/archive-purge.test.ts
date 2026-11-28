import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { createForge, type Forge, type Project } from "../../src/forge/forge.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote, git, type TempRemote, type TempRepo } from "../harness/git.js";

const DAY = 24 * 60 * 60 * 1000;
let pool: pg.Pool;
let drop: () => Promise<void>;
let worktrees: string;
let clock = new Date("2026-06-01T10:00:00Z");
let counter = 0;
const runner = createFakeRunner();
const codeHost = createFakeCodeHost();
const cleanups: Array<() => void> = [];
const forges: Forge[] = [];

/** A timer driven by hand: `tick()` is 24 hours going by. */
function manualTimer() {
  const tasks = new Set<() => void>();
  return {
    every: (task: () => void) => (tasks.add(task), () => void tasks.delete(task)),
    tick: () => tasks.forEach((t) => t()),
    running: () => tasks.size,
  };
}

function newForge(extra: { archiveDays?: number; every?: ReturnType<typeof manualTimer>["every"] } = {}): Forge {
  const f = createForge({ pool, runner, codeHost, worktreesRoot: worktrees, now: () => clock, ...extra });
  forges.push(f);
  return f;
}

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  pool = db.pool;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-purge-"));
});
afterAll(async () => {
  await Promise.all(forges.map((f) => f.whenIdle()));
  await drop();
  rmSync(worktrees, { recursive: true, force: true });
});
afterEach(async () => {
  await Promise.all(forges.map((f) => f.whenIdle()));
  cleanups.splice(0).forEach((c) => c());
});

async function projectOf(forge: Forge): Promise<{ project: Project; repo: TempRepo; remote: TempRemote }> {
  const { repo, remote } = createRepoWithBareRemote({ remote: `git@github.com:acme/purge-${++counter}.git` });
  cleanups.push(repo.cleanup, remote.cleanup);
  const project = await forge.registerProject({ path: repo.path });
  remote.pointOriginAtBare();
  return { project, repo, remote };
}

/** A Run that waits at its final Gate, with its worktree, a pull request, a Gate and an attempt. */
async function waitingRun(forge: Forge, project: Project) {
  runner.use((step) => {
    writeFileSync(join(step.cwd, "jump.gd"), "extends Node\n");
    git(step.cwd, "add", ".");
    git(step.cwd, "commit", "-q", "-m", "feat(player): add jump");
  });
  const started = await forge.startRun({ projectId: project.id, task: "Do it." });
  await forge.whenIdle();
  return forge.getRun(started.id);
}

const count = async (table: string, runId: number) =>
  Number((await pool.query(`SELECT count(*) FROM ${table} WHERE run_id = $1`, [runId])).rows[0].count);

describe("the startup catch-up", () => {
  it("archives finished Runs that were not, and leaves live Runs alone", async () => {
    const forge = newForge();
    const { project, repo } = await projectOf(forge);
    const finished = await waitingRun(forge, project);
    const live = await waitingRun(forge, project);
    // The previous Forgequor stopped between "merged" and "archived".
    await pool.query("UPDATE runs SET state = 'merged' WHERE id = $1", [finished.id]);
    expect(existsSync(finished.worktreePath!)).toBe(true);

    await newForge().recoverAfterRestart();

    const after = await forge.getRun(finished.id);
    expect(after.state).toBe("merged");
    expect(after.archivedAt).not.toBeNull();
    expect(existsSync(finished.worktreePath!)).toBe(false);
    expect(git(repo.path, "branch", "--list")).not.toContain(finished.branch);
    const stillLive = await forge.getRun(live.id);
    expect(stillLive.archivedAt).toBeNull();
    expect(existsSync(live.worktreePath!)).toBe(true);
  });

  it("sweeps the Run folder of an archived Run and of a Run that no longer exists, and only those", async () => {
    const forge = newForge();
    const { project } = await projectOf(forge);
    const live = await waitingRun(forge, project);
    const projectDir = join(worktrees, `sweep-${project.id}`);
    const folder = (name: string) => {
      mkdirSync(join(projectDir, name), { recursive: true });
      writeFileSync(join(projectDir, name, "file.txt"), "x");
      return join(projectDir, name);
    };
    const archivedRun = (await pool.query("INSERT INTO runs (project_id, title, task, state, archived_at) VALUES ($1, 'A', 'a', 'abandoned', now()) RETURNING id", [project.id])).rows[0].id;
    const archivedFolder = folder(`run-${archivedRun}`);
    const goneFolder = folder("run-999999");
    const notARunFolder = folder("notes");
    const queuedRun = (await pool.query("INSERT INTO runs (project_id, title, task, state) VALUES ($1, 'B', 'b', 'queued') RETURNING id", [project.id])).rows[0].id;
    const queuedFolder = folder(`run-${queuedRun}`);

    await newForge().recoverAfterRestart();

    expect(existsSync(archivedFolder)).toBe(false);
    expect(existsSync(goneFolder)).toBe(false);
    expect(existsSync(notARunFolder)).toBe(true);
    expect(existsSync(queuedFolder)).toBe(true);
    expect(existsSync(live.worktreePath!)).toBe(true);
    await pool.query("DELETE FROM runs WHERE id = $1", [queuedRun]);
  });
});

describe("the purge", () => {
  /** A Run with a row in every table that belongs to a Run, archived at the given time. */
  async function runWithEverything(forge: Forge, project: Project, archivedAt: Date) {
    const run = await waitingRun(forge, project);
    const gateId = run.gates[0]!.id;
    const asset = (await pool.query("INSERT INTO assets (run_id, position, name, kind, description, width, height, target_path) VALUES ($1, 0, 'a', 'sprite', 'd', 8, 8, 'a.png') RETURNING id", [run.id])).rows[0].id;
    const version = (await pool.query("INSERT INTO asset_versions (asset_id, iteration, attempt) VALUES ($1, 0, 1) RETURNING id", [asset])).rows[0].id;
    await pool.query("INSERT INTO asset_verdicts (gate_id, asset_id, version_id, verdict) VALUES ($1, $2, $3, 'approve')", [gateId, asset, version]);
    await pool.query("UPDATE step_attempts SET asset_id = $2 WHERE run_id = $1", [run.id, asset]);
    await pool.query("INSERT INTO check_results (run_id, attempt, command, exit_status) VALUES ($1, 1, 'true', 0)", [run.id]);
    await pool.query("INSERT INTO reviews (run_id, iteration, step_id, attempt, author, verdict, body, final) VALUES ($1, 0, 'review', 1, 'a', 'approve', 'ok', true)", [run.id]);
    await pool.query("INSERT INTO conversation_turns (run_id, step_id, seq, author, kind, body, gate_id) VALUES ($1, 's', 1, 'human', 'reply', 'hi', $2)", [run.id, gateId]);
    await pool.query("UPDATE runs SET state = 'abandoned', archived_at = $2 WHERE id = $1", [run.id, archivedAt]);
    return run;
  }
  const tables = ["step_attempts", "gates", "assets", "check_results", "reviews", "conversation_turns"];

  it("deletes Runs archived more than the delay ago, with everything that belongs to them, and logs how many", async () => {
    const forge = newForge({ archiveDays: 30 });
    const { project } = await projectOf(forge);
    const old = await runWithEverything(forge, project, new Date(clock.getTime() - 31 * DAY));
    const recent = await runWithEverything(forge, project, new Date(clock.getTime() - 29 * DAY));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    (await forge.startPurging())();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("1 archived Run deleted"));
    log.mockRestore();
    await expect(forge.getRun(old.id)).rejects.toThrow();
    expect((await forge.getRun(recent.id)).id).toBe(recent.id);
    for (const table of tables) {
      expect(await count(table, old.id), table).toBe(0);
      expect(await count(table, recent.id), table).toBeGreaterThan(0);
    }
    const verdicts = await pool.query("SELECT count(*) FROM asset_verdicts v JOIN assets a ON a.id = v.asset_id WHERE a.run_id = $1", [old.id]);
    expect(Number(verdicts.rows[0].count)).toBe(0);
  });

  it("never deletes a Run that is not archived, however old", async () => {
    const forge = newForge({ archiveDays: 1 });
    const { project } = await projectOf(forge);
    const waiting = await waitingRun(forge, project);
    const approved = await waitingRun(forge, project);
    await pool.query("UPDATE runs SET state = 'approved' WHERE id = $1", [approved.id]);
    const merged = await waitingRun(forge, project);
    await pool.query("UPDATE runs SET state = 'merged' WHERE id = $1", [merged.id]);

    clock = new Date(clock.getTime() + 400 * DAY);
    (await forge.startPurging())();

    for (const run of [waiting, approved, merged]) expect((await forge.getRun(run.id)).id).toBe(run.id);
  });

  it("runs again every 24 hours by the clock, with a default delay of 60 days", async () => {
    const timer = manualTimer();
    const forge = newForge({ every: timer.every });
    const { project } = await projectOf(forge);
    const run = await runWithEverything(forge, project, new Date(clock.getTime() - 59 * DAY));
    const stop = await forge.startPurging();
    expect((await forge.getRun(run.id)).id).toBe(run.id);

    clock = new Date(clock.getTime() + 2 * DAY);
    timer.tick();
    await forge.whenIdle();
    expect(await count("gates", run.id)).toBe(0);
    await expect(forge.getRun(run.id)).rejects.toThrow();

    stop();
    expect(timer.running()).toBe(0);
  });
});
