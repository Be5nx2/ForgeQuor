import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createForge, type Forge, type ForgeDeps, type Project, type RunDetail } from "../../src/forge/forge.js";
import { REVIEW_NOTE, parseReview } from "../../src/forge/review.js";
import { seatSettingsFromEnv } from "../../src/forge/seats.js";
import type { StepRequest, StepResult } from "../../src/runner/runner.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote, type TempRemote, type TempRepo } from "../harness/git.js";

/** `bugfix` and the solo review, through the Forge core: real git and PostgreSQL, scripted Runners, a fake code host. */

let pool: pg.Pool;
let drop: () => Promise<void>;
let worktrees: string;
let forge: Forge;
const claude = createFakeRunner();
const codex = createFakeRunner();
const codeHost = createFakeCodeHost();
const cleanups: Array<() => void> = [];
const forges: Forge[] = [];
let counter = 0;

const isReviewer = (step: StepRequest) => step.instructions.includes("You are the Reviewer");
const review = (verdict: string, body = "Summary: It fixes the bug.\n\nFindings:\n- None.\n\nDoubts: None.") => `${body}\n\nVerdict: ${verdict}`;

/** The Reviewer's answers, one per Review in turn (the last repeats); the Developer just works. */
function script(reviews: (string | ((step: StepRequest) => StepResult | void))[]) {
  let n = 0;
  return (step: StepRequest): StepResult | void => {
    if (!isReviewer(step)) {
      writeFileSync(join(step.cwd, "fix.txt"), `fix ${claude.steps.length}\n`);
      writeFileSync(join(step.cwd, ".forgequor", "review-brief.md"), "What the Developer did.\n");
      return;
    }
    const next = reviews[Math.min(n++, reviews.length - 1)]!;
    return typeof next === "function" ? next(step) : { status: "succeeded", summary: next };
  };
}

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  pool = db.pool;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-review-"));
  forge = forgeWith({});
});
function forgeWith(overrides: Partial<ForgeDeps>): Forge {
  const created = createForge({ pool, runner: claude, artistRunner: codex, codeHost, worktreesRoot: worktrees, ...overrides });
  forges.push(created);
  return created;
}
afterAll(async () => {
  await Promise.all(forges.map((f) => f.whenIdle()));
  await drop();
  rmSync(worktrees, { recursive: true, force: true });
});
afterEach(() => {
  claude.use(() => {});
  claude.steps.length = 0;
  codex.use(() => {});
  codex.steps.length = 0;
  codeHost.pullRequests.length = 0;
  cleanups.splice(0).forEach((c) => c());
});

async function project(checks: string[] = []): Promise<{ project: Project; remote: TempRemote }> {
  const { repo, remote } = createRepoWithBareRemote({ remote: `git@github.com:acme/review-${++counter}.git` }) as { repo: TempRepo; remote: TempRemote };
  cleanups.push(repo.cleanup, remote.cleanup);
  const registered = await forge.registerProject({ path: repo.path });
  remote.pointOriginAtBare();
  return { project: checks.length ? await forge.setChecks(registered.id, checks) : registered, remote };
}

async function bugfix(p: Project, input: { review?: "solo" | "duo"; workflow?: string; f?: Forge } = {}): Promise<RunDetail> {
  const started = await (input.f ?? forge).startRun({ projectId: p.id, workflow: input.workflow ?? "bugfix", task: "The player cannot jump twice.", review: input.review });
  await (input.f ?? forge).whenIdle();
  return (input.f ?? forge).getRun(started.id);
}

const reviewers = () => claude.steps.filter(isReviewer);
const developers = () => claude.steps.filter((s) => !isReviewer(s));
const stepsOf = (r: RunDetail) => r.steps.map((s) => `${s.id}:${s.status}`);
const escalation = (r: RunDetail) => r.gates.find((g) => g.kind === "escalation" && !g.decidedAt);

