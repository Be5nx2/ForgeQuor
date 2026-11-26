import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { forgetProcessGroup, killProcessGroup, trackProcessGroup } from "../process-group.js";
import type { Runner, RunnerEvent, StepRequest, StepResult } from "./runner.js";

export interface ClaudeRunnerOptions {
  /** Environment for the subprocess (defaults to the current one). */
  env?: NodeJS.ProcessEnv;
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
function interpret(final: any, rateLimit: any, exit: { code: number | null; signal: NodeJS.Signals | null; stderr: string }): StepResult {
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
    return exit.code
      ? { status: "failed", error: `claude exited with code ${exit.code}${detail ? `: ${detail}` : ""}` }
      : { status: "failed", error: "claude produced unreadable output: no result message" };
  }
  if (final.is_error) return { status: "failed", error: text || `claude reported ${final.subtype ?? "an error"}` };
  return { status: "succeeded", summary: text };
}

/** Drives `claude` headless (stream-json) in the Step's directory, on the user's subscription. */
export function createClaudeRunner(options: ClaudeRunnerOptions = {}): Runner {
  return {
    run(step: StepRequest, onEvent): Promise<StepResult> {
      return new Promise((resolve) => {
        if (!existsSync(step.cwd)) {
          resolve({ status: "failed", error: `working directory does not exist: ${step.cwd}` });
          return;
        }
        // The Agent must edit files and run git unattended, so permission prompts are off.
        // It is confined only by the Run's worktree (ADR 0002: no sandbox in v1).
        const args = [
          "-p",
          "--output-format", "stream-json",
          "--verbose",
          "--no-session-persistence",
          "--permission-mode", "bypassPermissions",
          // No human is there to answer: these tools would wait forever.
          "--disallowedTools", HUMAN_WAIT_TOOLS.join(" "),
          "--append-system-prompt", step.instructions,
        ];
        if (step.model) args.push("--model", step.model);

        if (step.signal?.aborted) {
          resolve({ status: "failed", error: "the Step was cancelled before it started" });
          return;
        }
        // Its own process group, so a cancel can end claude and every tool it started in one go.
        const child = spawn("claude", args, { cwd: step.cwd, env: options.env ?? process.env, detached: true });
        trackProcessGroup(child.pid);
        const cancel = () => killProcessGroup(child.pid);
        step.signal?.addEventListener("abort", cancel, { once: true });
        let buffer = "";
        let final: any = null;
        let rateLimit: any = null;
        let stderr = "";
        let settled = false;
        const finish = (r: StepResult) => { if (!settled) { settled = true; resolve(r); } };

        const handleLine = (text: string) => {
          if (!text.trim()) return;
          let msg: any = null;
          try { msg = JSON.parse(text); } catch { /* kept as an unreadable-line event */ }
          for (const e of toEvents(msg, text)) {
            try { onEvent(e); } catch { /* a buggy listener must not break the Step */ }
          }
          if (msg?.type === "result") final = msg;
          if (msg?.type === "rate_limit_event") rateLimit = msg.rate_limit_info;
        };

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          buffer += chunk;
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            handleLine(buffer.slice(0, nl));
            buffer = buffer.slice(nl + 1);
          }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", (e: NodeJS.ErrnoException) =>
          finish({ status: "failed", error: e.code === "ENOENT" ? "claude CLI not found on PATH" : `could not start claude: ${e.message}` }));
        child.on("close", (code, signal) => {
          step.signal?.removeEventListener("abort", cancel);
          forgetProcessGroup(child.pid);
          handleLine(buffer);
          finish(interpret(final, rateLimit, { code, signal, stderr }));
        });
        child.stdin.on("error", () => {});
        child.stdin.end(step.prompt);
      });
    },
  };
}
