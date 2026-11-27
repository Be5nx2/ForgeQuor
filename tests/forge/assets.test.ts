import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createForge, type Forge, type Project } from "../../src/forge/forge.js";
import type { AssetRequest } from "../../src/forge/assets.js";
import type { StepRequest } from "../../src/runner/runner.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote, git, type TempRemote, type TempRepo } from "../harness/git.js";
import { makePng, type Pixel } from "../harness/png.js";

let forge: Forge;
let pool: pg.Pool;
let drop: () => Promise<void>;
let worktrees: string;
let scratch: string;
const developer = createFakeRunner();
const artist = createFakeRunner();
const codeHost = createFakeCodeHost();
const cleanups: Array<() => void> = [];
const others: Forge[] = [];
let counter = 0;

/** The first bytes of a PNG file: enough for the image route, which only serves PNGs. */
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("pixels")]);
const ART_DIRECTION = "# Art Direction\n\nChunky 16-bit pixel art, warm light.\n";

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  pool = db.pool;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-worktrees-"));
  scratch = mkdtempSync(join(tmpdir(), "forgequor-scratch-"));
  forge = forgeWith();
});
function forgeWith() {
  const created = createForge({
    pool,
    runner: developer,
    artistRunner: artist,
    artistModel: "gpt-test",
    codeHost,
    worktreesRoot: worktrees,
  });
  others.push(created);
  return created;
}
afterAll(async () => {
  await Promise.all(others.map((f) => f.whenIdle()));
  await drop();
  rmSync(worktrees, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});
afterEach(() => {
  developer.use(() => {});
  developer.steps.length = 0;
  artist.use(() => {});
  artist.steps.length = 0;
  codeHost.pullRequests.length = 0;
  codeHost.failWith(null);
  cleanups.splice(0).forEach((c) => c());
});

/** A registered Project whose `origin` is a real (bare) remote; its default branch has an Art Direction unless told otherwise. */
async function projectWithRemote(opts: { artDirection?: boolean; artText?: string } = {}): Promise<{ project: Project; repo: TempRepo; remote: TempRemote }> {
  const { repo, remote } = createRepoWithBareRemote({ remote: `git@github.com:acme/game-${++counter}.git` });
  cleanups.push(repo.cleanup, remote.cleanup);
  if (opts.artDirection !== false) remote.advance("docs/ART_DIRECTION.md", opts.artText ?? ART_DIRECTION);
  const project = await forge.registerProject({ path: repo.path });
  remote.pointOriginAtBare();
  return { project, repo, remote };
}

const hero: AssetRequest = { name: "Hero Idle", kind: "sprite", description: "The hero standing still, facing right.", width: 16, height: 16 };
const grass: AssetRequest = { name: "grass", kind: "tile", description: "A plain grass tile.", width: 32, height: 32 };

/** The path the Artist is told to write the Asset to. */
const targetOf = (step: StepRequest) => /Target path: (\S+)/.exec(step.prompt)![1]!;

/** An Artist that draws every Asset at its target path, as the real one must. */
function drawing(pixel?: (x: number, y: number) => Pixel) {
  return (step: StepRequest) => write(step, makePng(...sizeOf(step), { pixel }));
}
const sizeOf = (step: StepRequest): [number, number] => {
  const m = /Image size: (\d+)x(\d+)/.exec(step.prompt)!;
  return [Number(m[1]), Number(m[2])];
};
/** What the Artist saves at the target path. */
function write(step: StepRequest, bytes: Buffer | string) {
  const file = join(step.cwd, targetOf(step));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

/**
 * The human's verdicts at the Run's open Asset Gate: for each waiting Asset by name, "approve" or the Feedback that rejects
 * it; Assets not named are approved.
 */
async function judge(run: { id: number }, verdicts: Record<string, string> = {}) {
  const current = await forge.getRun(run.id);
  const gate = current.gates.find((g) => g.kind === "asset" && !g.decidedAt)!;
  return forge.decideGate({
    gateId: gate.id,
    action: "judge",
    verdicts: current.assets
      .filter((a) => a.status === "waiting")
      .map((a) => (verdicts[a.name] && verdicts[a.name] !== "approve" ? { assetId: a.id, action: "reject" as const, feedback: verdicts[a.name] } : { assetId: a.id, action: "approve" as const })),
  });
}

async function startAssets(project: Project, assets: AssetRequest[] = [hero, grass], extra: { title?: string } = {}) {
  const started = await forge.startRun({ projectId: project.id, workflow: "assets", assets, ...extra });
  await forge.whenIdle();
  return forge.getRun(started.id);
}

describe("a Project's art settings", () => {
  it("default to docs/ART_DIRECTION.md and assets/art", async () => {
    const { project } = await projectWithRemote();

    expect(project).toMatchObject({ artDirectionPath: "docs/ART_DIRECTION.md", artFolder: "assets/art" });
  });

  it("can be changed, and must stay inside the repository", async () => {
    const { project } = await projectWithRemote();

    const saved = await forge.setArt(project.id, { artDirectionPath: " art/STYLE.md ", artFolder: "game/art/" });

    expect(saved).toMatchObject({ artDirectionPath: "art/STYLE.md", artFolder: "game/art" });
    expect((await forge.listProjects()).find((p) => p.id === project.id)).toMatchObject({ artDirectionPath: "art/STYLE.md", artFolder: "game/art" });
    for (const bad of ["", "   ", "/etc/passwd", "../outside", "a/../../b"]) {
      await expect(forge.setArt(project.id, { artDirectionPath: bad, artFolder: "assets/art" })).rejects.toThrow(/inside the repository/);
      await expect(forge.setArt(project.id, { artDirectionPath: "docs/ART_DIRECTION.md", artFolder: bad })).rejects.toThrow(/inside the repository/);
    }
  });
});

describe("starting an assets Run", () => {
  it("records each Asset Request in order with its target path, and describes the Run itself", async () => {
    const { project } = await projectWithRemote();
    await forge.setArt(project.id, { artDirectionPath: "docs/ART_DIRECTION.md", artFolder: "assets/art" });

    const started = await forge.startRun({ projectId: project.id, workflow: "assets", assets: [hero, grass], trackerRef: "$9z" });

    const run = await forge.getRun(started.id);
    expect(run.workflow).toBe("assets");
    expect(run.trackerRef).toBe("$9z");
    expect(run.title).toBe("Art: Hero Idle, grass");
    expect(run.task).toContain("Hero Idle");
    expect(run.task).toContain("16x16");
    expect(run.assets).toMatchObject([
      { name: "Hero Idle", kind: "sprite", width: 16, height: 16, fill: false, targetPath: "assets/art/sprites/hero-idle.png" },
      { name: "grass", kind: "tile", width: 32, height: 32, targetPath: "assets/art/tiles/grass.png" },
    ]);
    await forge.whenIdle();
  });

  it("keeps a title the human gave", async () => {
    const { project } = await projectWithRemote();

    const run = await startAssets(project, [hero], { title: "Hero art" });

    expect(run.title).toBe("Hero art");
  });

  it("refuses an Asset Request that is missing something, before anything starts", async () => {
    const { project } = await projectWithRemote();
    const bad: Array<[Partial<AssetRequest>, RegExp]> = [
      [{ name: "  " }, /name/],
      [{ name: "!!!" }, /name/],
      [{ description: " " }, /description/],
      [{ kind: "boss" as any }, /sprite, a tile or an animation/],
      [{ width: 0 }, /size/],
      [{ height: -4 }, /size/],
      [{ width: 16.5 }, /size/],
    ];

    await expect(forge.startRun({ projectId: project.id, workflow: "assets", assets: [] })).rejects.toThrow(/at least one Asset/);
    await expect(forge.startRun({ projectId: project.id, workflow: "assets" })).rejects.toThrow(/at least one Asset/);
    for (const [change, message] of bad) {
      await expect(forge.startRun({ projectId: project.id, workflow: "assets", assets: [{ ...hero, ...change }] })).rejects.toThrow(message);
    }
    expect(await forge.listRuns({ projectId: project.id })).toEqual([]);
  });

  it("still needs a task for a developer Run", async () => {
    const { project } = await projectWithRemote();

    await expect(forge.startRun({ projectId: project.id })).rejects.toThrow(/task/);
  });
});

describe("the assets Workflow", () => {
  it("has the Artist draw each Asset in turn at its target path, then waits at the Asset Gate", async () => {
    const { project } = await projectWithRemote();
    artist.use(drawing());

    const run = await startAssets(project);

    expect(run.state).toBe("waiting");
    expect(artist.steps).toHaveLength(2);
    expect(artist.steps.map(targetOf)).toEqual(["assets/art/sprites/hero-idle.png", "assets/art/tiles/grass.png"]);
    expect(developer.steps).toHaveLength(0);
    expect(artist.steps[0]).toMatchObject({ cwd: run.worktreePath, model: "gpt-test" });
    expect(artist.steps[0]!.prompt).toContain("The hero standing still, facing right.");
    expect(artist.steps[0]!.prompt).toContain("16x16");
    expect(artist.steps[0]!.prompt).toContain("Chunky 16-bit pixel art");
    expect(artist.steps[0]!.instructions).toMatch(/Target path/);
    expect(run.attempts).toMatchObject([
      { step: "artist", attempt: 1, runner: "codex", model: "gpt-test", status: "succeeded" },
      { step: "artist", attempt: 1, runner: "codex", model: "gpt-test", status: "succeeded" },
    ]);
    expect(run.assets.map((a) => a.status)).toEqual(["waiting", "waiting"]);
    expect(run.gates).toMatchObject([{ kind: "asset", actions: ["judge", "abandon"], decision: null }]);
    expect(existsSync(join(run.worktreePath!, "assets/art/sprites/hero-idle.png"))).toBe(true);
  });

  it("draws the Assets one at a time", async () => {
    const { project } = await projectWithRemote();
    let running = 0;
    let most = 0;
    artist.use(async (step) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 20));
      drawing()(step);
      running--;
    });

    await startAssets(project);

    expect(most).toBe(1);
  });

  it("skips the Project's setup commands and Checks", async () => {
    const { project } = await projectWithRemote();
    await forge.setSetup(project.id, ["exit 1"]);
    await forge.setChecks(project.id, ["exit 1"]);
    artist.use(drawing());

    const run = await startAssets(project, [hero]);

    expect(run.state).toBe("waiting");
    expect(run.checks).toEqual([]);
    expect(run.gates).toMatchObject([{ kind: "asset" }]);
  });

  it("keeps the Runner's raw images in the Run Notes as a trace, out of git", async () => {
    const { project } = await projectWithRemote();
    const raw = join(scratch, "raw-1254.png");
    writeFileSync(raw, PNG);
    artist.use((step) => {
      drawing()(step);
      return { status: "succeeded", summary: "drawn", files: [raw] };
    });

    const run = await startAssets(project, [hero]);

    const trace = join(run.worktreePath!, ".forgequor", "assets");
    const traces = readdirSync(trace).filter((name) => name.endsWith(".png"));
    expect(traces).toHaveLength(1);
    expect(readFileSync(join(trace, traces[0]!))).toEqual(PNG);
    const status = git(run.worktreePath!, "status", "--porcelain", "-uall");
    expect(status).toContain("assets/art/sprites/hero-idle.png");
    expect(status).not.toContain(".forgequor");
  });

  it("uses the Project's own Art Direction path and art folder", async () => {
    const { project, remote } = await projectWithRemote({ artDirection: false });
    remote.advance("art/STYLE.md", "# Style\n\nVery round shapes.\n");
    await forge.setArt(project.id, { artDirectionPath: "art/STYLE.md", artFolder: "game/art" });
    artist.use(drawing());

    const run = await startAssets(project, [hero]);

    expect(run.state).toBe("waiting");
    expect(targetOf(artist.steps[0]!)).toBe("game/art/sprites/hero-idle.png");
    expect(artist.steps[0]!.prompt).toContain("Very round shapes.");
  });
});

