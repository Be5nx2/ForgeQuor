import { mkdirSync, realpathSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createForge, type Forge } from "../../src/forge/forge.js";
import { createTempFolder, createTempRepo, type TempRepo } from "../harness/git.js";
import { createTestDatabase } from "../harness/database.js";

let forge: Forge;
let drop: () => Promise<void>;
const temps: TempRepo[] = [];

function track(t: TempRepo): string {
  temps.push(t);
  return t.path;
}

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  forge = createForge({ pool: db.pool });
});
afterAll(async () => drop());
afterEach(() => temps.splice(0).forEach((t) => t.cleanup()));

describe("registering a Project", () => {
  it("reads the GitHub remote and default branch from a local repo", async () => {
    const path = track(createTempRepo({ remote: "git@github.com:acme/space-game.git" }));

    const project = await forge.registerProject({ path });

    expect(project).toMatchObject({
      name: "space-game",
      remoteOwner: "acme",
      remoteName: "space-game",
      defaultBranch: "main",
      maxConcurrentRuns: 2,
      checks: [],
    });
  });

  it("understands https remotes, with or without .git", async () => {
    const a = track(createTempRepo({ remote: "https://github.com/acme/one.git" }));
    const b = track(createTempRepo({ remote: "https://github.com/acme/two" }));

    expect(await forge.registerProject({ path: a })).toMatchObject({ remoteOwner: "acme", remoteName: "one" });
    expect(await forge.registerProject({ path: b })).toMatchObject({ remoteOwner: "acme", remoteName: "two" });
  });

  it("lists registered Projects", async () => {
    const before = (await forge.listProjects()).length;
    const path = track(createTempRepo({ remote: "git@github.com:acme/listed.git" }));

    await forge.registerProject({ path });

    const names = (await forge.listProjects()).map((p) => p.name);
    expect(names).toHaveLength(before + 1);
    expect(names).toContain("listed");
  });

  it("refuses a folder that is not a git repository", async () => {
    const path = track(createTempFolder());

    await expect(forge.registerProject({ path })).rejects.toThrow(/not a git repository/i);
  });

  it("refuses a path that does not exist", async () => {
    await expect(forge.registerProject({ path: "/nonexistent/forgequor" })).rejects.toThrow(/does not exist/i);
  });

  it("refuses a repository without a GitHub remote", async () => {
    const noRemote = track(createTempRepo());
    const otherHost = track(createTempRepo({ remote: "git@gitlab.com:acme/game.git" }));

    await expect(forge.registerProject({ path: noRemote })).rejects.toThrow(/no github remote/i);
    await expect(forge.registerProject({ path: otherHost })).rejects.toThrow(/not a github remote/i);
  });

  it("refuses to register the same repository twice", async () => {
    const path = track(createTempRepo({ remote: "git@github.com:acme/dup.git" }));
    await forge.registerProject({ path });

    await expect(forge.registerProject({ path })).rejects.toThrow(/already registered/i);
  });

  it("registers a repository from one of its subfolders as its root", async () => {
    const path = track(createTempRepo({ remote: "git@github.com:acme/root.git" }));
    mkdirSync(`${path}/sub`);

    const project = await forge.registerProject({ path: `${path}/sub` });

    expect(project.localPath).toBe(realpathSync(path));
  });
});
