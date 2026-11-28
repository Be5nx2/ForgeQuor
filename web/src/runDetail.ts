// What the Run detail shows, worked out from a Run: the Step rail, which Step is selected, what the selected Step's panel
// holds, and the remarks of a Review. Plain data in, plain data out, so the screen only draws it.
import type { Gate, Iteration, Review, RunDetail, StepAttempt } from "./api.js";
import { attemptStatus, stepStatus, type Status } from "./status.js";

type Step = RunDetail["steps"][number];

/** How a Step's dot on the rail looks: finished, running, waiting for the human, not started (or skipped), failed. */
export type RailMark = "done" | "run" | "wait" | "idle" | "bad";

/** One line of the Step rail. */
export interface RailItem {
  /** The Step's id, or `stepId/name` for a sub-Step (one Agent of a `review` Step); what the URL keeps. */
  key: string;
  label: string;
  /** A sub-Step is indented under its Step. */
  sub: boolean;
  status: Status;
  mark: RailMark;
  /** Iteration and passes, as small print. */
  note: string;
  /** The Runner that works the Step; null for a Step no Agent works. */
  runner: string | null;
  model: string | null;
}

const titleCase = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** The Step's name for people: its Agent, "Spec Gate", "Checks". */
export function stepLabel(step: Pick<Step, "id" | "type" | "detail">): string {
  switch (step.type) {
    case "gate":
      return `${titleCase(step.detail ?? step.id)} Gate`;
    case "checks":
      return "Checks";
    case "publish":
      return "Open pull request";
    case "review":
      return "Review";
    case "artist":
      return "Artist";
    default:
      return titleCase(step.detail ?? step.id);
  }
}

/** An Agent's name as the Step attempts record it ("reviewer-a"), for the rail. */
function agentLabel(name: string, solo: boolean): string {
  if (name === "reviewer-a" && solo) return "Reviewer";
  const found = /^reviewer-(.)$/.exec(name);
  return found ? `Reviewer ${found[1]!.toUpperCase()}` : titleCase(name);
}

const openGates = (run: RunDetail): Gate[] => run.gates.filter((g) => !g.decidedAt);

/** The attempts that belong to a Step (a Run from before Workflows were frozen has none with a `stepId`: it falls back to the Agent's name). */
function attemptsOf(run: RunDetail, step: Step, agent?: string): StepAttempt[] {
  return run.attempts.filter((a) => (a.stepId ? a.stepId === step.id : a.step === step.detail) && (!agent || a.step === agent));
}

const pass = (n: number) => `${n} ${n === 1 ? "pass" : "passes"}`;
const MARK_OF: Record<Status["kind"], RailMark> = { running: "run", waiting: "wait", ok: "done", bad: "bad", idle: "idle" };

/** The Step rail: every Step of the Run in Workflow order; a `review` Step is followed by the Agents that reviewed (its sub-Steps). */
export function railOf(run: RunDetail): RailItem[] {
  const waitingFor = new Set(openGates(run).map((g) => g.stepId));
  const solo = run.review === "solo";
  const items: RailItem[] = [];
  for (const step of run.steps) {
    const attempts = attemptsOf(run, step);
    const last = attempts.at(-1);
    const waiting = waitingFor.has(step.id);
    const status: Status = waiting ? { kind: "waiting", glyph: "●", label: "Waiting for you" } : stepStatus(step.status);
    const notes = [`Iteration ${step.iteration}`, ...(step.attempts > 1 ? [pass(step.attempts)] : [])];
    items.push({
      key: step.id,
      label: stepLabel(step),
      sub: false,
      status,
      mark: MARK_OF[status.kind],
      note: notes.join(" · "),
      runner: step.type === "review" ? null : (last?.runner ?? null),
      model: step.type === "review" ? null : (last?.model ?? null),
    });
    if (step.type !== "review") continue;
    // Each Agent's latest attempt of the Step in its current Iteration.
    const latest = new Map<string, StepAttempt>();
    for (const a of attempts.filter((x) => x.iteration === step.iteration)) latest.set(a.step, a);
    for (const [name, a] of latest) {
      const s = attemptStatus(a.status);
      items.push({ key: `${step.id}/${name}`, label: agentLabel(name, solo), sub: true, status: s, mark: MARK_OF[s.kind], note: `Attempt ${a.attempt}`, runner: a.runner, model: a.model });
    }
  }
  return items;
}

