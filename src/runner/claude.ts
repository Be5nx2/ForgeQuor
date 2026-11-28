import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { parseUsage, unknownReading } from "./claude-usage.js";
import { runCli } from "./process.js";
import type { QuotaReading, QuotaWindow, Runner, RunnerEvent, StepRequest, StepResult } from "./runner.js";

export interface ClaudeRunnerOptions {
  /** Environment for the subprocess (defaults to the current one). */
  env?: NodeJS.ProcessEnv;
  /** The clock that stamps a Quota Reading. Default: the real time. */
  now?: () => Date;
}

/** How long `/usage` may take before it is given up on (it answers without calling a model). */
const USAGE_TIMEOUT_MS = 30_000;

/**
 * What the stream's `rate_limit_event`s said about the Quota: the five-hour and weekly windows' reset times they named,
 * and whether any was rejected. Null when there were none.
 */
function partialReading(infos: Map<string, any>, readAt: Date): QuotaReading | null {
  if (infos.size === 0) return null;
  const window = (info: any): QuotaWindow => ({ percentUsed: null, resetsAt: fromEpochSeconds(info?.resetsAt) });
  const weekly = [...infos].find(([type]) => /^seven_day/.test(type))?.[1];
  return { fiveHour: window(infos.get("five_hour")), weekly: window(weekly), exhausted: [...infos.values()].some((i) => i?.status === "rejected"), readAt };
}

/** Claude Code tools that block on a human, which a headless Step cannot have. */
const HUMAN_WAIT_TOOLS = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"];

/** One or more events for a line; only the first carries `raw`, so the log never repeats a line. */
function toEvents(msg: any, raw: string): RunnerEvent[] {
  const events: RunnerEvent[] = [];
  if (msg?.type === "assistant") {
    for (const block of msg.message?.content ?? []) {
      if (block.type === "text") events.push({ kind: "text", summary: block.text, raw: "" });
      else if (block.type === "tool_use") events.push({ kind: "tool", summary: block.name, raw: "" });
    }
  }
  if (events.length === 0) {
    const label = msg ? [msg.type, msg.subtype].filter(Boolean).join(" ") : "unreadable line";
    events.push({ kind: "other", summary: label, raw: "" });
  }
  events[0]!.raw = raw;
  return events;
}

// Wording of the CLI's limit messages ("5-hour limit reached", "Claude AI usage limit reached|<epoch>").
const QUOTA_TEXT = /\b(usage|hour|weekly|session) limit/i;

function fromEpochSeconds(n: unknown): Date | null {
  return typeof n === "number" && Number.isFinite(n) ? new Date(n * 1000) : null;
}

/** Decides how a Step ended from what the CLI printed and how the process exited. */
const SESSION_MISSING = /no conversation found/i;

function interpret(final: any, rateLimit: any, exit: { code: number | null; signal: NodeJS.Signals | null; stderr: string }, session?: string): StepResult {
  const text = typeof final?.result === "string" ? final.result : "";
  const completed = final && !final.is_error;
  if (!completed && (rateLimit?.status === "rejected" || (final?.is_error && QUOTA_TEXT.test(text)))) {
    const legacy = /\|(\d{9,})\s*$/.exec(text);
    const resetsAt = fromEpochSeconds(rateLimit?.resetsAt) ?? fromEpochSeconds(legacy ? Number(legacy[1]) : undefined);
    return { status: "quota_exhausted", resetsAt };
  }
  if (!final) {
    const detail = exit.stderr.trim();
    if (exit.signal) return { status: "failed", error: `claude was killed by ${exit.signal}${detail ? `: ${detail}` : ""}` };
    if (session && SESSION_MISSING.test(exit.stderr)) return { status: "failed", error: detail, sessionLost: true };
    return exit.code
      ? { status: "failed", error: `claude exited with code ${exit.code}${detail ? `: ${detail}` : ""}` }
      : { status: "failed", error: "claude produced unreadable output: no result message" };
  }
  if (final.is_error) {
    const errors = Array.isArray(final.errors) ? final.errors.join("\n") : "";
    const error = text || errors || `claude reported ${final.subtype ?? "an error"}`;
    return session && SESSION_MISSING.test(`${errors}\n${text}\n${exit.stderr}`) ? { status: "failed", error, sessionLost: true } : { status: "failed", error };
  }
  return session ? { status: "succeeded", summary: text, sessionId: typeof final.session_id === "string" ? final.session_id : session } : { status: "succeeded", summary: text };
}

/** Drives `claude` headless (stream-json) in the Step's directory, on the user's subscription. */
export function createClaudeRunner(options: ClaudeRunnerOptions = {}): Runner {
  const now = options.now ?? (() => new Date());
  return {
    async readQuota() {
      // `/usage` is answered by the CLI itself: no model is called, so it costs no Quota.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), USAGE_TIMEOUT_MS);
      const lines: string[] = [];
      try {
        const outcome = await runCli({ command: "claude", args: ["-p", "/usage", "--output-format", "json"], cwd: tmpdir(), env: options.env, stdin: "", signal: abort.signal }, (l) => lines.push(l));
        if (!outcome.ran) return null;
      } finally {
        clearTimeout(timer);
      }
      const readAt = now();
      try {
        const text = JSON.parse(lines.join("\n")).result;
        return typeof text === "string" ? parseUsage(text, readAt) : unknownReading(readAt);
      } catch {
        return unknownReading(readAt);
      }
    },

    async run(step: StepRequest, onEvent): Promise<StepResult> {
      // The Agent must edit files and run git unattended, so permission prompts are off.
      // It is confined only by the Run's worktree (ADR 0005).
      // Only a Step that asked for a session leaves one behind for the CLI to resume; the others are forgotten.
      const session = step.session ? ("resume" in step.session ? step.session.resume : randomUUID()) : undefined;
      const sessionArgs = !step.session ? ["--no-session-persistence"] : "resume" in step.session ? ["--resume", session!] : ["--session-id", session!];
      const args = [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        ...sessionArgs,
        "--permission-mode", "bypassPermissions",
        // No human is there to answer: these tools would wait forever.
        "--disallowedTools", HUMAN_WAIT_TOOLS.join(" "),
        "--append-system-prompt", step.instructions,
      ];
      if (step.model) args.push("--model", step.model);
      if (step.effort) args.push("--effort", step.effort);

      let final: any = null;
      let rateLimit: any = null;
      const rateLimits = new Map<string, any>();
      const outcome = await runCli({ command: "claude", args, cwd: step.cwd, env: options.env, stdin: step.prompt, signal: step.signal }, (text) => {
        if (!text.trim()) return;
        let msg: any = null;
        try { msg = JSON.parse(text); } catch { /* kept as an unreadable-line event */ }
        for (const e of toEvents(msg, text)) {
          try { onEvent(e); } catch { /* a buggy listener must not break the Step */ }
        }
        if (msg?.type === "result") final = msg;
        if (msg?.type === "rate_limit_event") {
          rateLimit = msg.rate_limit_info;
          if (typeof rateLimit?.rateLimitType === "string") rateLimits.set(rateLimit.rateLimitType, rateLimit);
        }
      });
      if (!outcome.ran) return { status: "failed", error: outcome.error };
      const result = interpret(final, rateLimit, outcome, session);
      const quota = partialReading(rateLimits, now());
      return quota ? { ...result, quota } : result;
    },
  };
}
