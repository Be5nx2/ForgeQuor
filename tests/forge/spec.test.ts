import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createForge, GateError, InvalidInputError, type Forge, type Gate, type Project, type RunDetail } from "../../src/forge/forge.js";
import { specPathOf } from "../../src/forge/spec.js";
import type { StepRequest, StepResult } from "../../src/runner/runner.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote, type TempRemote, type TempRepo } from "../harness/git.js";

/** The Spec Writer and the spec Gate of the `feature` Workflow, through the Forge core: real git and PostgreSQL, scripted Runners. */

let pool: pg.Pool;
let drop: () => Promise<void>;
let worktrees: string;
let forge: Forge;
const claude = createFakeRunner();
const codex = createFakeRunner();
const codeHost = createFakeCodeHost();
const cleanups: Array<() => void> = [];
let counter = 0;

const SPEC = "docs/specs/let-the-player-jump-twice.md";
const isGriller = (s: StepRequest) => s.instructions.includes("You are the Griller");
const isSpecWriter = (s: StepRequest) => s.instructions.includes("You are the Spec Writer");
const isReviewer = (s: StepRequest) => s.instructions.includes("You are the Reviewer") || s.instructions.includes("You are the Consolidator");
const passing: StepResult = { status: "succeeded", summary: "Summary: Fine.\n\nFindings:\n- None.\n\nDoubts: None.\n\nVerdict: pass" };
const specWriters = () => claude.steps.filter(isSpecWriter);
const developers = () => claude.steps.filter((s) => !isGriller(s) && !isSpecWriter(s) && !isReviewer(s));

const write = (step: StepRequest, path: string, text: string) => {
  mkdirSync(dirname(join(step.cwd, path)), { recursive: true });
  writeFileSync(join(step.cwd, path), text);
};
/** The Spec Writer writes version `n` of the spec (the `n`th time it is asked) unless `specWriting` says otherwise. */
let specWriting: (step: StepRequest, n: number) => StepResult | void = (step, n) => write(step, SPEC, `# Double jump\n\nSpec, version ${n}.\n`);

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  pool = db.pool;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-spec-"));
  claude.use(play);
  codex.use(() => passing);
  forge = createForge({ pool, runner: claude, artistRunner: codex, codeHost, worktreesRoot: worktrees });
});
afterAll(async () => {
  await forge.whenIdle();
  await drop();
  rmSync(worktrees, { recursive: true, force: true });
});
afterEach(() => {
  specWriting = (step, n) => write(step, SPEC, `# Double jump\n\nSpec, version ${n}.\n`);
  claude.use(play);
  claude.steps.length = 0;
  claude.sessions.clear();
  codex.use(() => passing);
  codex.steps.length = 0;
  codeHost.pullRequests.length = 0;
  cleanups.splice(0).forEach((c) => c());
});

let specs = 0;
/** The Griller proposes its summary at once; the Spec Writer writes what `specWriting` says; the Developer and the Reviewers do their parts. */
function play(step: StepRequest): StepResult | void {
  if (isReviewer(step)) return passing;
  if (isGriller(step)) return { status: "succeeded", summary: "Kind: summary\n\nBuild a double jump: once per fall." };
  if (isSpecWriter(step)) return specWriting(step, ++specs);
  write(step, "jump.txt", "jump\n");
  write(step, ".forgequor/review-brief.md", "What the Developer did.\n");
}

let remote: TempRemote;
async function project(): Promise<Project> {
  const made = createRepoWithBareRemote({ remote: `git@github.com:acme/spec-${++counter}.git` }) as { repo: TempRepo; remote: TempRemote };
  cleanups.push(made.repo.cleanup, made.remote.cleanup);
  remote = made.remote;
  const registered = await forge.registerProject({ path: made.repo.path });
  made.remote.pointOriginAtBare();
  return registered;
}

