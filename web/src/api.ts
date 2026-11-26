export interface Project {
  id: number;
  name: string;
  localPath: string;
  remoteOwner: string;
  remoteName: string;
  defaultBranch: string;
  checks: string[];
  setup: string[];
  maxConcurrentRuns: number;
  artDirectionPath: string;
  artFolder: string;
}
export type AssetKind = "sprite" | "tile";
export interface AssetRequest {
  name: string;
  kind: AssetKind;
  description: string;
  width: number;
  height: number;
  fill?: boolean;
}
export interface Asset extends AssetRequest {
  id: number;
  fill: boolean;
  position: number;
  targetPath: string;
  status: "pending" | "generating" | "waiting" | "approved";
  /** Colours outside the Art Direction's palette in the current version; a warning, never a failure. */
  warnings: string[];
  /** The versions the human saw, oldest first, each with the Feedback it got; the last is the current one. */
  versions: AssetVersion[];
}
export interface AssetVersion {
  id: number;
  iteration: number;
  attempt: number;
  feedback: string | null;
}
export interface Verdict {
  assetId: number;
  action: "approve" | "reject";
  feedback?: string;
}
export interface GateVerdict {
  assetId: number;
  verdict: "approve" | "reject";
  feedback: string | null;
}
export interface CheckResult {
  id: number;
  iteration: number;
  attempt: number;
  command: string;
  exitStatus: number | null;
  output: string;
}
export interface Run {
  id: number;
  projectId: number;
  workflow: string;
  iteration: number;
  title: string;
  task: string;
  trackerRef: string | null;
  state: string;
  branch: string | null;
  worktreePath: string | null;
  prNumber: number | null;
  prUrl: string | null;
  resumeAt: string | null;
  createdAt: string;
}
export interface StepAttempt {
  id: number;
  iteration: number;
  step: string;
  attempt: number;
  runner: string;
  model: string | null;
  assetId: number | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
  error: string | null;
  eventLog: string;
}
export interface Gate {
  id: number;
  runId: number;
  kind: "final" | "escalation" | "asset";
  reason: string;
  evidence: string | null;
  actions: GateAction[];
  decidedAt: string | null;
  decision: "approve" | "reject" | "abandon" | null;
  feedback: string | null;
  verdicts: GateVerdict[];
}
export type GateAction = "approve" | "reject" | "abandon" | "judge";

/** Records the human's decision at a Gate and returns the updated Run. */
export function decideGate(gateId: number, action: GateAction, feedback?: string, verdicts?: Verdict[]): Promise<RunDetail> {
  return postJson(`/api/gates/${gateId}/decision`, { action, feedback, verdicts });
}
export interface Iteration {
  number: number;
  feedback: string | null;
}
export interface RunDetail extends Run {
  assets: Asset[];
  iterations: Iteration[];
  attempts: StepAttempt[];
  checks: CheckResult[];
  gates: Gate[];
}
export interface OpenGate extends Gate {
  runTitle: string;
  projectName: string;
}

/** A live update from the server: a Step's progress, or a Run that changed. */
export type RunUpdate =
  | { type: "progress"; runId: number; attemptId: number; kind: "text" | "tool" | "other"; summary: string }
  | { type: "changed"; runId: number };

/**
 * Follows live Run updates over server-sent events. `onOpen` fires on every (re)connection, so a view can reload what it
 * missed meanwhile. Returns the function that stops following.
 */
export function followRuns(onUpdate: (update: RunUpdate) => void, onOpen?: () => void): () => void {
  const source = new EventSource("/api/events");
  source.onopen = () => onOpen?.();
  source.onmessage = (m) => onUpdate(JSON.parse(m.data));
  return () => source.close();
}

export async function putJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
  return res.json();
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}
