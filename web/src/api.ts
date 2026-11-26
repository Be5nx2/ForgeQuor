export interface Project {
  id: number;
  name: string;
  localPath: string;
  remoteOwner: string;
  remoteName: string;
  defaultBranch: string;
}
export interface Run {
  id: number;
  projectId: number;
  title: string;
  task: string;
  trackerRef: string | null;
  state: string;
  branch: string | null;
  worktreePath: string | null;
  prNumber: number | null;
  prUrl: string | null;
  createdAt: string;
}
export interface StepAttempt {
  id: number;
  step: string;
  attempt: number;
  runner: string;
  model: string | null;
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
  kind: "final" | "escalation";
  reason: string;
  evidence: string | null;
  actions: GateAction[];
  decidedAt: string | null;
  decision: GateAction | null;
}
export type GateAction = "approve" | "abandon";

/** Records the human's decision at a Gate and returns the updated Run. */
export function decideGate(gateId: number, action: GateAction): Promise<RunDetail> {
  return postJson(`/api/gates/${gateId}/decision`, { action });
}
export interface RunDetail extends Run {
  attempts: StepAttempt[];
  gates: Gate[];
}
export interface OpenGate extends Gate {
  runTitle: string;
  projectName: string;
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
