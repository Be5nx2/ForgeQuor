import { describe, expect, it } from "vitest";
import { InvalidInputError } from "../../src/forge/errors.js";
import { escalationGate, finalGate, refusal } from "../../src/forge/gates.js";
import type { Gate } from "../../src/forge/types.js";

const gate = { id: 1, runId: 1 } as Gate;

describe("the final Gate kind", () => {
  it("offers approve, reject and abandon", () => {
    expect(finalGate.actions).toEqual(["approve", "reject", "abandon"]);
  });

  it("sends the Run to Approved on approve and to Abandoned on abandon", async () => {
    expect(await finalGate.decide(gate, { action: "approve" })).toEqual({ next: "approve" });
    expect(await finalGate.decide(gate, { action: "abandon" })).toEqual({ next: "abandon" });
  });

  it("starts the next Iteration on a rejection with Feedback, trimmed", async () => {
    expect(await finalGate.decide(gate, { action: "reject", feedback: "  more tests " })).toEqual({
      next: "continue",
      decision: "reject",
      feedback: "more tests",
      nextIteration: true,
    });
  });

  it("refuses a rejection without Feedback", async () => {
    await expect(finalGate.decide(gate, { action: "reject", feedback: "  " })).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("the escalation Gate kind", () => {
  it("only abandons", async () => {
    expect(escalationGate.actions).toEqual(["abandon"]);
    expect(await escalationGate.decide(gate, { action: "abandon" })).toEqual({ next: "abandon" });
  });

  it("says what it offers when a choice is refused", () => {
    expect(refusal(escalationGate, "approve")).toBe("An Escalation cannot be approved; it can only be abandoned.");
  });
});
