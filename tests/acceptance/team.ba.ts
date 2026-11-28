import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project, Run, RunDetail } from "../../src/forge/types.js";
import {
  BA_DB,
  cloneSandbox,
  getRun,
  gh,
  ok,
  openGate,
  prState,
  pushToSandbox,
  registerProject,
  resetDatabase,
  sandboxRepo,
  STAMP,
  startApp,
  waitFor,
  FatalWait,
  type App,
} from "./harness.js";

/**
 * The M3b team, end to end, for real: `bugfix` with a solo Reviewer, and `feature` through the Griller's Conversation
 * Gate, the Spec Writer and its Gate, the Architect, the Developer, the Checks and a duo review. Every Claude seat runs on
 * the cheap model, and the second Reviewer on Claude too unless BA_CODEX=1 (see the harness).
 */

const T = (minutes: number) => minutes * 60_000;
const marker = `ba-${STAMP}`;
const buggy = `ba/sum-${STAMP}.sh`;

let app: App;
let pusher: string;

beforeAll(async () => {
  sandboxRepo();
  await resetDatabase(BA_DB);
  pusher = cloneSandbox("team-pusher");
  // The bug `bugfix` must fix: a script that subtracts where it should add.
  pushToSandbox(pusher, `chore(ba): a buggy script for BA ${STAMP}`, { [buggy]: '#!/bin/sh\n# Prints the sum of its two arguments.\necho $(($1 - $2))\n' });
  app = await startApp();
}, T(5));

afterAll(async () => {
  if (pusher) pushToSandbox(pusher, `chore(ba): remove the buggy script of BA ${STAMP}`, { [buggy]: null });
  await app?.stop();
  if (process.env.BA_SHOW_LOG) console.log(app?.log.join(""));
}, T(2));

/** Waits until the Run stops at a Gate (or ends), and returns it. Fails at once on an Escalation, with its reason. */
async function nextGate(id: number, timeoutMs = T(20)): Promise<RunDetail> {
  return waitFor(`Run ${id} at a Gate`, timeoutMs, async () => {
    const run = await getRun(id);
    if (run.state === "waiting") {
      const gate = openGate(run)!;
      if (gate.kind === "escalation") throw new FatalWait(`Run ${id} escalated: ${gate.reason}\n${gate.evidence ?? ""}`);
      return run;
    }
    if (["abandoned", "closed", "merged", "approved"].includes(run.state)) return run;
    return null;
  });
}

const stepLine = (run: RunDetail) => run.steps.map((s) => `${s.id}:${s.status}`).join(" ");

async function decide(run: RunDetail, body: Record<string, unknown>): Promise<RunDetail> {
  return ok<RunDetail>("POST", `/api/gates/${openGate(run)!.id}/decision`, body);
}

async function abandonAtFinalGate(run: RunDetail): Promise<void> {
  expect(openGate(run)?.kind).toBe("final");
  await decide(run, { action: "abandon" });
  await waitFor("pull request closed", 60_000, async () => (prState(run.prNumber!) === "CLOSED" ? true : null));
}

describe.sequential("bugfix: a bug description becomes a reviewed fix (solo)", () => {
  let project: Project;
  let run: Run;

  it("reproduces, fixes and reviews the bug up to the final Gate", async () => {
    project = await registerProject(cloneSandbox("bugfix"), { checks: [`test "$(sh ${buggy} 2 3)" = 5`], max: 1 });
    const workflows = await ok<{ workflows: { name: string; inputs: string[] }[] }>("GET", `/api/projects/${project.id}/workflows`);
    expect(workflows.workflows.find((w) => w.name === "bugfix")?.inputs).toEqual(["task", "review"]);
    // An effort set on the Team page reaches the next Step attempt (the cheapest level, so the BA stays cheap).
    const team = await ok<any>("PUT", "/api/team/developer", { effort: "low" });
    expect(team.seats.find((s: any) => s.seat === "developer").effort).toEqual({ value: "low", source: "team" });
    run = await ok<Run>("POST", "/api/runs", {
      projectId: project.id,
      workflow: "bugfix",
      title: `BA ${STAMP} bugfix`,
      task: `Bug: \`sh ${buggy} 2 3\` prints -1, it should print 5 (the sum of its two arguments). Reproduce it with a failing test, then fix it.`,
    });
    expect(run.review).toBe("solo");
    const detail = await nextGate(run.id);
    expect(openGate(detail)?.kind).toBe("final");
    expect(detail.attempts.find((a) => a.step === "developer")).toMatchObject({ effort: "low" });
    await ok("PUT", "/api/team/developer", { effort: null });
    expect(stepLine(detail)).toBe("developer:done checks:done review:done publish:done final:running");
    const reviews = (detail as any).reviews as { author: string; verdict: string }[];
    expect(reviews.at(-1)).toMatchObject({ author: "reviewer-a", verdict: "pass" });
    const files = gh("pr", "view", String(detail.prNumber), "-R", sandboxRepo(), "--json", "files", "-q", ".files[].path").split("\n");
    expect(files).toContain(buggy);
    expect(files.some((f) => f.startsWith(".claude/") || f.startsWith(".agents/") || f.startsWith(".forgequor/"))).toBe(false);
    const brief = gh("pr", "view", String(detail.prNumber), "-R", sandboxRepo(), "--comments");
    expect(brief).toContain("## Review");
    await abandonAtFinalGate(detail);
  });
});

