import { fileURLToPath } from "node:url";
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node } from "yaml";

/** Where Forgequor's own Workflow files live, one `<name>.yaml` per built-in Workflow. */
export const BUILT_IN_WORKFLOWS_DIR = fileURLToPath(new URL("./workflows/", import.meta.url));

/** What a Run can be given: by the human at launch, or by a Step that produces it. */
export type WorkflowInput = "task" | "assets";
const INPUTS: readonly WorkflowInput[] = ["task", "assets"];

export type StepType = "agent" | "checks" | "gate" | "publish" | "artist";
const STEP_TYPES: readonly StepType[] = ["agent", "checks", "gate", "publish", "artist"];

/** The Gate kinds a Workflow can place; Escalations are opened by Forgequor, never declared. */
export type WorkflowGateKind = "final" | "asset";
const GATE_KINDS: readonly WorkflowGateKind[] = ["final", "asset"];

/** Automatic loop-backs a Step allows when it does not say (1 try + 2 more). */
export const DEFAULT_MAX_ATTEMPTS = 3;

interface StepCommon {
  id: string;
  /** Ids of the Steps that must be done or skipped before this one starts. */
  needs: string[];
  /** A read-only Step may run beside others; it must change nothing outside the Run Notes. */
  readonly: boolean;
  /** The Step to loop back to when this one rejects. */
  onReject?: string;
  /** Caps automatic loop-backs from this Step; Gate rejections by the human have no cap. */
  maxAttempts: number;
  /** The Step is skipped when this input is missing. */
  when?: WorkflowInput;
}

export type StepDefinition = StepCommon &
  (
    | { type: "agent"; agent: string }
    | { type: "gate"; gate: WorkflowGateKind }
    | { type: "checks" }
    | { type: "publish" }
    | { type: "artist" }
  );

/** A validated Workflow: what a Run freezes and the engine schedules. */
export interface WorkflowDefinition {
  name: string;
  description: string;
  /** What the human gives at launch. */
  inputs: WorkflowInput[];
  /** In Workflow order. */
  steps: StepDefinition[];
}

/** One thing wrong with a Workflow file, and where: a path such as `steps[1].needs[0]`, and the 1-based line and column. */
export interface DefinitionError {
  path: string;
  line?: number;
  column?: number;
  message: string;
}

export type ParsedWorkflow = { ok: true; definition: WorkflowDefinition } | { ok: false; errors: DefinitionError[] };

/** The coded parts a Workflow can name: each Agent, and the inputs it produces for the Steps after it. */
export interface StepCatalogue {
  agents: Record<string, { produces: readonly WorkflowInput[] }>;
}

/** Forgequor's Agents today. */
export const DEFAULT_CATALOGUE: StepCatalogue = { agents: { developer: { produces: [] } } };

type Segment = string | number;

const TOP_KEYS = ["name", "description", "inputs", "steps"];
const STEP_KEYS = ["id", "type", "agent", "gate", "needs", "readonly", "on_reject", "max_attempts", "when"];
const NAME = /^[a-z0-9][a-z0-9-]*$/;

const formatPath = (path: Segment[]) =>
  path.reduce<string>((s, seg) => (typeof seg === "number" ? `${s}[${seg}]` : s ? `${s}.${seg}` : seg), "");
const list = (values: readonly string[]) => values.join(", ");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Turns the YAML text of a Workflow into a validated definition with its defaults applied, or into every error found,
 * each with its location. The graph rules (cycles, parallel Steps, `when`) are checked once the Step ids and `needs`
 * are sound, so that one typo does not drown in errors that follow from it.
 */
