// What the Runs home shows, as plain functions: the state pills, a Run's "Now" cell, the Gate cards' wording and the
// relative times. No DOM and no Vue, so the root tests can load it.
import type { GateKind, RunState } from "../../src/forge/types.js";

/** The pills over "All Runs": `states` are the Run states a pill keeps (all of them for "All"). */
export const statePills = [
  { id: "all", label: "All", states: null },
  { id: "running", label: "Running", states: ["running"] },
  { id: "waiting", label: "Waiting", states: ["waiting"] },
  { id: "queued", label: "Queued", states: ["queued"] },
  { id: "paused", label: "Paused", states: ["paused"] },
  { id: "done", label: "Done", states: ["approved", "merged", "closed", "abandoned"] },
] as const satisfies readonly { id: string; label: string; states: readonly RunState[] | null }[];

export type PillId = (typeof statePills)[number]["id"];

export function keepsState(pill: PillId, state: RunState): boolean {
  const states: readonly RunState[] | null = statePills.find((p) => p.id === pill)!.states;
  return !states || states.includes(state);
}

/** Runs not over: they hold a slot or wait for one. */
export const isActive = (state: RunState) => state === "queued" || state === "running" || state === "waiting" || state === "paused";

const GATE_LABEL: Record<GateKind, string> = {
  final: "Final Gate",
  review: "Review Gate",
  spec: "Spec Gate",
  conversation: "Conversation Gate",
  asset: "Asset Gate",
  escalation: "Escalation",
};
export const gateLabel = (kind: GateKind) => GATE_LABEL[kind];
/** The card's button: a Conversation Gate asks for answers, every other one is opened. */
export const gateAction = (kind: GateKind) => (kind === "conversation" ? "Answer" : "Open");

/** The part of a Run's detail the "Now" cell reads. */
export interface NowInput {
  steps: { status: string; id: string; detail: string | null; attempts: number }[];
  gates: { decidedAt: string | null; kind: GateKind }[];
}

export interface Now {
  /** The current Step. */
  text: string;
  /** What more is worth saying about it. */
  sub: string;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** A Run's "Now": its current Step (and why it is there), or, when none is moving, the word that fits its state. */
export function nowOf(run: { state: RunState; prNumber: number | null; resumeAt: string | null }, detail?: NowInput): Now {
  if (run.state === "queued") return { text: "waiting for a free slot", sub: "" };
  if (run.state === "approved" || run.state === "merged") return { text: run.prNumber ? `pull request #${run.prNumber}` : "", sub: "" };
  const step = detail?.steps.find((s) => s.status === "running");
  if (!step) return { text: "", sub: "" };
  const text = capitalize(step.detail ?? step.id);
  const gate = detail!.gates.find((g) => !g.decidedAt);
  if (run.state === "waiting" && gate) return { text, sub: gateLabel(gate.kind) };
  if (run.state === "paused") return { text, sub: run.resumeAt ? `Quota, resumes ${clock(run.resumeAt)}` : "Quota used up" };
  return { text, sub: step.attempts ? `attempt ${step.attempts + 1}` : "" };
}

/** "waiting 4 min": how long a Gate has been open. */
export function waitingFor(openedAt: string, now = Date.now()): string {
  const min = Math.max(0, Math.floor((now - new Date(openedAt).getTime()) / 60_000));
  if (min < 1) return "waiting less than a minute";
  if (min < 60) return `waiting ${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `waiting ${h} h` : `waiting ${Math.floor(h / 24)} d`;
}

/** The "Started" cell: the time for today's Runs, then "yesterday" and "N days ago". */
export function startedLabel(createdAt: string, now = new Date()): string {
  const at = new Date(createdAt);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return clock(createdAt);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