describe.sequential("feature: a subject becomes code after a grilling, a spec, a plan and a duo review", () => {
  let project: Project;
  let run: Run;
  let detail: RunDetail;

  it("grills the human in a Conversation Gate until they confirm a summary", async () => {
    project = await registerProject(cloneSandbox("feature"), { checks: ["test -f CREDITS.md"], max: 1 });
    run = await ok<Run>("POST", "/api/runs", {
      projectId: project.id,
      workflow: "feature",
      title: `BA ${STAMP} credits`,
      task: "Add a tiny CREDITS.md file at the repository root listing who made the game. No art needed.",
    });
    expect(run.review).toBe("duo");
    for (let round = 1; ; round++) {
      detail = await nextGate(run.id);
      const gate = openGate(detail)!;
      expect(gate.kind).toBe("conversation");
      if (gate.actions.includes("confirm")) break;
      expect(round, "the Griller kept asking after 3 rounds").toBeLessThan(4);
      detail = await decide(detail, {
        action: "answer",
        message: "This is an automated acceptance test: take your own recommendation for every question, order no art, and propose your summary now.",
      });
    }
    expect(existsSync(join(detail.worktreePath!, ".forgequor/grilling.md"))).toBe(true);
    await decide(detail, { action: "confirm" });
  });

  it("writes a spec the human approves at the spec Gate", async () => {
    detail = await nextGate(run.id);
    expect(openGate(detail)?.kind).toBe("spec");
    expect(openGate(detail)?.evidence ?? "").toMatch(/#/);
    await decide(detail, { action: "approve" });
  });

  it("plans, builds, checks and reviews in duo up to the final Gate", async () => {
    detail = await nextGate(run.id, T(30));
    // A disagreement the Consolidator could not settle: the BA goes on with its recommendation's alternative, approval.
    if (openGate(detail)?.kind === "review") {
      await decide(detail, { action: "approve" });
      detail = await nextGate(run.id, T(10));
    }
    expect(openGate(detail)?.kind).toBe("final");
    expect(stepLine(detail)).toBe(
      "griller:done spec-writer:done spec:done architect:done artist:skipped asset-gate:skipped developer:done checks:done review:done publish:done final:running",
    );
    const plan = join(detail.worktreePath!, ".forgequor/implementation-plan.md");
    expect(existsSync(plan) && readFileSync(plan, "utf8").trim().length).toBeTruthy();
    const authors = ((detail as any).reviews as { author: string }[]).map((r) => r.author);
    expect(authors).toEqual(expect.arrayContaining(["reviewer-a", "reviewer-b", "consolidator"]));
    const files = gh("pr", "view", String(detail.prNumber), "-R", sandboxRepo(), "--json", "files", "-q", ".files[].path").split("\n");
    expect(files).toContain("CREDITS.md");
    expect(files.some((f) => f.startsWith("docs/specs/"))).toBe(true);
    expect(files.some((f) => f.startsWith(".claude/") || f.startsWith(".agents/") || f.startsWith(".forgequor/"))).toBe(false);
  });

  it("closes the pull request when the human abandons at the final Gate", async () => {
    await abandonAtFinalGate(detail);
  });
});
