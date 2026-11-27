# Workflows are YAML compositions of coded Step types

A **Workflow** is a YAML file that only composes **Steps** of a fixed set of types written in Forgequor's code: an Agent Step, Checks, a **Gate** of a given kind, Publish, and coded composites such as the Artist batch. A Step can depend on others (independent Steps run in parallel), loop back on rejection with a cap on automatic attempts, and be skipped when an input is missing. That is all the YAML can say: no scripts, no free expressions, no Agents defined in YAML. A **Run** freezes the Workflow it started with.

We chose this over a general workflow language because every behaviour that matters (retries, Asset Checks, Quota pauses, restarts) has to be tested through the Forge core. A composition of tested Step types stays checkable by a schema and keeps running Runs predictable. Anything a Workflow cannot express becomes a new coded Step type, not a scripting feature.

## Considered Options

- **Coded Step types composed in YAML (chosen).**
- **Workflows as TypeScript code.** Most flexible, but every Project's custom Workflow would be code Forgequor runs, and nothing could be validated before a Run starts.
- **A YAML language with loops, conditions and scripts.** Covers "for each Asset Request" directly, but turns the engine into an interpreter whose combinations no test suite covers.

## Consequences

- Built-in Workflows live in Forgequor. A **Project** adds or overrides one in `forgequor/workflows/` at its root, outside the ignored Run Notes folder.
- Only read-only Steps may run in parallel, because parallel Steps share the Run's worktree. Forgequor fails a read-only Step that changed anything outside the Run Notes.
