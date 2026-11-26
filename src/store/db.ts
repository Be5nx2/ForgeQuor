import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const DEFAULT_DATABASE_URL = "postgres://forgequor:forgequor@localhost:5433/forgequor";

const MIGRATIONS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "migrations");

/** Pool whose connections all use `schema` (default: `public`). */
export function createPool(url: string, schema = "public"): pg.Pool {
  return new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
}

/** Applies pending SQL migrations in filename order, each in a transaction. */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  );
  const done = new Set((await pool.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  return applied;
}
