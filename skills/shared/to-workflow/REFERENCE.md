# Workflow reference

What a Forgequor Workflow can be made of. A test keeps the headings and lists below equal to what Forgequor has code for.

## Workflow file

```yaml
name: bugfix            # equals the file name; lowercase letters, digits, dashes
description: One sentence on what the Run does.
inputs: [task, review]  # what the human gives at launch
review: solo            # only with the review input: solo or duo, the preselected review mode
steps: [...]
```

Inputs: `task`, `assets`, `review`. A Workflow takes exactly one of these combinations: `task`, `assets`, `task` + `review`.

## Step fields

Every Step has `id` (lowercase letters, digits, dashes, unique) and `type`. Optional:

- `needs: [ids]`: Steps that finish first. Steps with no path between them run at the same time, so both must be `readonly: true` (they change nothing outside the Run Notes).
- `on_reject: id`: the Step to redo when this one rejects; it must be a Step this one needs, directly or not.
- `max_attempts: n`: automatic loop-backs from this Step, default 3; a Gate rejected by the human has no cap.
- `when: task | assets`: skip the Step when that input is missing. `assets` works when it is a launch input, or when a Step this one needs produces it (the `griller` does).
- `readonly: true|false`.

## Step types

### `agent`

An Agent works in the Run's worktree. Needs `agent:` (one of the Agents below).

### `conversation`

An Agent talks with the human over several turns until the human confirms its summary. Needs `agent:` (one of the Conversation Agents below).

### `checks`

Runs the Project's Checks (tests, lint). A failure goes back to the Step in `on_reject`, usually an `agent` Step.

### `gate`

Stops for the human to approve or reject. Needs `gate:` (one of the Gate kinds below). A rejection with Feedback goes to `on_reject`.

### `publish`

Pushes the branch and opens the pull request.

### `artist`

The Artist draws each Asset Request. Pair it with an `asset` Gate whose `on_reject` is this Step.

### `review`

A Reviewer reads the change. Always read-only. Needs `on_reject` (the Step that reworks the change), and the Workflow must take the `review` input.

## Agents

Names for `agent:` in an `agent` Step.

- `developer`: builds the task and commits.
- `bugfixer`: reproduces a bug with a failing test, then fixes it.
- `spec-writer`: writes the spec from the grilling.
- `architect`: writes the Implementation Plan.

## Conversation Agents

Names for `agent:` in a `conversation` Step.

- `griller`: questions the human about the subject; may order Assets, which produces the `assets` input.

## Gate kinds

- `final`: the human approves or rejects the finished work.
- `spec`: the human approves or rejects the spec.
- `asset`: the human gives a verdict per Asset.

## Built-in Workflows

Reuse or copy these first.

### `developer`

Inputs: task. Developer, Checks, publish, final Gate.

### `bugfix`

Inputs: task, review. Bugfixer, Checks, review, publish, final Gate.

### `feature`

Inputs: task, review. Griller, spec-writer, spec Gate, architect, then (when `assets`) artist and asset Gate, developer, Checks, review, publish, final Gate.

### `assets`

Inputs: assets. Artist, asset Gate, publish.
