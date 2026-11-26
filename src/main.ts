import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createForge } from "./forge/forge.js";
import { createClaudeRunner } from "./runner/claude.js";
import { createServer } from "./http/server.js";
import { loadEnvFile } from "./startup/env.js";
import { checkTools } from "./startup/preflight.js";
import { createPool, DEFAULT_DATABASE_URL, migrate } from "./store/db.js";

const root = fileURLToPath(new URL("..", import.meta.url));
if (loadEnvFile(root)) console.log("Settings read from .env");
const databaseUrl = process.env.FORGEQUOR_DATABASE_URL ?? DEFAULT_DATABASE_URL;
const port = Number(process.env.FORGEQUOR_PORT ?? 4170);

console.log("Starting PostgreSQL (docker compose)...");
try {
  execFileSync("docker", ["compose", "up", "-d", "--wait", "postgres"], { cwd: root, stdio: "inherit" });
} catch {
  console.error("Could not start PostgreSQL: is Docker (OrbStack) installed and running?");
  process.exit(1);
}

console.log("Building the UI...");
execFileSync("npm", ["run", "build:web", "--silent"], { cwd: root, stdio: "inherit" });

const pool = createPool(databaseUrl);
const applied = await migrate(pool);
console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Database up to date.");

const tools = await checkTools();
for (const t of tools) console.log(`${t.status === "ok" ? "✓" : "✗"} ${t.tool}: ${t.detail}`);

const forge = createForge({
  pool,
  runner: createClaudeRunner(),
  worktreesRoot: process.env.FORGEQUOR_WORKTREES ?? join(homedir(), ".forgequor", "worktrees"),
  developerModel: process.env.FORGEQUOR_DEVELOPER_MODEL,
});
const app = await createServer({ forge, tools, webRoot: `${root}web/dist` });
await app.listen({ host: "127.0.0.1", port });
console.log(`Forgequor on http://127.0.0.1:${port}`);
