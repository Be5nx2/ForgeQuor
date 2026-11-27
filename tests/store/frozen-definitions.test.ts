import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBuiltInWorkflow } from "../../src/forge/workflow-definition.js";
import { createPool, DEFAULT_DATABASE_URL, migrate } from "../../src/store/db.js";

const url = process.env.FORGEQUOR_DATABASE_URL ?? DEFAULT_DATABASE_URL;
const MIGRATIONS = fileURLToPath(new URL("../../src/store/migrations/", import.meta.url));

describe("Runs created before Workflows were frozen", () => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = createPool(url, schema);
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it("get the built-in definition of their Workflow, as the YAML says, when the migration runs", async () => {
    // The database as it was before M3a: every migration up to the one that freezes definitions.
    await pool.query("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f < "017").sort()) {
      await pool.query(readFileSync(join(MIGRATIONS, file), "utf8"));
      await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    }
    const { rows: project } = await pool.query(
      "INSERT INTO projects (name, local_path, remote_owner, remote_name, default_branch) VALUES ('game', '/tmp/game', 'acme', 'game', 'main') RETURNING id",
    );
    const insert = (workflow: string) =>
      pool.query("INSERT INTO runs (project_id, workflow, title, task, state) VALUES ($1, $2, 'Old', 'Old task', 'merged') RETURNING id", [project[0].id, workflow]);
    const developer = (await insert("developer")).rows[0].id;
    const assets = (await insert("assets")).rows[0].id;

    expect(await migrate(pool)).toEqual(["017_workflow_engine.sql"]);

    const { rows } = await pool.query("SELECT id, definition, inputs FROM runs");
    const of = (id: string) => rows.find((r) => r.id === id)!;
    expect(of(developer).definition).toEqual(loadBuiltInWorkflow("developer"));
    expect(of(developer).inputs).toEqual(["task"]);
    expect(of(assets).definition).toEqual(loadBuiltInWorkflow("assets"));
    expect(of(assets).inputs).toEqual(["assets"]);
  });
});
