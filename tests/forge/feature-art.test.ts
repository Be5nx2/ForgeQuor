import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createForge, type Forge, type Gate, type RunDetail } from "../../src/forge/forge.js";
import type { StepRequest, StepResult } from "../../src/runner/runner.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote, type TempRemote, type TempRepo } from "../harness/git.js";
import { makePng } from "../harness/png.js";

/** Art inside `feature`: the Griller orders Assets, the Artist and the Asset Gate run only then, and the Developer builds on them. */

let pool: pg.Pool;
let drop: () => Promise<void>;
let worktrees: string;
let forge: Forge;
const claude = createFakeRunner();
const codex = createFakeRunner();
const codeHost = createFakeCodeHost();
const cleanups: Array<() => void> = [];
let counter = 0;

const passing: StepResult = { status: "succeeded", summary: "Summary: Fine.\n\nFindings:\n- None.\n\nDoubts: None.\n\nVerdict: pass" };
const isGriller = (s: StepRequest) => s.instructions.includes("You are the Griller");
const isReviewer = (s: StepRequest) => s.instructions.includes("You are the Reviewer") || s.instructions.includes("You are the Consolidator");
const grillers = () => claude.steps.filter(isGriller);
const isSpecWriter = (s: StepRequest) => s.instructions.includes("You are the Spec Writer");
const developers = () => claude.steps.filter((s) => !isGriller(s) && !isSpecWriter(s) && !isReviewer(s));
const artists = () => codex.steps.filter((s) => s.instructions.includes("You are the Artist"));

const REQUESTS = join(".forgequor", "asset-requests.json");
const hero = { name: "Hero Idle", kind: "sprite", description: "The hero, standing.", width: 16, height: 16 };
const HERO_PATH = "assets/art/sprites/hero-idle.png";

const questions = "Kind: questions\n\n1. Which art does the double jump need? (Recommended: a puff.)";
const summary = (body = "Build a double jump, with a dust puff sprite.") => `Kind: summary\n\n${body}`;

/** A Griller that says each turn in turn (the last repeats); `files` writes the Asset Requests (or not) when it speaks the n-th turn. */
function griller(turns: { say: string; requests?: unknown }[]) {
  let n = 0;
  return (step: StepRequest): StepResult | void => {
    if (isReviewer(step)) return passing;
    if (isSpecWriter(step)) {
      mkdirSync(join(step.cwd, "docs", "specs"), { recursive: true });
      writeFileSync(join(step.cwd, "docs", "specs", "let-the-player-jump-twice.md"), "# Double jump\n");
      return;
    }
    if (!isGriller(step)) {
      writeFileSync(join(step.cwd, "jump.txt"), `jump ${claude.steps.length}\n`);
      writeFileSync(join(step.cwd, ".forgequor", "review-brief.md"), "What the Developer did.\n");
      return;
    }
    const turn = turns[Math.min(n++, turns.length - 1)]!;
    if (turn.requests !== undefined) {
      mkdirSync(join(step.cwd, ".forgequor"), { recursive: true });
      writeFileSync(join(step.cwd, REQUESTS), JSON.stringify(turn.requests));
    }
    return { status: "succeeded", summary: turn.say };
  };
}

/** The fake Artist (and second Reviewer): draws the Asset a prompt asks for, passes any review. */
function draw(step: StepRequest): StepResult | void {
  const target = /Target path: (\S+)/.exec(step.prompt)?.[1];
  if (!target) return passing;
  const m = /Image size: (\d+)x(\d+)/.exec(step.prompt)!;
  mkdirSync(dirname(join(step.cwd, target)), { recursive: true });
  writeFileSync(join(step.cwd, target), makePng(Number(m[1]), Number(m[2])));
}

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  pool = db.pool;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-feature-art-"));
  forge = createForge({ pool, runner: claude, artistRunner: codex, codeHost, worktreesRoot: worktrees });
});
afterAll(async () => {
  await forge.whenIdle();
  await drop();
  rmSync(worktrees, { recursive: true, force: true });
});
afterEach(() => {
  claude.use(() => {});
  claude.steps.length = 0;
  claude.sessions.clear();
  codex.use(draw);
  codex.steps.length = 0;
  codeHost.pullRequests.length = 0;
  cleanups.splice(0).forEach((c) => c());
});

