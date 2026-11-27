import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILT_IN_WORKFLOWS_DIR, parseWorkflow, type DefinitionError } from "../../src/forge/workflow-definition.js";

/** The errors of a Workflow that must not validate. */
function errorsOf(text: string, catalogue?: Parameters<typeof parseWorkflow>[1]): DefinitionError[] {
  const parsed = parseWorkflow(text, catalogue);
  if (parsed.ok) throw new Error("expected the Workflow to be invalid");
  return parsed.errors;
}

const simple = `
name: tiny
description: One Developer, then the final Gate.
inputs: [task]
steps:
  - id: developer
    type: agent
    agent: developer
  - id: review
    type: gate
    gate: final
    needs: [developer]
    on_reject: developer
`;

describe("a valid Workflow", () => {
  it("becomes a definition with its name, description, inputs and Steps, defaults applied", () => {
    expect(parseWorkflow(simple)).toEqual({
      ok: true,
      definition: {
        name: "tiny",
        description: "One Developer, then the final Gate.",
        inputs: ["task"],
        steps: [
          { id: "developer", type: "agent", agent: "developer", needs: [], readonly: false, maxAttempts: 3 },
          { id: "review", type: "gate", gate: "final", needs: ["developer"], readonly: false, onReject: "developer", maxAttempts: 3 },
        ],
      },
    });
  });

  it("keeps every optional field a Step declares", () => {
    const parsed = parseWorkflow(`
name: art
inputs: [task, assets]
steps:
  - id: draw
    type: artist
    when: assets
  - id: look
    type: checks
    readonly: true
    needs: [draw]
    on_reject: draw
    max_attempts: 5
  - id: publish
    type: publish
    needs: [look]
`);

    expect(parsed.ok && parsed.definition).toEqual({
      name: "art",
      description: "",
      inputs: ["task", "assets"],
      steps: [
        { id: "draw", type: "artist", needs: [], readonly: false, maxAttempts: 3, when: "assets" },
        { id: "look", type: "checks", needs: ["draw"], readonly: true, onReject: "draw", maxAttempts: 5 },
        { id: "publish", type: "publish", needs: ["look"], readonly: false, maxAttempts: 3 },
      ],
    });
  });

  it("lets read-only Steps run side by side", () => {
    const parsed = parseWorkflow(`
name: reviews
inputs: [task]
steps:
  - { id: developer, type: agent, agent: developer }
  - { id: lint, type: checks, readonly: true, needs: [developer] }
  - { id: test, type: checks, readonly: true, needs: [developer] }
  - { id: publish, type: publish, needs: [lint, test] }
`);

    expect(parsed.ok).toBe(true);
  });

  it("accepts a when input produced by a Step it depends on, even indirectly", () => {
    const catalogue = { agents: { developer: { produces: [] }, griller: { produces: ["assets" as const] } } };
    const parsed = parseWorkflow(
      `
name: feature
inputs: [task]
steps:
  - { id: grill, type: agent, agent: griller }
  - { id: developer, type: agent, agent: developer, needs: [grill] }
  - { id: draw, type: artist, needs: [developer], when: assets }
`,
      catalogue,
    );

    expect(parsed.ok).toBe(true);
  });
});

