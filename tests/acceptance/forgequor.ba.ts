import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApprovedRun, OpenGate, Project, Run, RunDetail, WorkflowList } from "../../src/forge/types.js";
import {
  api,
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
  stepLine,
  waitFor,
  waitForState,
  type App,
} from "./harness.js";

/**
 * Forgequor acceptance (BA) suite. Replays, end to end, what the human checks by hand after M3a:
 *   1. slots and the merge list (two Runs on a Project limited to one),
 *   2. a `developer` Run through a rejection, an approval and a real merge,
 *   3. Project Workflows (listing, override, invalid, frozen definition),
 *   4. Escalations with choices (retry, go back, refusals, abandon),
 *   5. optionally (BA_ASSETS=1, uses Codex) an `assets` Run through an Asset Gate.
 * Real GitHub sandbox (FORGEQUOR_SMOKE_REPO), real Claude on a cheap model (BA_MODEL, default haiku), its own database.
 */

const T = (minutes: number) => minutes * 60_000;
const marker = `ba-${STAMP}`;
const files = { flow: "forgequor/workflows/ba-flow.yaml", broken: "forgequor/workflows/ba-broken.yaml", override: "forgequor/workflows/developer.yaml" };

let app: App;
let pusher: string;

beforeAll(async () => {
  sandboxRepo();
  await resetDatabase(BA_DB);
  pusher = cloneSandbox("pusher");
  // A previous BA run that stopped half-way may have left its Project Workflows on the sandbox.
  pushToSandbox(pusher, "chore(ba): clear Project Workflows", { forgequor: null });
  app = await startApp();
}, T(5));

afterAll(async () => {
  if (pusher) pushToSandbox(pusher, "chore(ba): clear Project Workflows", { forgequor: null });
  await app?.stop();
  if (process.env.BA_SHOW_LOG) console.log(app?.log.join(""));
}, T(2));

describe.sequential("1–2. slots, merge list and a developer Run end to end", () => {
  let project: Project;
  let r1: Run;
  let r2: Run;

  it("registers the sandbox, limited to one Run at a time, with a passing Check", async () => {
    project = await registerProject(cloneSandbox("slots"), { checks: ["true"], max: 1 });
    expect(project.maxConcurrentRuns).toBe(1);
    const workflows = await ok<WorkflowList>("GET", `/api/projects/${project.id}/workflows`);
    expect(workflows.workflows.map((w) => `${w.name}:${w.origin}`).sort()).toEqual(["assets:built-in", "developer:built-in"]);
  });

  it("queues a second Run while the first holds the only slot", async () => {
    const task = (n: number) => `Create a file named ${marker}-r${n}.txt at the repository root containing exactly the line "hello from run ${n}". Commit it. Do nothing else.`;
    r1 = await ok<Run>("POST", "/api/runs", { projectId: project.id, task: task(1), title: `BA ${STAMP} slots r1` });
    r2 = await ok<Run>("POST", "/api/runs", { projectId: project.id, task: task(2), title: `BA ${STAMP} slots r2` });
    expect((await getRun(r2.id)).state).toBe("queued");
  });

  it("brings the first Run to its final Gate through every Step, the second still queued", async () => {
    const run = await waitForState(r1.id, "waiting", T(15));
    expect(stepLine(run)).toBe("developer:done:1 checks:done:1 publish:done:1 review:running:0");
    expect(openGate(run)?.kind).toBe("final");
    expect(run.prUrl).toContain(`/pull/${run.prNumber}`);
    expect(prState(run.prNumber!)).toBe("OPEN");
    const gates = await ok<OpenGate[]>("GET", "/api/gates");
    expect(gates.some((g) => g.runId === r1.id && g.kind === "final")).toBe(true);
    expect((await getRun(r2.id)).state).toBe("queued");
  });

  it("starts a new Iteration with the Feedback when the final Gate is rejected", async () => {
    const feedback = `Also add a second line "iteration 2" to ${marker}-r1.txt.`;
    await ok("POST", `/api/gates/${openGate(await getRun(r1.id))!.id}/decision`, { action: "reject", feedback });
    const run = await waitForState(r1.id, "waiting", T(15), (r) => r.iteration === 2);
    expect(run.iterations.map((i) => i.feedback)).toEqual([null, feedback]);
    expect(run.steps.every((s) => s.iteration === 2)).toBe(true);
    expect(openGate(run)?.kind).toBe("final");
    expect((await getRun(r2.id)).state).toBe("queued");
  });

  it("frees the slot when approved: the queued Run starts and the first waits in the merge list", async () => {
    const run = await ok<RunDetail>("POST", `/api/gates/${openGate(await getRun(r1.id))!.id}/decision`, { action: "approve" });
    expect(run.state).toBe("approved");
    expect(run.steps.find((s) => s.id === "review")?.status).toBe("done");
    const merging = await ok<ApprovedRun[]>("GET", "/api/approved-runs");
    const listed = merging.find((r) => r.id === r1.id);
    expect(listed?.prUrl).toBe(run.prUrl);
    expect(listed?.projectName).toBe(project.name);
    await waitFor("second Run leaves the queue", 60_000, async () => ((await getRun(r2.id)).state !== "queued" ? true : null));
  });

  it("notices the real merge on GitHub and drops the Run from the merge list", async () => {
    const run = await getRun(r1.id);
    gh("pr", "merge", String(run.prNumber), "-R", sandboxRepo(), "--squash", "--delete-branch");
    await waitForState(r1.id, "merged", 120_000);
    const merging = await ok<ApprovedRun[]>("GET", "/api/approved-runs");
    expect(merging.some((r) => r.id === r1.id)).toBe(false);
  });

  it("closes the pull request when the human abandons at the final Gate", async () => {
    const run = await waitForState(r2.id, "waiting", T(15));
    const after = await ok<RunDetail>("POST", `/api/gates/${openGate(run)!.id}/decision`, { action: "abandon" });
    expect(after.state).toBe("abandoned");
    await waitFor("pull request closed", 60_000, async () => (prState(run.prNumber!) === "CLOSED" ? true : null));
  });

  it("lists every Run in every state", async () => {
    const runs = await ok<Run[]>("GET", `/api/runs`);
    const states = Object.fromEntries(runs.map((r) => [r.id, r.state]));
    expect(states[r1.id]).toBe("merged");
    expect(states[r2.id]).toBe("abandoned");
  });
});

