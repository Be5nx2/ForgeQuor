import { describe, expect, it } from "vitest";
import type { Asset } from "../../web/src/api.js";
import { approveAllOf, checksOf, draftsFor, earlierVersions, gateSummary, historyOf, isComplete, verdictsOf, waitingKey, zoomOf } from "../../web/src/assetGate.js";

const asset = (extra: Partial<Asset> = {}): Asset =>
  ({ id: 1, name: "coin", status: "waiting", width: 16, height: 16, frames: 1, warnings: [], versions: [{ id: 10, iteration: 1, attempt: 1, feedback: null }], attempts: [], ...extra }) as Asset;
const redoing = { status: "pending" as Asset["status"] };

describe("Asset Checks", () => {
  it("shows format, size and place as passed and a clean palette for a delivered Asset", () => {
    expect(checksOf(asset())).toEqual([
      { label: "format", state: "ok" },
      { label: "size 16×16", state: "ok" },
      { label: "place", state: "ok" },
      { label: "palette", state: "ok" },
    ]);
  });
  it("warns about the palette without failing", () => {
    expect(checksOf(asset({ warnings: ["#123456 is outside the palette"] })).at(-1)).toEqual({ label: "palette: 1 warning", state: "warn" });
  });
  it("has none to show while the Asset is being redone", () => {
    expect(checksOf(asset(redoing))).toEqual([]);
  });
});

describe("version history", () => {
  const versions = [
    { id: 10, iteration: 1, attempt: 1, feedback: "too dark" },
    { id: 11, iteration: 2, attempt: 1, feedback: null },
  ];
  it("numbers versions and marks the last as current", () => {
    expect(historyOf(asset({ versions })).map((v) => [v.n, v.current])).toEqual([[1, false], [2, true]]);
    expect(earlierVersions(asset({ versions })).map((v) => v.id)).toEqual([10]);
  });
  it("has no current version while the Asset is being redone", () => {
    const a = asset({ ...redoing, versions: [versions[0]!] });
    expect(historyOf(a).some((v) => v.current)).toBe(false);
    expect(earlierVersions(a)).toHaveLength(1);
  });
});

describe("zoom", () => {
  it("brings the longest side to about 256 pixels in whole steps, 2 to 16", () => {
    expect(zoomOf({ width: 16, height: 16, frames: 1 })).toBe(16);
    expect(zoomOf({ width: 32, height: 32, frames: 1 })).toBe(8);
    expect(zoomOf({ width: 32, height: 32, frames: 4 })).toBe(2);
    expect(zoomOf({ width: 4, height: 4, frames: 1 })).toBe(16);
  });
});

describe("Verdicts", () => {
  const assets = [asset({ id: 3 }), asset({ id: 1 }), asset({ id: 2, status: "approved" })];
  it("drafts one approval per Asset waiting", () => {
    expect(Object.keys(draftsFor(assets))).toEqual(["1", "3"]);
    expect(waitingKey(assets)).toBe("3,1");
  });
  it("needs Feedback for every rejection", () => {
    const d = draftsFor(assets);
    expect(isComplete(d)).toBe(true);
    d[1] = { action: "reject", feedback: "  " };
    expect(isComplete(d)).toBe(false);
    expect(gateSummary(d).missing).toBe(1);
    d[1]!.feedback = "add a crack";
    expect(isComplete(d)).toBe(true);
  });
  it("sends Verdicts by Asset id, a rejection with its Feedback", () => {
    const d = draftsFor(assets);
    d[3] = { action: "reject", feedback: "darker" };
    expect(verdictsOf(d)).toEqual([{ assetId: 1, action: "approve" }, { assetId: 3, action: "reject", feedback: "darker" }]);
    expect(approveAllOf(d)).toEqual([{ assetId: 1, action: "approve" }, { assetId: 3, action: "approve" }]);
  });
  it("summarises for the bar", () => {
    const d = draftsFor(assets);
    d[1] = { action: "reject", feedback: "x" };
    expect(gateSummary(d)).toMatchObject({ count: 2, assets: "2 Assets to judge", send: "Send 2 Verdicts", rejected: 1, missing: 0 });
    expect(gateSummary(draftsFor([asset()])).send).toBe("Send 1 Verdict");
  });
});
