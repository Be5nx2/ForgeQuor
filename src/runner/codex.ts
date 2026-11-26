import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCli } from "./process.js";
import type { Runner, RunnerEvent, StepRequest, StepResult } from "./runner.js";

export interface CodexRunnerOptions {
  /** Environment for the subprocess (defaults to the current one). `CODEX_HOME` is honoured. */
  env?: NodeJS.ProcessEnv;
}

/** Wording of Codex's limit messages ("You've hit your usage limit", an image tool failing for its limit). */
const QUOTA_TEXT = /\b(usage|image generation) limit/i;

/** Item types that are Codex doing work (as opposed to talking). */
const WORK_ITEMS = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);

/** One event for a line of Codex's JSON stream. */
function toEvent(msg: any, raw: string): RunnerEvent {
  if (msg?.type === "item.completed" && msg.item?.type === "agent_message") {
    return { kind: "text", summary: String(msg.item.text ?? ""), raw };
  }
  if (msg?.type === "item.started" && WORK_ITEMS.has(msg.item?.type)) {
    return { kind: "tool", summary: msg.item.command ? `${msg.item.type}: ${msg.item.command}` : msg.item.type, raw };
  }
  const label = msg ? [msg.type, msg.item?.type].filter(Boolean).join(" ") : "unreadable line";
  return { kind: "other", summary: label, raw };
}

/** When the human can try again, from a limit message ("try again at Nov 28th, 2026 3:45 PM"); null when it says none we can read. */
function retryTime(text: string): Date | null {
  const m = /try again at ([^.]*?\d{1,2}:\d{2}[^.]*?)\.?\s*$/i.exec(text.trim());
  if (!m) return null;
  const at = new Date(m[1]!.replace(/(\d)(st|nd|rd|th)\b/g, "$1"));
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The images Codex generated in a thread, in creation order, as absolute paths. */
function generatedImages(env: NodeJS.ProcessEnv, threadId: string | null): string[] {
  if (!threadId) return [];
  const dir = join(env.CODEX_HOME || join(homedir(), ".codex"), "generated_images", threadId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => a.at - b.at || a.path.localeCompare(b.path))
    .map((f) => f.path);
}

/**
 * Drives `codex exec` headless (JSON events) in the Step's directory, on the user's subscription. Unlike the Claude
 * Runner it is sandboxed: it can write only inside the worktree, and never waits for an approval (ADR 0006).
 */
export function createCodexRunner(options: CodexRunnerOptions = {}): Runner {
  const env = options.env ?? process.env;
  return {
    async run(step: StepRequest, onEvent): Promise<StepResult> {
      const args = [
        "exec",
        "--json",
        // The Run's worktree is a git repository, but the sandbox, not that check, is what confines the Step.
        "--skip-git-repo-check",
        "-s", "workspace-write",
        "-c", 'approval_policy="never"',
        // A JSON string is a valid TOML basic string, so quotes and newlines stay inside the one value.
        "-c", `developer_instructions=${JSON.stringify(step.instructions)}`,
      ];
      if (step.model) args.push("-m", step.model);
      args.push("-"); // the prompt comes on standard input

      let threadId: string | null = null;
      let completed = false;
      let failure: string | null = null;
      // An `error` event can be transient ("Reconnecting…"): it only counts when the turn never completed.
      let lastError: string | null = null;
      let lastMessage = "";
      const emit = (e: RunnerEvent) => {
        try { onEvent(e); } catch { /* a buggy listener must not break the Step */ }
      };
      const outcome = await runCli({ command: "codex", args, cwd: step.cwd, env, stdin: step.prompt, signal: step.signal }, (text) => {
        if (!text.trim()) return;
        let msg: any = null;
        try { msg = JSON.parse(text); } catch { /* kept as an unreadable-line event */ }
        emit(toEvent(msg, text));
        if (msg?.type === "thread.started") threadId = msg.thread_id ?? threadId;
        if (msg?.type === "turn.completed") completed = true;
        if (msg?.type === "turn.failed") failure = msg.error?.message ?? "the turn failed";
        else if (msg?.type === "error") lastError = msg.message ?? "Codex reported an error";
        if (msg?.type === "item.completed" && msg.item?.type === "agent_message") lastMessage = String(msg.item.text ?? "");
      });
      if (!outcome.ran) return { status: "failed", error: outcome.error };

      if (failure !== null) {
        return QUOTA_TEXT.test(failure) ? { status: "quota_exhausted", resetsAt: retryTime(failure) } : { status: "failed", error: failure };
      }
      if (!completed) {
        if (lastError !== null) {
          return QUOTA_TEXT.test(lastError) ? { status: "quota_exhausted", resetsAt: retryTime(lastError) } : { status: "failed", error: lastError };
        }
        const detail = outcome.stderr.trim();
        if (outcome.signal) return { status: "failed", error: `codex was killed by ${outcome.signal}${detail ? `: ${detail}` : ""}` };
        return outcome.code
          ? { status: "failed", error: `codex exited with code ${outcome.code}${detail ? `: ${detail}` : ""}` }
          : { status: "failed", error: "codex produced unreadable output: no completed turn" };
      }
      const files = generatedImages(env, threadId);
      // The image tool's own limit reaches the model as a tool failure: only its final message tells.
      if (!files.length && QUOTA_TEXT.test(lastMessage)) return { status: "quota_exhausted", resetsAt: null };
      for (const f of files) emit({ kind: "other", summary: `image generated: ${f.split("/").pop()}`, raw: "" });
      return { status: "succeeded", summary: lastMessage, files };
    },
  };
}
