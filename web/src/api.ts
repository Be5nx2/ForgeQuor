// The API's shapes are the server's own (src/forge/types.ts), so the two can never drift apart. That module imports
// nothing, and these imports are types only: no server code reaches the browser.
import type * as Server from "../../src/forge/types.js";

/** A server shape as it arrives over JSON: every Date is a string. */
type Json<T> = T extends Date ? string : T extends (infer U)[] ? Json<U>[] : T extends object ? { [K in keyof T]: Json<T[K]> } : T;

export type Project = Json<Server.Project>;
export type ArtInfo = Json<Server.ArtInfo>;
export type WorkflowOption = Json<Server.WorkflowOption>;
export type WorkflowList = Json<Server.WorkflowList>;
export type AssetKind = Server.AssetKind;
export type ReviewMode = Server.ReviewMode;
export type AssetStatus = Server.AssetStatus;
export type AssetRequest = Json<Server.AssetRequest>;
export type Asset = Json<Server.Asset>;
export type AssetVersion = Json<Server.AssetVersion>;
export type AssetAttempt = Json<Server.AssetAttempt>;
export type Verdict = Json<Server.Verdict>;
export type GateVerdict = Json<Server.GateVerdict>;
export type CheckResult = Json<Server.CheckResult>;
export type RunState = Server.RunState;
export type Run = Json<Server.Run>;
export type StepAttempt = Json<Server.StepAttempt>;
export type GateKind = Server.GateKind;
export type GateAction = Server.GateAction;
export type Gate = Json<Server.Gate>;
export type Iteration = Json<Server.Iteration>;
export type Review = Json<Server.Review>;
export type ConversationTurn = Json<Server.ConversationTurn>;
export type RunNoteInfo = Json<Server.RunNoteInfo>;
export type RunNote = Json<Server.RunNote>;
export type RunDetail =Json<Server.RunDetail>;
export type OpenGate = Json<Server.OpenGate>;
export type ApprovedRun = Json<Server.ApprovedRun>;
export type RunUpdate = Json<Server.RunUpdate>;
export type QuotaReading = Json<Server.QuotaReading>;
export type QuotaStatus = Json<Server.QuotaStatus>;
export type DogfoodNature = Server.DogfoodNature;
export type DogfoodTarget = Server.DogfoodTarget;
export type DogfoodNote = Json<Server.DogfoodNote>;
export type DogfoodNoteList = Json<Server.DogfoodNoteList>;
export type DogfoodExport = Json<Server.DogfoodExport>;

/** Records the human's decision at a Gate and returns the updated Run. */
export function decideGate(gateId: number, action: GateAction, feedback?: string, verdicts?: Verdict[], target?: string, message?: string): Promise<RunDetail> {
  return postJson(`/api/gates/${gateId}/decision`, { action, feedback, verdicts, target, message });
}

export interface TeamField {
  value: string | null;
  source: "env" | "team" | "default";
  /** The environment variable that holds the field, when it does (the field is then locked). */
  variable?: string;
}
export interface CatalogModel {
  id: string;
  efforts: string[];
  defaultEffort: string | null;
}
export interface CatalogEntry {
  models: CatalogModel[];
  defaultModel: string | null;
  /** The levels of the default model and of a model the list does not know. */
  efforts: string[];
  /** True when the CLI could not be read and the list is the built-in one. */
  fallback: boolean;
}
export interface TeamSeat {
  seat: string;
  runner: TeamField;
  model: TeamField;
  /** A null value is the Runner's own default effort. */
  effort: TeamField;
}
export interface Team {
  seats: TeamSeat[];
  /** What each Runner offers, read from its CLI at startup. */
  catalog: Record<string, CatalogEntry>;
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

export async function deleteJson(url: string): Promise<void> {
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}