const open = (r: RunDetail): Gate => r.gates.find((g) => !g.decidedAt)!;
const stepsOf = (r: RunDetail) => r.steps.map((s) => `${s.id}:${s.status}`);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Starts a feature Run and confirms the Griller's summary: the Run is then at the spec Gate (or escalated). */
async function toSpecGate(p: Project): Promise<RunDetail> {
  specs = 0;
  const started = await forge.startRun({ projectId: p.id, workflow: "feature", task: "Let the player jump twice." });
  await forge.whenIdle();
  await forge.decideGate({ gateId: open(await forge.getRun(started.id)).id, action: "confirm" });
  await forge.whenIdle();
  return forge.getRun(started.id);
}
async function decide(r: RunDetail, action: "approve" | "reject", feedback?: string): Promise<RunDetail> {
  await forge.decideGate({ gateId: open(r).id, action, feedback });
  await forge.whenIdle();
  return forge.getRun(r.id);
}

describe("the Spec Writer", () => {
  it("writes the spec at docs/specs/<slug>.md and commits it, and only that file", async () => {
    const p = await project();

    const run = await toSpecGate(p);

    expect(specPathOf({ id: run.id, title: run.title })).toBe(SPEC);
    expect(stepsOf(run)).toEqual(["griller:done", "spec-writer:done", "spec:running", "artist:waiting", "asset-gate:waiting", "developer:waiting", "checks:waiting", "review:waiting", "publish:waiting", "final:waiting"]);
    const commits = git(run.worktreePath!, "log", "--format=%H %s", "origin/main..HEAD").split("\n");
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatch(/docs\(spec\): Let the player jump twice\.$/);
    expect(git(run.worktreePath!, "show", "--name-only", "--format=", "HEAD")).toBe(SPEC);
    expect(git(run.worktreePath!, "status", "--porcelain")).toBe("");
    expect(run.attempts.filter((a) => a.step === "spec-writer").map((a) => [a.stepId, a.runner])).toEqual([["spec-writer", "claude"]]);
  });

  it("is given the subject, the confirmed summary and the transcript, and told never to ask", async () => {
    const p = await project();

    await toSpecGate(p);

    const [step] = specWriters();
    expect(step!.prompt).toContain("Let the player jump twice.");
    expect(step!.prompt).toContain("Build a double jump: once per fall.");
    expect(step!.prompt).toContain(".forgequor/grilling.md");
    expect(step!.prompt).toContain(`Write the spec to ${SPEC}.`);
    expect(step!.instructions).toContain("to-spec");
    expect(step!.instructions).toMatch(/NEVER ask the human/);
    expect(step!.instructions).toMatch(/no tickets/);
    expect(step!.session).toBeUndefined();
  });

  it("escalates instead of overwriting a spec the default branch already has", async () => {
    const p = await project();
    remote.advance(SPEC, "# The old spec\n");

    const run = await toSpecGate(p);

    expect(run.state).toBe("waiting");
    expect(open(run)).toMatchObject({ kind: "escalation", stepId: "spec-writer", reason: expect.stringContaining(`${SPEC} on the default branch`) });
    expect(run.steps.find((s) => s.id === "spec-writer")!.status).toBe("failed");
    expect(specWriters()).toHaveLength(0);
    expect(readFileSync(join(run.worktreePath!, SPEC), "utf8")).toBe("# The old spec\n");
    // The human can go back to the Griller to change the subject.
    expect(open(run).redo!.goBack.map((s) => s.stepId)).toEqual(["griller"]);
  });

  it("is sent back when it wrote no spec, and escalates after three tries", async () => {
    const p = await project();
    specWriting = () => {};

    const run = await toSpecGate(p);

    expect(specWriters()).toHaveLength(3);
    expect(specWriters()[1]!.prompt).toContain(`No spec was written: ${SPEC} is missing or empty`);
    expect(open(run)).toMatchObject({ kind: "escalation", stepId: "spec-writer" });
    expect(git(run.worktreePath!, "log", "--oneline", "origin/main..HEAD")).toBe("");
  });

  it("may change no other file: they are put back, and an Escalation names them", async () => {
    const p = await project();
    specWriting = (step) => {
      write(step, SPEC, "# Double jump\n");
      write(step, "ROADMAP.md", "- [ ] `jump-01` a ticket\n");
      write(step, "docs/specs/other.md", "another spec\n");
      write(step, "src/jump.ts", "export {};\n");
    };

    const run = await toSpecGate(p);

    expect(open(run)).toMatchObject({ kind: "escalation", stepId: "spec-writer" });
    expect(open(run).evidence!.split("\n").sort()).toEqual(["ROADMAP.md", "docs/specs/other.md", "src/jump.ts"]);
    for (const path of ["ROADMAP.md", "docs/specs/other.md", "src/jump.ts"]) expect(existsSync(join(run.worktreePath!, path))).toBe(false);
    expect(git(run.worktreePath!, "status", "--porcelain", "--", ".", ":!docs/specs/let-the-player-jump-twice.md")).toBe("");
    // Nothing of that attempt reaches the branch.
    expect(git(run.worktreePath!, "log", "--oneline", "origin/main..HEAD")).toBe("");
  });

  it("may not commit another file either", async () => {
    const p = await project();
    specWriting = (step) => {
      write(step, SPEC, "# Double jump\n");
      write(step, "docs/specs/ticket-1.md", "a ticket\n");
      execFileSync("git", ["add", "-A"], { cwd: step.cwd });
      execFileSync("git", ["commit", "-q", "-m", "docs: spec and a ticket"], { cwd: step.cwd });
    };

    const run = await toSpecGate(p);

    expect(open(run)).toMatchObject({ kind: "escalation", evidence: expect.stringContaining("docs/specs/ticket-1.md") });
    expect(existsSync(join(run.worktreePath!, "docs/specs/ticket-1.md"))).toBe(false);
    expect(git(run.worktreePath!, "log", "--oneline", "origin/main..HEAD")).toBe("");
  });

  it("fails like any Agent when its Runner fails, and sweeps what the failed attempt left", async () => {
    const p = await project();
    specWriting = (step) => {
      write(step, "src/x.ts", "export {};\n");
      return { status: "failed", error: "The Runner died." };
    };

    const run = await toSpecGate(p);

    expect(open(run)).toMatchObject({ kind: "escalation", reason: "The Spec Writer failed." });
    expect(existsSync(join(run.worktreePath!, "src/x.ts"))).toBe(false);
  });
});

