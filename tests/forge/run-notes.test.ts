import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { createForge, type Forge, type Project } from "../../src/forge/forge.js";
import { MAX_RUN_NOTE_BYTES } from "../../src/forge/run-notes.js";
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

function newForge(): Forge {
  const f = createForge({ pool, runner, codeHost, worktreesRoot: worktrees, now: () => clock });
  forges.push(f);
  return f;
}

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  pool = db.pool;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-notes-"));
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
  const { repo, remote } = createRepoWithBareRemote({ remote: `git@github.com:acme/notes-${++counter}.git` });
  cleanups.push(repo.cleanup, remote.cleanup);
  const project = await forge.registerProject({ path: repo.path });
  remote.pointOriginAtBare();
  return { project, repo, remote };
}

/** A Run waiting at its final Gate whose worktree holds the given Run Notes (path -> content). */
async function runWithNotes(forge: Forge, project: Project, notes: Record<string, string | Buffer>) {
  runner.use((step) => {
    writeFileSync(join(step.cwd, "jump.gd"), "extends Node\n");
    git(step.cwd, "add", ".");
    git(step.cwd, "commit", "-q", "-m", "feat(player): add jump");
    for (const [path, content] of Object.entries(notes)) {
      mkdirSync(join(step.cwd, ".forgequor", path, ".."), { recursive: true });
      writeFileSync(join(step.cwd, ".forgequor", path), content);
    }
  });
  const started = await forge.startRun({ projectId: project.id, task: "Do it." });
  await forge.whenIdle();
  return forge.getRun(started.id);
}

describe("an Archived Run's Run Notes", () => {
  it("are kept in the database when the Run is abandoned, text only", async () => {
    const forge = newForge();
    const { project } = await projectOf(forge);
    const run = await runWithNotes(forge, project, {
      "grilling.md": "# Questions\n\nWhat jumps?\n",
      "asset-requests.json": '{"assets":[]}',
      "assets/replaced/1.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]),
      "big.txt": "x".repeat(MAX_RUN_NOTE_BYTES + 1),
    });
    expect(run.runNotes).toEqual([]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await forge.abandonRun(run.id);
    await forge.whenIdle();

    const after = await forge.getRun(run.id);
    expect(existsSync(run.worktreePath!)).toBe(false);
    expect(after.runNotes.map((n) => n.path)).toEqual(["asset-requests.json", "grilling.md"]);
    expect((await forge.getRunNote(run.id, "grilling.md")).content).toBe("# Questions\n\nWhat jumps?\n");
    expect((await forge.getRunNote(run.id, "asset-requests.json")).size).toBe(13);
    await expect(forge.getRunNote(run.id, "assets/replaced/1.png")).rejects.toThrow();
    expect(warn.mock.calls.flat().join(" ")).toContain("assets/replaced/1.png (binary)");
    expect(warn.mock.calls.flat().join(" ")).toContain("big.txt");
    warn.mockRestore();
  });

  it("are kept by the startup catch-up, and removed by the purge", async () => {
    const forge = newForge();
    const { project } = await projectOf(forge);
    const run = await runWithNotes(forge, project, { "review-brief.md": "Brief.", "notes/deep/plan.md": "Plan." });
    await pool.query("UPDATE runs SET state = 'merged' WHERE id = $1", [run.id]);

    await newForge().recoverAfterRestart();

    expect((await forge.getRun(run.id)).runNotes.map((n) => n.path)).toEqual(["notes/deep/plan.md", "review-brief.md"]);

    await pool.query("UPDATE runs SET archived_at = $2 WHERE id = $1", [run.id, new Date(clock.getTime() - 61 * DAY)]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    (await newForge().startPurging())();
    log.mockRestore();
    await expect(forge.getRun(run.id)).rejects.toThrow();
    const left = await pool.query("SELECT count(*) FROM run_notes WHERE run_id = $1", [run.id]);
    expect(Number(left.rows[0].count)).toBe(0);
  });

  it("do not stop the archiving when they cannot be copied", async () => {
    const forge = newForge();
    const { project } = await projectOf(forge);
    const run = await runWithNotes(forge, project, { "a.md": "A" });
    chmodSync(join(run.worktreePath!, ".forgequor", "a.md"), 0o000);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await forge.abandonRun(run.id);
    await forge.whenIdle();
    expect(error.mock.calls.flat().join(" ")).toContain("Run Notes");
    error.mockRestore();
    const after = await forge.getRun(run.id);
    expect(after.archivedAt).not.toBeNull();
    expect(existsSync(run.worktreePath!)).toBe(false);
  });
});
