import type { StepTypeModule } from "./engine.js";
import type { GateKindModule } from "./gates.js";
import type { AgentModule } from "./step-types.js";
import type { Asset, GateVerdict } from "./types.js";
import type { Workflow } from "./workflow.js";

/** What an extension adds to one Run's detail. */
export interface RunDetailPart {
  assets: Asset[];
  /** Per Gate id: what the extension recorded at it, and the Feedback its decision gave (null when it rejected nothing). */
  gates: Map<number, { verdicts: GateVerdict[]; feedback: string | null }>;
}

/**
 * The seam between the Forge core and the Step types, Gate kinds and Workflows built on it. The core keeps the Run
 * lifecycle (slots, queue, Pause, restart, Gates as a mechanism, abandon, pull-request follow-up) and knows nothing of what
 * an extension stores: it asks.
 */
export interface Extension {
  workflows: Workflow[];
  /** The Gate kinds the extension decides. */
  gateKinds: GateKindModule[];
  /** The Agents a Workflow's Agent Step can name, besides the Developer. */
  agents?: AgentModule[];
  /** The Step types the extension adds to the engine's. */
  stepTypes?: StepTypeModule[];
  /** What the extension holds of a Run, for its detail, given the ids of the Run's Gates. */
  detail(runId: number, gateIds: number[]): Promise<RunDetailPart>;
  /** The file of an Asset image of a Run; throws an AssetNotFoundError for what it does not have. */
  assetImage(runId: number, assetId: number, which?: number | "replaced"): Promise<string>;
}
