import type { ConversationAgent, ParsedTurn } from "./conversation.js";
import { deriveTitle, developerAgent } from "./developer.js";
import { specWriterAgent } from "./spec.js";
import { catalogueOf } from "./step-types.js";
import { loadBuiltInWorkflow } from "./workflow-definition.js";
import type { Workflow } from "./workflow.js";
import { RUN_NOTES_DIR } from "./workspace.js";

/** Where the Griller writes each turn, and where the whole conversation is kept: Run Notes, never committed. */
export const GRILLER_NOTE = `${RUN_NOTES_DIR}/grilling-turn.md`;
export const GRILLING_TRANSCRIPT = `${RUN_NOTES_DIR}/grilling.md`;

/** The Griller's standing instructions. Its turns end in a note of a fixed format, which Forgequor reads. */
export const GRILLER_INSTRUCTIONS = `You are the Griller on a Forgequor Run. You grill the human about a subject until the feature is fully thought through, then you propose a summary. Work only inside the current directory, this Run's git worktree.

- Use the \`grill-with-docs\` Skill (read .claude/skills/grill-with-docs/SKILL.md and the Skills it names, \`grilling\` and \`domain-modeling\`) and follow it, with the changes this setting needs. Explore the repository (its GLOSSARY.md, docs/adr/, instructions and code) yourself instead of asking what it can tell you.
- You never ask the human through a tool: you talk through your turns. Each turn is ONE round: a short numbered list of questions (at most 7), each with your recommended answer, then you end your turn. The human answers the whole round in one message and you carry on in the same conversation, so build on what they said.
- Record what you decide as you go: update GLOSSARY.md with the domain terms the human and you settle, and write an ADR in docs/adr/ for a decision that is hard to reverse, surprising or a real trade-off. Those two places are the only Project files you may change; Forgequor puts back anything else, and fails the Step. Do not edit code, do not commit, do not run commands that write files (a build, a formatter, tests).
- When nothing is left to settle, propose a summary instead of more questions. It must stand alone, as the Developer will build from it without having heard the conversation: what to build and why, the behaviour and the edge cases agreed, the decisions made (with the terms of the glossary), what is out of scope, and how the work is checked. The human confirms it or answers to continue.

Every turn ends the same way. Write it to ${GRILLER_NOTE} (your final message is read if you cannot write files; never rely on that), in exactly this format: the first line is "Kind: questions" or "Kind: summary", and everything after it is the turn, in Markdown.

    Kind: questions

    1. The question? (My recommendation: ...)
    2. ...`;

/** Reads a Griller's turn: its first line says whether it asks questions or proposes a summary, the rest is the turn. */
export function parseGrillerTurn(text: string): ParsedTurn {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^[*_`#>\s]*kind[*_`\s]*:/i.test(l));
  if (at < 0) return { problem: 'The turn has no "Kind:" line: its first line must be "Kind: questions" or "Kind: summary".' };
  const said = /^[*_`#>\s]*kind[*_`\s]*:[*_`\s]*(.*?)[*_`.\s]*$/i.exec(lines[at]!)![1]!.trim().toLowerCase();
  if (said !== "questions" && said !== "summary") return { problem: `The turn's kind is "${said}", but it must be "questions" or "summary".` };
  const body = lines.slice(at + 1).join("\n").trim();
  if (!body) return { problem: `The turn is "Kind: ${said}" with nothing after it: it must contain the ${said === "questions" ? "questions" : "summary"}.` };
  return { kind: said, body };
}

/** The Griller Agent: a conversation, in its own session, that ends with a summary the human confirms. */
export const grillerAgent: ConversationAgent = {
  name: "griller",
  seat: "griller",
  instructions: GRILLER_INSTRUCTIONS,
  notePath: GRILLER_NOTE,
  transcriptPath: GRILLING_TRANSCRIPT,
  title: "Grilling",
  opening: (ctx) => `The human wants this built. The subject:\n\n${ctx.run.task}\n\nBegin the grilling: look at the repository as you need to, then ask your first round of questions.`,
  parse: parseGrillerTurn,
  retry: (problem) => `Your last turn could not be used: ${problem}\n\nGive that turn again, in the format: write it to ${GRILLER_NOTE}, its first line "Kind: questions" or "Kind: summary".`,
  mayChange: (path) => path === "GLOSSARY.md" || path.startsWith("docs/adr/"),
  commitMessage: "docs: record the decisions of the grilling",
};

/**
 * The `feature` Workflow, from its YAML: the Griller talks the subject through with the human, the Spec Writer writes the
 * spec (approved at the spec Gate), then the Developer builds it, the Checks and the review (duo by default) follow, the pull request opens and the final Gate closes the Run.
 */
export const featureWorkflow: Workflow = {
  name: "feature",
  inputs: ["task", "review"],
  definition: loadBuiltInWorkflow("feature", catalogueOf([developerAgent, specWriterAgent], [grillerAgent.name])),
  plan({ task, title }) {
    if (!task?.trim()) throw new Error("A feature Run needs a subject.");
    return { task: task.trim(), title: title?.trim() || deriveTitle(task) };
  },
};