describe("the spec Gate", () => {
  it("shows the spec's Markdown, and approving goes on to the Developer, who is given the spec", async () => {
    const p = await project();
    let run = await toSpecGate(p);

    expect(open(run)).toMatchObject({ kind: "spec", stepId: "spec", actions: ["approve", "reject", "abandon"], evidence: "# Double jump\n\nSpec, version 1.\n" });
    expect((await forge.listOpenGates()).filter((g) => g.runId === run.id)).toMatchObject([{ kind: "spec", evidence: "# Double jump\n\nSpec, version 1.\n" }]);
    expect(developers()).toHaveLength(0);

    run = await decide(run, "approve");

    expect(run.state).toBe("waiting");
    expect(stepsOf(run)).toEqual(["griller:done", "spec-writer:done", "spec:done", "artist:skipped", "asset-gate:skipped", "developer:done", "checks:done", "review:done", "publish:done", "final:running"]);
    expect(developers()).toHaveLength(1);
    expect(developers()[0]!.prompt).toContain(`The human approved the spec at ${SPEC}: read it first, and build what it says.`);
    expect(developers()[0]!.prompt).toContain("Build a double jump: once per fall.");
    expect(run.iteration).toBe(1);
    // The spec is in the pull request's branch.
    expect(git(run.worktreePath!, "diff", "--name-only", "origin/main", "HEAD")).toContain(SPEC);
    expect(codeHost.pullRequests).toHaveLength(1);
  });

  it("gives the Reviewers and the Consolidator the spec, path and content", async () => {
    const p = await project();
    let run = await toSpecGate(p);

    run = await decide(run, "approve");

    const prompts = [...claude.steps, ...codex.steps].filter(isReviewer).map((s) => s.prompt);
    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) {
      expect(prompt).toContain(`The human approved this spec (it is at ${SPEC} on the branch); review against it:\n\n# Double jump\n\nSpec, version 1.`);
      expect(prompt).not.toContain("confirmed this summary");
    }
  });

  it("sends a rejection's Feedback to the Spec Writer, which redoes the spec in a new Iteration; approving then goes on", async () => {
    const p = await project();
    let run = await toSpecGate(p);

    run = await decide(run, "reject", "Add what happens on a ledge.");

    expect(run.iteration).toBe(2);
    expect(run.state).toBe("waiting");
    expect(open(run)).toMatchObject({ kind: "spec", iteration: 2, evidence: "# Double jump\n\nSpec, version 2.\n" });
    expect(specWriters()).toHaveLength(2);
    expect(specWriters()[1]!.prompt).toContain("The human rejected your earlier spec");
    expect(specWriters()[1]!.prompt).toContain("1. Add what happens on a ledge.");
    expect(developers()).toHaveLength(0);
    expect(run.iterations.map((i) => [i.number, i.feedback])).toEqual([[1, null], [2, "Add what happens on a ledge."]]);
    // The Griller is not asked again: only the spec is redone, and committed again on top of the first.
    expect(claude.steps.filter(isGriller)).toHaveLength(1);
    expect(git(run.worktreePath!, "log", "--format=%s", "origin/main..HEAD").split("\n")).toHaveLength(2);

    run = await decide(run, "reject", "Also say nothing about double taps.");
    expect(specWriters()[2]!.prompt).toContain("1. Add what happens on a ledge.\n2. Also say nothing about double taps.");

    run = await decide(run, "approve");
    expect(stepsOf(run).slice(0, 6)).toEqual(["griller:done", "spec-writer:done", "spec:done", "artist:skipped", "asset-gate:skipped", "developer:done"]);
    // The Developer reads the spec the human approved; Feedback on the spec is not "the reviewer rejected your work".
    expect(developers()[0]!.prompt).not.toContain("rejected your earlier work");
    expect(readFileSync(join(run.worktreePath!, SPEC), "utf8")).toContain("version 3");
  });

  it("refuses a rejection without Feedback, a confirmation and an answer", async () => {
    const p = await project();
    const run = await toSpecGate(p);

    await expect(forge.decideGate({ gateId: open(run).id, action: "reject", feedback: "  " })).rejects.toThrow(InvalidInputError);
    await expect(forge.decideGate({ gateId: open(run).id, action: "confirm" })).rejects.toThrow(GateError);
    await expect(forge.decideGate({ gateId: open(run).id, action: "answer", message: "x" })).rejects.toThrow(GateError);
    expect((await forge.getRun(run.id)).state).toBe("waiting");
  });

  it("can be abandoned", async () => {
    const p = await project();
    const run = await toSpecGate(p);

    const abandoned = await forge.decideGate({ gateId: open(run).id, action: "abandon" });

    expect(abandoned.state).toBe("abandoned");
    expect(developers()).toHaveLength(0);
  });

  it("keeps waiting at the open spec Gate after a restart", async () => {
    const p = await project();
    const run = await toSpecGate(p);
    const restarted = createForge({ pool, runner: claude, artistRunner: codex, codeHost, worktreesRoot: worktrees });

    await restarted.recoverAfterRestart();
    await restarted.whenIdle();

    const after = await restarted.getRun(run.id);
    expect(after.state).toBe("waiting");
    expect(open(after)).toMatchObject({ kind: "spec", evidence: "# Double jump\n\nSpec, version 1.\n" });
    expect(specWriters()).toHaveLength(1);
  });
});
