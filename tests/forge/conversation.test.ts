import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { parseGrillerTurn } from "../../src/forge/feature.js";
import { createForge, GateError, InvalidInputError, type Forge, type ForgeDeps, type Gate, type Project, type RunDetail } from "../../src/forge/forge.js";
import type { StepRequest, StepResult } from "../../src/runner/runner.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote, type TempRemote, type TempRepo } from "../harness/git.js";

/** The `feature` Workflow's Griller and its Conversation Gate, through the Forge core: real git and PostgreSQL, scripted Runners. */

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

const isGriller = (s: StepRequest) => s.instructions.includes("You are the Griller");
const isReviewer = (s: StepRequest) => s.instructions.includes("You are the Reviewer") || s.instructions.includes("You are the Consolidator");
const passing: StepResult = { status: "succeeded", summary: "Summary: Fine.\n\nFindings:\n- None.\n\nDoubts: None.\n\nVerdict: pass" };
const isSpecWriter = (s: StepRequest) => s.instructions.includes("You are the Spec Writer");
const isArchitect = (s: StepRequest) => s.instructions.includes("You are the Architect");
const grillers = () => claude.steps.filter(isGriller);
const developers = () => claude.steps.filter((s) => !isGriller(s) && !isSpecWriter(s) && !isArchitect(s) && !isReviewer(s));
/** Where the Spec Writer writes the spec of the Run these tests start. */
const SPEC = "docs/specs/let-the-player-jump-twice.md";

const questions = (body = "1. What should the double jump feel like? (Recommended: a short hop.)") => `Kind: questions\n\n${body}`;
const summary = (body = "Build a double jump: a second jump in mid-air, once per fall.") => `Kind: summary\n\n${body}`;

/** What each Griller turn says in turn (the last repeats); `act` may also change files; the Developer and the Reviewer just do their parts. */
function script(turns: (string | ((step: StepRequest, n: number) => StepResult | string | void))[]) {
  let n = 0;
  return (step: StepRequest): StepResult | void => {
    if (isReviewer(step)) return passing;
    if (isArchitect(step)) {
      mkdirSync(join(step.cwd, ".forgequor"), { recursive: true });
      writeFileSync(join(step.cwd, ".forgequor", "implementation-plan.md"), "The plan.\n");
      return;
    }
    if (isSpecWriter(step)) {
      mkdirSync(join(step.cwd, "docs/specs"), { recursive: true });
      writeFileSync(join(step.cwd, SPEC), "# Double jump\n\nThe spec.\n");
      return;
    }
    if (!isGriller(step)) {
      writeFileSync(join(step.cwd, "jump.txt"), `jump ${claude.steps.length}\n`);
      writeFileSync(join(step.cwd, ".forgequor", "review-brief.md"), "What the Developer did.\n");
      return;
    }
    const turn = turns[Math.min(n++, turns.length - 1)]!;
    const said = typeof turn === "function" ? turn(step, n) : turn;
    if (typeof said === "string") return { status: "succeeded", summary: said };
    return said;
  };
}

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  pool = db.pool;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-conversation-"));
  forge = forgeWith({});
  codex.use(() => passing);
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
  claude.sessions.clear();
  codex.use(() => passing);
  codex.steps.length = 0;
  codeHost.pullRequests.length = 0;
  cleanups.splice(0).forEach((c) => c());
});

async function project(checks: string[] = []): Promise<Project> {
  const { repo, remote } = createRepoWithBareRemote({ remote: `git@github.com:acme/conversation-${++counter}.git` }) as { repo: TempRepo; remote: TempRemote };
  cleanups.push(repo.cleanup, remote.cleanup);
  const registered = await forge.registerProject({ path: repo.path });
  remote.pointOriginAtBare();
  return checks.length ? forge.setChecks(registered.id, checks) : registered;
}

async function feature(p: Project, f: Forge = forge, input: { review?: "solo" | "duo" } = {}): Promise<RunDetail> {
  const started = await f.startRun({ projectId: p.id, workflow: "feature", task: "Let the player jump twice.", ...input });
  await f.whenIdle();
  return f.getRun(started.id);
}