async function project(opts: { artDirection?: boolean; existing?: string } = {}) {
  const { repo, remote } = createRepoWithBareRemote({ remote: `git@github.com:acme/feature-art-${++counter}.git` }) as { repo: TempRepo; remote: TempRemote };
  cleanups.push(repo.cleanup, remote.cleanup);
  if (opts.artDirection !== false) remote.advance("docs/ART_DIRECTION.md", "# Art Direction\n\nChunky pixel art.\n");
  if (opts.existing) remote.advance(opts.existing, "not really a png");
  const registered = await forge.registerProject({ path: repo.path });
  remote.pointOriginAtBare();
  return registered;
}

async function feature(projectId: number): Promise<RunDetail> {
  const started = await forge.startRun({ projectId, workflow: "feature", task: "Let the player jump twice." });
  await forge.whenIdle();
  return forge.getRun(started.id);
}
const open = (r: RunDetail): Gate => r.gates.find((g) => !g.decidedAt)!;
const stepsOf = (r: RunDetail) => r.steps.map((s) => `${s.id}:${s.status}`);
async function decide(r: RunDetail, input: Parameters<Forge["decideGate"]>[0] extends infer I ? Omit<I & object, "gateId"> : never): Promise<RunDetail> {
  await forge.decideGate({ gateId: open(r).id, ...input } as Parameters<Forge["decideGate"]>[0]);
  await forge.whenIdle();
  return forge.getRun(r.id);
}
/** Confirms the Griller's summary and, when the Run then stops at the spec Gate, approves the spec. */
async function confirm(r: RunDetail): Promise<RunDetail> {
  const confirmed = await decide(r, { action: "confirm" });
  return open(confirmed)?.kind === "spec" ? decide(confirmed, { action: "approve" }) : confirmed;
}
async function judge(r: RunDetail, feedback?: string): Promise<RunDetail> {
  const verdicts = r.assets.filter((a) => a.status === "waiting").map((a) => (feedback ? { assetId: a.id, action: "reject" as const, feedback } : { assetId: a.id, action: "approve" as const }));
  return decide(r, { action: "judge", verdicts });
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("art inside feature", () => {
  it("runs the Artist and the Asset Gate for the Asset Requests the Griller wrote, then builds on the approved Assets", async () => {
    const p = await project();
    claude.use(griller([{ say: questions }, { say: summary(), requests: [hero] }]));
    codex.use(draw);

    let run = await feature(p.id);
    run = await decide(run, { action: "answer", message: "A puff." });
    expect(open(run)).toMatchObject({ kind: "conversation" });
    run = await confirm(run);

    // The Artist drew the Asset and the human is asked for a verdict; nothing of the code started yet.
    expect(stepsOf(run).slice(0, 5)).toEqual(["griller:done", "spec-writer:done", "spec:done", "artist:done", "asset-gate:running"]);
    expect(open(run)).toMatchObject({ kind: "asset", stepId: "asset-gate" });
    expect(run.assets.map((a) => [a.name, a.targetPath, a.status])).toEqual([["Hero Idle", HERO_PATH, "waiting"]]);
    expect(artists()).toHaveLength(1);
    expect(developers()).toHaveLength(0);

    // A rejection goes back to the Artist, not the Griller.
    run = await judge(run, "Make the hero taller.");
    expect(artists()).toHaveLength(2);
    expect(grillers()).toHaveLength(2);
    expect(open(run)).toMatchObject({ kind: "asset" });

    run = await judge(run);
    expect(run.state).toBe("waiting");
    expect(stepsOf(run)).toEqual(["griller:done", "spec-writer:done", "spec:done", "artist:done", "asset-gate:done", "developer:done", "checks:done", "review:done", "publish:done", "final:running"]);
    // The Developer is given the approved Assets' paths, and the Assets are already in the branch.
    expect(developers()).toHaveLength(1);
    expect(developers()[0]!.prompt).toContain(HERO_PATH);
    expect(developers()[0]!.prompt).toContain("Build a double jump");
    expect(developers()[0]!.prompt).toContain("docs/specs/let-the-player-jump-twice.md");

    // One pull request, opened at the end, with the Developer's Review Brief; it holds the Assets and the code.
    expect(codeHost.pullRequests).toHaveLength(1);
    expect(codeHost.pullRequests[0]!.comments.join("\n")).toContain("What the Developer did.");
    const files = git(run.worktreePath!, "ls-tree", "-r", "--name-only", "HEAD").split("\n");
    expect(files).toContain(HERO_PATH);
    expect(files).toContain("jump.txt");
    expect(git(run.worktreePath!, "log", "--format=%s", "origin/main..HEAD").split("\n")).toContain("feat(art): add 1 asset");
    expect(git(run.worktreePath!, "ls-files", ".forgequor")).toBe("");
  });

  it("skips both art Steps when the Griller ordered no art, when it wrote an empty list (no file at all is the plain feature tests)", async () => {
    const p = await project();
    claude.use(griller([{ say: summary(), requests: [] }]));
    let run = await feature(p.id);
    run = await confirm(run);

    expect(stepsOf(run)).toEqual(["griller:done", "spec-writer:done", "spec:done", "artist:skipped", "asset-gate:skipped", "developer:done", "checks:done", "review:done", "publish:done", "final:running"]);
    expect(run.gates.map((g) => g.kind)).toEqual(["conversation", "spec", "final"]);
    expect(artists()).toHaveLength(0);
    expect(developers()[0]!.prompt).not.toContain("Assets");
  });

  it("reopens the conversation with the reasons when the Asset Requests would overwrite art, and carries on once they are fixed", async () => {
    const p = await project({ existing: HERO_PATH });
    claude.use(griller([{ say: summary(), requests: [hero] }, { say: summary("Build a double jump, replacing the hero sprite."), requests: [{ ...hero, replace: true }] }]));

    let run = await feature(p.id);
    run = await confirm(run);

    // Back to the Griller: nothing was drawn, the Run waits at a new Conversation Gate.
    expect(artists()).toHaveLength(0);
    expect(stepsOf(run)[0]).toBe("griller:running");
    expect(open(run)).toMatchObject({ kind: "conversation", stepId: "griller" });
    expect(grillers()).toHaveLength(2);
    expect(grillers()[1]!.prompt).toContain("could not use what you produced");
    expect(grillers()[1]!.prompt).toContain(`would overwrite the existing file ${HERO_PATH}`);
    expect(run.conversation.map((t) => [t.author, t.kind])).toEqual([["agent", "summary"], ["human", "confirm"], ["human", "feedback"], ["agent", "summary"]]);
    expect(run.assets).toEqual([]);

    run = await confirm(run);
    expect(artists()).toHaveLength(1);
    expect(artists()[0]!.prompt).toContain("replacing an existing Asset");
    expect(open(run)).toMatchObject({ kind: "asset" });
    expect(run.assets.map((a) => [a.name, a.replace])).toEqual([["Hero Idle", true]]);
  });

  it("sends back Asset Requests that are not a list, not valid requests, or ordered without an Art Direction", async () => {
    const bad = (requests: unknown) => ({ say: summary(), requests });
    const reasonFor = async (turns: ReturnType<typeof bad>[], opts: Parameters<typeof project>[0] = {}) => {
      const p = await project(opts);
      claude.steps.length = 0;
      claude.use(griller(turns));
      const run = await confirm(await feature(p.id));
      expect(artists()).toHaveLength(0);
      expect(open(run)).toMatchObject({ kind: "conversation" });
      return grillers()[1]!.prompt;
    };

    expect(await reasonFor([bad({ not: "a list" })])).toContain("must hold a JSON array");
    expect(await reasonFor([bad([{ ...hero, kind: "portrait" }])])).toContain("must be a sprite, a tile or an animation");
    expect(await reasonFor([bad([{ ...hero, references: ["docs/missing.png"] }])])).toContain("does not exist in the repository's default branch");
    expect(await reasonFor([bad([hero])], { artDirection: false })).toContain("has no Art Direction");
  });

  it("explains the file to the Griller", async () => {
    const p = await project();
    claude.use(griller([{ say: questions }]));
    await feature(p.id);
    expect(grillers()[0]!.instructions).toContain(".forgequor/asset-requests.json");
    expect(grillers()[0]!.instructions).toContain('"kind"');
  });
});