/** Where the human lands when the URL names no Step: the Step that waits for them, else the one running, else the last one that finished, else the first. */
export function defaultSelection(rail: RailItem[], run: RunDetail): string {
  const gate = openGates(run).find((g) => g.stepId && rail.some((r) => r.key === g.stepId));
  if (gate) return gate.stepId!;
  const top = rail.filter((r) => !r.sub);
  const running = top.find((r) => r.mark === "run");
  if (running) return running.key;
  const failed = top.find((r) => r.mark === "bad");
  if (failed) return failed.key;
  return (top.filter((r) => r.mark === "done").at(-1) ?? top[0])?.key ?? "";
}

/** The Step in view: the one the URL names when the rail has it, else the default. */
export function resolveSelection(rail: RailItem[], wanted: string | null | undefined, run: RunDetail): string {
  return wanted && rail.some((r) => r.key === wanted) ? wanted : defaultSelection(rail, run);
}

/** The rail key one step above or below `key` (arrow keys), staying put at the ends. */
export function neighbour(rail: RailItem[], key: string, by: 1 | -1): string {
  const i = rail.findIndex((r) => r.key === key);
  return rail[Math.min(rail.length - 1, Math.max(0, i + by))]?.key ?? key;
}

/** One seat's use in a Step: who worked, through which Runner and model, how many attempts. */
export interface SeatUse {
  agent: string;
  runner: string;
  model: string | null;
  attempts: number;
}

/** What the panel of the selected Step is made of. */
export interface StepView {
  item: RailItem;
  step: Step;
  /** The sub-Step's Agent name ("reviewer-a") when a sub-Step is selected. */
  agent: string | null;
  attempts: StepAttempt[];
  /** The attempt now running, whose live events the log shows. */
  running: StepAttempt | null;
  seats: SeatUse[];
  /** The Gates this Step opened, oldest first. */
  gates: Gate[];
  /** The Gate waiting for the human at this Step, if any. */
  openGate: Gate | null;
  /** The Feedback the Step works from: the human's reasons for rejecting earlier Iterations. */
  feedback: Iteration[];
  reviews: Review[];
  remarks: RemarkTable | null;
}

/** What the panel of the Step `key` shows; null when the Run has no such Step. */
export function stepViewOf(run: RunDetail, key: string): StepView | null {
  const item = railOf(run).find((r) => r.key === key);
  const [id, agent = null] = key.split("/") as [string, string?];
  const step = run.steps.find((s) => s.id === id);
  if (!item || !step) return null;
  const attempts = attemptsOf(run, step, agent ?? undefined);
  const seats = new Map<string, SeatUse>();
  for (const a of attempts) {
    const k = `${a.step}|${a.runner}|${a.model}`;
    const seen = seats.get(k);
    if (seen) seen.attempts++;
    else seats.set(k, { agent: agentLabel(a.step, run.review === "solo"), runner: a.runner, model: a.model, attempts: 1 });
  }
  const gates = agent ? [] : run.gates.filter((g) => g.stepId === step.id);
  const agentWorks = step.type === "agent" || step.type === "artist" || step.type === "conversation";
  const reviews = step.type === "review" ? run.reviews.filter((r) => r.stepId === step.id && (!agent || r.author === agent)) : [];
  return {
    item,
    step,
    agent,
    attempts,
    running: attempts.find((a) => a.status === "running") ?? null,
    seats: [...seats.values()],
    gates,
    openGate: gates.find((g) => !g.decidedAt) ?? null,
    feedback: agentWorks ? run.iterations.filter((i) => i.feedback && i.number <= step.iteration) : [],
    reviews,
    remarks: step.type === "review" && !agent ? remarksOf(run.reviews.filter((r) => r.stepId === step.id)) : null,
  };
}

/** The Gate's name for the bar and the history. */
export function gateTitle(gate: Pick<Gate, "kind">): string {
  const titles: Record<Gate["kind"], string> = {
    final: "Final Gate",
    asset: "Asset Gate",
    review: "Review disagreement",
    spec: "Spec Gate",
    conversation: "Conversation Gate",
    escalation: "Escalation",
  };
  return titles[gate.kind];
}

// ---- Remarks of a Review ----

