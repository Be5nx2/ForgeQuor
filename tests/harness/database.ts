import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPool, DEFAULT_DATABASE_URL, migrate } from "../../src/store/db.js";

const url = process.env.FORGEQUOR_DATABASE_URL ?? DEFAULT_DATABASE_URL;

/** A migrated, isolated schema on the real PostgreSQL. Call `drop()` when done. */
export async function createTestDatabase(): Promise<{ pool: pg.Pool; drop: () => Promise<void> }> {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = createPool(url, schema);
  await migrate(pool);
  return {
    pool,
    drop: async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}
