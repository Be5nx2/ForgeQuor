import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { createForge, type Forge, type ForgeDeps, type Project, type QuotaReading, type RunUpdate } from "../../src/forge/forge.js";
import type { Runner } from "../../src/runner/runner.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner, type FakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote, type TempRemote, type TempRepo } from "../harness/git.js";

let pool: pg.Pool;
let drop: () => Promise<void>;
let worktrees: string;
let counter = 0;
let clock = new Date("2026-11-27T10:00:00Z");
const cleanups: Array<() => void> = [];
const forges: Forge[] = [];

beforeAll(async () => {
  const db = await createTestDatabase();
  pool = db.pool;
  drop = db.drop;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-worktrees-"));
});
afterAll(async () => {
  await Promise.all(forges.map((f) => f.whenIdle()));
  await drop();
  rmSync(worktrees, { recursive: true, force: true });
});
afterEach(async () => {
  await pool.query("DELETE FROM quota_readings");
  clock = new Date("2026-11-27T10:00:00Z");
  cleanups.splice(0).forEach((c) => c());
});

const reading = (percent: number | null, over: Partial<QuotaReading> = {}): QuotaReading => ({
  fiveHour: { percentUsed: percent, resetsAt: new Date("2026-11-27T14:00:00Z") },
  weekly: { percentUsed: percent === null ? null : percent / 2, resetsAt: new Date("2026-11-30T14:00:00Z") },
  exhausted: false,
  readAt: clock,
  ...over,
});

/** A Runner that can be asked for its Quota: it answers with the next reading of its list (the last one again when they run out). */
function askable(...answers: (QuotaReading | null | Error)[]): FakeRunner & { asked: number } {
  const runner = createFakeRunner() as FakeRunner & { asked: number; readQuota: Runner["readQuota"] };
  runner.asked = 0;
  runner.readQuota = async () => {
    const answer = answers[Math.min(runner.asked++, answers.length - 1)]!;
    if (answer instanceof Error) throw answer;
    return answer && { ...answer, readAt: clock };
  };
  return runner;
}

/** A timer driven by hand: `tick()` is the 5 minutes going by. */
function manualTimer() {
  const tasks = new Set<() => void>();
  return {
    every: (task: () => void) => (tasks.add(task), () => void tasks.delete(task)),
    tick: () => tasks.forEach((t) => t()),
    running: () => tasks.size,
  };
}

function forgeWith(runner: Runner, extra: { artistRunner?: Runner; seats?: ForgeDeps["seats"]; every?: ReturnType<typeof manualTimer>["every"] } = {}): Forge {
  const created = createForge({ pool, runner, artistRunner: extra.artistRunner, seats: extra.seats, codeHost: createFakeCodeHost(), worktreesRoot: worktrees, now: () => clock, every: extra.every });
  forges.push(created);
  return created;
}

async function project(forge: Forge): Promise<Project> {
  const { repo, remote }: { repo: TempRepo; remote: TempRemote } = createRepoWithBareRemote({ remote: `git@github.com:acme/quota-${++counter}.git` });
  cleanups.push(repo.cleanup, remote.cleanup);
  const registered = await forge.registerProject({ path: repo.path });
  remote.pointOriginAtBare();
  return registered;
}

async function developerStep(forge: Forge) {
  const p = await project(forge);
  await forge.startRun({ projectId: p.id, task: "Do the thing." });
  await forge.whenIdle();
}

