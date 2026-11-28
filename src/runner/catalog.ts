import { tmpdir } from "node:os";
import { withAppServer } from "./codex-quota.js";
import { runCli } from "./process.js";

/** The Runners whose models and effort levels the Catalog knows. */
export type CatalogRunner = "claude" | "codex";

export interface CatalogModel {
  id: string;
  /** The effort levels this model accepts, in the Runner's own order. */
  efforts: string[];
  /** The level the Runner applies when none is given (null when it did not say). */
  defaultEffort: string | null;
}

export interface CatalogEntry {
  /** The models on offer; any other identifier typed is still accepted. */
  models: CatalogModel[];
  /** The model the Runner uses when a Seat sets none (null when it did not say). */
  defaultModel: string | null;
  /** The levels of the default model, and of a model the list does not know. */
  efforts: string[];
  /** True when the CLI could not be read and this is the built-in list. */
  fallback: boolean;
}

/** What each Runner's CLI says it can do, read once at startup and kept in memory. */
export type RunnerCatalog = Record<CatalogRunner, CatalogEntry>;

export const FALLBACK_CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const FALLBACK_CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
/** Claude Code has no model list: its aliases stay as they are. */
export const CLAUDE_MODEL_ALIASES = ["opus", "sonnet", "haiku"];

/** The Claude Code entry for these levels (they do not depend on the model). */
function claudeEntry(efforts: string[], fallback: boolean): CatalogEntry {
  return { models: CLAUDE_MODEL_ALIASES.map((id) => ({ id, efforts, defaultEffort: null })), defaultModel: null, efforts, fallback };
}

/** The built-in Catalog: used when a reading fails, and as the default of a Forge given none. */
export function fallbackCatalog(): RunnerCatalog {
  return {
    claude: claudeEntry(FALLBACK_CLAUDE_EFFORTS, true),
    codex: { models: [], defaultModel: null, efforts: FALLBACK_CODEX_EFFORTS, fallback: true },
  };
}

/** The effort levels a Seat running this Runner and model accepts; an unknown or unset model gets the default model's. */
export function effortLevels(catalog: RunnerCatalog, runner: CatalogRunner, model: string | null | undefined): string[] {
  const entry = catalog[runner];
  return entry.models.find((m) => m.id === model)?.efforts ?? entry.efforts;
}

const isLevel = (x: unknown): x is string => typeof x === "string" && /^[a-z][a-z0-9_-]*$/i.test(x);

/**
 * Claude Code's levels from its `--help` text: the parenthesised list that follows the `--effort` option (it may be on the
 * next line). Null when the option or its list is not found.
 */
export function parseClaudeEfforts(help: string): string[] | null {
  const at = help.search(/--effort\b/);
  if (at < 0) return null;
  const list = /\(([^()]*)\)/.exec(help.slice(at, at + 400))?.[1];
  const levels = list?.split(",").map((l) => l.trim());
  return levels?.length && levels.every(isLevel) ? levels : null;
}

/**
 * Codex's models from the answer to `model/list`: hidden ones skipped, each with the efforts it supports and its default.
 * The model marked `isDefault` is the default one. Null when the answer holds no usable model.
 */
export function parseCodexModels(answers: unknown[]): CatalogEntry | null {
  const models: CatalogModel[] = [];
  let defaultModel: string | null = null;
  for (const answer of answers) {
    const data = (answer as any)?.result?.data;
    if (!Array.isArray(data)) return null;
    for (const m of data) {
      if (!m || typeof m !== "object" || m.hidden === true) continue;
      const id = typeof m.model === "string" && m.model ? m.model : typeof m.id === "string" ? m.id : null;
      const efforts = Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.map((e: any) => e?.reasoningEffort) : [];
      if (!id || !efforts.length || !efforts.every(isLevel)) continue;
      models.push({ id, efforts, defaultEffort: isLevel(m.defaultReasoningEffort) ? m.defaultReasoningEffort : null });
      if (m.isDefault === true && !defaultModel) defaultModel = id;
    }
  }
  if (!models.length) return null;
  defaultModel ??= models[0]!.id;
  return { models, defaultModel, efforts: models.find((m) => m.id === defaultModel)!.efforts, fallback: false };
}

export interface CatalogReading {
  env?: NodeJS.ProcessEnv;
  /** How long each CLI may take. Default: 15 seconds. */
  timeoutMs?: number;
  /** Where a failed reading is reported (once per Runner). Default: the console. */
  log?: (message: string) => void;
}

async function readCodex({ env, timeoutMs = 15_000 }: CatalogReading): Promise<CatalogEntry> {
  const answers = await withAppServer({ env, timeoutMs }, async (request) => {
    const pages: unknown[] = [];
    let cursor: string | null = null;
    // A bounded walk: a server that never stops giving a cursor must not keep it here until the timeout.
    for (let i = 0; i < 20; i++) {
      const page: any = await request("model/list", cursor ? { cursor } : {});
      pages.push(page);
      cursor = typeof page?.result?.nextCursor === "string" && page.result.nextCursor ? page.result.nextCursor : null;
      if (!cursor) break;
    }
    return pages;
  });
  const entry = parseCodexModels(answers);
  if (!entry) throw new Error("codex app-server's model/list held no usable model");
  return entry;
}

async function readClaude({ env, timeoutMs = 15_000 }: CatalogReading): Promise<CatalogEntry> {
  let help = "";
  const outcome = await runCli({ command: "claude", args: ["--help"], cwd: tmpdir(), env, stdin: "", signal: AbortSignal.timeout(timeoutMs) }, (line) => {
    help += `${line}\n`;
  });
  if (!outcome.ran) throw new Error(outcome.error);
  if (outcome.signal) throw new Error(`claude --help did not finish within ${timeoutMs} ms`);
  const levels = parseClaudeEfforts(help);
  if (!levels) throw new Error("claude --help does not list the --effort levels");
  return claudeEntry(levels, false);
}

/**
 * Reads each Runner's models and effort levels from its CLI, once: Codex through `codex app-server` (`model/list`), Claude
 * Code from `claude --help`. Neither calls a model, so none costs Quota. A reading that fails, is slow or makes no sense
 * gives that Runner's built-in list, flagged `fallback`, and is logged once. Never rejects.
 */
export async function readCatalog(options: CatalogReading = {}): Promise<RunnerCatalog> {
  const log = options.log ?? ((m: string) => console.error(m));
  const fallback = fallbackCatalog();
  const read = async (runner: CatalogRunner, reading: Promise<CatalogEntry>): Promise<CatalogEntry> => {
    try {
      return await reading;
    } catch (e) {
      log(`Could not read ${runner}'s models and effort levels, using the built-in list: ${e instanceof Error ? e.message : String(e)}`);
      return fallback[runner];
    }
  };
  const [claude, codex] = await Promise.all([read("claude", readClaude(options)), read("codex", readCodex(options))]);
  return { claude, codex };
}