describe("an invalid Workflow", () => {
  it("reports a YAML syntax error with its line", () => {
    expect(errorsOf("name: broken\nsteps: [\n")).toEqual([
      expect.objectContaining({ path: "", line: expect.any(Number), message: expect.stringMatching(/YAML/) }),
    ]);
  });

  it("reports a missing name and missing steps", () => {
    expect(errorsOf("description: nothing\n").map((e) => [e.path, e.message])).toEqual([
      ["name", expect.stringMatching(/needs a name/)],
      ["steps", expect.stringMatching(/needs at least one Step/)],
    ]);
  });

  it("reports a duplicate id where the second one is", () => {
    const errors = errorsOf(`
name: twice
inputs: [task]
steps:
  - { id: developer, type: agent, agent: developer }
  - { id: developer, type: checks, needs: [developer] }
`);

    expect(errors).toContainEqual({ path: "steps[1].id", line: 6, column: 11, message: 'Step id "developer" is used by more than one Step.' });
  });

  it("reports an unknown type, an unknown Agent and an unknown Gate kind", () => {
    const errors = errorsOf(`
name: unknowns
inputs: [task]
steps:
  - { id: a, type: script }
  - { id: b, type: agent, agent: wizard, needs: [a] }
  - { id: c, type: gate, gate: vote, needs: [b] }
`);

    expect(errors.map((e) => [e.path, e.message])).toEqual([
      ["steps[0].type", 'Step "a" has an unknown type "script"; it must be one of agent, checks, gate, publish, artist, review.'],
      ["steps[1].agent", 'Step "b" names an unknown Agent "wizard"; it must be one of developer.'],
      ["steps[2].gate", 'Step "c" has an unknown Gate kind "vote"; it must be one of final, asset.'],
    ]);
  });

  it("reports unknown ids in needs and on_reject", () => {
    const errors = errorsOf(`
name: dangling
inputs: [task]
steps:
  - { id: developer, type: agent, agent: developer, needs: [griller] }
  - { id: checks, type: checks, needs: [developer], on_reject: dev }
`);

    expect(errors.map((e) => [e.path, e.message])).toEqual([
      ["steps[0].needs[0]", 'Step "developer" needs "griller", which is not a Step of this Workflow.'],
      ["steps[1].on_reject", 'Step "checks" loops back to "dev" on rejection, which is not a Step of this Workflow.'],
    ]);
  });

  it("reports an on_reject target this Step does not come after", () => {
    const errors = errorsOf(`
name: forward
inputs: [task]
steps:
  - { id: developer, type: agent, agent: developer }
  - { id: checks, type: checks, needs: [developer], on_reject: publish }
  - { id: publish, type: publish, needs: [checks] }
`);

    expect(errors.map((e) => [e.path, e.message])).toEqual([
      ["steps[1].on_reject", 'Step "checks" loops back to "publish" on rejection, but it does not need "publish", directly or indirectly.'],
    ]);
  });

  it("reports a needs cycle with the Steps on it", () => {
    const errors = errorsOf(`
name: loop
inputs: [task]
steps:
  - { id: a, type: checks, needs: [c] }
  - { id: b, type: checks, needs: [a] }
  - { id: c, type: checks, needs: [b] }
`);

    expect(errors.map((e) => [e.path, e.message])).toEqual([["steps[0].needs", "The needs of Steps a → c → b → a form a cycle."]]);
  });

  it("reports Steps that can run at the same time without both being read-only", () => {
    const errors = errorsOf(`
name: race
inputs: [task]
steps:
  - { id: developer, type: agent, agent: developer }
  - { id: lint, type: checks, readonly: true }
  - { id: test, type: checks, needs: [developer] }
`);

    expect(errors.map((e) => [e.path, e.message])).toEqual([
      ["steps[1]", 'Steps "developer" and "lint" can run at the same time, so both must be read-only ("developer" is not).'],
      ["steps[2]", 'Steps "lint" and "test" can run at the same time, so both must be read-only ("test" is not).'],
    ]);
  });

  it("reports a when input neither given at launch nor produced by a Step it needs", () => {
    const catalogue = { agents: { developer: { produces: [] }, griller: { produces: ["assets" as const] } } };
    const errors = errorsOf(
      `
name: art
inputs: [task]
steps:
  - { id: grill, type: agent, agent: griller, readonly: true }
  - { id: draw, type: artist, when: assets, readonly: true }
  - { id: other, type: checks, when: colour, needs: [grill, draw] }
`,
      catalogue,
    );

    expect(errors.map((e) => [e.path, e.message])).toEqual([
      ["steps[1].when", 'Step "draw" runs when "assets" is given, but it is neither a launch input of this Workflow nor produced by a Step it needs.'],
      ["steps[2].when", 'Step "other" runs when "colour" is given, which is not an input; it must be one of task, assets.'],
    ]);
  });

  it("reports malformed fields and unknown keys", () => {
    const errors = errorsOf(`
name: Not A Slug
inputs: [task, mood, task]
extra: 1
steps:
  - id: developer
    type: agent
    agent: developer
    readonly: yes please
    max_attempts: 0
    neds: [x]
  - id: publish
    type: publish
    agent: developer
    gate: final
    needs: developer
`);

    expect(errors.map((e) => e.path)).toEqual([
      "name",
      "inputs[1]",
      "inputs[2]",
      "extra",
      "steps[0].readonly",
      "steps[0].max_attempts",
      "steps[0].neds",
      "steps[1].agent",
      "steps[1].gate",
      "steps[1].needs",
    ]);
  });

  it("reports an unknown when input and a malformed Step id even when the needs are broken", () => {
    const errors = errorsOf(`
name: typos
inputs: [task]
steps:
  - { id: "dev eloper", type: agent, agent: developer }
  - { id: draw, type: artist, needs: [nope], when: colour }
`);

    expect(errors.map((e) => e.path)).toEqual(["steps[0].id", "steps[1].needs[0]", "steps[1].when"]);
  });

  it("returns errors instead of throwing on a YAML alias bomb", () => {
    const bomb = ["a: &a [x, x, x, x, x, x, x, x, x, x]"];
    for (let i = 1; i < 12; i++) bomb.push(`${String.fromCharCode(97 + i)}: &${String.fromCharCode(97 + i)} [${Array(10).fill(`*${String.fromCharCode(96 + i)}`).join(", ")}]`);

    expect(errorsOf(bomb.join("\n"))).toEqual([expect.objectContaining({ path: "", message: expect.stringMatching(/YAML/) })]);
  });

  it("reports every error at once, each with its line and column", () => {
    const errors = errorsOf(`name: many
inputs: [task]
steps:
  - { id: a, type: script }
  - { id: a, type: checks, needs: [nope] }
`);

    expect(errors).toEqual([
      { path: "steps[0].type", line: 4, column: 20, message: expect.stringMatching(/unknown type "script"/) },
      { path: "steps[1].id", line: 5, column: 11, message: expect.stringMatching(/more than one Step/) },
      { path: "steps[1].needs[0]", line: 5, column: 36, message: expect.stringMatching(/needs "nope"/) },
    ]);
  });
});

