import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StepRun, StepTypeModule } from "./engine.js";
import { requireSeat, type SeatName } from "./seats.js";
import { specOf } from "./spec.js";
import { runAgentStep } from "./step.js";
import type { GateKind, Review, ReviewMode, ReviewVerdict } from "./types.js";
import type { WorkflowContext } from "./workflow.js";
import { RUN_NOTES_DIR } from "./workspace.js";

/**
 * Where a Reviewer writes its Review, relative to the worktree: a Run Note, never committed. One note per author
 * (`review-a.md` for `reviewer-a`), so that Reviewers never overwrite each other; `review.md` is the Consolidator's.
 */
export const reviewNote = (author: string) => `${RUN_NOTES_DIR}/review-${author.replace(/^reviewer-/, "")}.md`;

/** The Consolidator's Run Note: the one Review a duo Run acts on. */
export const CONSOLIDATED_NOTE = `${RUN_NOTES_DIR}/review.md`;

/** Starts the reason a Review's rejection hands the Developer, so its prompt can tell a Review from a failed Check. */
export const REVIEW_REASON_PREFIX = "The Reviewer asked for changes.";

/** How many more times a Reviewer is asked when its Review has no usable verdict, within the same attempt of the Step. */
export const EXTRA_VERDICT_TRIES = 2;

/** A Reviewer Agent's standing instructions, for the Run Note it may write its Review to. */
export function reviewerInstructions(notePath: string): string {
  return `You are the Reviewer on a Forgequor Run. You read a change and write a Review of it; you never edit it.

- Work only inside the current directory, this Run's git worktree. Change nothing in it: no edits, no commits, no stash, no checkout. Only the Run Notes folder ${RUN_NOTES_DIR}/ may be written to.
- Do not run commands that write files outside ${RUN_NOTES_DIR}/ (a build, a formatter, a test run that leaves output): the Step fails if anything else in the worktree changes. Read, search and use git read commands.
- Use the \`code-review\` Skill: review the change on its two axes, Standards (does it follow this repository's documented standards, such as CLAUDE.md, AGENTS.md, CONTRIBUTING.md and the docs they point to?) and Spec (does it do what the task asked, no less and no more?).
- Check each finding against the code before you report it. Report only what you are sure of.
- Your FINAL MESSAGE is your Review: it is what Forgequor reads. You may also write the same text to ${notePath}, but you may not be able to (a read-only sandbox), so never rely on it. Use exactly this format:

    Summary: one or two sentences on what the change does and your overall judgement.

    Findings:
    - file:line - what is wrong or doubtful, and why (or "None.")

    Doubts: what you could not verify or are unsure of (or "None.")

    Verdict: pass

- The last line is exactly "Verdict: pass" or "Verdict: changes requested", with nothing after it.
- Ask for changes only for something the Developer must fix: a bug, a requirement that is missing or wrong, a breach of the repository's standards, a missing or weak test. Style preferences and optional ideas go under Findings without changing the verdict.`;
}

/** What a Reviewer's text said: its body and verdict, or what is wrong with it. */
export type ParsedReview = { verdict: ReviewVerdict; body: string } | { problem: string };

const REVIEWER_VERDICTS: readonly ReviewVerdict[] = ["pass", "changes requested"];
const CONSOLIDATOR_VERDICTS: readonly ReviewVerdict[] = ["pass", "changes requested", "disagreement"];
const orList = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`);

/**
 * Reads a Review in the fixed format: free text ending in a verdict line. A Reviewer's verdict is `pass` or `changes
 * requested`; the Consolidator may also say `disagreement` (see `parseConsolidation`).
 */
export function parseReview(text: string, allowed: readonly ReviewVerdict[] = REVIEWER_VERDICTS): ParsedReview {
  const lines = text.trimEnd().split("\n");
  const last = lines.at(-1)?.trim() ?? "";
  const found = /^[*_`\s]*verdict[*_`\s]*:[*_`\s]*(.*?)[*_`.\s]*$/i.exec(last);
  if (!found) return { problem: `The Review does not end with a verdict line: its last line must be ${orList(allowed.map((v) => `"Verdict: ${v}"`))}.` };
  const said = found[1]!.trim().toLowerCase().replace(/\s+/g, " ");
  if (!allowed.includes(said as ReviewVerdict)) {
    return { problem: `The Review's verdict is "${found[1]!.trim()}", but it must be ${orList(allowed.map((v) => `"${v}"`))}.` };
  }
  const body = lines.slice(0, -1).join("\n").trim();
  if (!body) return { problem: "The Review has a verdict but nothing before it: it must say what was found." };
  return { verdict: said as ReviewVerdict, body };
}