/** One remark: a finding of the Consolidator's (or the only Reviewer's) Review, or one it dropped. */
export interface Remark {
  id: string;
  text: string;
  /** `file:line`, when the remark starts with one. */
  where: string | null;
  dropped: boolean;
  /** What each Reviewer of a duo Review said about it: asked for a change, or let it pass. Empty for a solo Review. */
  votes: { reviewer: string; vote: "change" | "pass" }[];
  /** The Reviewers did not vote the same way. */
  disputed: boolean;
}

export interface RemarkTable {
  remarks: Remark[];
  /** What the Consolidator recommends the human decide, when it did. */
  recommendation: string | null;
  verdict: Review["verdict"];
}

interface Finding {
  text: string;
  where: string | null;
}

/** The bullet items under a heading ("Findings:", "Dropped:") of a Review's text; "None." counts as nothing. */
export function itemsUnder(body: string, heading: string): Finding[] {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^[ \\t*_#>-]*${heading}[ \\t*_]*:`, "i").test(l));
  if (start < 0) return [];
  const items: string[] = [];
  const first = lines[start]!.replace(new RegExp(`^[ \\t*_#>-]*${heading}[ \\t*_]*:[ \\t*_]*`, "i"), "").trim();
  if (first) items.push(first);
  let open = items.length > 0;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) {
      open = false; // a blank line ends the item
      continue;
    }
    if (/^[ \t*_#>-]*[A-Z][A-Za-z ]{1,20}[ \t*_]*:/.test(line) && !/^\s*[-*]\s/.test(line)) break; // the next heading
    const bullet = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      items.push(bullet[1]!.trim());
      open = true;
    } else if (open) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items
    .filter((t) => t && !/^none\.?$/i.test(t))
    .map((t) => {
      const found = /^`?([^\s`]+:\d+(?:[-–]\d+)?)`?\s*[-–—:]\s*([\s\S]*)$/.exec(t);
      return found ? { where: found[1]!, text: found[2]!.trim() } : { where: null, text: t };
    });
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
/** Two findings are the same remark when they point at the same place, or say mostly the same words. */
function sameRemark(a: Finding, b: Finding): boolean {
  if (a.where && b.where) return a.where === b.where;
  const [x, y] = [words(a.text), words(b.text)];
  const common = [...x].filter((w) => y.has(w)).length;
  return common > 0 && common / Math.min(x.size, y.size) >= 0.6;
}

/** What the Consolidator recommends: from its "Recommendation:" line to the end of its Review. */
export function recommendationOf(body: string): string | null {
  const found = /^[ \t*_#>-]*recommendation[ \t*_]*:[ \t*_]*([\s\S]*)$/im.exec(body);
  return found?.[1]?.trim() || null;
}

/**
 * The remarks of the Reviews of a `review` Step's latest attempt: the Review the Run acts on gives the remarks (its
 * findings, then what it dropped), and in a duo Review each Reviewer's Review gives that Reviewer's vote on it.
 * Null when the Step has no Review yet.
 */
export function remarksOf(reviews: Review[]): RemarkTable | null {
  const latest = reviews.reduce((n, r) => Math.max(n, r.iteration * 1000 + r.attempt), -1);
  const current = reviews.filter((r) => r.iteration * 1000 + r.attempt === latest);
  const final = current.find((r) => r.final);
  if (!final) return null;
  const reviewers = current.filter((r) => !r.final);
  const letter = (author: string) => /^reviewer-(.)$/.exec(author)?.[1]?.toUpperCase() ?? author;
  const said = reviewers.map((r) => ({ reviewer: letter(r.author), findings: itemsUnder(r.body, "findings") }));
  const make = (f: Finding, n: number, dropped: boolean): Remark => {
    const votes = said.map((s) => ({ reviewer: s.reviewer, vote: s.findings.some((x) => sameRemark(x, f)) ? ("change" as const) : ("pass" as const) }));
    return { id: `R${n}`, ...f, dropped, votes, disputed: new Set(votes.map((v) => v.vote)).size > 1 };
  };
  const kept = itemsUnder(final.body, "findings").map((f, i) => make(f, i + 1, false));
  const dropped = itemsUnder(final.body, "dropped").map((f, i) => make(f, kept.length + i + 1, true));
  return { remarks: [...kept, ...dropped], recommendation: recommendationOf(final.body), verdict: final.verdict };
}
