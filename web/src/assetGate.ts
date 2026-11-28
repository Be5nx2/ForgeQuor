// What the Asset Gate shows and decides, worked out from the Assets: the Asset Checks of each one, its version history,
// and the human's Verdicts (one per Asset waiting, Feedback required to reject). Plain data in, plain data out.
import type { Asset, Verdict } from "./api.js";

/** The Asset statuses whose current version has an image to show. */
const WITH_IMAGE: string[] = ["waiting", "approved", "rejected"];
export const hasImage = (a: Pick<Asset, "status">): boolean => WITH_IMAGE.includes(a.status);

/** One Asset Check as a chip: it passed, passed with a warning (a warning never fails an Asset), or failed. */
export interface AssetCheck {
  label: string;
  state: "ok" | "warn" | "bad";
}

/**
 * The Asset Checks of an Asset's current version. An Asset only reaches the human once format, size and placement pass, so
 * those show as passed; the palette shows its warnings. An Asset with no current version (being redone) has none to show.
 */
export function checksOf(a: Pick<Asset, "status" | "width" | "height" | "warnings">): AssetCheck[] {
  if (!hasImage(a)) return [];
  const outside = a.warnings.length;
  return [
    { label: "format", state: "ok" },
    { label: `size ${a.width}×${a.height}`, state: "ok" },
    { label: "place", state: "ok" },
    outside ? { label: `palette: ${outside} ${outside === 1 ? "warning" : "warnings"}`, state: "warn" } : { label: "palette", state: "ok" },
  ];
}

/** One version of an Asset in its history, numbered from 1 in the order the human saw them. */
export interface VersionEntry {
  id: number;
  n: number;
  iteration: number;
  /** The Feedback that sent this version back, if any. */
  feedback: string | null;
  current: boolean;
}

/** The versions of an Asset, oldest first; the last is the current one only when the Asset has a current version. */
export function historyOf(a: Pick<Asset, "status" | "versions">): VersionEntry[] {
  const last = a.versions.length - 1;
  return a.versions.map((v, i) => ({ id: v.id, n: i + 1, iteration: v.iteration, feedback: v.feedback, current: i === last && hasImage(a) }));
}

/** The versions before the current one. */
export const earlierVersions = (a: Pick<Asset, "status" | "versions">): VersionEntry[] => historyOf(a).filter((v) => !v.current);

/** Magnification that brings the longest side to about 256 screen pixels, in whole steps so pixels stay square. */
export const zoomOf = (a: Pick<Asset, "width" | "frames" | "height">): number =>
  Math.min(16, Math.max(2, Math.floor(256 / Math.max(a.width * a.frames, a.height))));

/** The human's draft Verdict on one Asset. */
export interface VerdictDraft {
  action: "approve" | "reject";
  feedback: string;
}
export type VerdictDrafts = Record<number, VerdictDraft>;

/** A draft for each Asset waiting for the human, all approving. */
export const draftsFor = (assets: Pick<Asset, "id" | "status">[]): VerdictDrafts =>
  Object.fromEntries(assets.filter((a) => a.status === "waiting").map((a) => [a.id, { action: "approve" as const, feedback: "" }]));

/** Which Assets are waiting: when this changes the drafts start over. */
export const waitingKey = (assets: Pick<Asset, "id" | "status">[]): string =>
  assets.filter((a) => a.status === "waiting").map((a) => a.id).join();

/** How many rejections still lack Feedback. */
export const missingFeedback = (drafts: VerdictDrafts): number =>
  Object.values(drafts).filter((v) => v.action === "reject" && !v.feedback.trim()).length;

/** Every rejection carries Feedback. */
export const isComplete = (drafts: VerdictDrafts): boolean => missingFeedback(drafts) === 0;

const byAsset = (a: Verdict, b: Verdict) => a.assetId - b.assetId;

/** The Verdicts to send, one per Asset waiting, by Asset id. A rejection carries its Feedback as typed. */
export const verdictsOf = (drafts: VerdictDrafts): Verdict[] =>
  Object.entries(drafts)
    .map(([id, v]): Verdict => (v.action === "reject" ? { assetId: Number(id), action: "reject", feedback: v.feedback } : { assetId: Number(id), action: "approve" }))
    .sort(byAsset);

/** The Verdicts of "Approve all". */
export const approveAllOf = (drafts: VerdictDrafts): Verdict[] =>
  Object.keys(drafts).map((id): Verdict => ({ assetId: Number(id), action: "approve" })).sort(byAsset);

/** The bar's summary and submit label: "3 Assets to judge", "Send 3 Verdicts". */
export function gateSummary(drafts: VerdictDrafts): { count: number; assets: string; send: string; rejected: number; missing: number } {
  const count = Object.keys(drafts).length;
  return {
    count,
    assets: `${count} ${count === 1 ? "Asset" : "Assets"} to judge`,
    send: `Send ${count} ${count === 1 ? "Verdict" : "Verdicts"}`,
    rejected: Object.values(drafts).filter((v) => v.action === "reject").length,
    missing: missingFeedback(drafts),
  };
}
