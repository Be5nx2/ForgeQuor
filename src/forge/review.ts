import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StepRun, StepTypeModule } from "./engine.js";
import { requireSeat, type SeatName } from "./seats.js";
import { runAgentStep } from "./step.js";
import type { Review, ReviewMode, ReviewVerdict } from "./types.js";
import { RUN_NOTES_DIR } from "./workspace.js";

/**
 * Where a Reviewer writes its Review, relative to the worktree: a Run Note, never committed. One note per author
 * (`review-a.md` for `reviewer-a`), so that Reviewers never overwrite each other; `review.md` is the Consolidator's.
 */
export const reviewNote = (author: string) => `${RUN_NOTES_DIR}/review-${author.replace(/^reviewer-/, "")}.md`;

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

/** Reads a Review in the fixed format: free text ending in a verdict line, `Verdict: pass` or `Verdict: changes requested`. */
export function parseReview(text: string): ParsedReview {
  const lines = text.trimEnd().split("\n");
  const last = lines.at(-1)?.trim() ?? "";
  const found = /^[*_`\s]*verdict[*_`\s]*:[*_`\s]*(.*?)[*_`.\s]*$/i.exec(last);
  if (!found) return { problem: 'The Review does not end with a verdict line: its last line must be "Verdict: pass" or "Verdict: changes requested".' };
  const said = found[1]!.trim().toLowerCase().replace(/\s+/g, " ");
  if (said !== "pass" && said !== "changes requested") {
    return { problem: `The Review's verdict is "${found[1]!.trim()}", but it must be "pass" or "changes requested".` };
  }
  const body = lines.slice(0, -1).join("\n").trim();
  if (!body) return { problem: "The Review has a verdict but nothing before it: it must say what was found." };
  return { verdict: said, body };
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
}

/** The Reviewer's prompt: the task, the human's Feedback, the change to read and, on a retry, what was wrong with the last Review. */
export function reviewerPrompt({ task, defaultBranch, notePath, feedbacks, problem }: ReviewerPromptInput): string {
  const base = `origin/${defaultBranch}`;
  let prompt = `Review the change on this Run's branch.

What was asked (the task, which is the spec for this Run):

${task}`;
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

/** The section of the Review Brief that tells the pull request's reader what was reviewed, from the Review the Run acted on. */
export function reviewSection(review: Review | null): string {
  if (!review) return "";
  const limit = 4000;
  const body = review.body.length > limit ? `${review.body.slice(0, limit).trimEnd()}\n\n(The Review is cut here; the Run detail has all of it.)` : review.body;
  return `## Review (${review.verdict})\n\n${body}`;
}

/** The Review as a Reviewer left it: its Run Note when it parses, else its final message. */
function readReview(worktreePath: string, notePath: string, finalMessage: string): ParsedReview {
  const file = join(worktreePath, notePath);
  if (existsSync(file)) {
    const fromNote = parseReview(readFileSync(file, "utf8"));
    if (!("problem" in fromNote)) return fromNote;
  }
  return parseReview(finalMessage);
}

function writeNote(worktreePath: string, notePath: string, text: string): void {
  const file = join(worktreePath, notePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${text.trim()}\n`);
}

/**
 * What one way of reviewing came to: the Run cannot go on (an Escalation opened, a Pause, an abandon), or the verdict of
 * the Review the Run acts on. New outcomes (a disagreement, for duo) are further members of this union.
 */
export type Reviewed = { stop: true } | { verdict: ReviewVerdict; body: string };

/** One way of reviewing a Run's change. Each reads and records its own Reviews, and returns the one the Run acts on. */
export type Reviewer = (run: StepRun) => Promise<Reviewed>;

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

/**
 * Runs one read-only Reviewer and keeps its Review. A Review without a usable verdict is asked for again, up to
 * EXTRA_VERDICT_TRIES more times, inside the same attempt of the Step: that does not use up the review's `max_attempts`.
 * When it never gives one, an Escalation opens with what was wrong. Never touches another author's note.
 */
export async function runReviewer({ ctx, step, state }: StepRun, { seat: seatName, name, notePath, final }: ReviewerSeat): Promise<Reviewed> {
  const seat = await requireSeat(ctx, seatName, "Reviewer");
  if (!seat) return { stop: true };
  const attempt = state.attempts + 1;
  const feedbacks = await ctx.records.earlierFeedbacks();
  let problem: string | undefined;
  for (let tries = 1; tries <= 1 + EXTRA_VERDICT_TRIES; tries++) {
    rmSync(join(ctx.worktreePath, notePath), { force: true });
    const result = await runAgentStep(ctx, seat, {
      name,
      stepId: step.id,
      attempt,
      instructions: reviewerInstructions(notePath),
      prompt: reviewerPrompt({ task: ctx.run.task, defaultBranch: ctx.defaultBranch, notePath, feedbacks, problem }),
      readonly: step.readonly,
    });
    if (!result) return { stop: true };
    const parsed = readReview(ctx.worktreePath, notePath, result.summary);
    if ("problem" in parsed) {
      problem = parsed.problem;
      continue;
    }
    writeNote(ctx.worktreePath, notePath, `${parsed.body}\n\nVerdict: ${parsed.verdict}`);
    await ctx.records.recordReview({ stepId: step.id, attempt, author: name, verdict: parsed.verdict, body: parsed.body, final });
    ctx.changed();
    return parsed;
  }
  await ctx.openGate("escalation", `The Reviewer gave no usable verdict after ${1 + EXTRA_VERDICT_TRIES} tries.`, problem);
  return { stop: true };
}

/** One Reviewer reads the change and writes the one Review. */
const soloReview: Reviewer = (run) => runReviewer(run, { seat: "reviewer-a", name: "reviewer-a", notePath: reviewNote("reviewer-a"), final: true });

/**
 * How each review mode runs. This is the seam of duo review: m3-12 gives `duo` its own Reviewer (two Reviewers side by
 * side, then the Consolidator) and nothing else in this module changes.
 */
const reviewers: Record<ReviewMode, Reviewer> = {
  solo: soloReview,
  // TODO(m3-12): duo runs reviewer-a and reviewer-b in parallel, then the Consolidator. Until then a duo Run is reviewed solo.
  duo: soloReview,
};

/**
 * The Review Step type: the Run's change is reviewed in the mode the Run was launched with. A pass is done; changes
 * requested reject to the Step's `on_reject` (the Developer) with the Review as the reason, and the Checks run again
 * before the next Review.
 */
export const reviewStepType: StepTypeModule = {
  type: "review",
  exhausted: (_step, attempts) => `The Reviewer still asks for changes after ${attempts} ${attempts === 1 ? "attempt" : "attempts"}.`,
  async execute(run) {
    const mode: ReviewMode = await run.ctx.records.reviewMode();
    const reviewed = await reviewers[mode](run);
    if ("stop" in reviewed) return { next: "stop" };
    if (reviewed.verdict === "pass") return { next: "done" };
    return { next: "reject", reason: `${REVIEW_REASON_PREFIX}\n\n${reviewed.body}` };
  },
};
