import { describe, expect, it } from "vitest";
import type { RunDetail } from "../../web/src/api.js";
import { defaultSelection, itemsUnder, neighbour, railOf, remarksOf, resolveSelection, stepLabel, stepViewOf } from "../../web/src/runDetail.js";

type Step = RunDetail["steps"][number];
const step = (id: string, type: Step["type"], detail: string | null, status: Step["status"], extra: Partial<Step> = {}): Step => ({
  id,
  type,
  detail,
  needs: [],
  iteration: 1,
  status,
  attempts: 0,
  ...extra,
});
const attempt = (stepId: string, name: string, runner: string, status: RunDetail["attempts"][number]["status"] = "succeeded") =>
  ({ id: Math.random(), iteration: 1, step: name, stepId, attempt: 1, runner, model: null, assetId: null, status, startedAt: "", endedAt: null, summary: null, error: null, quotaResetsAt: null, eventLog: "" }) as RunDetail["attempts"][number];
const gate = (stepId: string | null, kind: RunDetail["gates"][number]["kind"]) =>
  ({ id: 1, runId: 1, iteration: 1, stepId, kind, reason: "r", evidence: null, actions: ["approve"], redo: null, feedback: null, verdicts: [], openedAt: "", decidedAt: null, decision: null }) as RunDetail["gates"][number];
const review = (author: string, body: string, extra: Partial<RunDetail["reviews"][number]> = {}) =>
  ({ id: Math.random(), iteration: 1, stepId: "review", attempt: 1, author, verdict: "changes requested", body, final: false, createdAt: "", ...extra }) as RunDetail["reviews"][number];

function run(over: Partial<RunDetail> = {}): RunDetail {
  return {
    id: 1,
    iteration: 1,
    review: "duo",
    state: "waiting",
    steps: [step("dev", "agent", "developer", "done", { attempts: 2 }), step("review", "review", null, "running"), step("final", "gate", "final", "waiting")],
    attempts: [attempt("dev", "developer", "claude"), attempt("review", "reviewer-a", "claude"), attempt("review", "reviewer-b", "codex"), attempt("review", "consolidator", "claude")],
    gates: [],
    reviews: [],
    iterations: [{ number: 1, feedback: null }],
    conversation: [],
    checks: [],
    assets: [],
    runNotes: [],
    ...over,
  } as unknown as RunDetail;
}

describe("stepLabel", () => {
  it.each([
    [step("g", "gate", "spec", "done"), "Spec Gate"],
    [step("s", "agent", "spec-writer", "done"), "Spec Writer"],
    [step("c", "checks", null, "done"), "Checks"],
    [step("p", "publish", null, "done"), "Open pull request"],
  ])("names %j", (s, label) => expect(stepLabel(s)).toBe(label));
});

describe("railOf", () => {
  it("lists each Step with its state, Iteration and Runner, the Agents of a review as sub-Steps", () => {
    const rail = railOf(run());
    expect(rail.map((r) => [r.key, r.sub, r.mark, r.runner])).toEqual([
      ["dev", false, "done", "claude"],
      ["review", false, "run", null],
      ["review/reviewer-a", true, "done", "claude"],
      ["review/reviewer-b", true, "done", "codex"],
      ["review/consolidator", true, "done", "claude"],
      ["final", false, "idle", null],
    ]);
    expect(rail[0]!.note).toBe("Iteration 1 · 2 passes");
    expect(rail[2]!.label).toBe("Reviewer A");
  });

  it("marks the Step that opened an open Gate as waiting for the human", () => {
    const rail = railOf(run({ gates: [gate("review", "review")] }));
    expect(rail[1]!.mark).toBe("wait");
    expect(rail[1]!.status.label).toBe("Waiting for you");
  });

  it("calls the only Reviewer of a solo review just Reviewer", () => {
    const rail = railOf(run({ review: "solo", attempts: [attempt("review", "reviewer-a", "claude")] }));
    expect(rail.find((r) => r.sub)!.label).toBe("Reviewer");
  });

  it("marks a failed Step", () => {
    expect(railOf(run({ steps: [step("dev", "agent", "developer", "failed")] }))[0]!.mark).toBe("bad");
  });
});