describe("a bugfix Run", () => {
  it("goes Developer, Checks, review, pull request, final Gate, reviewed solo by default", async () => {
    const { project: p } = await project(["true"]);
    claude.use(script([review("pass")]));

    const run = await bugfix(p);

    expect(run.review).toBe("solo");
    expect(run.state).toBe("waiting");
    expect(stepsOf(run)).toEqual(["developer:done", "checks:done", "review:done", "publish:done", "final:running"]);
    expect(run.gates).toMatchObject([{ kind: "final", decision: null }]);
    expect(run.attempts.map((a) => [a.stepId, a.step, a.runner])).toEqual([
      ["developer", "bugfixer", "claude"],
      ["review", "reviewer", "claude"],
    ]);
    expect(codex.steps).toHaveLength(0);
  });

  it("asks the Developer to follow diagnosing-bugs and commit a failing test before the fix", async () => {
    const { project: p } = await project();
    claude.use(script([review("pass")]));

    await bugfix(p);

    const [developer] = developers();
    expect(developer!.instructions).toContain("diagnosing-bugs");
    expect(developer!.instructions).toMatch(/failing test/);
    expect(developer!.instructions).toMatch(/before any fix/);
    expect(developer!.prompt).toContain("The player cannot jump twice.");
  });

  it("has the Reviewer read the change against the task and the default branch, read-only, with code-review", async () => {
    const { project: p } = await project();
    claude.use(script([review("pass")]));

    await bugfix(p);

    const [reviewer] = reviewers();
    expect(reviewer!.readonly).toBe(true);
    expect(reviewer!.instructions).toContain("code-review");
    expect(reviewer!.instructions).toMatch(/Standards/);
    expect(reviewer!.prompt).toContain("The player cannot jump twice.");
    expect(reviewer!.prompt).toMatch(/git diff origin\/main\.\.\.HEAD/);
    expect(developers()[0]!.readonly).toBeUndefined();
  });

  it("keeps each Review in the Run, ending in its verdict, and summarises the final one in the Review Brief", async () => {
    const { project: p } = await project();
    claude.use(script([review("pass", "Summary: Fixes the double jump.\n\nFindings:\n- None.\n\nDoubts: The air-dash was not tried.")]));

    const run = await bugfix(p);

    expect(run.reviews).toMatchObject([
      { stepId: "review", attempt: 1, author: "reviewer-a", verdict: "pass", final: true, body: expect.stringContaining("The air-dash was not tried.") },
    ]);
    expect(run.reviews[0]!.body).not.toContain("Verdict:");
    const [brief] = codeHost.pullRequests[0]!.comments;
    expect(brief).toContain("What the Developer did.");
    expect(brief).toContain("## Review (pass)");
    expect(brief).toContain("Fixes the double jump.");
    expect(brief).toContain("The air-dash was not tried.");
  });

  it("takes the Review from the Reviewer's Run Note when it wrote one", async () => {
    const { project: p } = await project();
    claude.use(
      script([
        (step) => {
          mkdirSync(join(step.cwd, ".forgequor"), { recursive: true });
          writeFileSync(join(step.cwd, REVIEW_NOTE), review("pass", "Summary: From the note."));
          return { status: "succeeded", summary: "Done, see the note." };
        },
      ]),
    );

    const run = await bugfix(p);

    expect(run.reviews[0]).toMatchObject({ verdict: "pass", body: "Summary: From the note." });
    expect(run.state).toBe("waiting");
  });
});

describe("a Review asking for changes", () => {
  it("goes back to the Developer with the Review, and the Checks run again before the next Review", async () => {
    const { project: p } = await project(["true"]);
    claude.use(script([review("changes requested", "Summary: No test.\n\nFindings:\n- fix.txt - the reproducing test is missing.\n\nDoubts: None."), review("pass")]));

    const run = await bugfix(p);

    expect(developers()).toHaveLength(2);
    expect(developers()[1]!.prompt).toContain("asked for changes");
    expect(developers()[1]!.prompt).toContain("the reproducing test is missing.");
    expect(developers()[0]!.prompt).not.toContain("asked for changes");
    // Developer, Checks, Review, then again: the Checks ran on the rework before it was reviewed.
    expect(run.checks.map((c) => c.attempt)).toEqual([1, 2]);
    expect(reviewers()).toHaveLength(2);
    expect(run.reviews.map((r) => r.verdict)).toEqual(["changes requested", "pass"]);
    expect(run.gates).toMatchObject([{ kind: "final", decision: null }]);
    expect(run.state).toBe("waiting");
    expect(codeHost.pullRequests[0]!.comments[0]).toContain("## Review (pass)");
  });

  it("stops with an Escalation once max_attempts Reviews asked for changes", async () => {
    const { project: p } = await project();
    claude.use(script([review("changes requested", "Summary: Still wrong.")]));

    const run = await bugfix(p);

    expect(reviewers()).toHaveLength(3);
    expect(developers()).toHaveLength(3);
    expect(run.state).toBe("waiting");
    expect(escalation(run)).toMatchObject({ stepId: "review", reason: "The Reviewer still asks for changes, or gives no usable verdict, after 3 attempts." });
    expect(escalation(run)!.evidence).toContain("Still wrong.");
    expect(codeHost.pullRequests).toHaveLength(0);
  });

  it("lets the human retry the Escalation with a fresh budget of Reviews", async () => {
    const { project: p } = await project();
    claude.use(script([review("changes requested"), review("changes requested"), review("changes requested"), review("pass")]));
    const run = await bugfix(p);

    await forge.decideGate({ gateId: escalation(run)!.id, action: "retry" });
    await forge.whenIdle();

    const again = await forge.getRun(run.id);
    expect(again.gates.map((g) => [g.kind, g.decision])).toEqual([["escalation", "retry"], ["final", null]]);
  });
});

