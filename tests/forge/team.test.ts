import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createForge, InvalidInputError, SeatLockedError, type Forge, type ForgeDeps, type Project, type RunDetail } from "../../src/forge/forge.js";
import { seatSettingsFromEnv } from "../../src/forge/seats.js";
import { effectiveSeats } from "../../src/forge/team.js";
import { fallbackCatalog } from "../../src/runner/catalog.js";
import type { StepRequest, StepResult } from "../../src/runner/runner.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote, type TempRemote, type TempRepo } from "../harness/git.js";

/** The Team settings, through the Forge core: real git and PostgreSQL, scripted Runners, a fake code host. */

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
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-team-"));
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
  const { repo, remote } = createRepoWithBareRemote({ remote: `git@github.com:acme/team-${++counter}.git` }) as { repo: TempRepo; remote: TempRemote };
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

const seat = (team: Awaited<ReturnType<Forge["team"]>>, name: string) => team.seats.find((s) => s.seat === name)!;

describe("effectiveSeats", () => {
  it("takes each field from the environment, else the Team, else the default, Runner and model apart", () => {
    const seats = effectiveSeats({ developer: { model: "env-model" }, "reviewer-a": { runner: "codex" } }, { developer: { runner: "codex", model: "team-model" }, "reviewer-a": { runner: "claude", model: "team-opus" } });

    expect(seats.find((s) => s.seat === "developer")).toMatchObject({
      runner: { value: "codex", source: "team" },
      model: { value: "env-model", source: "env", variable: "FORGEQUOR_DEVELOPER_MODEL" },
    });
    expect(seats.find((s) => s.seat === "reviewer-a")).toMatchObject({
      runner: { value: "codex", source: "env", variable: "FORGEQUOR_REVIEWER_A_RUNNER" },
      model: { value: "team-opus", source: "team" },
    });
    expect(seats.find((s) => s.seat === "artist")).toMatchObject({ runner: { value: "codex", source: "default" }, model: { value: null, source: "default" } });
  });
});

describe("the Team", () => {
  it("lists every seat with its default Runner, and the built-in Catalog when none was read", async () => {
    const team = await forgeWith().team();

    expect(team.seats).toHaveLength(8);
    expect(seat(team, "reviewer-b").runner).toEqual({ value: "codex", source: "default" });
    expect(team.catalog.claude.models.map((m) => m.id)).toEqual(["opus", "sonnet", "haiku"]);
    expect(team.catalog.claude.fallback).toBe(true);
    expect(team.catalog.codex.fallback).toBe(true);
  });

  it("carries the Catalog the Forge was given, kept as read", async () => {
    const catalog = fallbackCatalog();
    catalog.codex = { models: [{ id: "gpt-6.1-terra", efforts: ["low", "high"], defaultEffort: "low" }], defaultModel: "gpt-6.1-terra", efforts: ["low", "high"], fallback: false };

    const team = await forgeWith({ catalog }).team();

    expect(team.catalog).toEqual(catalog);
    expect((await forgeWith({ catalog }).changeSeat("developer", { model: "x" })).catalog).toEqual(catalog);
  });

  it("keeps a saved setting across Forges (a restart), and clears a field with null", async () => {
    await forgeWith().changeSeat("developer", { runner: "codex", model: "gpt-x" });

    expect(seat(await forgeWith().team(), "developer")).toMatchObject({ runner: { value: "codex", source: "team" }, model: { value: "gpt-x", source: "team" } });

    const cleared = await forgeWith().changeSeat("developer", { model: null });
    expect(seat(cleared, "developer")).toMatchObject({ runner: { value: "codex", source: "team" }, model: { value: null, source: "default" } });
  });

  it("refuses an unknown seat, an unknown Runner, and an empty change, saving nothing", async () => {
    const f = forgeWith();

    await expect(f.changeSeat("janitor", { runner: "claude" })).rejects.toThrow(InvalidInputError);
    await expect(f.changeSeat("developer", { runner: "gemini" })).rejects.toThrow(/not a Runner/);
    await expect(f.changeSeat("developer", {})).rejects.toThrow(InvalidInputError);
    expect((await pool.query("SELECT 1 FROM team_seats")).rowCount).toBe(0);
  });

  it("refuses a field the environment holds, naming its variable, but still accepts the other one", async () => {
    const f = forgeWith({ seats: seatSettingsFromEnv({ FORGEQUOR_DEVELOPER_MODEL: "env-model" }) });

    await expect(f.changeSeat("developer", { model: "other" })).rejects.toThrow(SeatLockedError);
    await expect(f.changeSeat("developer", { model: "other" })).rejects.toThrow(/FORGEQUOR_DEVELOPER_MODEL/);
    const team = await f.changeSeat("developer", { runner: "codex" });

    expect(seat(team, "developer")).toMatchObject({ runner: { value: "codex", source: "team" }, model: { value: "env-model", source: "env", variable: "FORGEQUOR_DEVELOPER_MODEL" } });
  });
});