describe("when the assets Run cannot go on", () => {
  it("opens an Escalation before anything is generated when the Art Direction is missing", async () => {
    const { project } = await projectWithRemote({ artDirection: false });
    artist.use(drawing());

    const run = await startAssets(project);

    expect(run.state).toBe("waiting");
    expect(artist.steps).toHaveLength(0);
    expect(run.attempts).toEqual([]);
    expect(run.gates).toMatchObject([{ kind: "escalation", actions: ["abandon"] }]);
    expect(run.gates[0]!.reason).toMatch(/Art Direction/);
    expect(run.gates[0]!.evidence).toContain("docs/ART_DIRECTION.md");
  });

  it("opens an Escalation with the Artist's last message when nothing was written at the target path", async () => {
    const { project } = await projectWithRemote();
    artist.use(() => ({ status: "succeeded", summary: "I could not get the image tool to answer." }));

    const run = await startAssets(project, [hero]);

    expect(run.state).toBe("waiting");
    expect(run.gates).toMatchObject([{ kind: "escalation" }]);
    expect(run.gates[0]!.reason).toContain("Hero Idle");
    expect(run.gates[0]!.evidence).toContain("I could not get the image tool to answer.");
    expect(artist.steps).toHaveLength(2);
  });

  it("opens an Escalation with the error when the Artist fails", async () => {
    const { project } = await projectWithRemote();
    artist.use(() => ({ status: "failed", error: "codex crashed" }));

    const run = await startAssets(project, [hero]);

    expect(run.gates).toMatchObject([{ kind: "escalation", reason: "The Artist failed.", evidence: "codex crashed" }]);
    expect(run.attempts).toMatchObject([{ status: "failed", error: "codex crashed" }]);
  });

  it("opens an Escalation when no Artist Runner is configured", async () => {
    const { project } = await projectWithRemote();
    const bare = createForge({ pool, runner: developer, codeHost, worktreesRoot: worktrees });
    others.push(bare);

    const started = await bare.startRun({ projectId: project.id, workflow: "assets", assets: [hero] });
    await bare.whenIdle();

    expect((await bare.getRun(started.id)).gates).toMatchObject([{ kind: "escalation" }]);
  });

  it("pauses when Codex's Quota is used up, keeping its Project slot", async () => {
    const { project } = await projectWithRemote();
    const resetsAt = new Date(Date.now() + 3_600_000);
    artist.use(() => ({ status: "quota_exhausted", resetsAt }));

    const run = await startAssets(project, [hero]);

    expect(run.state).toBe("paused");
    expect(run.resumeAt).toEqual(resetsAt);
    await pool.query("UPDATE runs SET state = 'abandoned' WHERE id = $1", [run.id]);
  });
});