describe("a Review without a usable verdict", () => {
  it("asks the Reviewer again, telling it what was wrong, without sending the Developer back", async () => {
    const { project: p } = await project();
    claude.use(script(["Looks fine to me.", review("pass")]));

    const run = await bugfix(p);

    expect(reviewers()).toHaveLength(2);
    expect(reviewers()[1]!.prompt).toContain("does not end with a verdict line");
    expect(developers()).toHaveLength(1);
    expect(run.reviews).toHaveLength(1);
    expect(run.gates).toMatchObject([{ kind: "final", decision: null }]);
  });

  it("escalates when no attempt gives one", async () => {
    const { project: p } = await project();
    claude.use(script(["Verdict: unsure"]));

    const run = await bugfix(p);

    expect(reviewers()).toHaveLength(3);
    expect(escalation(run)).toMatchObject({ stepId: "review" });
    expect(escalation(run)!.evidence).toContain('The Review\'s verdict is "unsure"');
    expect(run.reviews).toHaveLength(0);
  });

  it("fails the Reviewer's attempt like any Agent failure", async () => {
    const { project: p } = await project();
    claude.use(script([() => ({ status: "failed", error: "boom" })]));

    const run = await bugfix(p);

    expect(escalation(run)).toMatchObject({ stepId: "review", reason: "The Reviewer failed.", evidence: "boom" });
  });
});

describe("a read-only Reviewer", () => {
  it("that changes the code is stopped with an Escalation naming the files", async () => {
    const { project: p } = await project();
    claude.use(
      script([
        (step) => {
          writeFileSync(join(step.cwd, "fix.txt"), "edited by the Reviewer\n");
          return { status: "succeeded", summary: review("pass") };
        },
      ]),
    );

    const run = await bugfix(p);

    expect(escalation(run)).toMatchObject({ stepId: "review", reason: expect.stringContaining("changed files outside the Run Notes"), evidence: "fix.txt" });
    expect(codeHost.pullRequests).toHaveLength(0);
  });
});

describe("choosing the review", () => {
  it("is recorded on the Run, and listed with the Workflow's default for the Run form", async () => {
    const { project: p } = await project();
    claude.use(script([review("pass")]));

    const run = await bugfix(p, { review: "duo" });

    expect(run.review).toBe("duo");
    const options = (await forge.listWorkflows(p.id)).workflows;
    expect(options.find((w) => w.name === "bugfix")).toMatchObject({ inputs: ["task", "review"], reviewDefault: "solo" });
    expect(options.find((w) => w.name === "developer")).not.toHaveProperty("reviewDefault");
  });

  it("refuses a mode that is neither solo nor duo", async () => {
    const { project: p } = await project();

    await expect(forge.startRun({ projectId: p.id, workflow: "bugfix", task: "A bug.", review: "trio" as any })).rejects.toThrow(/solo or duo/);
  });

  it("refuses a mode for a Workflow that has no review", async () => {
    const { project: p } = await project();

    await expect(forge.startRun({ projectId: p.id, workflow: "developer", task: "Work.", review: "solo" })).rejects.toThrow(/no review/);
  });

  it("gives a Project Workflow that takes task and review the launch rules and the default of its own YAML", async () => {
    const { project: p, remote } = await project();
    remote.advance(
      "forgequor/workflows/careful.yaml",
      `name: careful
inputs: [task, review]
review: duo
steps:
  - id: developer
    type: agent
    agent: developer
  - id: review
    type: review
    needs: [developer]
    on_reject: developer
  - id: publish
    type: publish
    needs: [review]
`,
    );
    claude.use(script([review("pass")]));

    const run = await bugfix(p, { workflow: "careful" });
    const solo = await bugfix(p, { workflow: "careful", review: "solo" });

    expect(run.review).toBe("duo");
    expect(solo.review).toBe("solo");
    expect((await forge.listWorkflows(p.id)).workflows.find((w) => w.name === "careful")).toMatchObject({ origin: "project", inputs: ["task", "review"], reviewDefault: "duo", errors: [] });
    expect(run.state).toBe("approved");
  });

  it("runs a duo Run's review solo for now (duo comes with the Consolidator)", async () => {
    const { project: p } = await project();
    claude.use(script([review("pass")]));

    const run = await bugfix(p, { review: "duo" });

    expect(reviewers()).toHaveLength(1);
    expect(run.gates).toMatchObject([{ kind: "final", decision: null }]);
  });
});