const effortCatalog = () => {
  const catalog = fallbackCatalog();
  catalog.codex = {
    models: [
      { id: "gpt-terra", efforts: ["low", "medium", "high"], defaultEffort: "low" },
      { id: "gpt-sol", efforts: ["low", "ultra"], defaultEffort: "low" },
    ],
    defaultModel: "gpt-terra",
    efforts: ["low", "medium", "high"],
    fallback: false,
  };
  return catalog;
};

describe("a Seat's effort", () => {
  it("is set from the environment, then the Team, else the Runner's default, with its source", async () => {
    const f = forgeWith({ seats: seatSettingsFromEnv({ FORGEQUOR_DEVELOPER_EFFORT: "max", FORGEQUOR_ARCHITECT_EFFORT: " " }), catalog: effortCatalog() });

    const team = await f.changeSeat("griller", { effort: "high" });

    expect(seat(team, "developer").effort).toEqual({ value: "max", source: "env", variable: "FORGEQUOR_DEVELOPER_EFFORT" });
    expect(seat(team, "griller").effort).toEqual({ value: "high", source: "team" });
    expect(seat(team, "architect").effort).toEqual({ value: null, source: "default" });
  });

  it("is kept across Forges, and cleared with null or an empty text", async () => {
    await forgeWith().changeSeat("developer", { effort: "low" });
    expect(seat(await forgeWith().team(), "developer").effort).toEqual({ value: "low", source: "team" });

    expect(seat(await forgeWith().changeSeat("developer", { effort: null }), "developer").effort).toEqual({ value: null, source: "default" });
    await forgeWith().changeSeat("developer", { effort: "low" });
    expect(seat(await forgeWith().changeSeat("developer", { effort: "" }), "developer").effort.value).toBeNull();
  });

  it("leaves the Runner and model alone when only the effort changes", async () => {
    const f = forgeWith({ catalog: effortCatalog() });
    await f.changeSeat("reviewer-b", { runner: "codex", model: "gpt-sol", effort: "ultra" });

    const team = await f.changeSeat("reviewer-b", { effort: "low" });

    expect(seat(team, "reviewer-b")).toMatchObject({ runner: { value: "codex" }, model: { value: "gpt-sol" }, effort: { value: "low" } });
  });

  it("is refused when the Runner has no such level, naming the accepted ones, saving nothing", async () => {
    const f = forgeWith({ catalog: effortCatalog() });

    await expect(f.changeSeat("developer", { effort: "ultra" })).rejects.toThrow(InvalidInputError);
    await expect(f.changeSeat("developer", { effort: "ultra" })).rejects.toThrow(/low, medium, high, xhigh, max/);
    await expect(f.changeSeat("developer", { effort: "turbo" })).rejects.toThrow(/not an effort level/);
    expect((await pool.query("SELECT 1 FROM team_seats")).rowCount).toBe(0);
  });

  it("follows the Seat's Codex model: a level only another model has is refused", async () => {
    const f = forgeWith({ catalog: effortCatalog() });
    await f.changeSeat("reviewer-b", { model: "gpt-sol", effort: "ultra" });

    await expect(f.changeSeat("reviewer-b", { effort: "medium" })).rejects.toThrow(/with model gpt-sol; it accepts low, ultra/);
    // A model the Catalog does not know gets the default model's levels.
    expect(seat(await f.changeSeat("reviewer-b", { model: "gpt-new", effort: "medium" }), "reviewer-b").effort.value).toBe("medium");
  });

  it("refuses a Runner or model change that strands the stored effort, saving nothing of it", async () => {
    const f = forgeWith({ catalog: effortCatalog() });
    await f.changeSeat("reviewer-b", { model: "gpt-sol", effort: "ultra" });

    await expect(f.changeSeat("reviewer-b", { model: "gpt-terra" })).rejects.toThrow(/"ultra" is not an effort level of codex with model gpt-terra/);
    await expect(f.changeSeat("reviewer-b", { runner: "claude" })).rejects.toThrow(/of claude with model gpt-sol; it accepts low, medium, high, xhigh, max/);
    expect(seat(await f.team(), "reviewer-b")).toMatchObject({ runner: { source: "default" }, model: { value: "gpt-sol" }, effort: { value: "ultra" } });
    // Changing both together to something that fits is fine.
    const ok = await f.changeSeat("reviewer-b", { model: "gpt-terra", effort: "high" });
    expect(seat(ok, "reviewer-b").effort.value).toBe("high");
  });

  it("is locked when the environment holds it, naming the variable; the other fields stay free", async () => {
    const f = forgeWith({ seats: seatSettingsFromEnv({ FORGEQUOR_DEVELOPER_EFFORT: "max" }) });

    await expect(f.changeSeat("developer", { effort: "low" })).rejects.toThrow(SeatLockedError);
    await expect(f.changeSeat("developer", { effort: "low" })).rejects.toThrow(/FORGEQUOR_DEVELOPER_EFFORT/);
    expect(seat(await f.changeSeat("developer", { model: "opus" }), "developer").model.value).toBe("opus");
  });
});

