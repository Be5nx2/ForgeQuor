import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { InvalidInputError } from "./errors.js";
import type { GateKindModule } from "./gates.js";
import type { AgentModule } from "./step-types.js";
import type { Run } from "./types.js";
import { RUN_NOTES_DIR, slugify } from "./workspace.js";
import type { WorkflowContext } from "./workflow.js";
import { commitDeliverables, type MayChange } from "./deliverables.js";

const run = promisify(execFile);

/** Where the Project keeps its specs. */
export const SPEC_DIR = "docs/specs";

/** The spec a Run writes, relative to the Project: `docs/specs/<slug>.md`, the slug from the Run's title. */
export function specPathOf(r: Pick<Run, "id" | "title">): string {
  return `${SPEC_DIR}/${slugify(r.title, 60) || `run-${r.id}`}.md`;
}

/** Whether the default branch the Run started from already has `path` (as last fetched). */
async function onBase(ctx: WorkflowContext, path: string): Promise<boolean> {
  return run("git", ["cat-file", "-e", `origin/${ctx.defaultBranch}:${path}`], { cwd: ctx.worktreePath }).then(() => true, () => false);
}

/**
 * The spec this Run wrote: its path and Markdown. Null when the Run has none (it follows no Spec Writer, or the spec is
 * not written yet). A file the default branch already has is not the Run's.
 */
export async function specOf(ctx: WorkflowContext): Promise<{ path: string; content: string } | null> {
  const path = specPathOf(ctx.run);
  const file = join(ctx.worktreePath, path);
  if (!existsSync(file) || (await onBase(ctx, path))) return null;
  const content = readFileSync(file, "utf8");
  return content.trim() ? { path, content } : null;
}

/** The Spec Writer's standing instructions. */
export const SPEC_WRITER_INSTRUCTIONS = `You are the Spec Writer on a Forgequor Run. The human has talked a feature through with the Griller and confirmed its summary; you turn that into a spec. Work only inside the current directory, this Run's git worktree.

- Use the \`to-spec\` Skill (read .claude/skills/to-spec/SKILL.md) and follow it, with the changes this setting needs. Read the conversation you are given, the repository's GLOSSARY.md, docs/adr/ and the code you need, and use the Project's vocabulary.
- You NEVER ask the human anything: no interview, and no checking the seams with them. Where the conversation leaves something open, decide it yourself, the way the summary points, and say what you decided in the spec.
- The spec is the Markdown file whose path you are given, in the template of the Skill. Write it in full: that file is the only thing you deliver. "Publish a spec" here means writing that file and nothing else: do not add a line to the ROADMAP, and write no tickets and no issues (one Run is one pull request).
- Change no other file in the Project: Forgequor puts back anything else, and fails the Step. Do not commit: Forgequor commits the spec. Do not run commands that write files (a build, a formatter, tests).`;

/** The Spec Writer's prompt: the subject, the confirmed summary, where the conversation is, where to write, and what sent the spec back. */
export async function specWriterPrompt(ctx: WorkflowContext, sentBack: string | null): Promise<string> {
  const path = specPathOf(ctx.run);
  const summary = await ctx.records.conversation.confirmedSummary();
  const feedbacks = await ctx.records.specFeedbacks();
  let prompt = `Subject:\n\n${ctx.run.task}`;
  if (summary) prompt += `\n\nThe human confirmed this summary of what to build:\n\n${summary}`;
  prompt += `\n\nThe whole conversation with the Griller is in ${RUN_NOTES_DIR}/grilling.md: read it, it holds the reasons.\n\nWrite the spec to ${path}.`;
  const earlier = existsSync(join(ctx.worktreePath, path));
  if (earlier && !feedbacks.length) prompt += `\n\nA spec from an earlier pass of this Run is already at that path: write it again from the conversation as it now stands.`;
  if (feedbacks.length) {
    const history = feedbacks.map((f, i) => `${i + 1}. ${f}`).join("\n");
    prompt += `\n\nThe human rejected your earlier spec. It is already at that path on this branch: rewrite it, address the latest Feedback (the last one) and keep the earlier ones satisfied.\n\nFeedback so far, oldest first:\n${history}`;
  }
  if (sentBack) prompt += `\n\nYour previous attempt could not be used: ${sentBack}`;
  return prompt;
}

/** The Spec Writer Agent: it may change the one spec file, and Forgequor commits it. */
export const specWriterAgent: AgentModule = {
  name: "spec-writer",
  label: "Spec Writer",
  seat: "spec-writer",
  instructions: SPEC_WRITER_INSTRUCTIONS,
  mayChange: (ctx): MayChange => {
    const path = specPathOf(ctx.run);
    return (p) => p === path;
  },
  async before(ctx) {
    const path = specPathOf(ctx.run);
    // A spec the default branch already has is never overwritten. (One this Run wrote earlier is on its own branch, not on the base.)
    if (await onBase(ctx, path)) {
      await ctx.openGate(
        "escalation",
        `A spec already exists at ${path} on the default branch, and the Spec Writer does not overwrite it.`,
        "Go back to the Griller to change the subject, or retry once the existing spec has been renamed or removed.",
      );
      return false;
    }
    return true;
  },
  prompt: (ctx, attempt) => specWriterPrompt(ctx, attempt.sentBack),
  async after(ctx) {
    await commitDeliverables(ctx.worktreePath, specWriterAgent.mayChange!(ctx), `docs(spec): ${ctx.run.title}`.slice(0, 72));
  },
  async harvest(ctx) {
    const path = specPathOf(ctx.run);
    if (!(await specOf(ctx))) return { invalid: `No spec was written: ${path} is missing or empty. Write the whole spec there.` };
    return { produced: [] };
  },
};

/** The spec Gate: the human reads the spec, rendered, and approves it, or rejects it with Feedback so the Spec Writer redoes it. */
export const specGate: GateKindModule = {
  kind: "spec",
  label: "A spec Gate",
  actions: ["approve", "reject", "abandon"],
  reason: "The Spec Writer wrote the spec for you to approve, or to reject with Feedback.",
  async evidence(ctx) {
    return (await specOf(ctx))?.content;
  },
  async decide(_gate, { action, feedback }) {
    if (action === "abandon") return { next: "abandon" };
    if (action === "approve") return { next: "continue", decision: "approve", nextIteration: false };
    const reason = feedback?.trim();
    if (!reason) throw new InvalidInputError("Rejecting a Gate needs a Feedback saying what to change.");
    // A rejection starts the next Iteration, which the Spec Writer begins again with the Feedback; the human decides when to stop.
    return { next: "continue", decision: "reject", feedback: reason, nextIteration: true };
  },
};