describe("the built-in Workflows", () => {
  const builtIn = (name: string) => parseWorkflow(readFileSync(join(BUILT_IN_WORKFLOWS_DIR, `${name}.yaml`), "utf8"));

  it("developer: Developer, Checks looping back up to 3 attempts, Publish, then the final Gate", () => {
    const parsed = builtIn("developer");

    expect(parsed.ok && parsed.definition).toMatchObject({
      name: "developer",
      inputs: ["task"],
      steps: [
        { id: "developer", type: "agent", agent: "developer", needs: [] },
        { id: "checks", type: "checks", needs: ["developer"], onReject: "developer", maxAttempts: 3 },
        { id: "publish", type: "publish", needs: ["checks"] },
        { id: "review", type: "gate", gate: "final", needs: ["publish"], onReject: "developer" },
      ],
    });
  });

  it("assets: the Artist, the Asset Gate looping back to it, then Publish", () => {
    const parsed = builtIn("assets");

    expect(parsed.ok && parsed.definition).toMatchObject({
      name: "assets",
      inputs: ["assets"],
      steps: [
        { id: "artist", type: "artist", needs: [] },
        { id: "review", type: "gate", gate: "asset", needs: ["artist"], onReject: "artist" },
        { id: "publish", type: "publish", needs: ["review"] },
      ],
    });
  });
});

describe("a Workflow with a review", () => {
  const reviewed = (extra = "", inputs = "[task, review]", step = "") => `
name: careful
inputs: ${inputs}
${extra}
steps:
  - id: developer
    type: agent
    agent: developer
  - id: review
    type: review
    needs: [developer]
    on_reject: developer
${step}`;

  it("takes the review input, defaults to solo, and its review Step is always read-only", () => {
    const parsed = parseWorkflow(reviewed());

    expect(parsed.ok && parsed.definition).toMatchObject({
      inputs: ["task", "review"],
      review: "solo",
      steps: [{ id: "developer" }, { id: "review", type: "review", readonly: true, onReject: "developer", maxAttempts: 3 }],
    });
  });

  it("declares its own default mode", () => {
    const parsed = parseWorkflow(reviewed("review: duo"));

    expect(parsed.ok && parsed.definition.review).toBe("duo");
  });

  it("has no mode when it does not take the review input", () => {
    const parsed = parseWorkflow(simple);

    expect(parsed.ok && "review" in parsed.definition).toBe(false);
  });

  it("refuses a mode that is not solo or duo, a mode without the input, and a review Step without it", () => {
    expect(errorsOf(reviewed("review: trio")).map((e) => [e.path, e.message])).toEqual([["review", "review is the default review mode, solo, duo."]]);
    expect(errorsOf(reviewed("review: duo", "[task]")).map((e) => e.path)).toEqual(["review", "steps[1].type"]);
    expect(errorsOf(reviewed("", "[task]"))[0]!.message).toContain("must take the review input");
  });

  it("refuses a review Step that names no Step to rework the change", () => {
    const errors = errorsOf(reviewed().replace("    on_reject: developer\n", ""));

    expect(errors.map((e) => [e.path, e.message])).toEqual([["steps[1].on_reject", expect.stringContaining("needs an on_reject")]]);
  });

  it("refuses a review Step marked as not read-only", () => {
    const errors = errorsOf(reviewed("", "[task, review]", "    readonly: false\n"));

    expect(errors.map((e) => [e.path, e.message])).toEqual([["steps[1].readonly", 'Step "review" is a review, which is always read-only.']]);
  });

  it("bugfix: the Developer in bug-fixing mode, Checks, review looping back to the Developer, Publish, the final Gate", () => {
    const parsed = parseWorkflow(readFileSync(join(BUILT_IN_WORKFLOWS_DIR, "bugfix.yaml"), "utf8"), { agents: { bugfixer: { produces: [] } } });

    expect(parsed.ok && parsed.definition).toMatchObject({
      name: "bugfix",
      inputs: ["task", "review"],
      review: "solo",
      steps: [
        { id: "developer", type: "agent", agent: "bugfixer" },
        { id: "checks", type: "checks", needs: ["developer"], onReject: "developer" },
        { id: "review", type: "review", needs: ["checks"], onReject: "developer", maxAttempts: 3, readonly: true },
        { id: "publish", type: "publish", needs: ["review"] },
        { id: "final", type: "gate", gate: "final", needs: ["publish"], onReject: "developer" },
      ],
    });
  });
});
