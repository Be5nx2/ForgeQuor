import { describe, expect, it } from "vitest";
import { effortLevels, FALLBACK_CLAUDE_EFFORTS, FALLBACK_CODEX_EFFORTS, fallbackCatalog, parseClaudeEfforts, readCatalog } from "../../src/runner/catalog.js";
import { fakeAppServer, stopped } from "../harness/fake-app-server.js";
import { createFakeCli } from "../harness/fake-cli.js";

const ALL = ["low", "medium", "high", "xhigh", "max", "ultra"];
const efforts = (levels: string[]) => levels.map((reasoningEffort) => ({ reasoningEffort, description: `${reasoningEffort} thinking` }));

/** The answer to `model/list`, as recorded from codex-cli 0.163.0 (one hidden model added). */
const MODEL_LIST = {
  id: 1,
  result: {
    data: [
      { id: "gpt-6.1-terra", model: "gpt-6.1-terra", displayName: "GPT-6.1 Terra", hidden: false, isDefault: true, supportedReasoningEfforts: efforts(ALL), defaultReasoningEffort: "low" },
      { id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", hidden: false, isDefault: false, supportedReasoningEfforts: efforts(["low", "high"]), defaultReasoningEffort: "high" },
      { id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6 Astra", hidden: false, isDefault: false, supportedReasoningEfforts: efforts(ALL), defaultReasoningEffort: "medium" },
      { id: "gpt-secret", model: "gpt-secret", displayName: "Secret", hidden: true, isDefault: false, supportedReasoningEfforts: efforts(ALL), defaultReasoningEffort: "low" },
    ],
    nextCursor: null,
  },
};

const CLAUDE_HELP = [
  "Usage: claude [options] [command] [prompt]",
  "  --effort <level>                                  Effort level for the current session",
  "                                                    (low, medium, high, xhigh, max)",
  "  --fallback-model <model>                          Enable automatic fallback",
];

const SERVER = `
if (m.method === "initialize") send({ id: m.id, result: { userAgent: "fake" } });
if (m.method === "model/list") send({ ...ANSWER, id: m.id });
`;

/** Both CLIs faked on one PATH. */
function fakes(codexBody: string, claudeHelp: string[] | null, answer: object = MODEL_LIST) {
  const server = fakeAppServer(codexBody, answer);
  const claude = createFakeCli({ stdout: claudeHelp ?? [], exitCode: claudeHelp ? 0 : 1 });
  const env = { ...server.env, PATH: `${claude.env.PATH!.split(":")[0]}:${server.env.PATH}`, FAKE_CLI_DIR: claude.env.FAKE_CLI_DIR };
  return { env, server, claude };
}

const quiet = () => {
  const logged: string[] = [];
  return { logged, log: (m: string) => logged.push(m) };
};

describe("the Runner Catalog", () => {
  it("reads Codex's models, their efforts and the default model from the app-server, hidden ones skipped", async () => {
    const { env, server } = fakes(SERVER, CLAUDE_HELP);
    const { log, logged } = quiet();

    const catalog = await readCatalog({ env, log });

    expect(catalog.codex.fallback).toBe(false);
    expect(catalog.codex.models.map((m) => m.id)).toEqual(["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra"]);
    expect(catalog.codex.defaultModel).toBe("gpt-6.1-terra");
    expect(catalog.codex.models.find((m) => m.id === "gpt-6.1-sol")).toMatchObject({ efforts: ["low", "high"], defaultEffort: "high" });
    expect(server.seen()).toEqual(["initialize", "initialized", "model/list"]);
    expect(logged).toEqual([]);
    await stopped(server);
  });

  it("gives a model its own levels, and an unset or unknown model the default model's", async () => {
    const { env } = fakes(SERVER, CLAUDE_HELP, { ...MODEL_LIST, result: { data: [{ ...MODEL_LIST.result.data[1], isDefault: true }, MODEL_LIST.result.data[0]] } });
    const catalog = await readCatalog({ env, log: () => {} });

    expect(effortLevels(catalog, "codex", "gpt-6.1-terra")).toEqual(ALL);
    expect(effortLevels(catalog, "codex", "gpt-6.1-sol")).toEqual(["low", "high"]);
    expect(effortLevels(catalog, "codex", null)).toEqual(["low", "high"]);
    expect(effortLevels(catalog, "codex", "typed-by-hand")).toEqual(["low", "high"]);
  });

  it("follows the cursor of a long model list", async () => {
    const { env, server } = fakes(
      `
if (m.method === "initialize") send({ id: m.id, result: {} });
if (m.method === "model/list" && !m.params.cursor) send({ id: m.id, result: { data: ANSWER.result.data.slice(0, 1), nextCursor: "page2" } });
else if (m.method === "model/list") send({ id: m.id, result: { data: ANSWER.result.data.slice(1, 3), nextCursor: null } });
`,
      CLAUDE_HELP,
    );
    const catalog = await readCatalog({ env, log: () => {} });
    expect(catalog.codex.models.map((m) => m.id)).toEqual(["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra"]);
    expect(server.seen()).toEqual(["initialize", "initialized", "model/list", "model/list"]);
  });

  it("ignores notifications that arrive on the same stream", async () => {
    const { env } = fakes(
      `
send({ method: "remoteControl/status/changed", params: { status: "off" } });
send({ method: "account/updated", params: {} });
${SERVER}
`,
      CLAUDE_HELP,
    );
    expect((await readCatalog({ env, log: () => {} })).codex.fallback).toBe(false);
  });

  it("reads Claude Code's levels from the --effort line of its help, whichever the model", async () => {
    const { env } = fakes(SERVER, [...CLAUDE_HELP.slice(0, 3).map((l) => l.replace("max)", "max, ultra)")), CLAUDE_HELP[3]!]);
    const catalog = await readCatalog({ env, log: () => {} });

    expect(catalog.claude.fallback).toBe(false);
    expect(catalog.claude.efforts).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(catalog.claude.models.map((m) => m.id)).toEqual(["opus", "sonnet", "haiku"]);
    expect(effortLevels(catalog, "claude", "haiku")).toEqual(catalog.claude.efforts);
  });

  it("falls back to the built-in lists, flagged and logged once per Runner, when both CLIs fail", async () => {
    const { log, logged } = quiet();
    const catalog = await readCatalog({ env: { ...process.env, PATH: "/nonexistent" }, log });

    expect(catalog).toEqual(fallbackCatalog());
    expect(catalog.claude).toMatchObject({ efforts: FALLBACK_CLAUDE_EFFORTS, fallback: true });
    expect(catalog.codex).toMatchObject({ efforts: FALLBACK_CODEX_EFFORTS, fallback: true, models: [], defaultModel: null });
    expect(logged).toHaveLength(2);
  });

  it("falls back for Codex alone when it never answers, and stops the process", async () => {
    const { env, server } = fakes("", CLAUDE_HELP);
    const { log, logged } = quiet();
    const started = Date.now();

    const catalog = await readCatalog({ env, timeoutMs: 600, log });

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(catalog.codex.fallback).toBe(true);
    expect(catalog.claude.fallback).toBe(false);
    expect(logged).toHaveLength(1);
    await stopped(server);
  });

  it("falls back for a garbled answer: no data, no usable model, an error", async () => {
    for (const reply of [
      `send({ id: m.id, result: {} })`,
      `send({ id: m.id, result: { data: [{ model: "x", supportedReasoningEfforts: [] }] } })`,
      `send({ id: m.id, error: { code: -1, message: "nope" } })`,
      `process.stdout.write("not json\\n")`,
    ]) {
      const { env } = fakes(`if (m.method === "initialize") send({ id: m.id, result: {} });\nif (m.method === "model/list") { ${reply} }`, CLAUDE_HELP);
      expect((await readCatalog({ env, timeoutMs: 800, log: () => {} })).codex.fallback).toBe(true);
    }
  });

  it("falls back for Claude when its help has no --effort levels or the CLI fails", async () => {
    for (const help of [["Usage: claude", "  --model <model>  The model"], ["  --effort <level>  Effort level"], null]) {
      const { env } = fakes(SERVER, help);
      const { log, logged } = quiet();
      const catalog = await readCatalog({ env, log });
      expect(catalog.claude).toMatchObject({ fallback: true, efforts: FALLBACK_CLAUDE_EFFORTS });
      expect(catalog.codex.fallback).toBe(false);
      expect(logged).toHaveLength(1);
    }
  });
});

describe("parseClaudeEfforts", () => {
  it("finds the list on the line after the option", () => {
    expect(parseClaudeEfforts(CLAUDE_HELP.join("\n"))).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
  it("finds it on the same line", () => {
    expect(parseClaudeEfforts("--effort <level>  Effort (low, high)")).toEqual(["low", "high"]);
  });
  it("gives nothing for text without the option or with a list that is prose", () => {
    expect(parseClaudeEfforts("--model <m> (a model)")).toBeNull();
    expect(parseClaudeEfforts("--effort <level>  How hard (see the docs here)")).toBeNull();
  });
});
