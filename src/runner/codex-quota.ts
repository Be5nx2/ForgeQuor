import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { forgetProcessGroup, killProcessGroup, trackProcessGroup } from "../process-group.js";
import type { QuotaReading, QuotaWindow } from "./runner.js";

const FIVE_HOUR_MINS = 300;
const WEEK_MINS = 10080;

const UNKNOWN: QuotaWindow = { percentUsed: null, resetsAt: null };

function toWindow(w: any): QuotaWindow {
  if (!w || typeof w !== "object") return UNKNOWN;
  const at = typeof w.resetsAt === "number" ? new Date(w.resetsAt * 1000) : null;
  return { percentUsed: typeof w.usedPercent === "number" ? w.usedPercent : null, resetsAt: at && !Number.isNaN(at.getTime()) ? at : null };
}

/**
 * Turns the answer of `account/rateLimits/read` into a reading. The windows are told apart by their length
 * (`windowDurationMins`: 300 is the five-hour one, 10080 the weekly one), not by being primary or secondary. Null when the
 * answer carries no rate limits at all (an error answer, anything unexpected).
 */
export function parseRateLimits(answer: unknown, readAt: Date): QuotaReading | null {
  const limits = (answer as any)?.result?.rateLimits;
  if (!limits || typeof limits !== "object") return null;
  const windows = [limits.primary, limits.secondary];
  const byLength = (mins: number) => toWindow(windows.find((w) => w && typeof w === "object" && w.windowDurationMins === mins));
  const fiveHour = byLength(FIVE_HOUR_MINS);
  const weekly = byLength(WEEK_MINS);
  const exhausted = Boolean(limits.rateLimitReachedType) || (fiveHour.percentUsed ?? 0) >= 100 || (weekly.percentUsed ?? 0) >= 100;
  return { fiveHour, weekly, exhausted, readAt };
}

export interface AppServerCall {
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}

/**
 * Asks `codex app-server` for the account's rate limits (JSON-RPC, one message per line): `initialize`, then, once that is
 * answered, `initialized` and `account/rateLimits/read`. It calls no model, so it costs no Quota. Resolves with the answer
 * to the read, or rejects when the server cannot start, ends, answers too late, or answers the handshake with an error. The
 * process is always ended.
 */
export function readRateLimits({ env, timeoutMs }: AppServerCall): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server"], { cwd: tmpdir(), env: env ?? process.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    trackProcessGroup(child.pid);
    let buffer = "";
    let stderr = "";
    let done = false;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killProcessGroup(child.pid);
      forgetProcessGroup(child.pid);
      settle();
    };
    const fail = (message: string) => finish(() => reject(new Error(message)));
    const timer = setTimeout(() => fail(`codex app-server did not answer within ${timeoutMs} ms`), timeoutMs);
    const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);

    child.on("error", (e: NodeJS.ErrnoException) => fail(e.code === "ENOENT" ? "codex CLI not found on PATH" : `could not start codex app-server: ${e.message}`));
    child.on("close", (code, signal) => fail(`codex app-server ended (${signal ?? `code ${code}`}) before answering${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const text = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let msg: any;
        try {
          msg = JSON.parse(text);
        } catch {
          continue; // not a protocol line
        }
        if (msg?.id === 0) {
          if (msg.error) return fail(`codex app-server refused to initialize: ${msg.error.message ?? "unknown error"}`);
          send({ method: "initialized", params: {} });
          send({ method: "account/rateLimits/read", id: 1 });
        } else if (msg?.id === 1) {
          return finish(() => resolve(msg));
        }
      }
    });

    send({ method: "initialize", id: 0, params: { clientInfo: { name: "forgequor", version: "1.0" } } });
  });
}
