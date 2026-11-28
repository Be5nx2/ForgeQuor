import { describe, expect, it } from "vitest";
import { assetStatus, attemptStatus, checkStatus, gateStatus, runStatus, stepStatus, verdictStatus } from "../../web/src/status.js";

/** Every state the server can send reads as one of the spec's statuses: colour, glyph and label. */

describe("runStatus", () => {
  it.each([
    ["queued", "idle", "○", "Queued"],
    ["running", "running", "●", "Running"],
    ["waiting", "waiting", "●", "Waiting for you"],
    ["paused", "idle", "‖", "Paused"],
    ["approved", "ok", "✓", "Approved"],
    ["merged", "ok", "✓", "Merged"],
    ["closed", "idle", "–", "Closed"],
    ["abandoned", "idle", "–", "Abandoned"],
  ] as const)("shows a %s Run as %s %s %s", (state, kind, glyph, label) => {
    expect(runStatus(state)).toEqual({ kind, glyph, label });
  });
});

describe("stepStatus", () => {
  it.each([
    ["waiting", "idle", "○", "Not started"],
    ["running", "running", "●", "Running"],
    ["done", "ok", "✓", "Done"],
    ["skipped", "idle", "–", "Skipped"],
    ["failed", "bad", "✕", "Failed"],
  ] as const)("shows a %s Step as %s %s %s", (status, kind, glyph, label) => {
    expect(stepStatus(status)).toEqual({ kind, glyph, label });
  });
});

describe("attemptStatus", () => {
  it.each([
    ["running", "running", "Running"],
    ["succeeded", "ok", "Succeeded"],
    ["failed", "bad", "Failed"],
    ["quota_exhausted", "idle", "Quota used up"],
  ] as const)("shows a %s attempt as %s %s", (status, kind, label) => {
    expect(attemptStatus(status)).toMatchObject({ kind, label });
  });
});

describe("assetStatus", () => {
  it.each([
    ["pending", "idle", "Pending"],
    ["generating", "running", "Drawing"],
    ["waiting", "waiting", "Waiting for you"],
    ["approved", "ok", "Approved"],
    ["rejected", "bad", "Rejected"],
  ] as const)("shows a %s Asset as %s %s", (status, kind, label) => {
    expect(assetStatus(status)).toMatchObject({ kind, label });
  });
});

describe("verdictStatus", () => {
  it("passes in green, asks for changes in red, and flags a disagreement for the human", () => {
    expect(verdictStatus("pass")).toMatchObject({ kind: "ok", glyph: "✓" });
    expect(verdictStatus("changes requested")).toMatchObject({ kind: "bad", glyph: "✕" });
    expect(verdictStatus("disagreement")).toMatchObject({ kind: "waiting", glyph: "●" });
  });
});

describe("gateStatus", () => {
  it("waits for the human while open", () => {
    expect(gateStatus(null)).toEqual({ kind: "waiting", glyph: "●", label: "Waiting for you" });
  });

  it.each([
    ["approve", "ok"],
    ["reject", "bad"],
    ["abandon", "idle"],
    ["retry", "idle"],
    ["go_back", "idle"],
    ["answer", "ok"],
    ["confirm", "ok"],
  ] as const)("shows a Gate decided by %s as %s", (decision, kind) => {
    expect(gateStatus(decision).kind).toBe(kind);
  });
});

describe("checkStatus", () => {
  it("passes on exit status 0, fails on another, and says when the Check was killed", () => {
    expect(checkStatus(0)).toEqual({ kind: "ok", glyph: "✓", label: "Passed" });
    expect(checkStatus(2)).toEqual({ kind: "bad", glyph: "✕", label: "Exit 2" });
    expect(checkStatus(null)).toEqual({ kind: "bad", glyph: "✕", label: "Killed" });
  });
});
