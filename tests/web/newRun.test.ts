import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gatesSentence, previewOf, quotaHint, type QuotaFigures } from "../../web/src/newRun.js";
import type { WorkflowOption } from "../../src/forge/types.js";

const yaml = (name: string) => readFileSync(`src/forge/workflows/${name}.yaml`, "utf8");
const summary = (steps: { id: string; type: string; agent?: string; when?: string }[], text: string): Pick<WorkflowOption, "steps" | "yaml"> => ({
  steps: steps.map((s) => ({ id: s.id, type: s.type, agent: s.agent ?? null, needs: [], when: s.when ?? null })),
  yaml: text,
});
const runners: Record<string, string> = { griller: "claude", "spec-writer": "claude", architect: "claude", developer: "claude", artist: "codex", "reviewer-a": "claude" };
const runnerOf = (seat: string) => runners[seat] ?? null;

const feature = summary(
  [
    { id: "griller", type: "conversation", agent: "griller" },
    { id: "spec-writer", type: "agent", agent: "spec-writer" },
    { id: "spec", type: "gate" },
    { id: "artist", type: "artist", when: "assets" },
    { id: "asset-gate", type: "gate", when: "assets" },
    { id: "developer", type: "agent", agent: "developer" },
    { id: "checks", type: "checks" },
    { id: "review", type: "review" },
    { id: "publish", type: "publish" },
    { id: "final", type: "gate" },
  ],
  yaml("feature"),
);

describe("previewOf", () => {
  it("lists the Steps with their Runner, naming each Gate by its kind", () => {
    const p = previewOf(feature, "duo", runnerOf);
    expect(p.rows.map((r) => [r.label, r.runner, r.human])).toEqual([
      ["Griller", "claude", true],
      ["Spec Writer", "claude", false],
      ["Spec Gate", null, true],
      ["Artist", "codex", false],
      ["Asset Gate", null, true],
      ["Developer", "claude", false],
      ["Checks", null, false],
      ["Review", "duo", false],
      ["Pull request", null, false],
      ["Final Gate", null, true],
    ]);
  });

  it("counts the Gates that need the human, and those only an Asset order brings", () => {
    const p = previewOf(feature, "duo", runnerOf);
    expect(p.gates).toBe(4);
    expect(p.conditionalGates).toBe(1);
    expect(p.rows.filter((r) => r.conditional).map((r) => r.id)).toEqual(["artist", "asset-gate"]);
  });

  it("shows the solo Reviewer's Runner, not duo", () => {
    expect(previewOf(feature, "solo", runnerOf).rows.find((r) => r.id === "review")!.runner).toBe("claude");
  });

  it("follows the Runner the seat is set to for this Run", () => {
    const p = previewOf(feature, "solo", (seat) => (seat === "developer" ? "codex" : "claude"));
    expect(p.rows.find((r) => r.id === "developer")!.runner).toBe("codex");
  });

  it("falls back to a bare Gate when the YAML does not say its kind, and to nothing for broken YAML", () => {
    expect(previewOf(summary([{ id: "x", type: "gate" }], "steps: [ unbalanced"), "solo", runnerOf).rows[0]!.label).toBe("Gate");
  });
});

describe("gatesSentence", () => {
  it("is plain when every Gate will happen and says 'up to' when some depend on Assets", () => {
    expect(gatesSentence({ rows: [], gates: 3, conditionalGates: 0 })).toBe("3 Gates will need you.");
    expect(gatesSentence({ rows: [], gates: 1, conditionalGates: 0 })).toBe("1 Gate will need you.");
    expect(gatesSentence({ rows: [], gates: 3, conditionalGates: 1 })).toBe("Up to 3 Gates will need you.");
    expect(gatesSentence({ rows: [], gates: 0, conditionalGates: 0 })).toBe("No Gate will need you.");
  });
});

const status = (vendor: "claude" | "codex", five: number | null, weekly: number | null = null, exhausted = false): QuotaFigures => ({
  vendor,
  reading: { fiveHour: { percentUsed: five }, weekly: { percentUsed: weekly }, exhausted },
});

describe("quotaHint", () => {
  it("says both Quotas have room, with the fuller window of each", () => {
    expect(quotaHint([status("claude", 72, 10), status("codex", 20, 55)])).toBe("Both Quotas have room: Claude 72% used, Codex 55% used.");
  });
  it("is absent unless both vendors were read", () => {
    expect(quotaHint([status("claude", 72)])).toBeNull();
    expect(quotaHint([status("claude", 72), { vendor: "codex", reading: null }])).toBeNull();
    expect(quotaHint([status("claude", 72), status("codex", null)])).toBeNull();
    expect(quotaHint([])).toBeNull();
  });
  it("warns instead when a vendor is used up", () => {
    expect(quotaHint([status("claude", 100, 30, true), status("codex", 10)])).toBe("Claude's Quota is used up: Claude 100% used, Codex 10% used.");
  });
});