describe("the Asset Checks", () => {
  it("send a failing Asset back to the Artist with the reason, and the next valid file goes to the Gate", async () => {
    const { project } = await projectWithRemote();
    artist.use((step) => (artist.steps.length === 1 ? write(step, makePng(32, 32)) : drawing()(step)));

    const run = await startAssets(project, [hero]);

    expect(run.gates).toMatchObject([{ kind: "asset" }]);
    expect(artist.steps).toHaveLength(2);
    expect(artist.steps[1]!.prompt).toContain("32x32");
    expect(artist.steps[1]!.prompt).toContain("expected exactly 16x16");
    expect(run.attempts.map((a) => [a.step, a.attempt])).toEqual([["artist", 1], ["artist", 2]]);
    expect(run.assets[0]).toMatchObject({ status: "waiting", warnings: [] });
  });

  it("give a failing Asset 2 extra attempts, then open an Escalation naming the Asset and the failure", async () => {
    const { project } = await projectWithRemote();
    artist.use((step) => write(step, makePng(16, 16, { alpha: false })));

    const run = await startAssets(project, [hero, grass]);

    expect(artist.steps).toHaveLength(3);
    expect(run.gates).toMatchObject([{ kind: "escalation", actions: ["abandon"] }]);
    expect(run.gates[0]!.reason).toContain("Hero Idle");
    expect(run.gates[0]!.reason).toContain("3 attempts");
    expect(run.gates[0]!.evidence).toMatch(/alpha channel/);
    expect(run.assets.map((a) => a.status)).toEqual(["generating", "pending"]);
  });

  it("treat a file that is not a PNG as a failure to fix, not as nothing written", async () => {
    const { project } = await projectWithRemote();
    artist.use((step) => (artist.steps.length === 1 ? write(step, "<html></html>") : drawing()(step)));

    const run = await startAssets(project, [hero]);

    expect(run.gates).toMatchObject([{ kind: "asset" }]);
    expect(artist.steps[1]!.prompt).toContain("not a readable PNG");
  });

  it("give an Asset with nothing written one more try, with a reminder of where to save it", async () => {
    const { project } = await projectWithRemote();
    artist.use((step) => (artist.steps.length === 1 ? { status: "succeeded", summary: "Done!" } : drawing()(step)));

    const run = await startAssets(project, [hero]);

    expect(run.gates).toMatchObject([{ kind: "asset" }]);
    expect(artist.steps[1]!.prompt).toContain("nothing at the target path");
    expect(artist.steps[1]!.prompt).toContain(targetOf(artist.steps[1]!));
  });

  it("fail a transparent pixel in an Asset marked as filling its square, and leave other Assets free to use transparency", async () => {
    const { project } = await projectWithRemote();
    artist.use((step) => (artist.steps.length === 1 ? drawing((x) => (x === 0 ? [0, 0, 0, 0] : [255, 0, 0, 255]))(step) : drawing()(step)));

    const run = await startAssets(project, [{ ...grass, fill: true }]);

    expect(run.assets[0]).toMatchObject({ fill: true, status: "waiting" });
    expect(artist.steps).toHaveLength(2);
    expect(artist.steps[0]!.prompt).toMatch(/Fill: yes/);
    expect(artist.steps[1]!.prompt).toContain("must fill its whole square");

    artist.steps.length = 0;
    artist.use(drawing((x) => (x === 0 ? [0, 0, 0, 0] : [255, 0, 0, 255])));
    const free = await startAssets(project, [hero]);
    expect(free.assets[0]).toMatchObject({ fill: false, status: "waiting" });
    expect(artist.steps).toHaveLength(1);
    expect(artist.steps[0]!.prompt).toMatch(/Fill: no/);
  });

  it("refuse a fill flag that is not a yes or a no", async () => {
    const { project } = await projectWithRemote();

    await expect(forge.startRun({ projectId: project.id, workflow: "assets", assets: [{ ...hero, fill: "yes" as any }] })).rejects.toThrow(/fill/);
  });

  it("show colours outside the Art Direction's palette as a warning on the Asset, never a failure", async () => {
    const { project } = await projectWithRemote({ artText: "# Art\n\n## Palette\n- #FF0000 red\n- #00FF00 green\n" });
    artist.use(drawing((x) => (x === 0 ? [1, 2, 3, 255] : [255, 0, 0, 255])));

    const run = await startAssets(project, [hero]);

    expect(artist.steps).toHaveLength(1);
    expect(run.gates).toMatchObject([{ kind: "asset" }]);
    expect(run.assets[0]!.warnings).toEqual(["1 colour outside the palette: #010203"]);
  });

  it("raise no palette warning when the Art Direction lists no palette", async () => {
    const { project } = await projectWithRemote();
    artist.use(drawing(() => [1, 2, 3, 255]));

    const run = await startAssets(project, [hero]);

    expect(run.assets[0]!.warnings).toEqual([]);
  });

  it("keep the warnings of the version the human is judging, not those of an earlier attempt", async () => {
    const { project } = await projectWithRemote({ artText: "## Palette\n#FF0000\n" });
    artist.use((step) => (artist.steps.length === 1 ? write(step, makePng(8, 8)) : drawing(() => [255, 0, 0, 255])(step)));

    const run = await startAssets(project, [hero]);

    expect(run.assets[0]!.warnings).toEqual([]);
  });
});

