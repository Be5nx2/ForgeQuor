import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { commitDeliverables, type MayChange } from "./deliverables.js";
import { specOf } from "./spec.js";
import type { AgentModule } from "./step-types.js";
import { RUN_NOTES_DIR } from "./workspace.js";
import type { WorkflowContext } from "./workflow.js";

/** Where the Architect writes the Implementation Plan: a Run Note, never committed. */
export const IMPLEMENTATION_PLAN = `${RUN_NOTES_DIR}/implementation-plan.md`;

/** Where the Project keeps its ADRs: the only Project files the Architect may change. */
export const ADR_DIR = "docs/adr/";

/** The Implementation Plan this Run has: its path and Markdown. Null when there is none (no Architect ran, or the plan is empty). */
export function planOf(worktreePath: string): { path: string; content: string } | null {
  const file = join(worktreePath, IMPLEMENTATION_PLAN);
  if (!existsSync(file)) return null;
  const content = readFileSync(file, "utf8");
  return content.trim() ? { path: IMPLEMENTATION_PLAN, content } : null;
}

/** The Architect's standing instructions. */
export const ARCHITECT_INSTRUCTIONS = `You are the Architect on a Forgequor Run. The human approved a spec; you design how it will be built, and the Developer then follows your Implementation Plan. Work only inside the current directory, this Run's git worktree.

- Use the \`codebase-design\` Skill (read .claude/skills/codebase-design/SKILL.md) for the vocabulary: deep modules, interfaces, seams. Read the spec you are given, the repository's GLOSSARY.md, docs/adr/ and the code the change touches, and use the Project's vocabulary.
- You NEVER ask the human anything. Where the spec leaves a design choice open, decide it yourself and say why in the plan.
- The Implementation Plan is the Markdown file whose path you are given, a Run Note that is never committed. Write it in full; it is the Developer's only guide to the design. It holds: the modules the change touches or adds (and the interface of each), the seams where it will be tested and which tests to write, and the order of small steps the Developer follows (each leaving the tests green).
- When a decision is hard to reverse, surprising or a real trade-off, also write a Project ADR in docs/adr/, in the format of the ADRs already there (see the \`domain-modeling\` Skill). Write none when no decision warrants one.
- The plan and the ADRs under docs/adr/ are the only files you may write: Forgequor puts back any other change, and fails the Step. Do not edit code, do not commit (Forgequor commits the ADRs), and do not run commands that write files (a build, a formatter, tests).`;

/** The Architect's prompt: the subject, the confirmed summary, the spec, and where to write the plan. */
export async function architectPrompt(ctx: WorkflowContext, sentBack: string | null): Promise<string> {
  const summary = await ctx.records.conversation.confirmedSummary();
  const spec = await specOf(ctx);
  let prompt = `Subject:\n\n${ctx.run.task}`;
  if (summary) prompt += `\n\nThe human confirmed this summary of what to build:\n\n${summary}`;
  if (spec) prompt += `\n\nThe human approved this spec (it is at ${spec.path} on the branch):\n\n${spec.content}`;
  prompt += `\n\nWrite the Implementation Plan to ${IMPLEMENTATION_PLAN}.`;
  if (sentBack) prompt += `\n\nYour previous attempt could not be used: ${sentBack}`;
  return prompt;
}

/** The Architect Agent: the plan in the Run Notes, and ADRs it may add, committed by Forgequor. No Gate follows it. */
export const architectAgent: AgentModule = {
  name: "architect",
  label: "Architect",
  seat: "architect",
  instructions: ARCHITECT_INSTRUCTIONS,
  mayChange: (): MayChange => (path) => path.startsWith(ADR_DIR),
  async before(ctx) {
    // A plan from an earlier pass (a rejected spec, a go back) must not pass for this attempt's.
    rmSync(join(ctx.worktreePath, IMPLEMENTATION_PLAN), { force: true });
    return true;
  },
  prompt: (ctx, attempt) => architectPrompt(ctx, attempt.sentBack),
  async after(ctx) {
    await commitDeliverables(ctx.worktreePath, architectAgent.mayChange!(ctx), `docs(adr): ${ctx.run.title}`.slice(0, 72));
  },
  async harvest(ctx) {
    if (!planOf(ctx.worktreePath)) return { invalid: `No Implementation Plan was written: ${IMPLEMENTATION_PLAN} is missing or empty. Write the whole plan there.` };
    return { produced: [] };
  },
};
