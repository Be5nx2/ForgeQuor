import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createForge, type Forge } from "../../src/forge/forge.js";
import { createTestDatabase } from "../harness/database.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { createFakeRunner } from "../harness/fake-runner.js";
import { createRepoWithBareRemote } from "../harness/git.js";

/** The `/to-workflow` Skill's reference describes exactly what this Forgequor has code for. */

const reference = readFileSync(new URL("../../skills/shared/to-workflow/REFERENCE.md", import.meta.url), "utf8");

/** The body of a `## title` section. */
const sectionBody = (title: string) => reference.split(/^## /m).find((s) => s.startsWith(`${title}\n`)) ?? "";
/** The `### \`name\`` headings under a `## title` section, with the text under each. */
function headings(title: string): Map<string, string> {
  return new Map(sectionBody(title).split(/^### /m).slice(1).map((s) => [s.match(/^`([^`]+)`/)![1]!, s]));
}
/** The backticked names that start the bullets under a `## title` section. */
const bullets = (title: string) => [...sectionBody(title).matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]!);

let forge: Forge;
let drop: () => Promise<void>;
let worktrees: string;
let cleanup: () => void;
let projectId: number;

beforeAll(async () => {
  const db = await createTestDatabase();
  drop = db.drop;
  worktrees = mkdtempSync(join(tmpdir(), "forgequor-worktrees-"));
  forge = createForge({ pool: db.pool, runner: createFakeRunner(), codeHost: createFakeCodeHost(), worktreesRoot: worktrees });
  const { repo, remote } = createRepoWithBareRemote({ remote: "git@github.com:acme/skill-ref.git" });
  cleanup = () => (repo.cleanup(), remote.cleanup());
  const project = await forge.registerProject({ path: repo.path });
  remote.pointOriginAtBare();
  projectId = project.id;
});
afterAll(async () => {
  await forge.whenIdle();
  cleanup();
  await drop();
  rmSync(worktrees, { recursive: true, force: true });
});

/** What validation says a place accepts, read from the "must be one of a, b" part of the error that mentions it. */
async function allowed(step: string, mention: RegExp): Promise<string[]> {
  const { errors } = await forge.validateWorkflow(`name: probe\ninputs: [task]\nsteps:\n  - id: s\n${step}`);
  const message = errors.map((e) => e.message).find((m) => mention.test(m)) ?? "";
  const names = message.match(/one of (.*?)\.?$/)?.[1] ?? "";
  return names.split(", ").filter(Boolean).sort();
}

describe("the to-workflow reference", () => {
  it("names exactly the Step types Forgequor has", async () => {
    const real = await allowed("    type: nope", /unknown type/);
    expect(real.length).toBeGreaterThan(0);
    expect([...headings("Step types").keys()].sort()).toEqual(real);
  });

  it("names exactly the Agents, conversation Agents and Gate kinds Forgequor has", async () => {
    const agents = await allowed("    type: agent\n    agent: nope", /unknown Agent/);
    const conversations = await allowed("    type: conversation\n    agent: nope", /unknown Agent/);
    const gates = await allowed("    type: gate\n    gate: nope", /unknown Gate kind/);
    expect([agents.length, conversations.length, gates.length].every((n) => n > 0)).toBe(true);
    expect(bullets("Agents").sort()).toEqual(agents);
    expect(bullets("Conversation Agents").sort()).toEqual(conversations);
    expect(bullets("Gate kinds").sort()).toEqual(gates);
  });

  it("lists exactly the built-in Workflows, with their inputs", async () => {
    const real = (await forge.listWorkflows(projectId)).workflows.filter((w) => w.origin === "built-in");
    const documented = headings("Built-in Workflows");
    expect([...documented.keys()].sort()).toEqual(real.map((w) => w.name).sort());
    for (const w of real) expect(documented.get(w.name)).toContain(`Inputs: ${w.inputs.join(", ")}.`);
  });
});