describe("selection", () => {
  it("defaults to the Step with the open Gate, then the running Step, then the last finished one", () => {
    const withGate = run({ gates: [gate("final", "final")] });
    expect(defaultSelection(railOf(withGate), withGate)).toBe("final");
    const r = run();
    expect(defaultSelection(railOf(r), r)).toBe("review");
    const done = run({ steps: [step("a", "agent", "developer", "done"), step("b", "agent", "architect", "done"), step("c", "agent", "x", "waiting")] });
    expect(defaultSelection(railOf(done), done)).toBe("b");
  });

  it("keeps the Step the URL names when the rail has it, else falls back", () => {
    const r = run();
    expect(resolveSelection(railOf(r), "dev", r)).toBe("dev");
    expect(resolveSelection(railOf(r), "review/consolidator", r)).toBe("review/consolidator");
    expect(resolveSelection(railOf(r), "gone", r)).toBe("review");
    expect(resolveSelection(railOf(r), undefined, r)).toBe("review");
  });

  it("moves with the arrow keys and stops at the ends", () => {
    const rail = railOf(run());
    expect(neighbour(rail, "dev", 1)).toBe("review");
    expect(neighbour(rail, "dev", -1)).toBe("dev");
    expect(neighbour(rail, "final", 1)).toBe("final");
  });
});

describe("stepViewOf", () => {
  it("collects a Step's attempts, seats used and Feedback", () => {
    const r = run({ iterations: [{ number: 1, feedback: "Fix R1" }, { number: 2, feedback: null }] as RunDetail["iterations"] });
    r.steps[0]!.iteration = 2;
    const v = stepViewOf(r, "dev")!;
    expect(v.attempts).toHaveLength(1);
    expect(v.seats).toEqual([{ agent: "Developer", runner: "claude", model: null, attempts: 1 }]);
    expect(v.feedback.map((f) => f.feedback)).toEqual(["Fix R1"]);
  });

  it("shows only that Agent's attempts and Review for a sub-Step", () => {
    const r = run({ reviews: [review("reviewer-a", "x"), review("reviewer-b", "y")] });
    const v = stepViewOf(r, "review/reviewer-b")!;
    expect(v.attempts.map((a) => a.step)).toEqual(["reviewer-b"]);
    expect(v.reviews.map((x) => x.author)).toEqual(["reviewer-b"]);
    expect(v.remarks).toBeNull();
  });

  it("gives the running attempt and the open Gate of the Step", () => {
    const r = run({ gates: [gate("final", "final")], attempts: [attempt("dev", "developer", "claude", "running")] });
    expect(stepViewOf(r, "dev")!.running).not.toBeNull();
    expect(stepViewOf(r, "final")!.openGate?.kind).toBe("final");
  });

  it("knows nothing of a Step the Run does not have", () => {
    expect(stepViewOf(run(), "nope")).toBeNull();
  });
});

describe("remarks", () => {
  const consolidated = `Summary: ok.

Findings:
- player.gd:84 - The dash cooldown is not reset on respawn.
- dash.gd:12 - Gravity is off during the dash: make it an @export variable.

Dropped:
- Missing null check on AnimationPlayer: the node is required.

Doubts: None.

Recommendation: send back for the first one only.`;

  it("reads the bullets under a heading", () => {
    expect(itemsUnder(consolidated, "findings")).toEqual([
      { where: "player.gd:84", text: "The dash cooldown is not reset on respawn." },
      { where: "dash.gd:12", text: "Gravity is off during the dash: make it an @export variable." },
    ]);
    expect(itemsUnder("Findings:\n- None.\n\nVerdict", "findings")).toEqual([]);
    expect(itemsUnder("nothing", "findings")).toEqual([]);
  });

  it("numbers the remarks, matches each Reviewer's vote and marks a split as disputed", () => {
    const table = remarksOf([
      review("reviewer-a", "Findings:\n- player.gd:84 - cooldown\n- dash.gd:12 - gravity"),
      review("reviewer-b", "Findings:\n- player.gd:84 - cooldown not reset"),
      review("consolidator", consolidated, { final: true, verdict: "disagreement" }),
    ])!;
    expect(table.recommendation).toBe("send back for the first one only.");
    expect(table.remarks.map((r) => [r.id, r.dropped, r.disputed, r.votes.map((v) => `${v.reviewer}:${v.vote}`)])).toEqual([
      ["R1", false, false, ["A:change", "B:change"]],
      ["R2", false, true, ["A:change", "B:pass"]],
      ["R3", true, false, ["A:pass", "B:pass"]],
    ]);
  });

  it("has no votes for a solo Review, and nothing before the Review exists", () => {
    const table = remarksOf([review("reviewer-a", "Findings:\n- a.ts:1 - bug", { final: true })])!;
    expect(table.remarks[0]!.votes).toEqual([]);
    expect(table.remarks[0]!.disputed).toBe(false);
    expect(remarksOf([])).toBeNull();
    expect(remarksOf([review("reviewer-a", "x")])).toBeNull();
  });

  it("reads only the latest attempt's Reviews", () => {
    const table = remarksOf([
      review("reviewer-a", "Findings:\n- old.ts:1 - old", { final: true, attempt: 1 }),
      review("reviewer-a", "Findings:\n- new.ts:2 - new", { final: true, attempt: 2 }),
    ])!;
    expect(table.remarks.map((r) => r.where)).toEqual(["new.ts:2"]);
  });
});