export function parseWorkflow(text: string, catalogue: StepCatalogue = DEFAULT_CATALOGUE): ParsedWorkflow {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length) {
    return {
      ok: false,
      errors: doc.errors.map((e) => {
        const pos = lineCounter.linePos(e.pos[0]);
        return { path: "", line: pos.line, column: pos.col, message: `Invalid YAML: ${e.message.split("\n")[0]}` };
      }),
    };
  }

  const errors: (DefinitionError & { offset: number })[] = [];
  /** Locates a path in the document: the key itself when `atKey`, else its value; the nearest parent when missing. */
  const locate = (path: Segment[], atKey: boolean): number => {
    let node: unknown = doc.contents;
    let offset = (doc.contents as Node | null)?.range?.[0] ?? 0;
    for (const [i, seg] of path.entries()) {
      const last = i === path.length - 1;
      if (isMap(node)) {
        const pair = node.items.find((p) => (isScalar(p.key) ? p.key.value : p.key) === seg);
        if (!pair) break;
        const target = last && atKey ? pair.key : pair.value;
        node = target;
      } else if (isSeq(node) && typeof seg === "number") {
        node = node.items[seg];
      } else break;
      const range = (node as Node | null)?.range;
      if (!range) break;
      offset = range[0];
    }
    return offset;
  };
  const fail = (path: Segment[], message: string, atKey = false) => {
    const offset = locate(path, atKey);
    const pos = lineCounter.linePos(offset);
    errors.push({ path: formatPath(path), line: pos.line, column: pos.col, message, offset });
  };

  let root: unknown;
  try {
    root = doc.toJS();
  } catch (e) {
    // Such as too many alias expansions: a hostile file must not crash the caller.
    return { ok: false, errors: [{ path: "", line: 1, column: 1, message: `Invalid YAML: ${(e as Error).message}` }] };
  }
  if (!isRecord(root)) {
    return { ok: false, errors: [{ path: "", line: 1, column: 1, message: "A Workflow must be a mapping with a name and steps." }] };
  }
  for (const key of Object.keys(root)) {
    if (!TOP_KEYS.includes(key)) fail([key], `Unknown field "${key}"; a Workflow has ${list(TOP_KEYS)}.`, true);
  }

  const name = root.name;
  if (name === undefined) fail(["name"], "A Workflow needs a name.");
  else if (typeof name !== "string" || !NAME.test(name)) {
    fail(["name"], "A Workflow's name is lowercase letters, digits and dashes, such as feature or bugfix.");
  }

  const description = root.description ?? "";
  if (typeof description !== "string") fail(["description"], "A Workflow's description is text.");

  const inputs: WorkflowInput[] = [];
  if (root.inputs !== undefined && !Array.isArray(root.inputs)) fail(["inputs"], `inputs is a list of ${list(INPUTS)}.`);
  else {
    for (const [i, input] of ((root.inputs as unknown[] | undefined) ?? []).entries()) {
      if (!INPUTS.includes(input as WorkflowInput)) fail(["inputs", i], `Unknown input ${JSON.stringify(input)}; it must be one of ${list(INPUTS)}.`);
      else if (inputs.includes(input as WorkflowInput)) fail(["inputs", i], `Input "${input}" is listed twice.`);
      else inputs.push(input as WorkflowInput);
    }
  }

  const rawSteps = root.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    fail(["steps"], "A Workflow needs at least one Step, as a list under steps.");
  }

  const steps: StepDefinition[] = [];
  /** False once something makes the needs graph unsound (a duplicate id, a malformed or unknown need). */
  let graphSound = true;
  const ids = new Set<string>();
  for (const [i, raw] of (Array.isArray(rawSteps) ? rawSteps : []).entries()) {
    const at = (...rest: Segment[]) => ["steps", i, ...rest];
    if (!isRecord(raw)) {
      fail(at(), "A Step is a mapping with at least an id and a type.");
      graphSound = false;
      continue;
    }
    for (const key of Object.keys(raw)) {
      if (!STEP_KEYS.includes(key)) fail(at(key), `Unknown field "${key}" in a Step; a Step has ${list(STEP_KEYS)}.`, true);
    }

    const id = typeof raw.id === "string" && NAME.test(raw.id) ? raw.id : null;
    if (raw.id === undefined) {
      fail(at("id"), "A Step needs an id.");
      graphSound = false;
    } else if (!id) {
      fail(at("id"), "A Step id is lowercase letters, digits and dashes, such as developer or review.");
      graphSound = false;
    } else if (ids.has(id)) {
      fail(at("id"), `Step id "${id}" is used by more than one Step.`);
      graphSound = false;
    } else ids.add(id);
    const label = id ? `Step "${id}"` : `Step ${i + 1}`;

    const type = raw.type as StepType;
    if (raw.type === undefined) fail(at("type"), `${label} needs a type, one of ${list(STEP_TYPES)}.`);
    else if (!STEP_TYPES.includes(type)) fail(at("type"), `${label} has an unknown type ${JSON.stringify(raw.type)}; it must be one of ${list(STEP_TYPES)}.`);

    const agents = Object.keys(catalogue.agents);
    if (type === "agent") {
      if (raw.agent === undefined) fail(at("agent"), `${label} is an Agent Step, so it needs an agent, one of ${list(agents)}.`);
      else if (!agents.includes(raw.agent as string)) {
        fail(at("agent"), `${label} names an unknown Agent ${JSON.stringify(raw.agent)}; it must be one of ${list(agents)}.`);
      }
    } else if (raw.agent !== undefined) fail(at("agent"), `${label} is not an Agent Step, so it takes no agent.`, true);
    if (type === "gate") {
      if (raw.gate === undefined) fail(at("gate"), `${label} is a Gate, so it needs a gate kind, one of ${list(GATE_KINDS)}.`);
      else if (!GATE_KINDS.includes(raw.gate as WorkflowGateKind)) {
        fail(at("gate"), `${label} has an unknown Gate kind ${JSON.stringify(raw.gate)}; it must be one of ${list(GATE_KINDS)}.`);
      }
    } else if (raw.gate !== undefined) fail(at("gate"), `${label} is not a Gate, so it takes no gate kind.`, true);

    let needs: string[] = [];
    if (raw.needs !== undefined) {
      if (!Array.isArray(raw.needs) || raw.needs.some((n) => typeof n !== "string")) {
        fail(at("needs"), `${label}: needs is a list of Step ids, such as [developer].`);
        graphSound = false;
      } else needs = raw.needs as string[];
    }

    const readonly = raw.readonly ?? false;
    if (typeof readonly !== "boolean") fail(at("readonly"), `${label}: readonly is true or false.`);

    let onReject: string | undefined;
    if (raw.on_reject !== undefined) {
      if (typeof raw.on_reject !== "string") fail(at("on_reject"), `${label}: on_reject is the id of one Step.`);
      else onReject = raw.on_reject;
    }

    const maxAttempts = raw.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || (maxAttempts as number) < 1) {
      fail(at("max_attempts"), `${label}: max_attempts is a whole number of at least 1.`);
    }

    let when: WorkflowInput | undefined;
    if (raw.when !== undefined) {
      if (!INPUTS.includes(raw.when as WorkflowInput)) {
        fail(at("when"), `${label} runs when ${JSON.stringify(raw.when)} is given, which is not an input; it must be one of ${list(INPUTS)}.`);
      } else when = raw.when as WorkflowInput;
    }

    const step = {
      id: id ?? "",
      type,
      ...(type === "agent" ? { agent: raw.agent } : {}),
      ...(type === "gate" ? { gate: raw.gate } : {}),
      needs,
      readonly: readonly === true,
      ...(onReject !== undefined ? { onReject } : {}),
      maxAttempts: maxAttempts as number,
      ...(when !== undefined ? { when } : {}),
    } as StepDefinition;
    steps.push(step);
  }

  // References to other Steps.
  for (const [i, step] of steps.entries()) {
    for (const [n, need] of step.needs.entries()) {
      if (!ids.has(need)) {
        fail(["steps", i, "needs", n], `Step "${step.id}" needs "${need}", which is not a Step of this Workflow.`);
        graphSound = false;
      }
    }
    if (step.onReject !== undefined && !ids.has(step.onReject)) {
      fail(["steps", i, "on_reject"], `Step "${step.id}" loops back to "${step.onReject}" on rejection, which is not a Step of this Workflow.`);
    }
  }

  if (graphSound) checkGraph(steps, inputs, catalogue, fail);

  if (errors.length) {
    // Stable: errors at the same place keep the order they were found in.
    errors.sort((a, b) => a.offset - b.offset);
    return { ok: false, errors: errors.map(({ offset: _, ...e }) => e) };
  }
  return { ok: true, definition: { name: name as string, description: description as string, inputs, steps } };
}