const open = (r: RunDetail): Gate => r.gates.find((g) => !g.decidedAt)!;
const stepsOf = (r: RunDetail) => r.steps.map((s) => `${s.id}:${s.status}`);
const transcript = (r: RunDetail) => readFileSync(join(r.worktreePath!, ".forgequor", "grilling.md"), "utf8");

async function answer(r: RunDetail, message: string, f: Forge = forge): Promise<RunDetail> {
  await f.decideGate({ gateId: open(r).id, action: "answer", message });
  await f.whenIdle();
  return f.getRun(r.id);
}
async function confirm(r: RunDetail, f: Forge = forge): Promise<RunDetail> {
  await f.decideGate({ gateId: open(r).id, action: "confirm" });
  await f.whenIdle();
  return f.getRun(r.id);
}
/** Confirms the summary, then approves the spec the Spec Writer wrote, so the Run goes on to the Developer. */
async function confirmAndApprove(r: RunDetail, f: Forge = forge): Promise<RunDetail> {
  const confirmed = await confirm(r, f);
  await f.decideGate({ gateId: open(confirmed).id, action: "approve" });
  await f.whenIdle();
  return f.getRun(r.id);
}

/** The one session the fake Runner keeps (the newest, when the conversation started another). */
const session = () => [...claude.sessions].at(-1)!;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("a feature Run's grilling", () => {
  it("waits at a Conversation Gate with the Griller's first round, in a session it starts", async () => {
    const p = await project();
    claude.use(script([questions()]));

    const run = await feature(p);

    expect(run.workflow).toBe("feature");
    expect(run.review).toBe("duo");
    expect(run.state).toBe("waiting");
    expect(stepsOf(run)).toEqual(["griller:running", "spec-writer:waiting", "spec:waiting", "architect:waiting", "artist:waiting", "asset-gate:waiting", "developer:waiting", "checks:waiting", "review:waiting", "publish:waiting", "final:waiting"]);
    expect(run.steps[0]).toMatchObject({ type: "conversation", detail: "griller" });
    expect(open(run)).toMatchObject({ kind: "conversation", stepId: "griller", actions: ["answer", "abandon"], evidence: expect.stringContaining("double jump feel") });
    expect(grillers()).toHaveLength(1);
    expect(grillers()[0]!.session).toEqual({ start: true });
    expect(grillers()[0]!.instructions).toContain("grill-with-docs");
    expect(grillers()[0]!.prompt).toContain("Let the player jump twice.");
    expect(run.attempts.map((a) => [a.stepId, a.step, a.runner])).toEqual([["griller", "griller", "claude"]]);
    expect(run.conversation.map((t) => [t.author, t.kind])).toEqual([["agent", "questions"]]);
    expect((await forge.listOpenGates()).filter((g) => g.runId === run.id)).toMatchObject([{ kind: "conversation", runTitle: run.title }]);
  });

  it("resumes the same session with the answer, round after round, and keeps the transcript at each exchange", async () => {
    const p = await project();
    claude.use(script([questions("1. Round one question?"), questions("1. Round two question?"), summary()]));

    let run = await feature(p);
    expect(transcript(run)).toContain("## Round 1\n\n### Questions\n\n1. Round one question?");

    run = await answer(run, "Round one: short hop.\n\n- also: no air dash");
    expect(grillers()[1]!.session).toEqual({ resume: session() });
    expect(grillers()[1]!.prompt).toBe("Round one: short hop.\n\n- also: no air dash");
    expect(open(run).evidence).toContain("Round two question");
    expect(transcript(run)).toBe(
      "# Grilling\n\nSubject:\n\n> Let the player jump twice.\n\n## Round 1\n\n### Questions\n\n1. Round one question?\n\n### Answer\n\n> Round one: short hop.\n>\n> - also: no air dash\n\n## Round 2\n\n### Questions\n\n1. Round two question?\n",
    );

    run = await answer(run, "Round two: yes.");
    expect(grillers()[2]!.session).toEqual({ resume: session() });
    expect(open(run)).toMatchObject({ kind: "conversation", actions: ["answer", "confirm", "abandon"] });
    expect(open(run).reason).toMatch(/summary/);
    expect(run.conversation.map((t) => [t.author, t.kind])).toEqual([
      ["agent", "questions"], ["human", "answer"], ["agent", "questions"], ["human", "answer"], ["agent", "summary"],
    ]);
    expect(run.gates.filter((g) => g.kind === "conversation").map((g) => [g.decision, g.feedback])).toEqual([
      ["answer", "Round one: short hop.\n\n- also: no air dash"], ["answer", "Round two: yes."], [null, null],
    ]);
    // A Griller that was answered is not a new Step: the Run is the same one, in the same Iteration.
    expect(run.iteration).toBe(1);
  });

  it("goes on to the Developer, given the subject and the confirmed summary, once the human confirms", async () => {
    const p = await project(["true"]);
    claude.use(script([questions(), summary("Build a double jump: once per fall.")]));

    let run = await feature(p);
    run = await answer(run, "Short hop.");
    run = await confirmAndApprove(run);

    expect(run.state).toBe("waiting");
    expect(stepsOf(run)).toEqual(["griller:done", "spec-writer:done", "spec:done", "architect:done", "artist:skipped", "asset-gate:skipped", "developer:done", "checks:done", "review:done", "publish:done", "final:running"]);
    expect(run.gates.map((g) => g.kind)).toEqual(["conversation", "conversation", "spec", "final"]);
    expect(run.gates[1]).toMatchObject({ decision: "confirm" });
    expect(developers()).toHaveLength(1);
    expect(developers()[0]!.prompt).toContain("Let the player jump twice.");
    expect(developers()[0]!.prompt).toContain("Build a double jump: once per fall.");
    expect(transcript(run)).toMatch(/### Proposed summary\n\nBuild a double jump: once per fall\.\n\n### Answer\n\nConfirmed\.\n$/);
    expect(codeHost.pullRequests).toHaveLength(1);
    // `feature` reviews in duo by default: the second Reviewer is on the other Runner, then the Consolidator.
    expect(run.review).toBe("duo");
    expect(codex.steps).toHaveLength(1);
    expect(run.attempts.filter((a) => a.stepId === "review").map((a) => a.step).sort()).toEqual(["consolidator", "reviewer-a", "reviewer-b"]);
  });

  it("refuses to confirm questions, and an empty answer", async () => {
    const p = await project();
    claude.use(script([questions()]));
    const run = await feature(p);

    await expect(forge.decideGate({ gateId: open(run).id, action: "confirm" })).rejects.toThrow(GateError);
    await expect(forge.decideGate({ gateId: open(run).id, action: "confirm" })).rejects.toThrow(/answered or abandoned/);
    await expect(forge.decideGate({ gateId: open(run).id, action: "answer", message: "  \n " })).rejects.toThrow(InvalidInputError);
    await expect(forge.decideGate({ gateId: open(run).id, action: "approve" })).rejects.toThrow(GateError);
    await expect(forge.decideGate({ gateId: open(run).id, action: "answer" })).rejects.toThrow(/needs a message/);
    expect((await forge.getRun(run.id)).state).toBe("waiting");
  });

  it("lets the human keep talking after a summary instead of confirming it", async () => {
    const p = await project();
    claude.use(script([summary("First summary."), summary("Second summary.")]));

    let run = await feature(p);
    run = await answer(run, "You forgot the wall jump.");

    expect(grillers()[1]!.prompt).toBe("You forgot the wall jump.");
    expect(open(run).evidence).toBe("Second summary.");
    expect(open(run).actions).toContain("confirm");
    run = await confirmAndApprove(run);
    expect(developers()[0]!.prompt).toContain("Second summary.");
    expect(developers()[0]!.prompt).not.toContain("First summary.");
  });

  it("can be abandoned from the Conversation Gate", async () => {
    const p = await project();
    claude.use(script([questions()]));
    const run = await feature(p);

    const abandoned = await forge.decideGate({ gateId: open(run).id, action: "abandon" });

    expect(abandoned.state).toBe("abandoned");
    expect((await forge.listOpenGates()).filter((g) => g.runId === run.id)).toEqual([]);
    expect(developers()).toHaveLength(0);
  });
});

describe("a turn the Griller does not give in the format", () => {
  it("is asked again in the same session, without a new Gate, and the second try is used", async () => {
    const p = await project();
    claude.use(script(["Sure, what do you want to build?", questions("1. A usable question?")]));

    const run = await feature(p);

    expect(grillers()).toHaveLength(2);
    expect(grillers()[1]!.session).toEqual({ resume: session() });
    expect(grillers()[1]!.prompt).toMatch(/could not be used: .*Kind/);
    expect(run.gates.filter((g) => g.kind === "conversation")).toHaveLength(1);
    expect(open(run).evidence).toBe("1. A usable question?");
    expect(run.attempts).toHaveLength(2);
  });

  it("reads the turn from its Run Note when the Griller wrote one", async () => {
    const p = await project();
    claude.use(
      script([
        (step) => {
          writeFileSync(join(step.cwd, ".forgequor", "grilling-turn.md"), questions("1. From the note?"));
          return "I wrote my turn to the note.";
        },
      ]),
    );

    const run = await feature(p);

    expect(open(run).evidence).toBe("1. From the note?");
  });

  it("opens an Escalation when it never gives a usable turn", async () => {
    const p = await project();
    claude.use(script(["no kind here"]));

    const run = await feature(p);

    expect(grillers()).toHaveLength(3);
    expect(run.state).toBe("waiting");
    expect(open(run)).toMatchObject({ kind: "escalation", stepId: "griller", reason: expect.stringContaining("no usable turn") });
    expect(run.steps[0]!.status).toBe("failed");
  });

  it("parses a turn's first line, tolerating Markdown around it", () => {
    expect(parseGrillerTurn("Kind: questions\n\n1. Why?")).toEqual({ kind: "questions", body: "1. Why?" });
    expect(parseGrillerTurn("Thinking...\n**Kind:** Summary.\n\nIt does X.")).toEqual({ kind: "summary", body: "It does X." });
    expect(parseGrillerTurn("Kind: chatter\n\nhi")).toMatchObject({ problem: expect.stringContaining('"chatter"') });
    expect(parseGrillerTurn("Kind: questions")).toMatchObject({ problem: expect.stringContaining("nothing after it") });
    expect(parseGrillerTurn("just text")).toMatchObject({ problem: expect.stringContaining("Kind:") });
  });
});

describe("what the Griller may change in the Project", () => {
  const write = (step: StepRequest, path: string, text: string) => {
    mkdirSync(dirname(join(step.cwd, path)), { recursive: true });
    writeFileSync(join(step.cwd, path), text);
  };

  it("commits the glossary and the ADRs it changed when the conversation is confirmed, and only those", async () => {
    const p = await project();
    claude.use(
      script([
        (step) => {
          write(step, "GLOSSARY.md", "**Double jump**: a second jump in mid-air.\n");
          write(step, "docs/adr/0001-double-jump.md", "# Double jump is capped at one per fall\n");
          return questions();
        },
        summary(),
      ]),
    );

    let run = await feature(p);
    run = await answer(run, "ok");
    expect(git(run.worktreePath!, "log", "--oneline", "origin/main..HEAD")).toBe("");
    run = await confirm(run);

    const commits = git(run.worktreePath!, "log", "--format=%s", "origin/main..HEAD").split("\n");
    expect(commits).toContain("docs: record the decisions of the grilling");
    const grilling = git(run.worktreePath!, "log", "--format=%H %s", "origin/main..HEAD").split("\n").find((l) => l.endsWith("the grilling"))!.split(" ")[0]!;
    expect(git(run.worktreePath!, "show", "--name-only", "--format=", grilling).split("\n").sort()).toEqual(["GLOSSARY.md", "docs/adr/0001-double-jump.md"]);
    expect(git(run.worktreePath!, "status", "--porcelain")).toBe("");
  });

  it("puts back any other file it changed and escalates naming it", async () => {
    const p = await project();
    claude.use(
      script([
        (step) => {
          write(step, "GLOSSARY.md", "**Double jump**.\n");
          write(step, "src/jump.ts", "export const jump = 2;\n");
          write(step, "README.md", "overwritten\n");
          return questions();
        },
      ]),
    );

    const run = await feature(p);

    expect(run.state).toBe("waiting");
    expect(open(run)).toMatchObject({ kind: "escalation", stepId: "griller" });
    expect(open(run).evidence!.split("\n").sort()).toEqual(["README.md", "src/jump.ts"]);
    expect(existsSync(join(run.worktreePath!, "src/jump.ts"))).toBe(false);
    expect(readFileSync(join(run.worktreePath!, "README.md"), "utf8")).not.toContain("overwritten");
    // What it may change stays; no turn was recorded for the turn that broke the rule.
    expect(readFileSync(join(run.worktreePath!, "GLOSSARY.md"), "utf8")).toContain("Double jump");
    expect(run.conversation).toEqual([]);
  });

  it("puts back a file it committed itself", async () => {
    const p = await project();
    claude.use(
      script([
        (step) => {
          write(step, "src/sneaky.ts", "export {};\n");
          execFileSync("git", ["add", "-A"], { cwd: step.cwd });
          execFileSync("git", ["commit", "-q", "-m", "feat: sneaky"], { cwd: step.cwd });
          return questions();
        },
      ]),
    );

    const run = await feature(p);

    expect(open(run)).toMatchObject({ kind: "escalation", evidence: "src/sneaky.ts" });
    expect(existsSync(join(run.worktreePath!, "src/sneaky.ts"))).toBe(false);
    expect(git(run.worktreePath!, "log", "--oneline", "origin/main..HEAD")).toBe("");
  });
});

describe("stray files", () => {
  it("never reach the branch, even from a turn that failed", async () => {
    const p = await project();
    claude.use(
      script([
        (step) => {
          mkdirSync(join(step.cwd, "src"), { recursive: true });
          writeFileSync(join(step.cwd, "src/x.ts"), "export {};\n");
          writeFileSync(join(step.cwd, "README.md"), "scribbled\n");
          return { status: "failed", error: "The Runner died." };
        },
        questions(),
        summary(),
      ]),
    );
    let run = await feature(p);
    expect(open(run)).toMatchObject({ kind: "escalation", stepId: "griller" });
    // Swept at once, silently: the failure path names nothing.
    expect(existsSync(join(run.worktreePath!, "src/x.ts"))).toBe(false);

    await forge.decideGate({ gateId: open(run).id, action: "retry" });
    await forge.whenIdle();
    run = await forge.getRun(run.id);
    run = await answer(run, "ok");
    run = await confirm(run);

    expect(existsSync(join(run.worktreePath!, "src/x.ts"))).toBe(false);
    expect(git(run.worktreePath!, "status", "--porcelain")).toBe("");
    expect(git(run.worktreePath!, "diff", "--name-only", "origin/main", "HEAD")).not.toMatch(/x\.ts|README/);
  });

  it("are swept before a turn when a crash left them behind", async () => {
    const p = await project();
    claude.use(script([questions(), questions("1. Again?")]));
    const run = await feature(p);
    writeFileSync(join(run.worktreePath!, "left-behind.txt"), "x\n");

    await answer(run, "go on");

    expect(existsSync(join(run.worktreePath!, "left-behind.txt"))).toBe(false);
  });
});

describe("what the review and the Developer read after a grilling", () => {
  it("gives the Reviewers and the Consolidator the confirmed summary", async () => {
    const p = await project();
    claude.use(script([summary("Build a double jump: once per fall.")]));

    let run = await feature(p);
    run = await confirmAndApprove(run);

    // The Run has a spec, so that is what the Reviewers read the change against; the summary is the fallback for a Run without one.
    const prompts = [...claude.steps, ...codex.steps].filter(isReviewer).map((s) => s.prompt);
    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) expect(prompt).toContain(`The human approved this spec (it is at ${SPEC} on the branch); review against it:\n\n# Double jump\n\nThe spec.`);
  });

  it("does not reopen the confirmed conversation for a retry at a later Step", async () => {
    const p = await project();
    claude.use(script([summary()]));
    let run = await feature(p);
    await pool.query("UPDATE projects SET setup = $2 WHERE id = $1", [p.id, JSON.stringify(["false"])]);
    run = await confirmAndApprove(run);
    expect(open(run)).toMatchObject({ kind: "escalation", stepId: "developer" });
    await pool.query("UPDATE projects SET setup = '[]' WHERE id = $1", [p.id]);

    await forge.decideGate({ gateId: open(run).id, action: "retry", feedback: "Try again, please." });
    await forge.whenIdle();
    run = await forge.getRun(run.id);

    expect(grillers()).toHaveLength(1);
    expect(stepsOf(run)).toEqual(["griller:done", "spec-writer:done", "spec:done", "architect:done", "artist:skipped", "asset-gate:skipped", "developer:done", "checks:done", "review:done", "publish:done", "final:running"]);
  });
});

