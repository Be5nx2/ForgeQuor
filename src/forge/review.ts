import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StepOutcome, StepRun, StepTypeModule } from "./engine.js";
import { requireSeat } from "./seats.js";
import { runAgentStep } from "./step.js";
import type { Review, ReviewMode, ReviewVerdict } from "./types.js";
import { RUN_NOTES_DIR } from "./workspace.js";

/** Where a Reviewer writes its Review, relative to the worktree: a Run Note, never committed. */
export const REVIEW_NOTE = `${RUN_NOTES_DIR}/review.md`;

/** Starts the reason a Review's rejection hands the Developer, so its prompt can tell a Review from a failed Check. */
export const REVIEW_REASON_PREFIX = "The Reviewer asked for changes.";

/** The Reviewer Agent's standing instructions. */
export const REVIEWER_INSTRUCTIONS = `You are the Reviewer on a Forgequor Run. You read a change and write a Review of it; you never edit it.

- Work only inside the current directory, this Run's git worktree. Change nothing in it: no edits, no commits, no stash, no checkout. Only the Run Notes folder ${RUN_NOTES_DIR}/ may be written to.
- Use the \`code-review\` Skill: review the change on its two axes, Standards (does it follow this repository's documented standards, such as CLAUDE.md, AGENTS.md, CONTRIBUTING.md and the docs they point to?) and Spec (does it do what the task asked, no less and no more?).
- Check each finding against the code before you report it. Report only what you are sure of.
- Write your Review to ${REVIEW_NOTE}, and give the same text as your final message. Use exactly this format:

    Summary: one or two sentences on what the change does and your overall judgement.

    Findings:
    - file:line - what is wrong or doubtful, and why (or "None.")

    Doubts: what you could not verify or are unsure of (or "None.")

    Verdict: pass

- The last line is exactly "Verdict: pass" or "Verdict: changes requested", with nothing after it.
- Ask for changes only for something the Developer must fix: a bug, a requirement that is missing or wrong, a breach of the repository's standards, a missing or weak test. Style preferences and optional ideas go under Findings without changing the verdict.`;

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

/** The Reviewer's prompt: the task, the change to read and, on a retry, what was wrong with the last Review. */
export function reviewerPrompt(task: string, defaultBranch: string, sentBack: string | null): string {
  const base = `origin/${defaultBranch}`;
  let prompt = `Review the change on this Run's branch.

What was asked (the task, which is the spec for this Run):

${task}

The change is everything since the default branch: run \`git log ${base}..HEAD --oneline\` and \`git diff ${base}...HEAD\`. Read the files it touches in full where the diff is not enough. Read the repository's own instructions and coding standards to know what the Project expects.

Write your Review to ${REVIEW_NOTE} in the fixed format, ending with the verdict line.`;
  if (sentBack) prompt += `\n\nYour previous attempt could not be used: ${sentBack}`;
  return prompt;
}

/** The section of the Review Brief that tells the pull request's reader what was reviewed, from the Review the Run acted on. */
export function reviewSection(review: Review | null): string {
  if (!review) return "";
  const limit = 4000;
  const body = review.body.length > limit ? `${review.body.slice(0, limit).trimEnd()}\n\n(The Review is cut here; the Run detail has all of it.)` : review.body;
  return `## Review (${review.verdict})\n\n${body}`;
}

/** The Review as a Reviewer left it: its Run Note when there is one, else its final message (a read-only sandbox cannot write the note). */
function readWritten(worktreePath: string, summary: string): string {
  const file = join(worktreePath, REVIEW_NOTE);
  const note = existsSync(file) ? readFileSync(file, "utf8") : "";
  return note.trim() ? note : summary;
}

function writeNote(worktreePath: string, text: string): void {
  const file = join(worktreePath, REVIEW_NOTE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${text.trim()}\n`);
}

/**
 * What one way of reviewing came to: the Run cannot go on (an Escalation opened, a Pause, an abandon), the Review was
 * unusable (and says why, so the Reviewer is asked again), or the verdict of the Review the Run acts on.
 */
export type Reviewed = { stop: true } | { invalid: string } | { verdict: ReviewVerdict; body: string };

/** One way of reviewing a Run's change. Each reads and records its own Reviews, and returns the one the Run acts on. */
export type Reviewer = (run: StepRun) => Promise<Reviewed>;

/** One Reviewer reads the change and writes the one Review. */
const soloReview: Reviewer = async ({ ctx, step, state }) => {
  const seat = await requireSeat(ctx, "reviewer-a", "Reviewer");
  if (!seat) return { stop: true };
  rmSync(join(ctx.worktreePath, REVIEW_NOTE), { force: true });
  const attempt = state.attempts + 1;
  const result = await runAgentStep(ctx, seat, {
    name: "reviewer",
    stepId: step.id,
    attempt,
    instructions: REVIEWER_INSTRUCTIONS,
    prompt: reviewerPrompt(ctx.run.task, ctx.defaultBranch, state.sentBack),
    readonly: step.readonly,
  });
  if (!result) return { stop: true };
  const parsed = parseReview(readWritten(ctx.worktreePath, result.summary));
  if ("problem" in parsed) return { invalid: parsed.problem };
  writeNote(ctx.worktreePath, `${parsed.body}\n\nVerdict: ${parsed.verdict}`);
  await ctx.records.recordReview({ stepId: step.id, attempt, author: "reviewer-a", verdict: parsed.verdict, body: parsed.body, final: true });
  ctx.changed();
  return parsed;
};

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
 * before the next Review. A Review without a usable verdict asks the Reviewer again, as an attempt of the Step.
 */
export const reviewStepType: StepTypeModule = {
  type: "review",
  exhausted: (_step, attempts) => `The Reviewer still asks for changes, or gives no usable verdict, after ${attempts} ${attempts === 1 ? "attempt" : "attempts"}.`,
  async execute(run) {
    const mode: ReviewMode = await run.ctx.records.reviewMode();
    const reviewed = await reviewers[mode](run);
    if ("stop" in reviewed) return { next: "stop" };
    if ("invalid" in reviewed) return { next: "reject", reason: reviewed.invalid, to: run.step.id };
    if (reviewed.verdict === "pass") return { next: "done" } satisfies StepOutcome;
    return { next: "reject", reason: `${REVIEW_REASON_PREFIX}\n\n${reviewed.body}` };
  },
};