describe.sequential("3–4. Project Workflows and Escalations with choices", () => {
  let project: Project;
  let run: Run;

  const builtInDeveloper = readFileSync(join(import.meta.dirname, "../../src/forge/workflows/developer.yaml"), "utf8");
  const flow = (maxAttempts: number) => `name: ba-flow
description: BA test Workflow, Checks capped at ${maxAttempts} attempt(s).
inputs: [task]
steps:
  - id: developer
    type: agent
    agent: developer
  - id: checks
    type: checks
    needs: [developer]
    on_reject: developer
    max_attempts: ${maxAttempts}
  - id: publish
    type: publish
    needs: [checks]
  - id: review
    type: gate
    gate: final
    needs: [publish]
    on_reject: developer
`;

  it("lists the Project's own Workflows: added, overriding, and invalid with its errors", async () => {
    pushToSandbox(pusher, `chore(ba): Project Workflows for BA ${STAMP}`, {
      [files.flow]: flow(1),
      [files.broken]: "name: ba-broken\ndescription: broken on purpose\ninputs: [task]\nsteps:\n  - id: a\n    type: agent\n    agent: developer\n  - id: a\n    type: checks\n    needs: [nowhere]\n",
      [files.override]: builtInDeveloper.replace(/^description: .*$/m, "description: BA override of the built-in developer Workflow."),
    });
    project = await registerProject(cloneSandbox("workflows"), { checks: [`test -f ${marker}-never.txt`], max: 2 });
    const list = await ok<WorkflowList>("GET", `/api/projects/${project.id}/workflows`);
    expect(list.problem).toBeNull();
    const byName = Object.fromEntries(list.workflows.map((w) => [w.name, w]));
    expect(byName["ba-flow"]).toMatchObject({ origin: "project", inputs: ["task"], errors: [] });
    expect(byName["developer"]).toMatchObject({ origin: "project", description: "BA override of the built-in developer Workflow." });
    expect(byName["assets"]).toMatchObject({ origin: "built-in" });
    expect(byName["ba-broken"]?.errors.length).toBeGreaterThan(0);
  });

  it("refuses to launch an invalid Workflow and creates no Run", async () => {
    const before = (await ok<Run[]>("GET", "/api/runs")).length;
    const res = await api("POST", "/api/runs", { projectId: project.id, workflow: "ba-broken", task: "never runs" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect((await ok<Run[]>("GET", "/api/runs")).length).toBe(before);
  });

  it("escalates after one failed Check, following its frozen definition even after the YAML changed", async () => {
    run = await ok<Run>("POST", "/api/runs", {
      projectId: project.id,
      workflow: "ba-flow",
      title: `BA ${STAMP} escalation`,
      task: `Create a file named ${marker}-esc.txt at the repository root containing the line "escalation". Commit it. Do nothing else.`,
    });
    // Had the Run read its Workflow again, the Checks would now loop 4 times before escalating.
    pushToSandbox(pusher, `chore(ba): change ba-flow for BA ${STAMP}`, { [files.flow]: flow(4) });
    const detail = await waitForState(run.id, "waiting", T(15));
    const gate = openGate(detail)!;
    expect(gate.kind).toBe("escalation");
    expect(gate.stepId).toBe("checks");
    expect(detail.checks.length).toBe(1);
    expect(stepLine(detail)).toBe("developer:done:1 checks:failed:1 publish:waiting:0 review:waiting:0");
    expect(gate.actions).toContain("abandon");
    expect(gate.redo?.goBack.map((c) => c.stepId)).toEqual(["developer"]);
  });

  it("retries the failed Step alone, with a fresh attempt budget", async () => {
    const before = await getRun(run.id);
    await ok("POST", `/api/gates/${openGate(before)!.id}/decision`, { action: "retry", feedback: "BA retry feedback" });
    const after = await waitForState(run.id, "waiting", T(5), (r) => r.gates.filter((g) => g.kind === "escalation").length === 2);
    expect(after.checks.length).toBe(2);
    expect(after.attempts.filter((a) => a.step === "developer").length).toBe(before.attempts.filter((a) => a.step === "developer").length);
    expect(after.gates[0]).toMatchObject({ decision: "retry", feedback: "BA retry feedback" });
  });

  it("refuses a go back without Feedback, to a later Step, or to an unknown Step", async () => {
    const gate = openGate(await getRun(run.id))!;
    for (const body of [
      { action: "go_back", target: "developer" },
      { action: "go_back", target: "developer", feedback: "   " },
      { action: "go_back", target: "publish", feedback: "later Step" },
      { action: "go_back", target: "nowhere", feedback: "unknown Step" },
    ]) {
      const res = await api("POST", `/api/gates/${gate.id}/decision`, body);
      expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(res.status, JSON.stringify(body)).toBeLessThan(500);
    }
    expect(openGate(await getRun(run.id))?.id).toBe(gate.id);
  });

  it("goes back to the Developer with Feedback: it and every Step after it replay, files kept", async () => {
    const before = await getRun(run.id);
    const developerRuns = before.attempts.filter((a) => a.step === "developer").length;
    const feedback = `Also create ${marker}-goback.txt containing "went back".`;
    await ok("POST", `/api/gates/${openGate(before)!.id}/decision`, { action: "go_back", target: "developer", feedback });
    const after = await waitForState(run.id, "waiting", T(15), (r) => r.gates.filter((g) => g.kind === "escalation").length === 3);
    expect(after.attempts.filter((a) => a.step === "developer").length).toBe(developerRuns + 1);
    expect(after.checks.length).toBe(3);
    expect(after.iteration).toBe(1);
    expect(after.gates[1]).toMatchObject({ decision: "go_back", feedback });
    expect(existsSync(join(after.worktreePath!, `${marker}-esc.txt`))).toBe(true);
  });

  it("goes on to the final Gate once a retry passes the Check", async () => {
    await ok("PUT", `/api/projects/${project.id}/checks`, { checks: ["true"] });
    await ok("POST", `/api/gates/${openGate(await getRun(run.id))!.id}/decision`, { action: "retry" });
    const detail = await waitForState(run.id, "waiting", T(5), (r) => openGate(r)?.kind === "final");
    expect(detail.steps.map((s) => `${s.id}:${s.status}`).join(" ")).toBe("developer:done checks:done publish:done review:running");
    expect(prState(detail.prNumber!)).toBe("OPEN");
  });

  it("still lets the human abandon, closing the pull request", async () => {
    const detail = await getRun(run.id);
    await ok("POST", `/api/gates/${openGate(detail)!.id}/decision`, { action: "abandon" });
    await waitForState(run.id, "abandoned", 30_000);
    await waitFor("pull request closed", 60_000, async () => (prState(detail.prNumber!) === "CLOSED" ? true : null));
  });
});

describe.skipIf(!process.env.BA_ASSETS).sequential("5. an assets Run through its Asset Gate (Codex)", () => {
  let project: Project;
  let run: Run;

  it("draws one sprite and waits for the verdict", async () => {
    project = await registerProject(cloneSandbox("assets"), { checks: [], max: 1 });
    run = await ok<Run>("POST", "/api/runs", {
      projectId: project.id,
      workflow: "assets",
      title: `BA ${STAMP} assets`,
      assets: [{ name: `${marker}-gem`, kind: "sprite", description: "A small green gem, simple shapes.", width: 32, height: 32 }],
    });
    const detail = await waitForState(run.id, "waiting", T(20));
    expect(openGate(detail)?.kind).toBe("asset");
    expect(stepLine(detail)).toBe("artist:done:1 review:running:0 publish:waiting:0");
    expect(detail.assets[0]?.status).toBe("waiting");
  });

  it("redraws a rejected Asset in a new Iteration, then publishes once approved", async () => {
    const first = await getRun(run.id);
    await ok("POST", `/api/gates/${openGate(first)!.id}/decision`, {
      action: "judge",
      verdicts: [{ assetId: first.assets[0]!.id, action: "reject", feedback: "Make the gem blue." }],
    });
    const second = await waitForState(run.id, "waiting", T(20), (r) => r.iteration === 2);
    expect(second.iterations[1]?.feedback).toContain("Make the gem blue.");
    const done = await ok<RunDetail>("POST", `/api/gates/${openGate(second)!.id}/decision`, {
      action: "judge",
      verdicts: [{ assetId: second.assets[0]!.id, action: "approve" }],
    });
    const approved = done.state === "approved" ? done : await waitForState(run.id, "approved", T(5));
    expect(stepLine(approved)).toBe("artist:done:1 review:done:1 publish:done:1");
    gh("pr", "close", String(approved.prNumber), "-R", sandboxRepo(), "--delete-branch");
    await waitForState(run.id, "closed", 120_000);
  });
});