describe("the Agent seats", () => {
  it("sends the Reviewer to the Runner its seat is set to, and shows it with its model on the Step attempt", async () => {
    const { project: p } = await project();
    const f = forgeWith({ seats: { "reviewer-a": { runner: "codex", model: "gpt-review" }, developer: { model: "opus-test" } } });
    claude.use(script([]));
    codex.use(() => ({ status: "succeeded", summary: review("pass") }));

    const run = await bugfix(p, { f });

    expect(run.attempts.map((a) => [a.step, a.runner, a.model])).toEqual([
      ["bugfixer", "claude", "opus-test"],
      ["reviewer", "codex", "gpt-review"],
    ]);
    expect(codex.steps).toHaveLength(1);
    expect(codex.steps[0]!.readonly).toBe(true);
    expect(codex.steps[0]!.model).toBe("gpt-review");
  });

  it("keeps the Developer and Artist model settings working as before", async () => {
    const { project: p } = await project();
    const f = forgeWith({ developerModel: "dev-model", artistModel: "art-model" });
    claude.use(script([review("pass")]));

    const run = await bugfix(p, { f });

    expect(run.attempts[0]).toMatchObject({ runner: "claude", model: "dev-model" });
  });

  it("opens an Escalation naming the seat when its Runner is not one Forgequor knows", async () => {
    const { project: p } = await project();
    const f = forgeWith({ seats: { "reviewer-a": { runner: "gemini" } } });
    claude.use(script([review("pass")]));

    const run = await bugfix(p, { f });

    expect(escalation(run)).toMatchObject({ stepId: "review", reason: expect.stringContaining('seat "reviewer-a"') });
    expect(escalation(run)!.reason).toContain('"gemini" is not a Runner');
    expect(escalation(run)!.evidence).toContain("FORGEQUOR_REVIEWER_A_RUNNER");
    expect(reviewers()).toHaveLength(0);
    // The Developer's seat is fine: the Workflow did not fail at its start.
    expect(developers()).toHaveLength(1);
  });

  it("opens an Escalation naming the seat when its Runner is not installed", async () => {
    const { project: p } = await project();
    const f = forgeWith({ artistRunner: undefined, seats: { "reviewer-a": { runner: "codex" } } });
    claude.use(script([]));

    const run = await bugfix(p, { f });

    expect(escalation(run)).toMatchObject({ stepId: "review", reason: expect.stringMatching(/seat "reviewer-a" \(Forgequor has no codex Runner\)/) });
  });
});

describe("parseReview", () => {
  it("reads the body and the verdict of the last line", () => {
    expect(parseReview("Summary: ok.\n\nVerdict: pass\n")).toEqual({ verdict: "pass", body: "Summary: ok." });
    expect(parseReview("Summary: no.\n\n**Verdict: Changes requested.**")).toEqual({ verdict: "changes requested", body: "Summary: no." });
  });

  it("refuses a Review with no verdict line, an unknown verdict, or no body", () => {
    expect(parseReview("Looks good")).toHaveProperty("problem");
    expect(parseReview("Verdict: pass\n\nMore text")).toHaveProperty("problem");
    expect(parseReview("Summary: ok\nVerdict: maybe")).toMatchObject({ problem: expect.stringContaining('"maybe"') });
    expect(parseReview("Verdict: pass")).toHaveProperty("problem");
  });
});

describe("seat settings from the environment", () => {
  it("reads a Runner and a model per seat, and ignores empty values", () => {
    expect(
      seatSettingsFromEnv({
        FORGEQUOR_DEVELOPER_MODEL: "opus",
        FORGEQUOR_REVIEWER_B_RUNNER: "Claude",
        FORGEQUOR_REVIEWER_B_MODEL: " sonnet ",
        FORGEQUOR_SPEC_WRITER_RUNNER: "",
        FORGEQUOR_ARTIST_MODEL: "gpt-image",
      }),
    ).toEqual({
      developer: { runner: undefined, model: "opus" },
      "reviewer-b": { runner: "claude", model: "sonnet" },
      artist: { runner: undefined, model: "gpt-image" },
    });
  });
});
