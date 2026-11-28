import { describe, expect, it } from "vitest";
import { gateAction, gateLabel, keepsState, nowOf, startedLabel, waitingFor, type NowInput } from "../../web/src/runsHome.js";

const run = (state: "running" | "waiting" | "queued" | "merged" | "paused" = "running") => ({ state, prNumber: null, resumeAt: null });
const running = (detail: string | null, attempts = 0): NowInput => ({ steps: [{ id: "s1", detail, status: "running", attempts }], gates: [] });

describe("keepsState", () => {
  it("keeps every state under All and groups the finished ones under Done", () => {
    expect(keepsState("all", "paused")).toBe(true);
    expect(keepsState("done", "merged")).toBe(true);
    expect(keepsState("done", "abandoned")).toBe(true);
    expect(keepsState("done", "running")).toBe(false);
    expect(keepsState("waiting", "waiting")).toBe(true);
    expect(keepsState("waiting", "queued")).toBe(false);
  });
});

describe("nowOf", () => {
  it("names the running Step, with its attempt after the first", () => {
    expect(nowOf(run(), running("developer"))).toEqual({ text: "Developer", sub: "" });
    expect(nowOf(run(), running("developer", 1))).toEqual({ text: "Developer", sub: "attempt 2" });
  });
  it("falls back to the Step id when it has no detail", () => {
    expect(nowOf(run(), running(null)).text).toBe("S1");
  });
  it("names the open Gate of a waiting Run", () => {
    const d: NowInput = { steps: [{ id: "g", detail: "conversation", status: "running", attempts: 0 }], gates: [{ kind: "conversation", decidedAt: null }] };
    expect(nowOf(run("waiting"), d)).toEqual({ text: "Conversation", sub: "Conversation Gate" });
  });
  it("says a queued Run waits for a slot and a merged one shows its pull request", () => {
    expect(nowOf(run("queued")).text).toBe("waiting for a free slot");
    expect(nowOf({ state: "merged", prNumber: 56, resumeAt: null }).text).toBe("pull request #56");
  });
  it("is empty when the detail is not known", () => {
    expect(nowOf(run())).toEqual({ text: "", sub: "" });
  });
});

describe("times and wording", () => {
  it("counts how long a Gate has waited", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    expect(waitingFor("2026-01-01T11:56:00Z", now)).toBe("waiting 4 min");
    expect(waitingFor("2026-01-01T11:59:50Z", now)).toBe("waiting less than a minute");
    expect(waitingFor("2026-01-01T09:00:00Z", now)).toBe("waiting 3 h");
    expect(waitingFor("2025-12-30T09:00:00Z", now)).toBe("waiting 2 d");
  });
  it("dates a Run's start relative to today", () => {
    const now = new Date(2026, 0, 10, 12, 0);
    expect(startedLabel(new Date(2026, 0, 10, 9, 5).toISOString(), now)).toMatch(/09.05/);
    expect(startedLabel(new Date(2026, 0, 9, 23, 0).toISOString(), now)).toBe("yesterday");
    expect(startedLabel(new Date(2026, 0, 7, 8, 0).toISOString(), now)).toBe("3 days ago");
  });
  it("labels Gates and their button", () => {
    expect(gateLabel("review")).toBe("Review Gate");
    expect(gateAction("conversation")).toBe("Answer");
    expect(gateAction("final")).toBe("Open");
  });
});