/** What the Consolidator recommends: from the line that starts with `Recommendation:` to the end of its Review; null when it has none. */
export function recommendationOf(body: string): string | null {
  const found = /^[ \t*_#>-]*recommendation[ \t*_]*:[ \t*_]*([\s\S]*)$/im.exec(body);
  return found?.[1]?.trim() || null;
}

/** Reads the Consolidator's Review: as a Reviewer's, and it may say `disagreement`, which must come with a recommendation. */
export function parseConsolidation(text: string): ParsedReview {
  const parsed = parseReview(text, CONSOLIDATOR_VERDICTS);
  if ("problem" in parsed || parsed.verdict !== "disagreement" || recommendationOf(parsed.body)) return parsed;
  return { problem: 'A disagreement must carry your recommendation: add a "Recommendation:" line saying what the human should decide, before the verdict line.' };
}

/** What a Reviewer's prompt is built from. */
export interface ReviewerPromptInput {
  task: string;
  defaultBranch: string;
  notePath: string;
  /** The human's Feedback on earlier rejections of the Run, oldest first. */
  feedbacks: string[];
  /** What was wrong with the Reviewer's previous try, when it is being asked again. */
  problem?: string;
  /** The summary of what to build that the human confirmed at a Conversation Gate, when the Run had one. */
  summary?: string | null;
  /** The spec the human approved, when the Run had one: what the change is then reviewed against, instead of the summary. */
  spec?: { path: string; content: string } | null;
}

/** What a Review of a Run that was grilled is also read against: the approved spec when there is one, else the confirmed summary. */
const reviewedAgainst = ({ spec, summary }: { spec?: { path: string; content: string } | null; summary?: string | null }) =>
  spec
    ? `\n\nThe human approved this spec (it is at ${spec.path} on the branch); review against it:\n\n${spec.content.trimEnd()}`
    : summary
      ? `\n\nThe human confirmed this summary of what to build; review against it:\n\n${summary}`
      : "";

/** The Reviewer's prompt: the task, the human's Feedback, the change to read and, on a retry, what was wrong with the last Review. */
export function reviewerPrompt({ task, defaultBranch, notePath, feedbacks, problem, summary, spec }: ReviewerPromptInput): string {
  const base = `origin/${defaultBranch}`;
  let prompt = `Review the change on this Run's branch.

What was asked (the task, which is the spec for this Run):

${task}`;
  prompt += reviewedAgainst({ spec, summary });
  if (feedbacks.length) {
    const history = feedbacks.map((f, i) => `${i + 1}. ${f}`).join("\n");
    prompt += `\n\nThe human rejected the Run's earlier work and gave this Feedback, which the change must now satisfy as well (the last is the latest):\n${history}`;
  }
  prompt += `

The change is everything since the default branch: run \`git log ${base}..HEAD --oneline\` and \`git diff ${base}...HEAD\`. Read the files it touches in full where the diff is not enough. Read the repository's own instructions and coding standards to know what the Project expects.

Give your Review as your final message, in the fixed format, ending with the verdict line (you may also write it to ${notePath}).`;
  if (problem) prompt += `\n\nYour previous try could not be used: ${problem}`;
  return prompt;
}


/** A Consolidator Agent's standing instructions, for the Run Note it may write the one Review to. */
export function consolidatorInstructions(notePath: string): string {
  return `You are the Consolidator on a Forgequor Run. Two Reviewers each reviewed the same change; you turn their two Reviews into the one Review the Run acts on. You never edit the change.

- Work only inside the current directory, this Run's git worktree. Change nothing in it: no edits, no commits, no stash, no checkout. Only the Run Notes folder ${RUN_NOTES_DIR}/ may be written to.
- Do not run commands that write files outside ${RUN_NOTES_DIR}/ (a build, a formatter, a test run that leaves output): the Step fails if anything else in the worktree changes. Read, search and use git read commands.
- Check every remark of both Reviews against the code before you keep it. Drop a remark that is wrong, already handled, or only a preference, and say so. Keep a remark you could confirm, once even when both Reviewers made it. A remark you cannot confirm and cannot refute is a doubt, not a finding.
- Your FINAL MESSAGE is the Review: it is what Forgequor reads. You may also write the same text to ${notePath}, but you may not be able to (a read-only sandbox), so never rely on it. Use exactly this format:

    Summary: one or two sentences on what the change does and your overall judgement.

    Findings:
    - file:line - what is wrong, and why, as you confirmed it (or "None.")

    Dropped: each remark you did not keep, and why (or "None.")

    Doubts: what could not be settled (or "None.")

    Verdict: pass

- The last line is exactly "Verdict: pass", "Verdict: changes requested" or "Verdict: disagreement", with nothing after it.
- "changes requested" when at least one confirmed finding is something the Developer must fix. "pass" when none is.
- "disagreement" only when the Reviewers truly disagree about something the Developer's change turns on, and the code and the task cannot settle it. Then add, before the verdict line, a line starting with "Recommendation:" that says what you would decide and why; the human decides. Do not use it for a remark you were merely unsure of.`;
}

/** One Review that goes into the Consolidator's. */
export interface ReviewInput {
  /** The Reviewer's name: "reviewer-a". */
  author: string;
  verdict: ReviewVerdict;
  body: string;
}

/** What the Consolidator's prompt is built from. */
export interface ConsolidatorPromptInput {
  task: string;
  defaultBranch: string;
  notePath: string;
  reviews: ReviewInput[];
  feedbacks: string[];
  problem?: string;
  summary?: string | null;
  spec?: { path: string; content: string } | null;
}

/** The Consolidator's prompt: the task, the human's Feedback, both Reviews and the change to check them against. */
export function consolidatorPrompt({ task, defaultBranch, notePath, reviews, feedbacks, problem, summary, spec }: ConsolidatorPromptInput): string {
  const base = `origin/${defaultBranch}`;
  let prompt = `Consolidate the Reviews of the change on this Run's branch into one.

What was asked (the task, which is the spec for this Run):

${task}`;
  prompt += reviewedAgainst({ spec, summary });
  if (feedbacks.length) {
    prompt += `\n\nThe human's Feedback on earlier tries, oldest first (the change must satisfy it):\n\n${feedbacks.map((f, i) => `${i + 1}. ${f}`).join("\n")}`;
  }
  for (const r of reviews) prompt += `\n\n--- Review by ${reviewerLabel(r.author)}, verdict: ${r.verdict} ---\n\n${r.body}`;
  prompt += `

--- End of the Reviews ---

The change is everything since the default branch: run \`git log ${base}..HEAD --oneline\` and \`git diff ${base}...HEAD\`. Read the files it touches in full where the diff is not enough, and check each remark above against them.

Give the one Review as your final message, in the fixed format, ending with the verdict line (you may also write it to ${notePath}).`;
  if (problem) prompt += `\n\nYour previous try could not be used: ${problem}`;
  return prompt;
}

/** The section of the Review Brief that tells the pull request's reader what was reviewed, from the Review the Run acted on. */
export function reviewSection(review: Review | null): string {
  if (!review) return "";
  const limit = 4000;
  const body = review.body.length > limit ? `${review.body.slice(0, limit).trimEnd()}\n\n(The Review is cut here; the Run detail has all of it.)` : review.body;
  // A disagreement only gets this far when the human approved it at the review Gate.
  const verdict = review.verdict === "disagreement" ? "disagreement, approved by the human" : review.verdict;
  return `## Review (${verdict})\n\n${body}`;
}

/** The Review as its author left it: its Run Note when it parses, else its final message. */
function readReview(worktreePath: string, notePath: string, finalMessage: string, parse: (text: string) => ParsedReview): ParsedReview {
  const file = join(worktreePath, notePath);
  if (existsSync(file)) {
    const fromNote = parse(readFileSync(file, "utf8"));
    if (!("problem" in fromNote)) return fromNote;
  }
  return parse(finalMessage);
}

function writeNote(worktreePath: string, notePath: string, text: string): void {
  const file = join(worktreePath, notePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${text.trim()}\n`);
}

/**
 * What one way of reviewing came to: the Run cannot go on (an Escalation opened, a Pause, an abandon), or the verdict of
 * the Review the Run acts on. A `disagreement` verdict carries the Reviews the human is shown at the review Gate.
 */
export type Reviewed = { stop: true } | { verdict: ReviewVerdict; body: string; evidence?: string };

/** One way of reviewing a Run's change. Each reads and records its own Reviews, and returns the one the Run acts on. */
export type Reviewer = (run: StepRun) => Promise<Reviewed>;

/** "reviewer-a" is "Reviewer A (reviewer-a)": what a failure names, so that the two Reviewers are told apart. */
export function reviewerLabel(author: string): string {
  const found = /^reviewer-(.)$/.exec(author);
  return found ? `Reviewer ${found[1]!.toUpperCase()} (${author})` : author;
}

/** Which Reviewer runs, and where its Review goes. */
export interface ReviewerSeat {
  /** The seat whose Runner and model it works through. */
  seat: SeatName;
  /** Its name in the Run's record: the Step attempts and the Review's author. */
  name: string;
  /** Its Run Note, relative to the worktree. */
  notePath: string;
  /** Whether its Review is the one the Run acts on (the only Reviewer's, or the Consolidator's), as opposed to one that goes into it. */
  final: boolean;
}

/** What differs between a Reviewer and the Consolidator when one of them is run. */
interface ReviewingSpec extends ReviewerSeat {
  /** What it is called in an Escalation about its seat or its missing verdict ("Reviewer", "Reviewer B"). */
  noun: string;
  /** Who failed, when it fails; by default "The" and its name capitalised. */
  title?: string;
  instructions: string;
  prompt(input: { feedbacks: string[]; problem?: string }): string;
  parse(text: string): ParsedReview;
}

/**
 * Runs one read-only Agent that writes a Review and keeps its Review. A Review without a usable verdict is asked for
 * again, up to EXTRA_VERDICT_TRIES more times, inside the same attempt of the Step: that does not use up the review's
 * `max_attempts`. When it never gives one, an Escalation opens with what was wrong. Never touches another author's note.
 */
async function runReviewing({ ctx, step, state }: StepRun, spec: ReviewingSpec): Promise<Reviewed> {
  const seat = await requireSeat(ctx, spec.seat, spec.noun);
  if (!seat) return { stop: true };
  const attempt = state.attempts + 1;
  const feedbacks = await ctx.records.earlierFeedbacks();
  let problem: string | undefined;
  for (let tries = 1; tries <= 1 + EXTRA_VERDICT_TRIES; tries++) {
    rmSync(join(ctx.worktreePath, spec.notePath), { force: true });
    const result = await runAgentStep(ctx, seat, {
      name: spec.name,
      title: spec.title,
      stepId: step.id,
      attempt,
      instructions: spec.instructions,
      prompt: spec.prompt({ feedbacks, problem }),
      readonly: step.readonly,
    });
    if (!result) return { stop: true };
    const parsed = readReview(ctx.worktreePath, spec.notePath, result.summary, spec.parse);
    if ("problem" in parsed) {
      problem = parsed.problem;
      continue;
    }
    writeNote(ctx.worktreePath, spec.notePath, `${parsed.body}\n\nVerdict: ${parsed.verdict}`);
    await ctx.records.recordReview({ stepId: step.id, attempt, author: spec.name, verdict: parsed.verdict, body: parsed.body, final: spec.final });
    ctx.changed();
    return parsed;
  }
  await ctx.openGate("escalation", `The ${spec.noun} gave no usable verdict after ${1 + EXTRA_VERDICT_TRIES} tries.`, problem);
  return { stop: true };
}

/** Runs one read-only Reviewer, which reviews the change on its own and gives `pass` or `changes requested`. */
export async function runReviewer(run: StepRun, seat: ReviewerSeat & { noun?: string }): Promise<Reviewed> {
  const { ctx } = run;
  const summary = await ctx.records.conversation.confirmedSummary();
  const spec = await specOf(ctx);
  return runReviewing(run, {
    ...seat,
    noun: seat.noun ?? "Reviewer",
    title: reviewerLabel(seat.name),
    instructions: reviewerInstructions(seat.notePath),
    prompt: ({ feedbacks, problem }) =>
      reviewerPrompt({ task: ctx.run.task, defaultBranch: ctx.defaultBranch, notePath: seat.notePath, feedbacks, problem, summary, spec }),
    parse: parseReview,
  });
}

/** Runs the read-only Consolidator on the Reviews it is given: it checks them against the code and gives the one Review. */
export async function runConsolidator(run: StepRun, reviews: ReviewInput[]): Promise<Reviewed> {
  const { ctx } = run;
  const summary = await ctx.records.conversation.confirmedSummary();
  const spec = await specOf(ctx);
  const reviewed = await runReviewing(run, {
    seat: "consolidator",
    name: "consolidator",
    notePath: CONSOLIDATED_NOTE,
    final: true,
    noun: "Consolidator",
    instructions: consolidatorInstructions(CONSOLIDATED_NOTE),
    prompt: ({ feedbacks, problem }) =>
      consolidatorPrompt({ task: ctx.run.task, defaultBranch: ctx.defaultBranch, notePath: CONSOLIDATED_NOTE, reviews, feedbacks, problem, summary, spec }),
    parse: parseConsolidation,
  });
  if ("stop" in reviewed || reviewed.verdict !== "disagreement") return reviewed;
  // The human is shown what each side said next to what the Consolidator made of it.
  const sides = reviews.map((r) => `${reviewerLabel(r.author)}, verdict ${r.verdict}:\n\n${r.body}`);
  return { ...reviewed, evidence: [`Consolidator's Review:\n\n${reviewed.body}`, ...sides].join("\n\n---\n\n") };
}

/** One Reviewer reads the change and writes the one Review. */
const soloReview: Reviewer = (run) => runReviewer(run, { seat: "reviewer-a", name: "reviewer-a", notePath: reviewNote("reviewer-a"), final: true });

/** What a Reviewer asked of the Run while it ran beside the other: held back so that only one stop is applied. */
type Held = { kind: GateKind; reason: string; evidence?: string } | { pause: Date | null };

/**
 * Two Reviewers, Claude and Codex, read the change at the same time, both read-only; then the Consolidator checks their
 * Reviews against the code and writes the one Review. Both Reviewers could need the human at once (a failure, a Quota
 * pause), so each runs with a context that only notes what it would open, and the stops are applied afterwards in a
 * fixed order, `reviewer-a` first: a Run gets one Gate or Pause, never two.
 */
const duoReview: Reviewer = async (run) => {
  const { ctx } = run;
  const seats: ReviewerSeat[] = [
    { seat: "reviewer-a", name: "reviewer-a", notePath: reviewNote("reviewer-a"), final: false },
    { seat: "reviewer-b", name: "reviewer-b", notePath: reviewNote("reviewer-b"), final: false },
  ];
  const held = new Map<string, Held>();
  const quietly = (name: string): WorkflowContext => ({
    ...ctx,
    openGate: async (kind, reason, evidence) => void (!held.has(name) && held.set(name, { kind, reason, evidence })),
    pause: async (resetsAt) => void (!held.has(name) && held.set(name, { pause: resetsAt })),
  });
  const settled = await Promise.allSettled(
    seats.map((s) => runReviewer({ ...run, ctx: quietly(s.name) }, { ...s, noun: reviewerLabel(s.name).split(" (")[0]! })),
  );
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) throw failed.reason;

  for (const { name } of seats) {
    const stop = held.get(name);
    if (!stop) continue;
    if ("pause" in stop) await ctx.pause(stop.pause);
    else await ctx.openGate(stop.kind, stop.reason, stop.evidence);
    return { stop: true };
  }
  const reviews: ReviewInput[] = [];
  for (const [i, s] of settled.entries()) {
    const reviewed = (s as PromiseFulfilledResult<Reviewed>).value;
    // A Reviewer that stopped without asking for anything: the human abandoned the Run.
    if ("stop" in reviewed) return reviewed;
    reviews.push({ author: seats[i]!.name, verdict: reviewed.verdict, body: reviewed.body });
  }
  return runConsolidator(run, reviews);
};

/** How each review mode runs. Each mode is a Reviewer of its own and nothing else in this module knows the modes. */
const reviewers: Record<ReviewMode, Reviewer> = {
  solo: soloReview,
  duo: duoReview,
};

/** Why the review Gate opens, as the human reads it: the Consolidator's recommendation comes with it. */
function disagreementReason(body: string): string {
  const recommendation = recommendationOf(body);
  return `The Reviewers disagree and the Consolidator could not settle it.${recommendation ? ` Its recommendation: ${recommendation}` : ""}`;
}

/**
 * The Review Step type: the Run's change is reviewed in the mode the Run was launched with. A pass is done; changes
 * requested reject to the Step's `on_reject` (the Developer) with the Review as the reason, and the Checks run again
 * before the next Review. A disagreement the Consolidator could not settle opens a review Gate and waits; when the
 * human has decided, the Step goes on from their decision: approved is a pass, rejected sends the Developer back with
 * their Feedback, which counts as changes requested.
 */
export const reviewStepType: StepTypeModule = {
  type: "review",
  exhausted: (_step, attempts) => `The Reviewer still asks for changes after ${attempts} ${attempts === 1 ? "attempt" : "attempts"}.`,
  async execute(run) {
    const { ctx, step } = run;
    const decision = await ctx.records.gateDecision(step.id);
    if (decision === null) return { next: "stop" };
    if (decision === "approve") return { next: "done" };
    if (decision === "reject") {
      const feedback = (await ctx.records.gateFeedback(step.id)) ?? "";
      const consolidated = (await ctx.records.finalReview())?.body ?? "";
      return {
        next: "reject",
        reason: `${REVIEW_REASON_PREFIX}\n\nThe Reviewers disagreed, and the human rejected the change with this Feedback:\n\n${feedback}\n\nThe Consolidator's Review:\n\n${consolidated}`,
      };
    }
    const mode: ReviewMode = await ctx.records.reviewMode();
    const reviewed = await reviewers[mode](run);
    if ("stop" in reviewed) return { next: "stop" };
    if (reviewed.verdict === "pass") return { next: "done" };
    if (reviewed.verdict === "disagreement") {
      await ctx.openGate("review", disagreementReason(reviewed.body), reviewed.evidence);
      return { next: "stop" };
    }
    return { next: "reject", reason: `${REVIEW_REASON_PREFIX}\n\n${reviewed.body}` };
  },
};