describe("a restart during the conversation", () => {
  it("keeps waiting at an open Conversation Gate, and the answer then resumes the same session", async () => {
    const p = await project();
    claude.use(script([questions(), questions("1. After the restart?")]));
    const run = await feature(p);
    const restarted = forgeWith({});

    await restarted.recoverAfterRestart();
    await restarted.whenIdle();
    expect((await restarted.getRun(run.id)).state).toBe("waiting");
    expect(grillers()).toHaveLength(1);

    const after = await answer(run, "Before the restart.", restarted);
    expect(grillers()[1]!.session).toEqual({ resume: session() });
    expect(open(after).evidence).toBe("1. After the restart?");
  });

  it("resumes the session with the human's last message again when the Griller's turn was cut short", async () => {
    const p = await project();
    claude.use(script([questions(), questions("1. Second round?")]));
    let run = await feature(p);
    // What a crash leaves: the answer was given and recorded, the Run was Running, and the Griller's turn never finished.
    await pool.query("UPDATE gates SET decided_at = now(), decision = 'answer', feedback = 'My answer.' WHERE id = $1", [open(run).id]);
    await pool.query("UPDATE runs SET state = 'running' WHERE id = $1", [run.id]);
    await pool.query(
      `INSERT INTO conversation_turns (run_id, step_id, seq, author, kind, body, gate_id)
       VALUES ($1, 'griller', 2, 'human', 'answer', 'My answer.', $2)`,
      [run.id, open(run).id],
    );
    const restarted = forgeWith({});

    await restarted.recoverAfterRestart();
    await restarted.whenIdle();

    run = await restarted.getRun(run.id);
    expect(grillers()).toHaveLength(2);
    expect(grillers()[1]!.session).toEqual({ resume: session() });
    expect(grillers()[1]!.prompt).toBe("Your previous attempt at this turn was cut off or discarded; answer this message again.\n\nMy answer.");
    expect(open(run).evidence).toBe("1. Second round?");
    // The answer is in the transcript once.
    expect(run.conversation.map((t) => t.kind)).toEqual(["questions", "answer", "questions"]);
  });

  it("opens the Gate again when the Run stopped between the Griller's turn and its Gate", async () => {
    const p = await project();
    claude.use(script([questions()]));
    const run = await feature(p);
    await pool.query("UPDATE conversation_turns SET gate_id = NULL WHERE run_id = $1", [run.id]);
    await pool.query("DELETE FROM gates WHERE id = $1", [open(run).id]);
    await pool.query("UPDATE runs SET state = 'running' WHERE id = $1", [run.id]);
    const restarted = forgeWith({});

    await restarted.recoverAfterRestart();
    await restarted.whenIdle();

    const after = await restarted.getRun(run.id);
    expect(after.state).toBe("waiting");
    expect(open(after)).toMatchObject({ kind: "conversation", evidence: expect.stringContaining("double jump feel") });
    expect(grillers()).toHaveLength(1);
  });

  it("starts a new session from the transcript when the Runner no longer has the old one", async () => {
    const p = await project();
    claude.use(script([questions("1. Round one?"), questions("1. Round two?")]));
    let run = await feature(p);
    const old = session();
    claude.forgetSessions();

    run = await answer(run, "The answer to round one.");

    const [, lost, seeded] = grillers();
    expect(lost!.session).toEqual({ resume: old });
    expect(seeded!.session).toEqual({ start: true });
    expect(seeded!.prompt).toContain("1. Round one?");
    expect(seeded!.prompt).toContain("The answer to round one.");
    expect(open(run).evidence).toBe("1. Round two?");
    // The conversation goes on in the new session.
    run = await answer(run, "Round two.");
    expect(grillers()[3]!.session).toEqual({ resume: session() });
  });

  it("starts a session from the transcript for a conversation that kept none", async () => {
    const p = await project();
    claude.use(script([questions("1. Round one?"), questions("1. Round two?")]));
    let run = await feature(p);
    await pool.query("UPDATE conversation_turns SET session_id = NULL WHERE run_id = $1", [run.id]);

    run = await answer(run, "An answer.");

    expect(grillers()[1]!.session).toEqual({ start: true });
    expect(grillers()[1]!.prompt).toContain("1. Round one?");
    expect(grillers()[1]!.prompt).toContain("An answer.");
  });
});

