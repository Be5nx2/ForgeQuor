import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createForge, InvalidSeatError, SeatLockedError, type Forge, type ForgeDeps, type Project, type RunDetail } from "../../src/forge/forge.js";
import { seatSettingsFromEnv } from "../../src/forge/seats.js";
import type { StepRequest, StepResult } from "../../src/runner/runner.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote, type TempRemote, type TempRepo } from "../harness/git.js";

/** The seats of a Run (overrides, freezing, what each Step used), through the Forge core: real git and PostgreSQL, scripted Runners, a fake code host. */

let pool: pg.Pool;
let drop: () => Promise<void>;
let worktrees: string;
const claude = createFakeRunner();
const codex = createFakeRunner();
const codeHost = createFakeCodeHost();
const cleanups: Array<() => void> = [];
const forges: Forge[] = [];
let counter = 0;

const isReviewer = (step: StepRequest) => step.instructions.includes("You are the Reviewer");
const answer = (step: StepRequest): StepResult | void => {
  if (isReviewer(step)) return { status: "succeeded", summary: "Summary: ok.\n\nVerdict: pass" };
  writeFileSync(join(step.cwd, "fix.txt"), "fix\n");
  writeFileSync(join(step.cwd, ".forgequor", "review-brief.md"), "What the Developer did.\n");
};

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  pool = db.pool;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-run-seats-"));
});
afterAll(async () => {
  await Promise.all(forges.map((f) => f.whenIdle()));
  await drop();
  rmSync(worktrees, { recursive: true, force: true });
});
afterEach(async () => {
  claude.use(answer);
  codex.use(answer);
  claude.steps.length = 0;
  codex.steps.length = 0;
  codeHost.pullRequests.length = 0;
  await pool.query("DELETE FROM team_seats");
  cleanups.splice(0).forEach((c) => c());
});

function forgeWith(overrides: Partial<ForgeDeps> = {}): Forge {
  const created = createForge({ pool, runner: claude, artistRunner: codex, codeHost, worktreesRoot: worktrees, ...overrides });
  forges.push(created);
  return created;
}

async function project(f: Forge): Promise<Project> {
  const { repo, remote } = createRepoWithBareRemote({ remote: `git@github.com:acme/run-seats-${++counter}.git` }) as { repo: TempRepo; remote: TempRemote };
  cleanups.push(repo.cleanup, remote.cleanup);
  const registered = await f.registerProject({ path: repo.path });
  remote.pointOriginAtBare();
  return registered;
}

async function bugfix(f: Forge, p: Project): Promise<RunDetail> {
  const started = await f.startRun({ projectId: p.id, workflow: "bugfix", task: "The player cannot jump twice." });
  await f.whenIdle();
  return f.getRun(started.id);
}