describe("Animation Strips", () => {
  const walk: AssetRequest = { name: "Hero walk", kind: "animation", description: "The hero walking right.", width: 16, height: 16, frames: 4 };

  it("go to the animations folder, with their frame count recorded; other Assets have one frame", async () => {
    const { project } = await projectWithRemote();

    const started = await forge.startRun({ projectId: project.id, workflow: "assets", assets: [walk, { ...hero, frames: 9 }] });
    await forge.whenIdle();
    const run = await forge.getRun(started.id);

    expect(run.assets).toMatchObject([
      { kind: "animation", width: 16, height: 16, frames: 4, targetPath: "assets/art/animations/hero-walk.png" },
      { kind: "sprite", frames: 1, targetPath: "assets/art/sprites/hero-idle.png" },
    ]);
    expect(run.task).toContain("4 frames");
  });

  it("need a whole frame count of at least 2", async () => {
    const { project } = await projectWithRemote();

    for (const frames of [undefined, 0, 1, 2.5, "4" as any]) {
      await expect(forge.startRun({ projectId: project.id, workflow: "assets", assets: [{ ...walk, frames }] })).rejects.toThrow(/frames/);
    }
  });

  it("tell the Artist to lay the frames side by side, and check the whole strip's size", async () => {
    const { project } = await projectWithRemote();
    artist.use((step) => (artist.steps.length === 1 ? write(step, makePng(16, 16)) : drawing()(step)));

    const run = await startAssets(project, [walk]);

    expect(artist.steps[0]!.prompt).toContain("Frames: 4");
    expect(artist.steps[0]!.prompt).toContain("side by side");
    expect(artist.steps[0]!.prompt).toContain("Image size: 64x16");
    expect(artist.steps[1]!.prompt).toContain("16x16, expected exactly 64x16");
    expect(run.gates).toMatchObject([{ kind: "asset" }]);
    expect(readFileSync(join(run.worktreePath!, "assets/art/animations/hero-walk.png"))).toEqual(makePng(64, 16));
  });

  it("appear in the Review Brief with their frame count", async () => {
    const { project } = await projectWithRemote();
    artist.use(drawing());
    const waiting = await startAssets(project, [walk]);

    await judge(waiting);
    await forge.whenIdle();

    const [brief] = codeHost.pullRequests[0]!.comments;
    expect(brief).toContain("assets/art/animations/hero-walk.png");
    expect(brief).toContain("animation");
    expect(brief).toContain("16x16 × 4 frames");
  });
});

