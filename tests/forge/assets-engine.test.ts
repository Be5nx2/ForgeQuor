import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { createRepoWithBareRemote, type TempRemote, type TempRepo } from "../harness/git.js";
import { makePng } from "../harness/png.js";

/** The `assets` Workflow followed from its YAML: artist, then the asset Gate (back to the artist), then publish. */

let forge: Forge;
let pool: pg.Pool;
let drop: () => Promise<void>;
let worktrees: string;
const artist = createFakeRunner();
const codeHost = createFakeCodeHost();
const cleanups: Array<() => void> = [];
let counter = 0;

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  pool = db.pool;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-worktrees-"));
  forge = createForge({ pool, runner: createFakeRunner(), artistRunner: artist, codeHost, worktreesRoot: worktrees });
});
afterAll(async () => {
  await forge.whenIdle();
  await drop();
  rmSync(worktrees, { recursive: true, force: true });
});
afterEach(() => {
  artist.use(() => {});
  artist.steps.length = 0;
  codeHost.pullRequests.length = 0;
  cleanups.splice(0).forEach((c) => c());
});

async function project(): Promise<{ project: Project; repo: TempRepo; remote: TempRemote }> {
  const { repo, remote } = createRepoWithBareRemote({ remote: `git@github.com:acme/engine-art-${++counter}.git` });
  cleanups.push(repo.cleanup, remote.cleanup);
  remote.advance("docs/ART_DIRECTION.md", "# Art Direction\n\nChunky pixel art.\n");
  const registered = await forge.registerProject({ path: repo.path });
  remote.pointOriginAtBare();
  return { project: registered, repo, remote };
}

const hero: AssetRequest = { name: "Hero Idle", kind: "sprite", description: "The hero.", width: 16, height: 16 };
const target = (step: StepRequest) => /Target path: (\S+)/.exec(step.prompt)![1]!;
function draw(step: StepRequest) {
  const m = /Image size: (\d+)x(\d+)/.exec(step.prompt)!;
  const file = join(step.cwd, target(step));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, makePng(Number(m[1]), Number(m[2])));
}

async function start(p: Project) {
  const started = await forge.startRun({ projectId: p.id, workflow: "assets", assets: [hero] });
  await forge.whenIdle();
  return forge.getRun(started.id);
}

async function judge(runId: number, feedback?: string) {
  const current = await forge.getRun(runId);
  const gate = current.gates.find((g) => g.kind === "asset" && !g.decidedAt)!;
  const asset = current.assets.find((a) => a.status === "waiting")!;
  return forge.decideGate({
    gateId: gate.id,
    action: "judge",
    verdicts: [feedback ? { assetId: asset.id, action: "reject", feedback } : { assetId: asset.id, action: "approve" }],
  });
}

const stepsOf = (run: { steps: { id: string; status: string }[] }) => run.steps.map((s) => `${s.id}:${s.status}`);

describe("the assets Workflow from its definition", () => {
  it("lists its Steps in the Run detail, the Gate running while the human decides", async () => {
    artist.use(draw);
    const { project: p } = await project();
    const waiting = await start(p);

    expect(waiting.state).toBe("waiting");
    expect(waiting.steps.map((s) => [s.id, s.type, s.detail, s.needs])).toEqual([
      ["artist", "artist", null, []],
      ["review", "gate", "asset", ["artist"]],
      ["publish", "publish", null, ["review"]],
    ]);
    expect(stepsOf(waiting)).toEqual(["artist:done", "review:running", "publish:waiting"]);
    expect(waiting.gates[0]).toMatchObject({ kind: "asset" });
    expect(waiting.gates[0]!.reason).toBe("1 Asset is waiting for your verdict.");
  });

  it("is Approved once Published, with every Step done", async () => {
    artist.use(draw);
    const { project: p } = await project();
    const waiting = await start(p);
    await judge(waiting.id);
    await forge.whenIdle();

    const run = await forge.getRun(waiting.id);
    expect(run.state).toBe("approved");
    expect(stepsOf(run)).toEqual(["artist:done", "review:done", "publish:done"]);
    expect(codeHost.pullRequests).toHaveLength(1);
  });

  it("goes back to the artist on a rejection, and the replayed Gate does not reuse the old decision", async () => {
    artist.use(draw);
    const { project: p } = await project();
    const waiting = await start(p);
    await judge(waiting.id, "Make the hero taller.");
    await forge.whenIdle();

    const again = await forge.getRun(waiting.id);
    expect(again.state).toBe("waiting");
    expect(again.iteration).toBe(2);
    expect(artist.steps).toHaveLength(2);
    expect(stepsOf(again)).toEqual(["artist:done", "review:running", "publish:waiting"]);
    expect(again.gates.filter((g) => g.kind === "asset")).toHaveLength(2);
    expect(again.gates.at(-1)!.decidedAt).toBeFalsy();
    expect(codeHost.pullRequests).toHaveLength(0);

    await judge(waiting.id);
    await forge.whenIdle();
    expect((await forge.getRun(waiting.id)).state).toBe("approved");
  });
});
