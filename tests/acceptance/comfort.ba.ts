import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project, QuotaStatus, Run, RunDetail, WorkflowValidation } from "../../src/forge/types.js";
import type { Team } from "../../src/forge/team.js";
import { api, BA_DB, cloneSandbox, getRun, gh, git, ok, openGate, prState, registerProject, resetDatabase, sandboxRepo, STAMP, startApp, waitFor, waitForState, type App } from "./harness.js";

/**
 * Comfort acceptance (BA) scenarios (M4): what the human checks by hand after M4a.
 *   1. a Run abandoned at its final Gate is archived: worktree, local branch and remote branch gone, pull request closed,
 *      its history still readable;
 *   2. after a Claude Step the Quota shows a fresh Claude reading;
 *   3. (no Agent) Workflow validation and the Team's seats.
 * Same setup as the other BA files: its own database, the real sandbox repository, Claude on a cheap model.
 */

const T = (minutes: number) => minutes * 60_000;
const marker = `ba-${STAMP}-comfort`;

let app: App;
let clone: string;

beforeAll(async () => {
  sandboxRepo();
  await resetDatabase(BA_DB);
  app = await startApp();
}, T(5));

afterAll(async () => {
  await app?.stop();
  if (process.env.BA_SHOW_LOG) console.log(app?.log.join(""));
}, T(2));

/** Whether the sandbox still has `branch` (`gh api` answers 404 once it is deleted). */
function remoteBranchExists(branch: string): boolean {
  try {
    gh("api", `repos/${sandboxRepo()}/branches/${branch}`);
    return true;
  } catch (e: any) {
    if (/404|Not Found/.test(`${e.stderr ?? ""}${e.stdout ?? ""}${e.message}`)) return false;
    throw e;
  }
}

describe.sequential("1–2. a Run abandoned at its final Gate is archived; Quota is read after a Claude Step", () => {
  let project: Project;
  let runId: number;
  let before: RunDetail;
  let started = 0;

  it("brings a developer Run to its final Gate", async () => {
    clone = cloneSandbox("comfort");
    project = await registerProject(clone, { checks: ["true"], max: 1 });
    const created = await ok<Run>("POST", "/api/runs", {
      projectId: project.id,
      title: `BA ${STAMP} comfort`,
      task: `Create a file named ${marker}.txt at the repository root containing exactly the line "hello". Commit it. Do nothing else.`,
    });
    runId = created.id;
    started = Date.now();
    const run = await waitForState(runId, "waiting", T(15));
    expect(openGate(run)?.kind).toBe("final");
    expect(run.worktreePath).toBeTruthy();
    expect(existsSync(run.worktreePath!)).toBe(true);
    expect(run.branch).toBeTruthy();
    expect(run.archivedAt).toBeNull();
    expect(prState(run.prNumber!)).toBe("OPEN");
    expect(remoteBranchExists(run.branch!)).toBe(true);
    before = run;
  });

  it("reads a Claude Quota with both windows and a small age after the Claude Step", async () => {
    const quota = await ok<QuotaStatus[]>("GET", "/api/quota");
    const claude = quota.find((q) => q.vendor === "claude");
    expect(claude?.reading).toBeTruthy();
    expect(typeof claude!.reading!.fiveHour.percentUsed).toBe("number");
    expect(typeof claude!.reading!.weekly.percentUsed).toBe("number");
    expect(claude!.ageSeconds).not.toBeNull();
    // Refreshed by the Run's Agent Step (or the 5 minute reading), so no older than the Run plus a margin.
    expect(claude!.ageSeconds!).toBeLessThan((Date.now() - started) / 1000 + 120);
    expect(claude!.ageSeconds!).toBeLessThan(10 * 60);
  });

  it("archives the Run when the human abandons it: worktree and branches gone, pull request closed", async () => {
    const after = await ok<RunDetail>("POST", `/api/gates/${openGate(await getRun(runId))!.id}/decision`, { action: "abandon" });
    expect(after.state).toBe("abandoned");
    const archived = await waitFor("Run archived", 120_000, async () => {
      const r = await getRun(runId);
      return r.archivedAt ? r : null;
    }, 2000);
    expect(archived.state).toBe("abandoned");
    expect(existsSync(before.worktreePath!)).toBe(false);
    expect(git(clone, "branch", "--list", before.branch!)).toBe("");
    await waitFor("remote branch deleted", 60_000, async () => (remoteBranchExists(before.branch!) ? null : true), 2000);
    await waitFor("pull request closed", 60_000, async () => (prState(before.prNumber!) === "CLOSED" ? true : null));
  });

  it("still serves the archived Run's history", async () => {
    const detail = await getRun(runId);
    expect(detail.archivedAt).toBeTruthy();
    expect(detail.prUrl).toBe(before.prUrl);
    expect(detail.steps.map((s) => s.id)).toEqual(before.steps.map((s) => s.id));
    expect(detail.gates.length).toBe(before.gates.length);
    expect(detail.gates.find((g) => g.kind === "final")?.decidedAt).toBeTruthy();
    expect(detail.checks.length).toBe(before.checks.length);
    expect(detail.reviews.map((r) => r.id)).toEqual(before.reviews.map((r) => r.id));
    expect(detail.attempts.length).toBe(before.attempts.length);
  });
});

describe("3. Workflow validation and the Team (no Agent)", () => {
  const builtIn = readFileSync(join(import.meta.dirname, "../../src/forge/workflows/developer.yaml"), "utf8");

  it("answers valid for a copy of a built-in Workflow", async () => {
    const res = await ok<WorkflowValidation>("POST", "/api/workflows/validate", { yaml: builtIn });
    expect(res.errors).toEqual([]);
    expect(res.valid).toBe(true);
  });

  it("lists the errors of a broken Workflow and refuses a body without YAML text", async () => {
    const broken = builtIn.replace("type: checks", "type: nonsense").replace("needs: [publish]", "needs: [nowhere]");
    const res = await ok<WorkflowValidation>("POST", "/api/workflows/validate", { yaml: broken });
    expect(res.valid).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    for (const e of res.errors) expect(e.message).toBeTruthy();
    expect((await api("POST", "/api/workflows/validate", { yaml: 3 })).status).toBe(400);
  });

  it("lists the Team's seats", async () => {
    const team = await ok<Team>("GET", "/api/team");
    const names = team.seats.map((s) => s.seat);
    for (const seat of ["griller", "spec-writer", "architect", "developer", "reviewer-a", "reviewer-b", "consolidator", "artist"]) expect(names).toContain(seat);
    expect(team.seats.every((s) => s.runner.value && s.model.source)).toBe(true);
  });
});
