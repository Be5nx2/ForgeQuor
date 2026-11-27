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

describe("Skill Packs per Project", () => {
  let root: string;
  let packed: Forge;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "forgequor-skills-"));
    const skill = (pack: string, name: string, text: string) => {
      mkdirSync(join(root, pack, name), { recursive: true });
      writeFileSync(join(root, pack, name, "SKILL.md"), text);
    };
    skill("alpha", "scene", "alpha scene\n");
    skill("alpha", "only-alpha", "alpha only\n");
    skill("beta", "scene", "beta scene\n");
    skill("beta", "only-beta", "beta only\n");
    skill("forgequor", "internal", "internal\n");
    skill("shared", "tdd", "root shared\n");
    mkdirSync(join(root, "empty"));
    writeFileSync(join(root, "empty", "notes.md"), "no Skill\n");
    packed = createForge({ pool, runner, codeHost: createFakeCodeHost(), worktreesRoot: worktrees, skillPack: join(root, "shared"), skillsRoot: root });
  });
  afterAll(async () => {
    await packed.whenIdle();
    rmSync(root, { recursive: true, force: true });
  });

  async function runOf(project: Project): Promise<string> {
    const started = await packed.startRun({ projectId: project.id, title: "Packs", task: "Do it." });
    await packed.whenIdle();
    return (await packed.getRun(started.id)).worktreePath!;
  }

  it("offers the folders that hold Skills, but shared and forgequor", () => {
    expect(packed.offeredSkillPacks()).toEqual(["alpha", "beta"]);
  });

  it("never offers shared or forgequor from Forgequor's own skills", () => {
    expect(forge.offeredSkillPacks()).not.toContain("shared");
    expect(forge.offeredSkillPacks()).not.toContain("forgequor");
  });

  it("refuses an unknown pack and keeps the choice", async () => {
    const { project } = await projectWithRemote();
    await packed.setSkillPacks(project.id, ["alpha"]);
    await expect(packed.setSkillPacks(project.id, ["alpha", "forgequor"])).rejects.toThrow(/Unknown Skill Pack: forgequor/);
    expect((await packed.listProjects()).find((p) => p.id === project.id)!.skillPacks).toEqual(["alpha"]);
  });

  it("places shared then each chosen pack, the first placed winning, a Project's own Skill winning over all, none committed", async () => {
    const { project } = await projectWithRemote({ ".claude/skills/only-beta/SKILL.md": "project beta\n" });
    await packed.setSkillPacks(project.id, ["alpha", "beta"]);
    const wt = await runOf(project);
    for (const folder of FOLDERS) {
      expect(readFileSync(join(wt, folder, "tdd/SKILL.md"), "utf8")).toBe("root shared\n");
      expect(readFileSync(join(wt, folder, "scene/SKILL.md"), "utf8")).toBe("alpha scene\n");
      expect(readFileSync(join(wt, folder, "only-alpha/SKILL.md"), "utf8")).toBe("alpha only\n");
      expect(existsSync(join(wt, folder, "internal"))).toBe(false);
    }
    expect(readFileSync(join(wt, ".claude/skills/only-beta/SKILL.md"), "utf8")).toBe("project beta\n");
    expect(readFileSync(join(wt, ".agents/skills/only-beta/SKILL.md"), "utf8")).toBe("beta only\n");
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  it("gives a Run the packs picked when it started, not a later change, even after a restart", async () => {
    const { project } = await projectWithRemote();
    await packed.setSkillPacks(project.id, ["alpha"]);
    const first = await runOf(project);
    await packed.setSkillPacks(project.id, ["beta"]);
    const second = await runOf(project);
    expect(existsSync(join(first, ".claude/skills/only-alpha"))).toBe(true);
    expect(existsSync(join(first, ".claude/skills/only-beta"))).toBe(false);
    expect(existsSync(join(second, ".claude/skills/only-alpha"))).toBe(false);
    expect(existsSync(join(second, ".claude/skills/only-beta"))).toBe(true);

    rmSync(join(first, ".agents/skills/only-alpha"), { recursive: true });
    await pool.query("UPDATE runs SET state = 'running' WHERE worktree_path = $1", [first]);
    const restarted = createForge({ pool, runner, codeHost: createFakeCodeHost(), worktreesRoot: worktrees, skillPack: join(root, "shared"), skillsRoot: root });
    await restarted.recoverAfterRestart();
    await restarted.whenIdle();
    expect(readFileSync(join(first, ".agents/skills/only-alpha/SKILL.md"), "utf8")).toBe("alpha only\n");
    expect(existsSync(join(first, ".agents/skills/only-beta"))).toBe(false);
  });
});
