import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { listInBranch, readInBranch } from "./workspace.js";
import { BUILT_IN_WORKFLOWS_DIR, parseWorkflow, type DefinitionError, type StepCatalogue, type WorkflowDefinition } from "./workflow-definition.js";
import type { GateKind, WorkflowOption, WorkflowStepSummary, WorkflowValidation } from "./types.js";
import type { Workflow } from "./workflow.js";

/** Where a Project keeps its own Workflows, one `<name>.yaml` each, on its default branch. */
export const PROJECT_WORKFLOWS_DIR = "forgequor/workflows";
const FILE = new RegExp(`^${PROJECT_WORKFLOWS_DIR}/([^/]+)\\.yaml$`);

/** A Workflow a Project can launch: what the form lists, and for a valid one what launches. */
export interface ResolvedWorkflow {
  option: WorkflowOption;
  /** Missing when the Workflow is invalid. */
  workflow?: Workflow;
}

/** What Forgequor has code for: a Project Workflow can only compose these. */
export interface WorkflowKit {
  builtIn: readonly Workflow[];
  catalogue: StepCatalogue;
  stepTypes: ReadonlySet<string>;
  gateKinds: ReadonlySet<GateKind>;
}

const sameInputs = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((i) => b.includes(i));
/** The review mode a Workflow offers, as the option carries it: absent for a Workflow without a review. */
const reviewDefault = (d: WorkflowDefinition) => (d.review ? { reviewDefault: d.review } : {});
const error = (path: string, message: string): DefinitionError => ({ path, message });

const stepsOf = (d: WorkflowDefinition): WorkflowStepSummary[] =>
  d.steps.map((s) => ({ id: s.id, type: s.type, agent: "agent" in s ? s.agent : null, needs: [...s.needs], when: s.when ?? null }));

/** A built-in Workflow's YAML: its file when it has one, else its definition written out. */
function builtInYaml(w: Workflow): string {
  const file = join(BUILT_IN_WORKFLOWS_DIR, `${w.name}.yaml`);
  return existsSync(file) ? readFileSync(file, "utf8") : stringify(w.definition);
}

/**
 * Whether YAML text is a Workflow this Forgequor can launch: the definition rules plus what Forgequor has code for
 * (see `unsupported`). The one check shared by launch and `POST /api/workflows/validate`. `stem` is the file name the
 * Workflow must match; without it (text not yet in a file) the name is not compared.
 */
export function checkWorkflowText(text: string, stem: string | null, kit: WorkflowKit): { definition?: WorkflowDefinition; errors: DefinitionError[] } {
  const parsed = parseWorkflow(text, kit.catalogue);
  if (!parsed.ok) return { errors: parsed.errors };
  return { definition: parsed.definition, errors: unsupported(parsed.definition, stem ?? parsed.definition.name, kit) };
}

/** Validates YAML text as a Workflow, storing nothing. */
export function validateWorkflowText(text: string, kit: WorkflowKit): WorkflowValidation {
  const { errors } = checkWorkflowText(text, null, kit);
  return { valid: errors.length === 0, errors };
}

/** What a parsed Project Workflow still needs to be launchable here, as errors. */
function unsupported(definition: WorkflowDefinition, stem: string, kit: WorkflowKit): DefinitionError[] {
  const errors: DefinitionError[] = [];
  if (definition.name !== stem) errors.push(error("name", `The Workflow is called "${definition.name}" but its file is ${stem}.yaml: they must match.`));
  if (!definition.inputs.length) errors.push(error("inputs", "A Workflow needs at least one launch input (task, assets or review), so that the Run form can ask for it."));
  else if (!kit.builtIn.some((w) => sameInputs(w.inputs, definition.inputs))) {
    errors.push(error("inputs", `Forgequor has no way to launch a Run that takes exactly ${definition.inputs.join(" and ")}.`));
  }
  for (const [i, step] of definition.steps.entries()) {
    if (!kit.stepTypes.has(step.type)) errors.push(error(`steps[${i}].type`, `Step "${step.id}" has the type ${step.type}, which this Forgequor has no code for.`));
    if (step.type === "gate" && !kit.gateKinds.has(step.gate)) errors.push(error(`steps[${i}].gate`, `Step "${step.id}" is a ${step.gate} Gate, which this Forgequor has no code for.`));
  }
  return errors;
}

/**
 * The Workflows a Project can launch: Forgequor's own, then those of the Project's `forgequor/workflows/*.yaml` on the
 * remote's `branch` as last fetched (the caller fetches; null reads none). A Project Workflow named like a built-in replaces it, even an
 * invalid one: the Run is refused rather than quietly started from the built-in. A Project Workflow takes its launch
 * rules and its pull request from the built-in Workflow that takes the same inputs.
 */
export async function resolveWorkflows(repoRoot: string, branch: string | null, kit: WorkflowKit): Promise<ResolvedWorkflow[]> {
  const resolved = new Map<string, ResolvedWorkflow>();
  for (const w of kit.builtIn) {
    resolved.set(w.name, { option: { name: w.name, description: w.definition.description, inputs: [...w.inputs], ...reviewDefault(w.definition), origin: "built-in", errors: [], file: null, overrides: false, steps: stepsOf(w.definition), yaml: builtInYaml(w) }, workflow: w });
  }
  if (branch === null) return [...resolved.values()];
  const files = (await listInBranch(repoRoot, branch)).flatMap((path) => {
    const stem = FILE.exec(path)?.[1];
    return stem ? [{ path, stem }] : [];
  });
  for (const { path, stem } of files) {
    const text = await readInBranch(repoRoot, branch, path);
    const yaml = text ?? "";
    const overrides = kit.builtIn.some((w) => w.name === stem);
    const { definition, errors } = checkWorkflowText(yaml, stem, kit);
    if (!definition || errors.length) {
      resolved.set(stem, { option: { name: stem, description: "", inputs: [], origin: "project", errors, file: path, overrides, steps: definition ? stepsOf(definition) : [], yaml } });
      continue;
    }
    const template = kit.builtIn.find((w) => sameInputs(w.inputs, definition.inputs))!;
    const workflow: Workflow = { ...template, name: definition.name, inputs: definition.inputs, definition };
    resolved.set(stem, { option: { name: stem, description: definition.description, inputs: definition.inputs, ...reviewDefault(definition), origin: "project", errors: [], file: path, overrides, steps: stepsOf(definition), yaml }, workflow });
  }
  return [...resolved.values()];
}

/** The refusal for a Workflow that cannot be launched, naming each error with its place. */
export function describeInvalid(option: WorkflowOption): string {
  const lines = option.errors.map((e) => `  ${e.line ? `line ${e.line}: ` : e.path ? `${e.path}: ` : ""}${e.message}`);
  return `The Project's Workflow "${option.name}" (${option.file}) is invalid:\n${lines.join("\n")}`;
}
