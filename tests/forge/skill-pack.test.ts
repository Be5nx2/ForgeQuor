import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createForge, type Forge, type Project } from "../../src/forge/forge.js";
import { SHARED_SKILL_PACK } from "../../src/forge/skill-pack.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote, git, type TempRemote, type TempRepo } from "../harness/git.js";

let pool: pg.Pool;
let drop: () => Promise<void>;
let worktrees: string;
let pack: string;
let forge: Forge;
const runner = createFakeRunner();
const cleanups: Array<() => void> = [];
let counter = 0;

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  pool = db.pool;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-worktrees-"));
  pack = mkdtempSync(join(tmpdir(), "forgequor-pack-"));
  for (const name of ["tdd", "code-review"]) {
    mkdirSync(join(pack, name, "refs"), { recursive: true });
    writeFileSync(join(pack, name, "SKILL.md"), `pack ${name}\n`);
    writeFileSync(join(pack, name, "refs", "more.md"), "more\n");
  }
  mkdirSync(join(pack, "trackers"));
  writeFileSync(join(pack, "trackers", "local.md"), "not a Skill\n");
  forge = createForge({ pool, runner, codeHost: createFakeCodeHost(), worktreesRoot: worktrees, skillPack: pack });
});
afterAll(async () => {
  await forge.whenIdle();
  await drop();
  rmSync(worktrees, { recursive: true, force: true });
  rmSync(pack, { recursive: true, force: true });
});
afterEach(() => {
  runner.use(() => {});
  cleanups.splice(0).forEach((c) => c());
});

async function projectWithRemote(own?: Record<string, string>): Promise<{ project: Project; repo: TempRepo; remote: TempRemote }> {
  const { repo, remote } = createRepoWithBareRemote({ remote: `git@github.com:acme/skills-${++counter}.git` });
  cleanups.push(repo.cleanup, remote.cleanup);
  const project = await forge.registerProject({ path: repo.path });
  remote.pointOriginAtBare();
  for (const [file, content] of Object.entries(own ?? {})) remote.advance(file, content);
  return { project, repo, remote };
}

const FOLDERS = [".claude/skills", ".agents/skills"];

describe("the shared Skill Pack in a Run", () => {
  it("places every Skill for both Runners in a Project that has none, and never commits them", async () => {
    const { project } = await projectWithRemote();
    // The Developer commits everything it left.
    runner.use((step) => {
      writeFileSync(join(step.cwd, "feature.gd"), "extends Node\n");
      git(step.cwd, "add", "-A");
      git(step.cwd, "-c", "user.email=a@b.c", "-c", "user.name=A", "commit", "-q", "-m", "feat: add feature");
    });

    const started = await forge.startRun({ projectId: project.id, title: "Add feature", task: "Do it." });
    await forge.whenIdle();
    const run = await forge.getRun(started.id);

    for (const folder of FOLDERS) {
      for (const name of ["tdd", "code-review"]) {
        expect(readFileSync(join(run.worktreePath!, folder, name, "SKILL.md"), "utf8")).toBe(`pack ${name}\n`);
        expect(existsSync(join(run.worktreePath!, folder, name, "refs", "more.md"))).toBe(true);
      }
      expect(existsSync(join(run.worktreePath!, folder, "trackers"))).toBe(false);
    }
    const committed = git(run.worktreePath!, "log", "--name-only", "--format=", "origin/main..HEAD");
    expect(committed).toContain("feature.gd");
    expect(committed).not.toMatch(/\.claude|\.agents/);
    expect(git(run.worktreePath!, "status", "--porcelain")).toBe("");
  });

  it("keeps a Skill the Project already has", async () => {
    const { project } = await projectWithRemote({ ".claude/skills/tdd/SKILL.md": "project tdd\n" });

    const started = await forge.startRun({ projectId: project.id, title: "Keep own", task: "Do it." });
    await forge.whenIdle();
    const wt = (await forge.getRun(started.id)).worktreePath!;

    expect(readFileSync(join(wt, ".claude/skills/tdd/SKILL.md"), "utf8")).toBe("project tdd\n");
    expect(existsSync(join(wt, ".claude/skills/tdd/refs"))).toBe(false);
    expect(readFileSync(join(wt, ".claude/skills/code-review/SKILL.md"), "utf8")).toBe("pack code-review\n");
    // Codex's folder has no tdd of the Project's: the pack's is placed there.
    expect(readFileSync(join(wt, ".agents/skills/tdd/SKILL.md"), "utf8")).toBe("pack tdd\n");
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  it("repairs a missing Skill when the Run restarts", async () => {
    const { project } = await projectWithRemote();
    const started = await forge.startRun({ projectId: project.id, title: "Repair", task: "Do it." });
    await forge.whenIdle();
    const wt = (await forge.getRun(started.id)).worktreePath!;
    rmSync(join(wt, ".agents/skills/tdd"), { recursive: true });
    await pool.query("UPDATE runs SET state = 'running' WHERE id = $1", [started.id]);

    const restarted = createForge({ pool, runner, codeHost: createFakeCodeHost(), worktreesRoot: worktrees, skillPack: pack });
    await restarted.recoverAfterRestart();
    await restarted.whenIdle();

    expect(readFileSync(join(wt, ".agents/skills/tdd/SKILL.md"), "utf8")).toBe("pack tdd\n");
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  it("ships Forgequor's own shared pack by default", () => {
    expect(existsSync(join(SHARED_SKILL_PACK, "code-review", "SKILL.md"))).toBe(true);
  });
});
