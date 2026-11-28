// What the New Run screen tells the human before launching, as plain functions: the Steps a Workflow will run, which of
// them need the human (the Gates), who does each, and what the Quota says. No DOM and no Vue, so the root tests can load it.
import { parse } from "yaml";
import type { GateKind, ReviewMode, WorkflowOption } from "../../src/forge/types.js";
import { gateLabel } from "./runsHome.js";

/** One line of "What will happen". */
export interface PreviewRow {
  id: string;
  label: string;
  /** The Runner that does it ("duo" for a duo Review); null for a Step nobody drives with a Runner, and for a Gate. */
  runner: string | null;
  /** True for a Gate or a Conversation: the Run stops and waits for the human. */
  human: boolean;
  /** Only runs when the Run was given Assets (the Step's `when`). */
  conditional: boolean;
}

export interface Preview {
  rows: PreviewRow[];
  /** How many Steps will need the human. */
  gates: number;
  /** Of those, how many only happen when the Run orders Assets. */
  conditionalGates: number;
}

/** "spec-writer" is "Spec Writer". */
const title = (name: string) => name.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/** The Gate kind each Gate Step declares, read from the Workflow's YAML (the Step summaries do not carry it). */
function gateKinds(yaml: string): Map<string, GateKind> {
  const kinds = new Map<string, GateKind>();
  try {
    const steps = (parse(yaml) as { steps?: unknown })?.steps;
    if (!Array.isArray(steps)) return kinds;
    for (const s of steps) if (s && typeof s === "object" && typeof (s as any).id === "string" && typeof (s as any).gate === "string") kinds.set((s as any).id, (s as any).gate);
  } catch {
    // A YAML that does not parse has no Steps either: the preview is empty.
  }
  return kinds;
}

/**
 * The Steps a Workflow will run, in its order, with who does each and which ones wait for the human.
 * `runnerOf` answers the Runner a seat works through (the Team's, or what the human set for this Run).
 */
export function previewOf(workflow: Pick<WorkflowOption, "steps" | "yaml">, review: ReviewMode, runnerOf: (seat: string) => string | null): Preview {
  const kinds = gateKinds(workflow.yaml);
  const rows: PreviewRow[] = workflow.steps.map((s) => {
    const conditional = s.when !== null;
    switch (s.type) {
      case "gate":
        return { id: s.id, label: kinds.has(s.id) ? gateLabel(kinds.get(s.id)!) : "Gate", runner: null, human: true, conditional };
      case "conversation":
        return { id: s.id, label: title(s.agent ?? s.id), runner: s.agent ? runnerOf(s.agent) : null, human: true, conditional };
      case "artist":
        return { id: s.id, label: "Artist", runner: runnerOf("artist"), human: false, conditional };
      case "review":
        return { id: s.id, label: "Review", runner: review === "duo" ? "duo" : runnerOf("reviewer-a"), human: false, conditional };
      case "checks":
        return { id: s.id, label: "Checks", runner: null, human: false, conditional };
      case "publish":
        return { id: s.id, label: "Pull request", runner: null, human: false, conditional };
      default:
        return { id: s.id, label: title(s.agent ?? s.id), runner: s.agent ? runnerOf(s.agent) : null, human: false, conditional };
    }
  });
  const waiting = rows.filter((r) => r.human);
  return { rows, gates: waiting.length, conditionalGates: waiting.filter((r) => r.conditional).length };
}

/** "3 Gates will need you", "up to 3 Gates will need you" when some only happen with Assets, "No Gate will need you". */
export function gatesSentence(p: Preview): string {
  if (!p.gates) return "No Gate will need you.";
  const n = `${p.gates} Gate${p.gates > 1 ? "s" : ""}`;
  return `${p.conditionalGates ? "Up to " + n : n} will need you.`;
}

/** The part of a Quota status the hint reads (the API's, with its dates as strings). */
export interface QuotaFigures {
  vendor: string;
  reading: { fiveHour: { percentUsed: number | null }; weekly: { percentUsed: number | null }; exhausted: boolean } | null;
}

const VENDORS = ["claude", "codex"] as const;
const vendorName = (v: string) => title(v);
/** How much of its Quota a vendor has used: the fuller of its two windows, null when neither is known. */
function usedPercent(s: QuotaFigures | undefined): number | null {
  const r = s?.reading;
  if (!r) return null;
  const known = [r.fiveHour.percentUsed, r.weekly.percentUsed].filter((p): p is number => p !== null);
  return known.length ? Math.max(...known) : r.exhausted ? 100 : null;
}

/**
 * The Quota hint: shown only when both vendors have been read. It says whether there is room or one is used up,
 * and for a duo Review that both Runners spend Quota.
 */
export function quotaHint(statuses: QuotaFigures[]): string | null {
  const byVendor = VENDORS.map((v) => ({ v, status: statuses.find((s) => s.vendor === v) }));
  const used = byVendor.map((b) => usedPercent(b.status));
  if (used.some((u) => u === null)) return null;
  const figures = byVendor.map((b, i) => `${vendorName(b.v)} ${Math.round(used[i]!)}% used`).join(", ");
  const spent = byVendor.filter((b) => b.status!.reading!.exhausted).map((b) => vendorName(b.v));
  if (spent.length) return `${spent.join(" and ")}'s Quota is used up: ${figures}.`;
  return `Both Quotas have room: ${figures}.`;
}