describe("Seats per Run", () => {
  it("uses a Run's overrides for its Agent Steps only, field by field over the Team's settings", async () => {
    const f = forgeWith();
    const p = await project(f);
    await f.changeSeat("developer", { model: "team-model" });

    const started = await f.startRun({ projectId: p.id, workflow: "bugfix", task: "The player cannot jump twice.", seats: { developer: { runner: "codex" } } });
    await f.whenIdle();
    const run = await f.getRun(started.id);
    const next = await bugfix(f, p);

    expect(run.attempts[0]).toMatchObject({ runner: "codex", model: "team-model" });
    expect(next.attempts[0]).toMatchObject({ runner: "claude", model: "team-model" });
  });

  it("freezes the seats when the Run first starts, so neither a Team change nor a restart moves them", async () => {
    let now = new Date("2030-01-01T10:00:00Z");
    const f = forgeWith({ now: () => now });
    const p = await project(f);
    claude.use(() => ({ status: "quota_exhausted", resetsAt: new Date("2030-01-01T12:00:00Z") }));
    const started = await f.startRun({ projectId: p.id, workflow: "bugfix", task: "The player cannot jump twice.", seats: { developer: { model: "run-model" } } });
    await f.whenIdle();
    expect((await f.getRun(started.id)).state).toBe("paused");
    expect((await pool.query("SELECT seats FROM runs WHERE id = $1", [started.id])).rows[0].seats.developer).toEqual({ runner: "claude", model: "run-model" });

    await f.changeSeat("developer", { runner: "codex", model: "other" });
    claude.use(answer);
    codex.use(answer);
    now = new Date("2030-01-01T12:00:01Z");
    const restarted = forgeWith({ now: () => now });
    await restarted.resumePausedRuns();
    await restarted.whenIdle();

    const run = await f.getRun(started.id);
    expect(run.attempts.filter((a) => a.step === "bugfixer").map((a) => [a.runner, a.model, a.status])).toEqual([["claude", "run-model", "quota_exhausted"], ["claude", "run-model", "succeeded"]]);
    expect(codex.steps.filter((s) => !isReviewer(s))).toHaveLength(0);
  });

  it("keeps resolving the seats of a Run from before M4 (none frozen) from the Team, then freezes them", async () => {
    let now = new Date("2030-01-01T10:00:00Z");
    const f = forgeWith({ now: () => now });
    const p = await project(f);
    await f.changeSeat("developer", { runner: "codex" });
    codex.use(() => ({ status: "quota_exhausted", resetsAt: new Date("2030-01-01T12:00:00Z") }));
    const started = await f.startRun({ projectId: p.id, workflow: "bugfix", task: "The player cannot jump twice." });
    await f.whenIdle();
    await pool.query("UPDATE runs SET seats = NULL, seat_overrides = NULL WHERE id = $1", [started.id]);
    await f.changeSeat("developer", { runner: "claude" });
    claude.use(answer);
    now = new Date("2030-01-01T12:00:01Z");

    await f.resumePausedRuns();
    await f.whenIdle();

    const rows = (await f.getRun(started.id)).attempts.filter((a) => a.step === "bugfixer");
    expect(rows.map((a) => [a.runner, a.status])).toEqual([["codex", "quota_exhausted"], ["claude", "succeeded"]]);
    expect((await pool.query("SELECT seats FROM runs WHERE id = $1", [started.id])).rows[0].seats.developer.runner).toBe("claude");
  });

  it("refuses an unknown seat or Runner, and a field the environment holds, before creating anything", async () => {
    const f = forgeWith({ seats: seatSettingsFromEnv({ FORGEQUOR_DEVELOPER_MODEL: "env-model" }) });
    const p = await project(f);
    const start = (seats: unknown) => f.startRun({ projectId: p.id, workflow: "bugfix", task: "A bug.", seats: seats as never });

    await expect(start({ janitor: { runner: "claude" } })).rejects.toThrow(InvalidSeatError);
    await expect(start({ developer: { runner: "gemini" } })).rejects.toThrow(/not a Runner/);
    await expect(start({ developer: { model: "mine" } })).rejects.toThrow(SeatLockedError);
    await expect(start({ developer: { model: "mine" } })).rejects.toThrow(/FORGEQUOR_DEVELOPER_MODEL/);
    expect((await pool.query("SELECT 1 FROM runs WHERE project_id = $1", [p.id])).rowCount).toBe(0);
  });

  it("opens an Escalation naming the seat when a Run's override gives it a Runner Forgequor cannot start", async () => {
    const f = forgeWith({ artistRunner: undefined });
    const p = await project(f);

    const started = await f.startRun({ projectId: p.id, workflow: "bugfix", task: "A bug.", seats: { developer: { runner: "codex" } } });
    await f.whenIdle();

    const open = (await f.getRun(started.id)).gates.find((g) => g.kind === "escalation" && !g.decidedAt);
    expect(open?.reason).toMatch(/seat "developer" \(Forgequor has no codex Runner\)/);
  });
});
