import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createForge, type Forge, type ForgeDeps, type Project, type RunDetail } from "../../src/forge/forge.js";
import { parseConsolidation, parseReview, recommendationOf, reviewNote } from "../../src/forge/review.js";
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
const isConsolidator = (step: StepRequest) => step.instructions.includes("You are the Consolidator");
const review = (verdict: string, body = "Summary: It fixes the bug.\n\nFindings:\n- None.\n\nDoubts: None.") => `${body}\n\nVerdict: ${verdict}`;

/** The Reviewer's answers, one per Review in turn (the last repeats; the Consolidator of a duo Run takes its turn too); the Developer just works. */
function script(reviews: (string | ((step: StepRequest) => StepResult | void))[]) {
  let n = 0;
  return (step: StepRequest): StepResult | void => {
    if (!isReviewer(step) && !isConsolidator(step)) {
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
const developers = () => claude.steps.filter((s) => !isReviewer(s) && !isConsolidator(s));
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
      ["review", "reviewer-a", "claude"],
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

  it("falls back to the final message when the Run Note has no usable verdict", async () => {
    const { project: p } = await project();
    claude.use(
      script([
        (step) => {
          mkdirSync(join(step.cwd, ".forgequor"), { recursive: true });
          writeFileSync(join(step.cwd, reviewNote("reviewer-a")), "half written");
          return { status: "succeeded", summary: review("pass", "Summary: From the message.") };
        },
      ]),
    );

    const run = await bugfix(p);

    expect(run.reviews[0]).toMatchObject({ verdict: "pass", body: "Summary: From the message." });
  });

  it("tells the Reviewer its final message is the Review, and leaves another author's note alone", async () => {
    const { project: p } = await project();
    const base = script([review("pass")]);
    claude.use((step) => {
      if (!isReviewer(step)) writeFileSync(join(step.cwd, ".forgequor", "review-b.md"), "the other Reviewer's note\n");
      return base(step);
    });

    const run = await bugfix(p);

    expect(reviewers()[0]!.instructions).toContain("Your FINAL MESSAGE is your Review");
    expect(reviewers()[0]!.instructions).toContain("Do not run commands that write files outside .forgequor/");
    expect(readFileSync(join(run.worktreePath!, ".forgequor", "review-a.md"), "utf8")).toContain("Verdict: pass");
    expect(readFileSync(join(run.worktreePath!, ".forgequor", "review-b.md"), "utf8")).toBe("the other Reviewer's note\n");
  });

  it("gives the Reviewer the human's Feedback of earlier Iterations", async () => {
    const { project: p } = await project();
    claude.use(script([review("pass")]));
    const first = await bugfix(p);

    await forge.decideGate({ gateId: first.gates[0]!.id, action: "reject", feedback: "Also cover the wall jump." });
    await forge.whenIdle();

    expect(reviewers()).toHaveLength(2);
    expect(reviewers()[0]!.prompt).not.toContain("Feedback");
    expect(reviewers()[1]!.prompt).toContain("Also cover the wall jump.");
  });

  it("takes the Review from the Reviewer's Run Note when it wrote one", async () => {
    const { project: p } = await project();
    claude.use(
      script([
        (step) => {
          mkdirSync(join(step.cwd, ".forgequor"), { recursive: true });
          writeFileSync(join(step.cwd, reviewNote("reviewer-a")), review("pass", "Summary: From the note."));
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
    expect(escalation(run)).toMatchObject({ stepId: "review", reason: "The Reviewer still asks for changes after 3 attempts." });
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
    // Asked again inside the Step: one attempt of it, so nothing was rejected or replayed.
    expect(run.steps.find((s) => s.id === "review")).toMatchObject({ status: "done", attempts: 1 });
    expect(run.checks).toHaveLength(0);
    expect(run.gates).toMatchObject([{ kind: "final", decision: null }]);
  });

  it("escalates when no attempt gives one", async () => {
    const { project: p } = await project();
    claude.use(script(["Verdict: unsure"]));

    const run = await bugfix(p);

    expect(reviewers()).toHaveLength(3);
    expect(escalation(run)).toMatchObject({ stepId: "review", reason: "The Reviewer gave no usable verdict after 3 tries." });
    expect(escalation(run)!.evidence).toContain('The Review\'s verdict is "unsure"');
    expect(run.reviews).toHaveLength(0);
  });

  it("does not use up the review's max_attempts, so three Reviews can still ask for changes, then pass", async () => {
    const { project: p } = await project();
    claude.use(script([review("changes requested"), "no verdict", "no verdict", review("changes requested"), review("pass")]));

    const run = await bugfix(p);

    // 2 reworks, as the cap allows; the two retries for the missing verdict were not attempts.
    expect(developers()).toHaveLength(3);
    expect(run.reviews.map((r) => r.verdict)).toEqual(["changes requested", "changes requested", "pass"]);
    expect(run.gates).toMatchObject([{ kind: "final", decision: null }]);
  });

  it("fails the Reviewer's attempt like any Agent failure", async () => {
    const { project: p } = await project();
    claude.use(script([() => ({ status: "failed", error: "boom" })]));

    const run = await bugfix(p);

    expect(escalation(run)).toMatchObject({ stepId: "review", reason: "Reviewer A (reviewer-a) failed.", evidence: "boom" });
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
    codex.use(() => ({ status: "succeeded", summary: review("pass") }));

    const run = await bugfix(p, { workflow: "careful" });
    const solo = await bugfix(p, { workflow: "careful", review: "solo" });

    expect(run.review).toBe("duo");
    expect(solo.review).toBe("solo");
    expect((await forge.listWorkflows(p.id)).workflows.find((w) => w.name === "careful")).toMatchObject({ origin: "project", inputs: ["task", "review"], reviewDefault: "duo", errors: [] });
    expect(run.state).toBe("approved");
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
      ["reviewer-a", "codex", "gpt-review"],
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

describe("duo review", () => {
  const consolidated = (verdict: string, body = "Summary: Checked both Reviews against the code.\n\nFindings:\n- None.\n\nDropped: None.\n\nDoubts: None.") => review(verdict, body);
  const disagreement = (recommendation = "Recommendation: Keep the double jump behind the flag, as Reviewer B says.") =>
    consolidated("disagreement", `Summary: The Reviewers disagree about the flag.\n\nFindings:\n- None.\n\nDoubts: Whether the flag is in scope.\n\n${recommendation}`);

  /** The Developer works; Reviewer A and the Consolidator are Claude's, each given its own answers (the Consolidator's in turn, the last repeating). */
  function claudeScript(a: string | ((step: StepRequest) => StepResult | void | Promise<StepResult | void>), consolidations: string[]) {
    let c = 0;
    return async (step: StepRequest): Promise<StepResult | void> => {
      if (isReviewer(step)) return typeof a === "function" ? a(step) : { status: "succeeded", summary: a };
      if (isConsolidator(step)) return { status: "succeeded", summary: consolidations[Math.min(c++, consolidations.length - 1)]! };
      writeFileSync(join(step.cwd, "fix.txt"), `fix ${claude.steps.length}\n`);
      writeFileSync(join(step.cwd, ".forgequor", "review-brief.md"), "What the Developer did.\n");
    };
  }
  const reviewerBAnswers = (...answers: string[]) => {
    let n = 0;
    codex.use(() => ({ status: "succeeded", summary: answers[Math.min(n++, answers.length - 1)]! }));
  };
  const consolidators = () => claude.steps.filter(isConsolidator);
  const open = (run: RunDetail) => run.gates.find((g) => !g.decidedAt);

  it("runs a Claude Reviewer and a Codex Reviewer at the same time, both read-only, then the Consolidator", async () => {
    const { project: p } = await project();
    // Each Reviewer waits for the other to have started: they only finish if they overlap.
    let started = 0;
    let bothStarted!: () => void;
    const overlap = new Promise<void>((r) => (bothStarted = r));
    const meet = async () => {
      if (++started === 2) bothStarted();
      await overlap;
    };
    claude.use(
      claudeScript(
        async () => {
          await meet();
          return { status: "succeeded", summary: review("pass", "Summary: A is happy.\n\nFindings:\n- None.") };
        },
        [consolidated("pass")],
      ),
    );
    codex.use(async () => {
      await meet();
      return { status: "succeeded", summary: review("pass", "Summary: B is happy.\n\nFindings:\n- None.") };
    });

    const run = await bugfix(p, { review: "duo" });

    expect(run.attempts.filter((a) => a.stepId === "review").map((a) => [a.step, a.runner]).sort()).toEqual([
      ["consolidator", "claude"],
      ["reviewer-a", "claude"],
      ["reviewer-b", "codex"],
    ]);
    const at = (name: string) => run.attempts.find((a) => a.step === name)!;
    expect(at("consolidator").startedAt.getTime()).toBeGreaterThanOrEqual(Math.max(at("reviewer-a").endedAt!.getTime(), at("reviewer-b").endedAt!.getTime()));
    expect(reviewers()[0]!.readonly).toBe(true);
    expect(codex.steps).toHaveLength(1);
    expect(codex.steps[0]!.readonly).toBe(true);
    expect(codex.steps[0]!.instructions).toContain("You are the Reviewer");
    expect(consolidators()).toHaveLength(1);
    expect(consolidators()[0]!.readonly).toBe(true);
    expect(run.state).toBe("waiting");
    expect(stepsOf(run)).toEqual(["developer:done", "checks:done", "review:done", "publish:done", "final:running"]);
  });

  it("gives the Consolidator both Reviews and the change to check them against, and keeps all three Reviews with the consolidated one final", async () => {
    const { project: p } = await project();
    claude.use(claudeScript(review("pass", "Summary: A.\n\nFindings:\n- fix.txt:1 - A's remark."), [consolidated("pass", "Summary: One Review.\n\nFindings:\n- None.\n\nDropped: A's remark was wrong.")]));
    reviewerBAnswers(review("pass", "Summary: B.\n\nFindings:\n- fix.txt:1 - B's remark."));

    const run = await bugfix(p, { review: "duo" });

    const [consolidator] = consolidators();
    expect(consolidator!.instructions).toMatch(/Check every remark/);
    expect(consolidator!.prompt).toContain("The player cannot jump twice.");
    expect(consolidator!.prompt).toContain("A's remark.");
    expect(consolidator!.prompt).toContain("B's remark.");
    expect(consolidator!.prompt).toMatch(/git diff origin\/main\.\.\.HEAD/);
    expect(run.reviews.map((r) => [r.author, r.verdict, r.final]).sort()).toEqual([
      ["consolidator", "pass", true],
      ["reviewer-a", "pass", false],
      ["reviewer-b", "pass", false],
    ]);
    // The Review Brief summarises the consolidated Review only.
    const [brief] = codeHost.pullRequests[0]!.comments;
    expect(brief).toContain("## Review (pass)");
    expect(brief).toContain("One Review.");
    expect(brief).not.toContain("B's remark.");
  });

  it("sends the Developer the Consolidator's Review, not the Reviewers', when changes are requested, and checks again", async () => {
    const { project: p } = await project(["true"]);
    claude.use(claudeScript(review("changes requested", "Summary: A wants more.\n\nFindings:\n- A only."), [consolidated("changes requested", "Summary: Confirmed.\n\nFindings:\n- fix.txt:1 - the real problem."), consolidated("pass")]));
    reviewerBAnswers(review("pass", "Summary: B passes it."));

    const run = await bugfix(p, { review: "duo" });

    expect(developers()).toHaveLength(2);
    const rework = developers()[1]!.prompt;
    expect(rework).toContain("the real problem.");
    expect(rework).not.toContain("A only.");
    expect(run.checks.map((c) => c.attempt)).toEqual([1, 2]);
    expect(consolidators()).toHaveLength(2);
    expect(run.steps.find((s) => s.id === "review")).toMatchObject({ status: "done", attempts: 2 });
    expect(run.gates).toMatchObject([{ kind: "final", decision: null }]);
  });

  it("asks the Consolidator again when its Review has no usable verdict, or a disagreement without a recommendation", async () => {
    const { project: p } = await project();
    claude.use(claudeScript(review("pass"), ["No verdict here.", consolidated("disagreement"), consolidated("pass")]));
    reviewerBAnswers(review("pass"));

    const run = await bugfix(p, { review: "duo" });

    expect(consolidators()).toHaveLength(3);
    expect(consolidators()[1]!.prompt).toContain("does not end with a verdict line");
    expect(consolidators()[2]!.prompt).toContain("Recommendation:");
    expect(run.reviews.filter((r) => r.final)).toHaveLength(1);
    expect(run.gates).toMatchObject([{ kind: "final", decision: null }]);
  });

  describe("a disagreement the Consolidator cannot settle", () => {
    async function disagreed(f: Forge = forge) {
      const { project: p } = await project();
      claude.use(claudeScript(review("pass", "Summary: A is fine with it."), [disagreement(), consolidated("pass")]));
      reviewerBAnswers(review("changes requested", "Summary: B wants the flag.\n\nFindings:\n- fix.txt:1 - needs the flag."));
      return bugfix(p, { review: "duo", f });
    }

    it("opens a review Gate with the recommendation and both Reviews, and waits for the human", async () => {
      const run = await disagreed();

      expect(run.state).toBe("waiting");
      expect(open(run)).toMatchObject({ kind: "review", stepId: "review", actions: ["approve", "reject", "abandon"], redo: null });
      expect(open(run)!.reason).toContain("Keep the double jump behind the flag");
      const evidence = open(run)!.evidence!;
      expect(evidence).toContain("Reviewer A (reviewer-a)");
      expect(evidence).toContain("A is fine with it.");
      expect(evidence).toContain("Reviewer B (reviewer-b)");
      expect(evidence).toContain("B wants the flag.");
      expect(evidence).toContain("The Reviewers disagree about the flag.");
      expect(run.reviews.find((r) => r.final)).toMatchObject({ author: "consolidator", verdict: "disagreement" });
      expect(stepsOf(run)).toEqual(["developer:done", "checks:done", "review:running", "publish:waiting", "final:waiting"]);
      expect(codeHost.pullRequests).toHaveLength(0);
    });

    it("goes on as if the Review passed when the human approves, without reviewing again, and says so in the Review Brief", async () => {
      const run = await disagreed();

      await forge.decideGate({ gateId: open(run)!.id, action: "approve" });
      await forge.whenIdle();

      const after = await forge.getRun(run.id);
      expect(reviewers()).toHaveLength(1);
      expect(consolidators()).toHaveLength(1);
      expect(codex.steps).toHaveLength(1);
      expect(after.iteration).toBe(run.iteration);
      expect(stepsOf(after)).toEqual(["developer:done", "checks:done", "review:done", "publish:done", "final:running"]);
      expect(after.gates.map((g) => [g.kind, g.decision])).toEqual([["review", "approve"], ["final", null]]);
      expect(codeHost.pullRequests[0]!.comments[0]).toContain("## Review (disagreement, approved by the human)");
    });

    it("sends the Developer back with the human's Feedback when they reject it, as changes requested would, and reviews the rework", async () => {
      const run = await disagreed();

      await expect(forge.decideGate({ gateId: open(run)!.id, action: "reject" })).rejects.toThrow(/Feedback/);
      await forge.decideGate({ gateId: open(run)!.id, action: "reject", feedback: "Put the double jump behind the flag." });
      await forge.whenIdle();

      const after = await forge.getRun(run.id);
      expect(developers()).toHaveLength(2);
      expect(developers()[1]!.prompt).toContain("Put the double jump behind the flag.");
      expect(developers()[1]!.prompt).toContain("The Reviewers disagree about the flag.");
      // The Iteration is the same: a Review rejection is a loop-back, which counts against the Step's attempts.
      expect(after.iteration).toBe(run.iteration);
      expect(after.steps.find((s) => s.id === "review")).toMatchObject({ status: "done", attempts: 2 });
      expect(reviewers()).toHaveLength(2);
      expect(consolidators()).toHaveLength(2);
      expect(after.gates.map((g) => [g.kind, g.decision])).toEqual([["review", "reject"], ["final", null]]);
      expect(after.gates[0]!.feedback).toBe("Put the double jump behind the flag.");
    });

    it("stops the Run when the human abandons it", async () => {
      const run = await disagreed();

      await forge.decideGate({ gateId: open(run)!.id, action: "abandon" });
      await forge.whenIdle();

      expect(await forge.getRun(run.id)).toMatchObject({ state: "abandoned" });
      expect(codeHost.pullRequests).toHaveLength(0);
    });

    it("does not offer the choices of other Gates", async () => {
      const run = await disagreed();

      await expect(forge.decideGate({ gateId: open(run)!.id, action: "retry" })).rejects.toThrow(/review Gate cannot be retried/);
    });
  });

  describe("when a Reviewer fails", () => {
    it("opens one Escalation for Reviewer A when both Reviewers fail, and the Consolidator does not run", async () => {
      const { project: p } = await project();
      claude.use(claudeScript(() => ({ status: "failed", error: "A is broken" }), [consolidated("pass")]));
      codex.use(() => ({ status: "failed", error: "B is broken" }));

      const run = await bugfix(p, { review: "duo" });

      expect(run.gates).toHaveLength(1);
      expect(run.gates[0]).toMatchObject({ kind: "escalation", stepId: "review", reason: "Reviewer A (reviewer-a) failed.", evidence: "A is broken" });
      expect(run.state).toBe("waiting");
      expect(consolidators()).toHaveLength(0);
      expect(run.steps.find((s) => s.id === "review")).toMatchObject({ status: "failed" });
    });

    it("names Reviewer B when it alone fails, and a retry reviews again", async () => {
      const { project: p } = await project();
      claude.use(claudeScript(review("pass"), [consolidated("pass")]));
      let tries = 0;
      codex.use(() => (tries++ === 0 ? { status: "failed", error: "B is broken" } : { status: "succeeded", summary: review("pass") }));
      const run = await bugfix(p, { review: "duo" });
      expect(run.gates).toMatchObject([{ kind: "escalation", reason: "Reviewer B (reviewer-b) failed.", evidence: "B is broken" }]);

      await forge.decideGate({ gateId: open(run)!.id, action: "retry" });
      await forge.whenIdle();

      const after = await forge.getRun(run.id);
      expect(after.gates.map((g) => [g.kind, g.decision])).toEqual([["escalation", "retry"], ["final", null]]);
      expect(consolidators()).toHaveLength(1);
    });

    it("pauses the Run, with no Gate, when Reviewer A runs out of Quota and Reviewer B fails", async () => {
      const { project: p } = await project();
      claude.use(claudeScript(() => ({ status: "quota_exhausted", resetsAt: new Date("2031-01-01T00:00:00Z") }), [consolidated("pass")]));
      codex.use(() => ({ status: "failed", error: "B is broken" }));

      const run = await bugfix(p, { review: "duo" });

      expect(run.state).toBe("paused");
      expect(run.gates).toEqual([]);
      await forge.abandonRun(run.id);
    });

    it("opens just one Escalation, naming the seat, when both seats are unusable", async () => {
      const { project: p } = await project();
      const f = forgeWith({ seats: { "reviewer-a": { runner: "gemini" }, "reviewer-b": { runner: "gemini" } } });
      claude.use(claudeScript(review("pass"), [consolidated("pass")]));

      const run = await bugfix(p, { review: "duo", f });

      expect(run.gates).toHaveLength(1);
      expect(run.gates[0]!.reason).toContain('seat "reviewer-a"');
      expect(consolidators()).toHaveLength(0);
    });
  });

  it("holds the Reviewers to read-only: a Reviewer that changes the code is stopped with an Escalation", async () => {
    const { project: p } = await project();
    claude.use(claudeScript(review("pass"), [consolidated("pass")]));
    codex.use((step) => {
      writeFileSync(join(step.cwd, "fix.txt"), "edited by Reviewer B\n");
      return { status: "succeeded", summary: review("pass") };
    });

    const run = await bugfix(p, { review: "duo" });

    expect(escalation(run)).toMatchObject({ stepId: "review", reason: expect.stringContaining("changed files outside the Run Notes"), evidence: "fix.txt" });
    expect(codeHost.pullRequests).toHaveLength(0);
  });

  it("starts the duo again after a restart of Forgequor, keeping one Review per author", async () => {
    const { project: p } = await project();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const inB = new Promise<void>((r) => (reached = r));
    claude.use(claudeScript(review("pass", "Summary: A, first time."), [consolidated("pass")]));
    codex.use(async () => {
      reached();
      await hold;
      return { status: "failed", error: "the old process is gone" };
    });
    const started = await forge.startRun({ projectId: p.id, workflow: "bugfix", task: "The player cannot jump twice.", review: "duo" });
    await inB;
    expect(consolidators()).toHaveLength(0);

    reviewerBAnswers(review("pass", "Summary: B, second time."));
    const restarted = forgeWith({});
    await restarted.recoverAfterRestart();
    await restarted.whenIdle();

    const run = await restarted.getRun(started.id);
    expect(run.steps.find((s) => s.id === "review")).toMatchObject({ status: "done", attempts: 1 });
    expect(run.reviews.map((r) => r.author).sort()).toEqual(["consolidator", "reviewer-a", "reviewer-b"]);
    expect(run.reviews.filter((r) => r.final)).toHaveLength(1);
    expect(run.attempts.filter((a) => a.step === "reviewer-b").map((a) => a.status)).toEqual(["failed", "succeeded"]);
    expect(developers()).toHaveLength(1);
    expect(run.gates).toMatchObject([{ kind: "final", decision: null }]);
    release();
    await forge.whenIdle();
  });

  it("resumes at the review Gate after a restart without reviewing again", async () => {
    const { project: p } = await project();
    claude.use(claudeScript(review("pass"), [disagreement()]));
    reviewerBAnswers(review("changes requested"));
    const run = await bugfix(p, { review: "duo" });

    const restarted = forgeWith({});
    await restarted.recoverAfterRestart();
    await restarted.whenIdle();
    expect(open(await restarted.getRun(run.id))).toMatchObject({ kind: "review" });
    await restarted.decideGate({ gateId: open(run)!.id, action: "approve" });
    await restarted.whenIdle();

    expect(consolidators()).toHaveLength(1);
    expect((await restarted.getRun(run.id)).gates.map((g) => g.kind)).toEqual(["review", "final"]);
  });

  it("works through the Runner each seat is set to in the environment, the Consolidator's included", async () => {
    const { project: p } = await project();
    const f = forgeWith({
      seats: seatSettingsFromEnv({ FORGEQUOR_REVIEWER_A_RUNNER: "codex", FORGEQUOR_REVIEWER_B_RUNNER: "claude", FORGEQUOR_CONSOLIDATOR_RUNNER: "codex", FORGEQUOR_CONSOLIDATOR_MODEL: "gpt-consolidate" }),
    });
    claude.use(claudeScript(review("pass"), [consolidated("pass")]));
    codex.use((step) => ({ status: "succeeded", summary: isConsolidator(step) ? consolidated("pass") : review("pass") }));

    const run = await bugfix(p, { review: "duo", f });

    expect(run.attempts.filter((a) => a.stepId === "review").map((a) => [a.step, a.runner, a.model ?? null]).sort()).toEqual([
      ["consolidator", "codex", "gpt-consolidate"],
      ["reviewer-a", "codex", null],
      ["reviewer-b", "claude", null],
    ]);
    expect(codex.steps.every((s) => s.readonly)).toBe(true);
  });

  it("uses Claude for Reviewer A and the Consolidator and Codex for Reviewer B by default", async () => {
    const { project: p } = await project();
    claude.use(claudeScript(review("pass"), [consolidated("pass")]));
    reviewerBAnswers(review("pass"));

    const run = await bugfix(p, { review: "duo" });

    const runnerOf = (name: string) => run.attempts.find((a) => a.step === name)!.runner;
    expect([runnerOf("reviewer-a"), runnerOf("reviewer-b"), runnerOf("consolidator")]).toEqual(["claude", "codex", "claude"]);
  });
});

describe("parseConsolidation", () => {
  it("accepts a disagreement only with a recommendation, and reads it", () => {
    expect(parseConsolidation("Summary: x.\n\nVerdict: disagreement")).toHaveProperty("problem");
    const ok = parseConsolidation("Summary: x.\n\nRecommendation: do y.\n\nVerdict: disagreement");
    expect(ok).toMatchObject({ verdict: "disagreement" });
    expect(recommendationOf((ok as { body: string }).body)).toBe("do y.");
  });

  it("still tells a Reviewer that disagreement is not its to give", () => {
    expect(parseReview("Summary: x.\n\nRecommendation: y.\n\nVerdict: disagreement")).toMatchObject({ problem: expect.stringContaining('"pass" or "changes requested"') });
  });
});