describe("Runs and a Seat's effort", () => {
  it("record the effort on each Step attempt, and the Runner default as null", async () => {
    const f = forgeWith();
    const p = await project(f);
    const before = await bugfix(f, p);
    expect(before.attempts[0]!.effort).toBeNull();

    await f.changeSeat("developer", { effort: "high" });
    const after = await bugfix(f, p);

    expect(after.attempts[0]).toMatchObject({ runner: "claude", effort: "high" });
    expect(claude.steps.filter((s) => !isReviewer(s)).at(-1)).toMatchObject({ effort: "high" });
  });

  it("let the environment win over the Team", async () => {
    const f = forgeWith({ seats: seatSettingsFromEnv({ FORGEQUOR_DEVELOPER_EFFORT: "max" }) });
    const p = await project(f);
    await pool.query("INSERT INTO team_seats (seat, effort) VALUES ('developer', 'low')");

    const run = await bugfix(f, p);

    expect(run.attempts[0]!.effort).toBe("max");
  });

  it("freeze the effort with the Run's other Seat settings", async () => {
    const f = forgeWith();
    const p = await project(f);
    await f.changeSeat("developer", { effort: "low" });
    const started = await f.startRun({ projectId: p.id, workflow: "bugfix", task: "The player cannot jump twice." });
    await f.whenIdle();
    await f.changeSeat("developer", { effort: "max" });

    expect((await pool.query("SELECT seats FROM runs WHERE id = $1", [started.id])).rows[0].seats.developer.effort).toBe("low");
  });
});

describe("Runs and the Team", () => {
  it("use a Team change for the next Run without restarting the Forge", async () => {
    const f = forgeWith();
    const p = await project(f);
    const first = await bugfix(f, p);
    expect(first.attempts[0]).toMatchObject({ runner: "claude" });

    await f.changeSeat("developer", { runner: "codex", model: "gpt-team" });
    const second = await bugfix(f, p);

    expect(second.attempts[0]).toMatchObject({ runner: "codex", model: "gpt-team" });
  });

  it("let the environment win over the Team", async () => {
    const f = forgeWith({ seats: seatSettingsFromEnv({ FORGEQUOR_DEVELOPER_MODEL: "env-model" }) });
    const p = await project(f);
    await pool.query("INSERT INTO team_seats (seat, runner, model) VALUES ('developer', NULL, 'team-model')");

    const run = await bugfix(f, p);

    expect(run.attempts[0]).toMatchObject({ runner: "claude", model: "env-model" });
  });

  it("open an Escalation naming the seat when the Team gives it a Runner Forgequor cannot start", async () => {
    const f = forgeWith({ artistRunner: undefined });
    const p = await project(f);
    await f.changeSeat("developer", { runner: "codex" });

    const run = await bugfix(f, p);

    const open = run.gates.find((g) => g.kind === "escalation" && !g.decidedAt);
    expect(open?.reason).toMatch(/seat "developer" \(Forgequor has no codex Runner\)/);
  });
});
