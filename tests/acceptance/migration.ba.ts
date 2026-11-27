import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { createForge } from "../../src/forge/forge.js";
import { createPool, migrate } from "../../src/store/db.js";
import { createFakeCodeHost } from "../harness/fake-codehost.js";
import { databaseUrl, resetDatabase, ROOT } from "./harness.js";

/**
 * Upgrading the human's real database: a copy of it (never the original) is migrated to the current code, then every
 * Run is read back through the Forge interface. Nothing runs: no recovery, no Agent, no GitHub.
 */

const SOURCE = process.env.BA_SOURCE_DATABASE ?? "forgequor";
const COPY = "forgequor_ba_migration";

describe("upgrading a copy of the real database", () => {
  const pool = createPool(databaseUrl(COPY));

  afterAll(async () => {
    await pool.end();
  });

  it("migrates without error and reads back every Run with its frozen Steps", async () => {
    await resetDatabase(COPY);
    const dump = execFileSync("docker", ["compose", "exec", "-T", "postgres", "pg_dump", "-U", "forgequor", "--no-owner", SOURCE], { cwd: ROOT, maxBuffer: 1 << 28 });
    execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-q", "-v", "ON_ERROR_STOP=1", "-U", "forgequor", "-d", COPY], { cwd: ROOT, input: dump, stdio: ["pipe", "ignore", "inherit"] });

    const applied = await migrate(pool);
    console.log(`Migrations applied to the copy: ${applied.join(", ") || "none"}`);

    const forge = createForge({
      pool,
      runner: { run: async () => ({ status: "failed", error: "BA: no Agent runs here" }) } as any,
      codeHost: createFakeCodeHost(),
      worktreesRoot: "/nonexistent",
    });
    const runs = await forge.listRuns();
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) {
      const detail = await forge.getRun(r.id);
      expect(detail.steps.length, `Run ${r.id} (${r.workflow}, ${r.state}) has Steps`).toBeGreaterThan(0);
      console.log(`Run ${r.id} ${r.workflow} ${r.state}: ${detail.steps.map((s) => `${s.id}:${s.status}`).join(" ")}`);
      // A Run whose pull request was opened went through every Step: none of them should still read "waiting".
      if (["approved", "merged", "closed"].includes(r.state)) {
        expect.soft(detail.steps.filter((s) => s.status === "waiting").map((s) => s.id), `finished Run ${r.id} shows Steps still waiting`).toEqual([]);
      }
    }
    const definitions = await pool.query("SELECT id FROM runs WHERE definition IS NULL");
    expect(definitions.rows.map((x) => x.id)).toEqual([]);
    const approved = await forge.listApprovedRuns();
    expect(approved.map((r) => r.id).sort()).toEqual(runs.filter((r) => r.state === "approved").map((r) => r.id).sort());
    await forge.listOpenGates();
    for (const p of await forge.listProjects()) expect(p.maxConcurrentRuns).toBeGreaterThan(0);
  }, 120_000);
});

