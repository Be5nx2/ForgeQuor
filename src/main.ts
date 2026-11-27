import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGhCodeHost } from "./codehost/gh.js";
import { createForge } from "./forge/forge.js";
import { createClaudeRunner } from "./runner/claude.js";
import { createCodexRunner } from "./runner/codex.js";
import { createServer } from "./http/server.js";
import { killAllProcessGroups } from "./process-group.js";
import { seatSettingsFromEnv } from "./forge/seats.js";
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

/** A setting in minutes as milliseconds; unset leaves the default, and a bad value is refused. */
function minutesAsMs(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.error(`${name} must be a positive number of minutes, got "${raw}".`);
    process.exit(1);
  }
  return minutes * 60_000;
}

const forge = createForge({
  pool,
  runner: createClaudeRunner(),
  artistRunner: createCodexRunner(),
  codeHost: createGhCodeHost(),
  worktreesRoot: process.env.FORGEQUOR_WORKTREES ?? join(homedir(), ".forgequor", "worktrees"),
  // FORGEQUOR_<SEAT>_RUNNER and FORGEQUOR_<SEAT>_MODEL per Agent seat, such as FORGEQUOR_DEVELOPER_MODEL or FORGEQUOR_REVIEWER_B_RUNNER.
  seats: seatSettingsFromEnv(process.env),
  stepTimeoutMs: minutesAsMs("FORGEQUOR_STEP_TIMEOUT_MINUTES"),
  checkTimeoutMs: minutesAsMs("FORGEQUOR_CHECK_TIMEOUT_MINUTES"),
});
const POLL_MS = Number(process.env.FORGEQUOR_PR_POLL_SECONDS ?? 60) * 1000;
// Runs that were Running restart their Step, Queued Runs start, Approved Runs are followed again.
forge.recoverAfterRestart().catch((e) => console.error("Recovery after restart failed:", e));
// Claude's Quota is read now and every 5 minutes (and after each of its Steps), at no cost to it.
forge.startQuotaReading().catch((e) => console.error("Reading the Quota failed:", e));
setInterval(() => {
  forge.checkPullRequests().catch((e) => console.error("Pull request check failed:", e));
  forge.resumePausedRuns().catch((e) => console.error("Resuming Paused Runs failed:", e));
}, POLL_MS).unref();
const app = await createServer({ forge, tools, webRoot: `${root}web/dist` });
await app.listen({ host: "127.0.0.1", port });
console.log(`Forgequor on http://127.0.0.1:${port}`);

// Agents and Checks run in their own process groups, so they would outlive Forgequor: end them with it.
process.on("exit", killAllProcessGroups);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
