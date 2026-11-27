import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Gate, Project, RunDetail } from "../../src/forge/types.js";

/**
 * Acceptance (BA) harness: a real Forgequor started as a black box on its own database, port and worktree folder,
 * driven only through its HTTP API, against the real sandbox GitHub repository, with real Agents on a cheap model.
 */

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ADMIN_URL = "postgres://forgequor:forgequor@localhost:5433/postgres";
export const BA_DB = process.env.BA_DATABASE ?? "forgequor_ba";
export const BA_PORT = Number(process.env.BA_PORT ?? 4180);
export const BASE = `http://127.0.0.1:${BA_PORT}`;
/** Unique per BA run, so files and branches never collide with an earlier run. */
export const STAMP = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

export function sandboxRepo(): string {
  const repo = process.env.FORGEQUOR_SMOKE_REPO;
  if (!repo) throw new Error("Set FORGEQUOR_SMOKE_REPO=owner/name (in .env) to the sandbox repository.");
  return repo;
}

export async function resetDatabase(name: string): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
}

export function databaseUrl(name: string): string {
  return `postgres://forgequor:forgequor@localhost:5433/${name}`;
}

export interface App {
  process: ChildProcess;
  log: string[];
  worktrees: string;
  stop(): Promise<void>;
}

/**
 * Every Claude seat on the cheap model (BA_MODEL, default haiku). The second Reviewer defaults to Codex; unless BA_CODEX=1
 * the BA moves it to Claude too, so a run costs no Codex Quota. The Artist stays on Codex (it is only used with BA_ASSETS).
 */
function claudeSeats(): Record<string, string> {
  const model = process.env.BA_MODEL ?? "haiku";
  const seats = ["griller", "spec-writer", "architect", "developer", "reviewer-a", "consolidator"];
  const env: Record<string, string> = {};
  for (const seat of seats) env[`FORGEQUOR_${seat.toUpperCase().replace(/-/g, "_")}_MODEL`] = model;
  if (!process.env.BA_CODEX) {
    env.FORGEQUOR_REVIEWER_B_RUNNER = "claude";
    env.FORGEQUOR_REVIEWER_B_MODEL = model;
  }
  return env;
}

/** Starts Forgequor (`src/main.ts`, unchanged) with the BA settings and waits until its API answers. */
export async function startApp(): Promise<App> {
  const worktrees = mkdtempSync(join(tmpdir(), "forgequor-ba-worktrees-"));
  const log: string[] = [];
  const child = spawn(join(ROOT, "node_modules/.bin/tsx"), ["src/main.ts"], {
    cwd: ROOT,
    detached: true,
    env: {
      ...process.env,
      FORGEQUOR_DATABASE_URL: databaseUrl(BA_DB),
      FORGEQUOR_PORT: String(BA_PORT),
      FORGEQUOR_WORKTREES: worktrees,
      FORGEQUOR_PR_POLL_SECONDS: "5",
      ...claudeSeats(),
      FORGEQUOR_STEP_TIMEOUT_MINUTES: "15",
      FORGEQUOR_CHECK_TIMEOUT_MINUTES: "2",
    },
  });
  child.stdout?.on("data", (d) => log.push(String(d)));
  child.stderr?.on("data", (d) => log.push(String(d)));
  await waitFor("Forgequor answers", 180_000, async () => (await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)) || null, 1000);
  return {
    process: child,
    log,
    worktrees,
    async stop() {
      if (child.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
        await new Promise((r) => setTimeout(r, 2000));
      }
    },
  };
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, body: parsed };
}

/** Like `api`, but fails on any status that is not 2xx. */
export async function ok<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await api<T>(method, path, body);
  if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

export const getRun = (id: number) => ok<RunDetail>("GET", `/api/runs/${id}`);

/** Polls `probe` until it returns something other than null, or fails after `timeoutMs` with what it last saw. */
export async function waitFor<T>(label: string, timeoutMs: number, probe: () => Promise<T | null>, everyMs = 3000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await probe();
      if (v !== null && v !== undefined) return v;
    } catch (e) {
      if (e instanceof FatalWait) throw e;
      last = e;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`Timed out waiting for: ${label}${last ? ` (last error: ${last})` : ""}`);
}

/** Waits until the Run is in `state` (and, if given, `extra` holds), failing early if it ends up somewhere unexpected. */
export async function waitForState(id: number, state: RunDetail["state"], timeoutMs = 15 * 60_000, extra?: (r: RunDetail) => boolean): Promise<RunDetail> {
  return waitFor(`Run ${id} ${state}`, timeoutMs, async () => {
    const run = await getRun(id);
    if (run.state === state && (!extra || extra(run))) return run;
    const dead: RunDetail["state"][] = ["abandoned", "closed", "merged"];
    if (dead.includes(run.state) && !dead.includes(state)) throw new FatalWait(`Run ${id} is ${run.state}, expected ${state}`);
    if (run.state === "waiting" && state !== "waiting") {
      const open = openGate(run);
      if (open?.kind === "escalation") throw new FatalWait(`Run ${id} escalated: ${open.reason} ${open.evidence ?? ""}`);
    }
    return null;
  });
}

/** Thrown from a `waitFor` probe to stop waiting at once (an Escalation, a Run that ended elsewhere). */
export class FatalWait extends Error {}

export function openGate(run: RunDetail): Gate | undefined {
  return run.gates.find((g) => !g.decidedAt);
}

export const stepLine = (run: RunDetail) => run.steps.map((s) => `${s.id}:${s.status}:${s.attempts}`).join(" ");

export function gh(...args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8" }).trim();
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A fresh clone of the sandbox, for registering as a Project or pushing to its default branch. */
export function cloneSandbox(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `forgequor-ba-${label}-`));
  execFileSync("gh", ["repo", "clone", sandboxRepo(), dir, "--", "-q"]);
  return dir;
}

/** Commits `files` (path → content, null to delete) on the sandbox's default branch and pushes them. */
export function pushToSandbox(clone: string, message: string, files: Record<string, string | null>): void {
  git(clone, "pull", "-q", "--ff-only");
  for (const [path, content] of Object.entries(files)) {
    const full = join(clone, path);
    if (content === null) {
      try {
        git(clone, "rm", "-q", "-r", "--ignore-unmatch", path);
      } catch {}
    } else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      git(clone, "add", path);
    }
  }
  if (!git(clone, "status", "--porcelain")) return;
  git(clone, "commit", "-q", "-m", message);
  git(clone, "push", "-q");
}

export function prState(prNumber: number): string {
  return gh("pr", "view", String(prNumber), "-R", sandboxRepo(), "--json", "state", "-q", ".state");
}

export async function registerProject(path: string, settings: { checks: string[]; max: number }): Promise<Project> {
  const project = await ok<Project>("POST", "/api/projects", { path });
  await ok("PUT", `/api/projects/${project.id}/checks`, { checks: settings.checks });
  return ok<Project>("PUT", `/api/projects/${project.id}/concurrency`, { max: settings.max });
}