/** The rules on the needs graph: no cycle, parallel Steps read-only, `on_reject` backwards, `when` inputs available. */
function checkGraph(
  steps: StepDefinition[],
  inputs: WorkflowInput[],
  catalogue: StepCatalogue,
  fail: (path: Segment[], message: string) => void,
) {
  const index = new Map(steps.map((s, i) => [s.id, i]));

  // Cycles, by depth-first search along needs.
  const state = steps.map(() => "new" as "new" | "open" | "done");
  const stack: number[] = [];
  let cyclic = false;
  const visit = (i: number) => {
    state[i] = "open";
    stack.push(i);
    for (const need of steps[i]!.needs) {
      const j = index.get(need)!;
      if (state[j] === "open") {
        const cycle = stack.slice(stack.indexOf(j)).map((k) => steps[k]!.id);
        fail(["steps", j, "needs"], `The needs of Steps ${[...cycle, cycle[0]].join(" → ")} form a cycle.`);
        cyclic = true;
      } else if (state[j] === "new") visit(j);
    }
    stack.pop();
    state[i] = "done";
  };
  for (const i of steps.keys()) if (state[i] === "new") visit(i);
  if (cyclic) return;

  // Every Step each Step depends on, directly or indirectly.
  const ancestors: Set<number>[] = [];
  const ancestorsOf = (i: number): Set<number> => {
    if (ancestors[i]) return ancestors[i];
    const all = new Set<number>();
    for (const need of steps[i]!.needs) {
      const j = index.get(need)!;
      all.add(j);
      for (const k of ancestorsOf(j)) all.add(k);
    }
    return (ancestors[i] = all);
  };

  for (const [j, later] of steps.entries()) {
    for (let i = 0; i < j; i++) {
      const earlier = steps[i]!;
      if (ancestorsOf(j).has(i) || ancestorsOf(i).has(j) || (earlier.readonly && later.readonly)) continue;
      const offenders = [earlier, later].filter((s) => !s.readonly);
      const which = offenders.length === 2 ? "neither is" : `"${offenders[0]!.id}" is not`;
      fail(["steps", j], `Steps "${earlier.id}" and "${later.id}" can run at the same time, so both must be read-only (${which}).`);
    }
  }

  for (const [i, step] of steps.entries()) {
    if (step.onReject !== undefined && index.has(step.onReject) && !ancestorsOf(i).has(index.get(step.onReject)!)) {
      fail(
        ["steps", i, "on_reject"],
        `Step "${step.id}" loops back to "${step.onReject}" on rejection, but it does not need "${step.onReject}", directly or indirectly.`,
      );
    }
    if (step.when !== undefined) {
      const produced = [...ancestorsOf(i)].flatMap((k) => {
        const s = steps[k]!;
        return s.type === "agent" ? (catalogue.agents[s.agent]?.produces ?? []) : [];
      });
      if (!inputs.includes(step.when) && !produced.includes(step.when)) {
        fail(
          ["steps", i, "when"],
          `Step "${step.id}" runs when "${step.when}" is given, but it is neither a launch input of this Workflow nor produced by a Step it needs.`,
        );
      }
    }
  }
}