describe("the Asset Gate", () => {
  it("takes a verdict for the Assets or an abandon, never a plain approve or reject", async () => {
    const { project } = await projectWithRemote();
    artist.use(drawing());
    const run = await startAssets(project, [hero]);

    await expect(forge.decideGate({ gateId: run.gates[0]!.id, action: "reject", feedback: "Redo." })).rejects.toThrow(/cannot be rejected/);
    await expect(forge.decideGate({ gateId: run.gates[0]!.id, action: "approve" })).rejects.toThrow(/cannot be approved/);

    expect((await forge.getRun(run.id)).state).toBe("waiting");
  });

  it("abandons the Run, with no pull request and nothing committed", async () => {
    const { project } = await projectWithRemote();
    artist.use(drawing());
    const run = await startAssets(project, [hero]);

    const abandoned = await forge.decideGate({ gateId: run.gates[0]!.id, action: "abandon" });

    expect(abandoned.state).toBe("abandoned");
    expect(codeHost.pullRequests).toEqual([]);
    expect(git(run.worktreePath!, "log", "--format=%s", "origin/main..HEAD")).toBe("");
  });

  it("holds a Project slot like any other Run", async () => {
    const { project } = await projectWithRemote();
    await forge.setMaxConcurrentRuns(project.id, 1);
    artist.use(drawing());
    await startAssets(project, [hero]);

    const next = await forge.startRun({ projectId: project.id, task: "Do the thing." });

    expect(next.state).toBe("queued");
    await forge.setMaxConcurrentRuns(project.id, 5);
    await forge.whenIdle();
  });
});