describe("going back to the Griller from an Escalation", () => {
  it("reopens the conversation in the same session, with the Feedback as the human's next message", async () => {
    const p = await project();
    claude.use(
      script([
        questions(),
        summary("The first summary."),
        questions("1. Reopened: what about the wall?"),
        summary("The revised summary, with the wall."),
      ]),
    );
    let run = await feature(p);
    run = await answer(run, "Short hop.");
    // The Developer cannot start: its setup fails, which opens an Escalation at the Developer.
    await pool.query("UPDATE projects SET setup = $2 WHERE id = $1", [p.id, JSON.stringify(["false"])]);
    run = await confirmAndApprove(run);
    expect(open(run)).toMatchObject({ kind: "escalation", stepId: "developer" });
    expect(open(run).redo!.goBack.map((s) => s.stepId)).toEqual(["griller", "spec-writer", "spec", "architect"]);
    await pool.query("UPDATE projects SET setup = '[]' WHERE id = $1", [p.id]);

    await forge.decideGate({ gateId: open(run).id, action: "go_back", target: "griller", feedback: "The wall jump matters too." });
    await forge.whenIdle();
    run = await forge.getRun(run.id);

    const reopened = grillers().at(-1)!;
    expect(reopened.session).toEqual({ resume: session() });
    expect(reopened.prompt).toContain("The wall jump matters too.");
    expect(reopened.prompt).toMatch(/reopened/);
    expect(open(run)).toMatchObject({ kind: "conversation", evidence: "1. Reopened: what about the wall?" });
    expect(transcript(run)).toMatch(/### Answer\n\nConfirmed\.\n\n### Feedback\n\n> The wall jump matters too\.\n\n## Round 3/);

    run = await answer(run, "Yes, include it.");
    run = await confirmAndApprove(run);
    expect(developers().at(-1)!.prompt).toContain("The revised summary, with the wall.");
    expect(stepsOf(run)).toEqual(["griller:done", "spec-writer:done", "spec:done", "architect:done", "artist:skipped", "asset-gate:skipped", "developer:done", "checks:done", "review:done", "publish:done", "final:running"]);
  });
});

describe("the Griller's seat", () => {
  it("escalates, naming the Runner's refusal, when the seat is set to a Runner that keeps no session", async () => {
    const p = await project();
    const refusing = createFakeRunner(() => ({ status: "failed", error: "The Codex Runner cannot keep a session, which this Step needs." }));
    const f = forgeWith({ artistRunner: refusing, seats: { griller: { runner: "codex" } } });

    const run = await feature(p, f);

    expect(run.attempts[0]).toMatchObject({ step: "griller", runner: "codex", status: "failed" });
    expect(open(run)).toMatchObject({ kind: "escalation", reason: "The Griller failed.", evidence: expect.stringContaining("cannot keep a session") });
  });
});