describe("Quota readings", () => {
  it("knows nothing about either vendor before any reading", async () => {
    const forge = forgeWith(askable(reading(10)));

    expect(await forge.quota()).toEqual([
      { vendor: "claude", reading: null, ageSeconds: null },
      { vendor: "codex", reading: null, ageSeconds: null },
    ]);
  });

  it("reads Claude at startup and publishes the reading", async () => {
    const claude = askable(reading(12));
    const forge = forgeWith(claude);
    const heard: RunUpdate[] = [];
    forge.subscribe((u) => heard.push(u));

    const stop = await forge.startQuotaReading();
    stop();

    expect(claude.asked).toBe(1);
    expect(heard).toEqual([{ type: "quota", vendor: "claude", reading: reading(12) }]);
    expect(await forge.quota()).toEqual([
      { vendor: "claude", reading: reading(12), ageSeconds: 0 },
      { vendor: "codex", reading: null, ageSeconds: null },
    ]);
  });

  it("reads Claude again every 5 minutes by the clock, and says how old a reading is", async () => {
    const claude = askable(reading(12), reading(30));
    const timer = manualTimer();
    const forge = forgeWith(claude, { every: timer.every });
    const stop = await forge.startQuotaReading();
    expect(claude.asked).toBe(1);

    clock = new Date("2026-11-27T10:03:00Z");
    expect((await forge.quota())[0]).toMatchObject({ ageSeconds: 180 });

    clock = new Date("2026-11-27T10:05:00Z");
    timer.tick();
    await forge.whenIdle();

    expect(claude.asked).toBe(2);
    expect((await forge.quota())[0]).toMatchObject({ reading: { fiveHour: { percentUsed: 30 } }, ageSeconds: 0 });
    stop();
    expect(timer.running()).toBe(0);
  });

  it("keeps the readings through a restart", async () => {
    await forgeWith(askable(reading(12))).startQuotaReading().then((stop) => stop());

    const restarted = forgeWith(askable(null));
    clock = new Date("2026-11-27T10:01:00Z");

    expect((await restarted.quota())[0]).toEqual({ vendor: "claude", reading: reading(12, { readAt: new Date("2026-11-27T10:00:00Z") }), ageSeconds: 60 });
  });

  it("reads Claude's Quota again after every Claude Step, keeping the Step's own partial reading until then", async () => {
    const claude = askable(reading(12), reading(40));
    const forge = forgeWith(claude);
    claude.use(() => ({ status: "succeeded", summary: "done", quota: reading(null, { weekly: { percentUsed: null, resetsAt: null } }) /* a reset time only */ }));
    const heard: RunUpdate[] = [];
    forge.subscribe((u) => u.type === "quota" && heard.push(u));
    await (await forge.startQuotaReading())();

    await developerStep(forge);

    expect(claude.asked).toBe(2);
    expect(heard.map((u) => u.type === "quota" && u.reading.fiveHour.percentUsed)).toEqual([12, 12, 40]);
    expect((await forge.quota())[0]!.reading).toMatchObject({ fiveHour: { percentUsed: 40 } });
  });

  it("records what a Codex Step said of its Quota, which cannot be asked for", async () => {
    const codex = createFakeRunner(() => ({ status: "succeeded", summary: "done", quota: reading(55) }));
    const forge = forgeWith(askable(null), { artistRunner: codex, seats: { developer: { runner: "codex" } } });

    await developerStep(forge);

    expect(codex.steps).toHaveLength(1);
    expect(await forge.quota()).toEqual([
      { vendor: "claude", reading: null, ageSeconds: null },
      { vendor: "codex", reading: reading(55), ageSeconds: 0 },
    ]);
  });

  it("records an exhausted reading with its reset time when a Runner pauses a Run for Quota", async () => {
    const codex = createFakeRunner(() => ({ status: "quota_exhausted", resetsAt: new Date("2026-11-27T15:30:00Z") }));
    const forge = forgeWith(askable(null), { artistRunner: codex, seats: { developer: { runner: "codex" } } });

    await developerStep(forge);

    const [run] = await forge.listRuns();
    expect(run!.state).toBe("paused");
    const codexReading = (await forge.quota())[1]!.reading!;
    expect(codexReading.exhausted).toBe(true);
    expect(codexReading.fiveHour.resetsAt).toEqual(new Date("2026-11-27T15:30:00Z"));
  });

  it("keeps the percents last read when a pause records exhaustion", async () => {
    let calls = 0;
    const codex = createFakeRunner(() => (++calls === 1 ? { status: "succeeded", summary: "done", quota: reading(80) } : { status: "quota_exhausted", resetsAt: null }));
    const forge = forgeWith(askable(null), { artistRunner: codex, seats: { developer: { runner: "codex" } } });

    await developerStep(forge);
    await developerStep(forge);

    expect((await forge.quota())[1]!.reading).toMatchObject({ exhausted: true, fiveHour: { percentUsed: 80 }, weekly: { percentUsed: 40 } });
  });

  it("does not let a Runner that fails to answer disturb a Step", async () => {
    const claude = askable(new Error("claude is gone"));
    const forge = forgeWith(claude);
    const stop = await forge.startQuotaReading();
    stop();

    await developerStep(forge);

    const [run] = await forge.listRuns();
    expect(run!.state).toBe("waiting");
    expect((await forge.quota())[0]!.reading).toBeNull();
  });

  it("asks once more when a Step ends while a reading is under way, so the answer is never older than the Step", async () => {
    let release!: () => void;
    const claude = askable(reading(12));
    const first = claude.readQuota!;
    let calls = 0;
    claude.readQuota = async () => {
      if (calls++ === 0) await new Promise<void>((r) => (release = r));
      return first();
    };
    const forge = forgeWith(claude);
    const starting = forge.startQuotaReading();
    await new Promise((r) => setTimeout(r, 20));

    const p = await project(forge);
    const run = await forge.startRun({ projectId: p.id, task: "Do the thing." });
    await vi.waitFor(async () => expect((await forge.getRun(run.id)).state).toBe("waiting"));
    release();
    (await starting)();
    await forge.whenIdle();

    expect(calls).toBe(2);
  });
});
