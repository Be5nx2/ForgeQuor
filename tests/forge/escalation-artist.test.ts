import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createForge, type Forge } from "../../src/forge/forge.js";
import type { AssetRequest } from "../../src/forge/assets.js";
import type { StepRequest } from "../../src/runner/runner.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote } from "../harness/git.js";
import { makePng } from "../harness/png.js";

/** Retrying an Escalation of the Artist gives the Asset a fresh budget of attempts. */

let forge: Forge;
let pool: pg.Pool;
let drop: () => Promise<void>;
let worktrees: string;
const developer = createFakeRunner();
const artist = createFakeRunner();
const codeHost = createFakeCodeHost();
const cleanups: Array<() => void> = [];

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  pool = db.pool;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-artist-retry-"));
  forge = createForge({ pool, runner: developer, artistRunner: artist, codeHost, worktreesRoot: worktrees });
});
afterAll(async () => {
  await forge.whenIdle();
  await drop();
  rmSync(worktrees, { recursive: true, force: true });
});
afterEach(() => {
  artist.use(() => {});
  artist.steps.length = 0;
  cleanups.splice(0).forEach((c) => c());
});

const hero: AssetRequest = { name: "Hero Idle", kind: "sprite", description: "The hero standing still.", width: 16, height: 16 };
const targetOf = (step: StepRequest) => /Target path: (\S+)/.exec(step.prompt)![1]!;
const draw = (step: StepRequest) => {
  const file = join(step.cwd, targetOf(step));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, makePng(16, 16));
};

describe("retrying an Artist Escalation", () => {
  it("lets the Artist try the Asset again as many times as at first", async () => {
    const { repo, remote } = createRepoWithBareRemote({ remote: "git@github.com:acme/artist-retry.git" });
    cleanups.push(repo.cleanup, remote.cleanup);
    remote.advance("docs/ART_DIRECTION.md", "# Art Direction\n\nChunky pixel art.\n");
    const project = await forge.registerProject({ path: repo.path });
    remote.pointOriginAtBare();
    // The Artist writes nothing at the target path: two tries, then the Escalation.
    artist.use(() => ({ status: "succeeded", summary: "No image tool." }));
    const started = await forge.startRun({ projectId: project.id, workflow: "assets", assets: [hero] });
    await forge.whenIdle();
    const stuck = await forge.getRun(started.id);
    expect(artist.steps).toHaveLength(2);
    const escalation = stuck.gates.find((g) => g.kind === "escalation" && !g.decidedAt)!;
    expect(escalation).toMatchObject({ stepId: "artist", redo: { goBack: [] } });

    // Draws only on the second try after the retry: without a fresh budget the Run would escalate again at once.
    artist.use((step) => {
      if (artist.steps.length === 4) draw(step);
      return { status: "succeeded", summary: "Done." };
    });
    await forge.decideGate({ gateId: escalation.id, action: "retry" });
    await forge.whenIdle();

    const after = await forge.getRun(started.id);
    expect(artist.steps).toHaveLength(4);
    expect(after.gates.map((g) => [g.kind, g.decision])).toEqual([["escalation", "retry"], ["asset", null]]);
  });
});