describe("approving the Asset Gate", () => {
  async function approved(assets: AssetRequest[] = [hero, grass]) {
    const { project, remote } = await projectWithRemote();
    artist.use((step) => {
      drawing()(step);
      writeFileSync(join(step.cwd, "stray.txt"), "left behind\n");
    });
    const waiting = await startAssets(project, assets);
    const run = await judge(waiting, {});
    await forge.whenIdle();
    return { project, remote, waiting, run: await forge.getRun(run.id) };
  }

  it("commits the Assets in one commit, pushes, opens the pull request and approves the Run with no second Gate", async () => {
    const { remote, waiting, run } = await approved();

    expect(run.state).toBe("approved");
    expect(run.assets.map((a) => a.status)).toEqual(["approved", "approved"]);
    expect(run.gates).toHaveLength(1);
    expect(git(run.worktreePath!, "log", "--format=%s", "origin/main..HEAD")).toBe("feat(art): add 2 assets");
    expect(git(run.worktreePath!, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual([
      "assets/art/sprites/hero-idle.png",
      "assets/art/tiles/grass.png",
    ]);
    expect(git(remote.bare, "rev-parse", `refs/heads/${waiting.branch}`)).toBe(git(run.worktreePath!, "rev-parse", "HEAD"));
    expect(codeHost.pullRequests).toHaveLength(1);
    expect(codeHost.pullRequests[0]).toMatchObject({ head: waiting.branch, base: "main", title: "Art: Hero Idle, grass" });
    expect(run.prNumber).toBe(codeHost.pullRequests[0]!.number);
  });

  it("posts a Review Brief that Forgequor writes from what it stored", async () => {
    const { run } = await approved();

    const [brief] = codeHost.pullRequests[0]!.comments;
    expect(codeHost.pullRequests[0]!.comments).toHaveLength(1);
    expect(brief).toContain("assets/art/sprites/hero-idle.png");
    expect(brief).toContain("assets/art/tiles/grass.png");
    expect(brief).toMatch(/sprite/);
    expect(brief).toMatch(/tile/);
    expect(brief).toContain("16x16");
    expect(brief).toContain("32x32");
    expect(artist.steps).toHaveLength(2);
    expect(developer.steps).toHaveLength(0);
    expect(run.state).toBe("approved");
  });

  it("commits the Assets only, not other files the Artist left in the worktree", async () => {
    const { run } = await approved([hero]);

    expect(git(run.worktreePath!, "show", "--name-only", "--format=", "HEAD")).toBe("assets/art/sprites/hero-idle.png");
    expect(git(run.worktreePath!, "log", "--format=%s", "origin/main..HEAD")).toBe("feat(art): add 1 asset");
  });

  it("follows the pull request like any Approved Run", async () => {
    const { run } = await approved([hero]);
    codeHost.setState(run.prNumber!, "merged");

    await forge.checkPullRequests();

    expect((await forge.getRun(run.id)).state).toBe("merged");
  });
});

describe("serving an Asset's image", () => {
  it("returns the file the Artist wrote, for that Run only", async () => {
    const { project } = await projectWithRemote();
    artist.use(drawing());
    const run = await startAssets(project, [hero]);
    const other = await startAssets(project, [grass]);

    const path = await forge.assetImage(run.id, run.assets[0]!.id);

    expect(path).toBe(realpathSync(join(run.worktreePath!, "assets/art/sprites/hero-idle.png")));
    expect(readFileSync(path)).toEqual(makePng(16, 16));
    await expect(forge.assetImage(other.id, run.assets[0]!.id)).rejects.toThrow(/No such Asset/);
    await expect(forge.assetImage(run.id, 999_999)).rejects.toThrow(/No such Asset/);
    await expect(forge.assetImage(999_999, run.assets[0]!.id)).rejects.toThrow(/No such Asset/);
  });

  it("has nothing to serve before the Artist wrote the file", async () => {
    const { project } = await projectWithRemote();
    artist.use(() => ({ status: "failed", error: "nope" }));
    const run = await startAssets(project, [hero]);

    await expect(forge.assetImage(run.id, run.assets[0]!.id)).rejects.toThrow(/No such Asset/);
  });

  it("never serves a file outside the Run's worktree, nor anything that is not a PNG", async () => {
    const { project } = await projectWithRemote();
    artist.use(drawing());
    const run = await startAssets(project, [hero, grass]);
    const outside = join(scratch, "secret.png");
    writeFileSync(outside, PNG);
    const [first, second] = run.assets;

    // A recorded path that climbs out of the worktree.
    await pool.query("UPDATE assets SET target_path = $2 WHERE id = $1", [first!.id, `../../../${outside}`]);
    await expect(forge.assetImage(run.id, first!.id)).rejects.toThrow(/No such Asset/);

    // A file in the worktree that is really a link to one outside it.
    const link = join(run.worktreePath!, "assets/art/tiles/grass.png");
    rmSync(link);
    symlinkSync(outside, link);
    await expect(forge.assetImage(run.id, second!.id)).rejects.toThrow(/No such Asset/);

    // A file in the worktree that is not a PNG.
    rmSync(link);
    writeFileSync(link, "<html>not an image</html>");
    await expect(forge.assetImage(run.id, second!.id)).rejects.toThrow(/No such Asset/);
  });
});

describe("the human's verdicts at the Asset Gate", () => {
  /** An Artist whose pixels change with each Step, so every version of an Asset has its own bytes. */
  function drawingAnew() {
    return (step: StepRequest) => drawing((x) => [artist.steps.length * 10, x, 0, 255])(step);
  }
  const rejectedVersionOf = (step: StepRequest) => /Rejected version \(reference[^)]*\): (\S+)/.exec(step.prompt)?.[1];

  it("redoes only the rejected Assets, with the Feedback and the rejected version as a reference, and keeps the approved ones", async () => {
    const { project } = await projectWithRemote();
    let targetAtStart: boolean | null = null;
    artist.use((step) => {
      if (artist.steps.length === 3) targetAtStart = existsSync(join(step.cwd, targetOf(step)));
      drawingAnew()(step);
    });
    const first = await startAssets(project);
    const keptGrass = readFileSync(join(first.worktreePath!, "assets/art/tiles/grass.png"));
    const firstHero = readFileSync(join(first.worktreePath!, "assets/art/sprites/hero-idle.png"));

    await judge(first, { "Hero Idle": "Make the hero taller." });
    await forge.whenIdle();
    const run = await forge.getRun(first.id);

    expect(run.state).toBe("waiting");
    expect(run.iteration).toBe(2);
    expect(artist.steps).toHaveLength(3);
    const redo = artist.steps[2]!;
    expect(targetOf(redo)).toBe("assets/art/sprites/hero-idle.png");
    expect(redo.prompt).toContain("Make the hero taller.");
    expect(targetAtStart).toBe(false);
    expect(readFileSync(join(run.worktreePath!, rejectedVersionOf(redo)!))).toEqual(firstHero);
    expect(readFileSync(join(run.worktreePath!, "assets/art/tiles/grass.png"))).toEqual(keptGrass);
    expect(run.assets.map((a) => [a.name, a.status])).toEqual([["Hero Idle", "waiting"], ["grass", "approved"]]);
    expect(run.attempts.filter((a) => a.iteration === 2).map((a) => [a.step, a.attempt])).toEqual([["artist", 1]]);
    expect(run.iterations).toHaveLength(2);
    expect(run.gates).toMatchObject([
      { kind: "asset", decision: "reject", verdicts: [{ verdict: "reject", feedback: "Make the hero taller." }, { verdict: "approve", feedback: null }] },
      { kind: "asset", decision: null, actions: ["judge", "abandon"] },
    ]);
    expect(run.gates[1]!.reason).toContain("1 Asset");
  });

  it("shows each Asset's past versions with their Feedback, and serves the old image by version", async () => {
    const { project } = await projectWithRemote();
    artist.use(drawingAnew());
    const first = await startAssets(project, [hero]);
    const firstBytes = readFileSync(join(first.worktreePath!, "assets/art/sprites/hero-idle.png"));
    await judge(first, { "Hero Idle": "More blue." });
    await forge.whenIdle();
    const run = await forge.getRun(first.id);

    const [old, current] = run.assets[0]!.versions;

    expect(run.assets[0]!.versions).toHaveLength(2);
    expect(old).toMatchObject({ iteration: 1, feedback: "More blue." });
    expect(current).toMatchObject({ iteration: 2, feedback: null });
    expect(readFileSync(await forge.assetImage(run.id, run.assets[0]!.id, old!.id))).toEqual(firstBytes);
    expect(readFileSync(await forge.assetImage(run.id, run.assets[0]!.id))).not.toEqual(firstBytes);
    await expect(forge.assetImage(run.id, run.assets[0]!.id, 999_999)).rejects.toThrow(/No such Asset/);
  });

  it("goes on for as many Iterations as the human wants, handing the Artist all the Feedback so far", async () => {
    const { project } = await projectWithRemote();
    artist.use(drawingAnew());
    const first = await startAssets(project, [hero]);
    for (const feedback of ["One.", "Two.", "Three."]) {
      await judge(first, { "Hero Idle": feedback });
      await forge.whenIdle();
    }

    const run = await forge.getRun(first.id);

    expect(run.iteration).toBe(4);
    expect(run.state).toBe("waiting");
    expect(artist.steps.at(-1)!.prompt).toMatch(/1\. One\.\n2\. Two\.\n3\. Three\./);
    expect(run.assets[0]!.versions.map((v) => v.feedback)).toEqual(["One.", "Two.", "Three.", null]);
  });

  it("gives each Iteration a fresh budget of Asset Check attempts", async () => {
    const { project } = await projectWithRemote();
    artist.use((step) => write(step, artist.steps.length === 2 ? makePng(8, 8) : makePng(...sizeOf(step))));
    const first = await startAssets(project, [hero]);
    await judge(first, { "Hero Idle": "Again." });
    await forge.whenIdle();

    const run = await forge.getRun(first.id);

    expect(run.gates.at(-1)).toMatchObject({ kind: "asset", decidedAt: null });
    expect(run.attempts.filter((a) => a.iteration === 2).map((a) => a.attempt)).toEqual([1, 2]);
  });

  it("refuses a partial set of verdicts, an unknown or repeated Asset, and a rejection without Feedback, leaving the Gate open", async () => {
    const { project } = await projectWithRemote();
    artist.use(drawing());
    const run = await startAssets(project);
    const [a, b] = run.assets;
    const gateId = run.gates[0]!.id;
    const decide = (verdicts: any) => forge.decideGate({ gateId, action: "judge", verdicts });

    await expect(decide(undefined)).rejects.toThrow(/verdict/);
    await expect(decide([null])).rejects.toThrow(/names an Asset/);
    await expect(decide([])).rejects.toThrow(/every Asset/);
    await expect(decide([{ assetId: a!.id, action: "approve" }])).rejects.toThrow(/every Asset/);
    await expect(decide([{ assetId: a!.id, action: "approve" }, { assetId: a!.id, action: "approve" }])).rejects.toThrow(/once/);
    await expect(decide([{ assetId: a!.id, action: "approve" }, { assetId: 999_999, action: "approve" }])).rejects.toThrow(/not waiting/);
    await expect(decide([{ assetId: a!.id, action: "approve" }, { assetId: b!.id, action: "reject", feedback: "  " }])).rejects.toThrow(/Feedback/);
    await expect(decide([{ assetId: a!.id, action: "approve" }, { assetId: b!.id, action: "maybe" }])).rejects.toThrow(/approve or reject/);

    const after = await forge.getRun(run.id);
    expect(after.state).toBe("waiting");
    expect(after.gates[0]!.decidedAt).toBeNull();
    expect(after.assets.map((x) => x.status)).toEqual(["waiting", "waiting"]);
  });

  it("refuses verdicts at a Gate that is not an Asset Gate", async () => {
    const { project } = await projectWithRemote();
    artist.use(() => ({ status: "failed", error: "nope" }));
    const run = await startAssets(project, [hero]);

    await expect(forge.decideGate({ gateId: run.gates[0]!.id, action: "judge", verdicts: [] })).rejects.toThrow(/only be abandoned/);
  });

  it("commits everything once the last Iteration is approved, and lists the Feedback behind each Asset in the Review Brief", async () => {
    const { project } = await projectWithRemote();
    artist.use(drawingAnew());
    const first = await startAssets(project);
    await judge(first, { "Hero Idle": "Make the hero taller.", grass: "Greener." });
    await forge.whenIdle();
    await judge(first, { grass: "Even greener." });
    await forge.whenIdle();
    await judge(first, {});
    await forge.whenIdle();

    const run = await forge.getRun(first.id);

    expect(run.state).toBe("approved");
    expect(git(run.worktreePath!, "log", "--format=%s", "origin/main..HEAD")).toBe("feat(art): add 2 assets");
    expect(codeHost.pullRequests).toHaveLength(1);
    const [brief] = codeHost.pullRequests[0]!.comments;
    expect(codeHost.pullRequests[0]!.comments).toHaveLength(1);
    expect(brief).toContain("Make the hero taller.");
    expect(brief).toMatch(/Greener\.[\s\S]*Even greener\./);
    expect(run.assets.map((a) => a.status)).toEqual(["approved", "approved"]);
  });

  it("can still abandon the Run after a rejection", async () => {
    const { project } = await projectWithRemote();
    artist.use(drawing());
    const first = await startAssets(project, [hero]);
    await judge(first, { "Hero Idle": "Again." });
    await forge.whenIdle();
    const waiting = await forge.getRun(first.id);

    const run = await forge.decideGate({ gateId: waiting.gates.at(-1)!.id, action: "abandon" });

    expect(run.state).toBe("abandoned");
  });
});
