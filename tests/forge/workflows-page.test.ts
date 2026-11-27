import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createForge, type Forge } from "../../src/forge/forge.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote } from "../harness/git.js";

/** What the Workflows page reads (`listWorkflows`) and what `POST /api/workflows/validate` asks (`validateWorkflow`). */

let forge: Forge;
let drop: () => Promise<void>;
let worktrees: string;
const cleanups: Array<() => void> = [];
let counter = 0;

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-worktrees-"));
  forge = createForge({ pool: db.pool, runner: createFakeRunner(), codeHost: createFakeCodeHost(), worktreesRoot: worktrees });
});
afterAll(async () => {
  await forge.whenIdle();
  await drop();
  rmSync(worktrees, { recursive: true, force: true });
});
afterEach(() => cleanups.splice(0).forEach((c) => c()));

async function projectWithRemote() {
  const { repo, remote } = createRepoWithBareRemote({ remote: `git@github.com:acme/wp-${++counter}.git` });
  cleanups.push(repo.cleanup, remote.cleanup);
  const project = await forge.registerProject({ path: repo.path });
  remote.pointOriginAtBare();
  return { project, remote };
}

const HOTFIX = `name: hotfix
description: A quick fix, reviewed at once.
inputs: [task]
steps:
  - id: fix
    type: agent
    agent: developer
  - id: review
    type: gate
    gate: final
    needs: [fix]
    on_reject: fix
`;

describe("the Workflows page data", () => {
  it("gives a built-in Workflow its YAML, its Steps and no override", async () => {
    const { project } = await projectWithRemote();

    const developer = (await forge.listWorkflows(project.id)).workflows.find((w) => w.name === "developer")!;

    expect(developer).toMatchObject({ origin: "built-in", overrides: false, errors: [] });
    expect(developer.yaml).toContain("name: developer");
    expect(developer.steps.length).toBeGreaterThan(0);
    expect(developer.steps[0]).toEqual({ id: expect.any(String), type: expect.any(String), agent: expect.anything(), needs: [], when: null });
  });

  it("gives a Project Workflow its file text and Steps, and flags the one that replaces a built-in", async () => {
    const { project, remote } = await projectWithRemote();
    remote.advance("forgequor/workflows/hotfix.yaml", HOTFIX);
    remote.advance("forgequor/workflows/developer.yaml", HOTFIX.replace("name: hotfix", "name: developer"));

    const listed = new Map((await forge.listWorkflows(project.id)).workflows.map((w) => [w.name, w]));

    expect(listed.get("hotfix")).toMatchObject({ origin: "project", overrides: false, yaml: HOTFIX });
    expect(listed.get("hotfix")!.steps).toEqual([
      { id: "fix", type: "agent", agent: "developer", needs: [], when: null },
      { id: "review", type: "gate", agent: null, needs: ["fix"], when: null },
    ]);
    expect(listed.get("developer")).toMatchObject({ origin: "project", overrides: true });
  });

  it("keeps an invalid Workflow's YAML and errors, with its Steps when it parses", async () => {
    const { project, remote } = await projectWithRemote();
    remote.advance("forgequor/workflows/broken.yaml", "name: broken\ninputs: [task]\nsteps:\n  - id: a\n    type: nonsense\n");
    remote.advance("forgequor/workflows/misnamed.yaml", HOTFIX);

    const listed = new Map((await forge.listWorkflows(project.id)).workflows.map((w) => [w.name, w]));

    expect(listed.get("broken")).toMatchObject({ steps: [], yaml: expect.stringContaining("nonsense") });
    expect(listed.get("broken")!.errors.length).toBeGreaterThan(0);
    expect(listed.get("misnamed")!.errors[0]!.message).toContain("must match");
    expect(listed.get("misnamed")!.steps.map((s) => s.id)).toEqual(["fix", "review"]);
  });
});

describe("validating Workflow YAML", () => {
  it("accepts a launchable Workflow, whatever it is called", async () => {
    expect(await forge.validateWorkflow(HOTFIX)).toEqual({ valid: true, errors: [] });
  });

  it("lists every error, with its place", async () => {
    const text = "name: nope\ninputs: [task]\nsteps:\n  - id: a\n    type: nonsense\n  - id: a\n    type: agent\n    agent: nobody\n";

    const result = await forge.validateWorkflow(text);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
    expect(result.errors[0]).toMatchObject({ line: expect.any(Number), message: expect.any(String) });
  });

  it("refuses what Forgequor cannot launch, as launch does", async () => {
    const result = await forge.validateWorkflow(HOTFIX.replace("[task]", "[task, assets]"));

    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("no way to launch");
  });

  it("answers for a text that is not YAML at all", async () => {
    expect((await forge.validateWorkflow("")).valid).toBe(false);
    expect((await forge.validateWorkflow(": : [")).valid).toBe(false);
  });

  it("refuses an unknown Project and stores nothing", async () => {
    await expect(forge.validateWorkflow(HOTFIX, 999999)).rejects.toThrow("No Project 999999.");
    const { project } = await projectWithRemote();
    expect(await forge.validateWorkflow(HOTFIX, project.id)).toEqual({ valid: true, errors: [] });
    expect((await forge.listWorkflows(project.id)).workflows.map((w) => w.name)).not.toContain("hotfix");
  });
});
