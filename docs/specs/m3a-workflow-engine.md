# M3a Workflow engine

Roadmap: M3a. Vocabulary: `GLOSSARY.md`. Decisions:
- ADR 0001: one Run, one pull request.
- ADR 0005 and 0006: the Runners' permissions.
- ADR 0007: Workflows compose coded Step types in YAML.

Builds on M1 (`docs/specs/m1-walking-skeleton.md`) and M2 (`docs/specs/m2-assets.md`). M3b (the team: Griller, Spec Writer, Architect, review, `feature` and `bugfix`) builds on this.

## Problem Statement

Forgequor has two **Workflows**, `developer` and `assets`, and both are hand-written code. The next ones the human needs (`feature` with grilling, spec, review and art; `bugfix`) would each be another few hundred lines threaded through the Forge core, because today:
- the core knows about Assets: it validates Asset Requests, writes their rows and records per-Asset verdicts;
- each Workflow re-implements how a Step's result becomes an **Escalation** or a Pause;
- the context handed to a Workflow is a bag of seventeen things.

Adding a Workflow means editing the core, and a **Project** cannot have a Workflow of its own at all.

When a Run cannot go on, the human's only choice at an Escalation is to abandon, even when one more try or going back one Step would do.

The real M2 tests also showed that Approved Runs keep their Project slot until the human merges, which blocked the queue twice. Once an Approved Run leaves "Waiting for you", nothing keeps its pull request in front of the human. Finally, the M2 branch review left a handful of small gaps.

## Solution

A Workflow becomes a YAML file that composes **Steps** of a fixed set of coded types (ADR 0007): an Agent Step, Checks, a **Gate** of a given kind, Publish, and the coded Artist batch.

**What a Step can declare.**
- the Steps it needs, so that independent read-only Steps run in parallel;
- where to loop back when it rejects, with a cap on automatic loops;
- one condition that skips it when an input is missing.

**Where Workflows come from.** Forgequor ships `developer` and `assets` as YAML, with exactly today's behaviour. A Project can add Workflows or override a built-in one from its own repository. Each Run freezes the Workflow it started with.

**Escalations.** An Escalation now offers retry (with optional **Feedback**), go back to an earlier Step (with Feedback), or abandon.

**First, two prerequisites.**
- Approved Runs free their slot, and a "Waiting for your merge" list keeps their pull requests in view.
- The small gaps from the M2 review are fixed.

**Then the core is reshaped** so that nothing about Assets lives in it, and adding a Workflow touches no core code.

## User Stories

### Approved Runs and the merge list (m3-00a)

1. As the human, I want a Run to free its Project slot as soon as it is Approved, so that an open pull request waiting for my merge never holds the queue.
2. As the human, I want the next Queued Run to start as soon as a Run becomes Approved, so that work keeps flowing.
3. As the human, I want a "Waiting for your merge" list in "Waiting for you", with every Approved Run of every Project and a link to its pull request, so that the merges I owe stay in front of me.
4. As the human, I want a Run to leave that list once its pull request is merged or closed, so that the list stays true.
5. As the human, I want the Runs list to show every Run in every state, so that I can always find a past Run.

### M2 review follow-ups (m3-00b)

6. As the human, I want an `assets` Run's Review Brief to list each Asset's palette warnings, so that the pull request says what I accepted.
7. As the human, I want each Gate to record its Iteration, so that the Run detail shows which Feedback belongs to which Iteration of an `assets` Run.
8. As the human, I want a Run's Assets to expose each attempt's Asset Check failures, so that I can see why the Artist tried again.
9. As the human, I want the art an Asset replaces to stay a Style Reference for the Artist in every Iteration, not only the first, so that a redo still matches what it replaces.
10. As the human, I want one Asset to cost at most a fixed, documented number of Artist Steps per Iteration, so that a stubborn Asset cannot drain my Quota.
11. As the human, I want a bare Codex error on an unfinished turn treated as a failure, not as an exhausted Quota, so that a Run is not paused for the wrong reason.
12. As the human, I want the UI to show every Asset status the server knows, including "rejected", so that what I see matches what happened.
13. As a maintainer, I want tests to abandon Runs through the Forge core rather than SQL, and the README's art path to list `animations`, so that tests and docs say what the product does.

### Workflows as YAML

14. As the human, I want Workflows defined as YAML files, so that I can read and change one without touching Forgequor's code.
15. As the human, I want the built-in `developer` and `assets` Workflows shipped as YAML with exactly their current behaviour, so that nothing I rely on changes.
16. As the human, I want a Project to add its own Workflows in a `forgequor/workflows/` folder at its root, so that a game can have Workflows that fit it.
17. As the human, I want a Project's Workflow with the same name as a built-in one to replace it for that Project, so that I can adapt a default to a game.
18. As the human, I want a Project's Workflows read from the freshly fetched default branch, so that a Workflow I just merged is offered at once.
19. As the human, I want the Run form to offer exactly the Workflows the Project can use, marked built-in or Project, so that I pick from what really exists.
20. As the human, I want a Workflow whose YAML is invalid to be shown with its errors and not be offered, so that a typo never starts a broken Run.
21. As the human, I want the Run form to ask only for what the chosen Workflow needs (a task, or Asset Requests), so that the form fits the Workflow.
22. As the human, I want each Run to keep the version of the Workflow it started with, so that editing a YAML never changes a Run in flight.
23. As the human, I want the Run detail to show the Run's Steps in Workflow order with their state (waiting for an earlier Step, running, done, skipped, failed), so that I see where the Run stands.

### What a Workflow can say

24. As a Workflow author, I want each Step to have an id and one of the coded types (Agent with its name, Checks, Gate with its kind, Publish, Artist), so that a Workflow is built from parts Forgequor knows and tests.
25. As a Workflow author, I want a Step to list the Steps it needs, and Steps that do not depend on each other to run at the same time, so that independent work goes faster.
26. As a Workflow author, I want only Steps marked read-only to run in parallel, so that two Agents never write over each other in the shared worktree.
27. As the human, I want a read-only Step that changed anything outside the Run Notes to fail, so that the rule holds even if an Agent misbehaves.
28. As a Workflow author, I want a Step that rejects (a Gate, or Checks that fail) to loop back to the Step I name, so that rework is part of the Workflow.
29. As a Workflow author, I want automatic loop-backs capped by a maximum number of attempts (default 3) that I can set per Step, so that an Agent cannot loop forever.
30. As the human, I want reaching that cap to open an Escalation saying so, so that I decide what happens next.
31. As the human, I want loops that I drive by rejecting at a Gate to have no cap, so that I stop when the work is right.
32. As a Workflow author, I want a Step skipped when an input it needs is missing (such as no Asset Requests), so that one Workflow covers runs with and without art.
33. As a Workflow author, I want a Workflow to declare its inputs (a task, Asset Requests), so that the Run form and launch checks know what to ask for.
33b. As a Workflow author, I want an input to come either from the human at launch or from an earlier Step of the Run (such as Asset Requests the Griller produces in M3b), so that a Step can depend on what the Run itself discovered.
34. As a Workflow author, I want every error in a Workflow (unknown type, unknown Step id, a cycle, parallel Steps that are not read-only, an unknown input, a duplicate id) reported at once with where it is, so that I fix a Workflow in one go.
35. As the human, I want a Run's slot to count once however many of its Steps run in parallel, so that the concurrency limit still means Runs.

### Escalations with choices

36. As the human, I want an Escalation to offer retrying the Step that failed, with an optional Feedback, so that a passing problem does not cost me the Run.
37. As the human, I want an Escalation to offer going back to an earlier Step of the Workflow, with a required Feedback, so that I can fix the cause rather than the symptom.
38. As the human, I want going back to replay every Step after the one I chose, in Workflow order, so that the work after it is redone on the new basis.
39. As the human, I want going back to keep the worktree's files as they are, with the Agent told why it is redoing the Step, so that useful work is not thrown away.
40. As the human, I want a replayed or retried Step to get a fresh attempt budget, so that the cap applies per try I asked for.
41. As the human, I want abandon to stay available at every Escalation, so that I can still drop a Run.
42. As the human, I want the Escalation to list the earlier Steps I can go back to, by name, so that I pick the right one.

### Resilience and the core

43. As the human, I want a Run restarted by Forgequor or resumed after a Quota pause to pick up at the Steps that were not finished, never replaying finished ones, so that YAML Workflows are as resilient as today's.
44. As a maintainer, I want the Forge core to know nothing about Assets, so that adding a Workflow or a Step type touches no core code.
45. As a maintainer, I want how a Step's result becomes progress, an Escalation or a Pause written once, for every Step type, so that a fix lands everywhere.
46. As a maintainer, I want every Run created before M3a to keep working, so that the upgrade does not break Runs in flight.

## Implementation Decisions

### Order of work

The tickets follow the order decided in the grilling:
1. m3-00a;
2. m3-00b;
3. deepen the Workflow seam;
4. the YAML engine;
5. `developer` in YAML;
6. `assets` in YAML;
7. Escalations with choices.

**Rule for steps 3 to 6:** every existing test passes **unchanged**. Only new tests may be added.

### m3-00a, Approved Runs

- **Slots.** An Approved Run no longer holds a slot. Becoming Approved triggers the queue the way Merged and Closed already do.
- **The merge list.**
  - It is a Forge core query listing Approved Runs, with their Project and pull request.
  - "Waiting for you" shows it as a second list, under the open Gates.
- **The Runs list.** It is checked by hand: every Run in every state. Fix whatever hides one, for example a stale filter or a list not refreshed after a start.

### m3-00b, M2 follow-ups

These are the items listed under "M2 review follow-ups" in the roadmap:
- the palette warnings go into the Review Brief;
- each Gate records its Iteration;
- each attempt's Asset Check failures are exposed on a read Run;
- the Replaced Art is kept as a Style Reference in every Iteration;
- one documented cap on Artist Steps per Asset per Iteration replaces the two budgets that added up;
- a bare Codex `error` on an unfinished turn becomes a failure;
- the UI's Asset status gains `rejected`, and the dead label is removed;
- tests abandon Runs through the Forge core;
- the README's art path lists `animations`.

### Deepening the Workflow seam

**The core keeps the Run lifecycle:**
- slots and the queue;
- Pause and resume;
- restart;
- Gates as a mechanism;
- abandon;
- pull-request follow-up.

**It loses every Asset concern.** Validating Asset Requests, storing them, Asset verdicts and serving Asset images move behind the `artist` Step type and the `asset` Gate kind.

**A Gate kind is a small module of its own.** It knows the choices it offers, validates a decision (a plain choice, or per-Asset verdicts), records it, and says where the Run goes next. The core's decide operation delegates to it.

**Run input belongs to the Workflow.**
- A Workflow declares the inputs it takes.
- The Step types that use an input validate and store it themselves, at launch, inside the core's transaction.
- The core never names an input.

**One Step executor.**
- It runs any Step, records its attempts and streams its progress.
- It maps every result the same way: success moves on; failure or timeout opens an Escalation; Quota exhaustion pauses.
- The copies in each Workflow go.

**The context handed to a Step type shrinks to:**
- the Run, with its Project, worktree and branch;
- the stop signal;
- the Agent seat it needs;
- the few operations it uses: record and stream, open a Gate, read and write Run Notes.

Database access goes through those operations, not a raw pool.

### The engine

**Built-in Workflows** are YAML files shipped with Forgequor.

**A Project's Workflows**
- They are read from `forgequor/workflows/*.yaml` on the freshly fetched default branch, when the Run form loads and at launch.
- A Project Workflow with a built-in's name replaces it for that Project.

**The definition module** is a small deep module. It turns YAML text into a validated definition, or into a list of errors, each with its location. Its rules:
- ids are unique;
- types are known;
- `needs` and `on_reject` point at existing ids;
- `needs` has no cycle;
- two Steps that can run at the same time must both be read-only;
- `when` names an input that is either given at launch or produced by a Step this one needs, directly or indirectly;
- defaults are applied, such as 3 attempts.

**The shape of a definition, as decided in the grilling:**
- the Workflow's name and description, and the inputs it takes at launch (`task`, `assets`);
- `steps`, each with:
  - an `id`;
  - a `type`, one of `agent` (with `agent: <name>`), `checks`, `gate` (with `gate: final | asset`), `publish`, `artist`;
  - optionally:
    - `needs: [ids]`;
    - `readonly: true`;
    - `on_reject: <id>`;
    - `max_attempts: <n>`, default 3, which caps automatic loop-backs only;
    - `when: <input>`.

**A naming note.** The grilling spoke of an "iteration limit". The field is `max_attempts` because in the glossary an **Iteration** is a human-driven round, and those have no cap. The automatic Checks → Developer loop is attempts within an Iteration. Today's behaviour, 2 extra Developer attempts, is `max_attempts: 3`.

**`developer` in YAML:**
- inputs: task;
- Steps: Agent `developer`, then Checks with `on_reject: developer` and `max_attempts: 3`, then Publish, then a final Gate with `on_reject: developer`.

**`assets` in YAML:**
- inputs: assets;
- Steps: `artist`, then an asset Gate with `on_reject: artist`, then Publish.

The Run is Approved after Publish when the Workflow ends there.

**Freezing.** A Run stores the definition it started with. Runs created before M3a get the built-in definition of their Workflow name when the migration runs.

**Execution.**
- A Run's Steps are scheduled from the frozen definition. A Step starts when everything it needs is done or skipped.
- An input is given at launch or produced by a Step. Which inputs a Step type produces is part of that coded type (in M3b, the Griller Agent produces `assets`), never declared in YAML. A produced input is validated with the same rules as at launch, against the freshly fetched default branch; an invalid one goes back to the Step that produced it with the reason.
- `when` is evaluated when the Step becomes ready, on the inputs given or produced so far, not at launch.
- Read-only Steps whose needs are met start together.
- After a read-only Step, Forgequor compares the worktree outside the Run Notes with how it was before. Any change fails the Step and opens an Escalation naming the files.
- Each Step's state is persisted per Run and Iteration: waiting, running, done, skipped, failed, plus its attempt count.

**Loops.**
- A rejecting Step, meaning a Gate rejected by the human or Checks that fail, marks its `on_reject` target and every Step after it as waiting again, then counts one attempt.
- Past `max_attempts`, an automatic loop opens an Escalation that says the cap was reached. Gate rejections start a new Iteration and have no cap.

**Restart and Pause.** On a restart or a resume after a Pause, the Steps that were running start again, from the start of that Step, as today. Done Steps are never replayed.

### Escalations with choices

**The choices it offers:**
- **retry:** the failed Step runs again with a fresh attempt budget, and the Feedback, if given, is handed to it;
- **go back:** the human picks one of the done Steps before the failed one, and gives a required Feedback. That Step and every Step after it are marked waiting, and they replay in order with the Feedback. Files are not reverted;
- **abandon:** as today.

**The Feedback** reaches every replayed Agent Step the same way Gate Feedback does today.

**The UI.** The Escalation shows the three choices. "Go back" lists the eligible Steps by id and type.

### Data (indicative)

- **Run:** its frozen definition.
- **Step state:** the Run, its Iteration, the Step id, its status and attempts.
- **Gates and Step attempts:** the Step id that opened them.
- **Asset tables:** they move behind the Asset Step type and Gate kind, unchanged in shape.

### HTTP and UI

- **Routes:**
  - list a Project's Workflows, valid and invalid with their errors, from the fresh branch;
  - decide an Escalation with retry, go back with a target, or abandon;
  - list Approved Runs for the merge list.
- **The Run form:** it builds itself from the chosen Workflow's inputs.
- **The Run detail:** it shows the Steps in order with their state.
- **"Waiting for you":** it gains the merge list.

### Dependencies

A pure-JavaScript YAML parser is added. No native modules.

## Testing Decisions

**What a good test is.** As in M1 and M2: drive behaviour through a public interface and assert what the human would see. That covers Run states, Steps and their order, Gates and their choices, files, commits, pull requests and the merge list. Never assert internal calls or read the database behind the interface's back. Expected values come from this spec.

### Seam 1, the Forge core (primary)

Real git and PostgreSQL, the fake Runners and the fake code host.

**The existing suite.** Every test that exists before M3a passes **unchanged** after each of the seam, engine, `developer` and `assets` tickets. That is the proof that M3a changes nothing visible.

**What the new tests cover:**
- **m3-00a:** an Approved Run frees its slot and starts the next Queued Run; the merge list contents and their exits.
- **Workflow loading:**
  - built-in Workflows, and Project Workflows from the remote's default branch, including an override;
  - an invalid Workflow is listed with its errors and refused at launch;
  - a Run keeps its frozen Workflow after the YAML changes.
- **Engine semantics,** using small test Workflows:
  - parallel read-only Steps really overlap, and the slot counts once;
  - a read-only Step that writes a file fails;
  - `when` skips;
  - `on_reject` loops, with `max_attempts` reached opening an Escalation;
  - Gate rejection loops without a cap;
  - restart and Pause pick up at unfinished Steps.
- **Escalations:** retry with and without Feedback; going back replays the right Steps in order, with the Feedback and without reverting files; abandon.

### Seam 2, the Workflow definition (new)

The YAML-to-definition module is tested directly, like the Asset Checks in M2. Cases:
- valid Workflows, with defaults applied;
- every validation error with its location, all reported at once;
- the two built-in Workflow files themselves parse and validate.

### Not tested

The Runner contract is untouched. The HTTP routes stay thin and are not tested beyond what exists, and the Vue screens are not tested.

**Prior art:**
- the Forge core suites;
- the Asset Checks module tests, for the definition module;
- the HTTP Asset image test, should a route need one.

## Out of Scope

- The M3b team: Griller and the **Conversation Gate**, Spec Writer, Architect, Reviewer and Consolidator Agents, the `feature` and `bugfix` Workflows, and chaining Artist → Developer in one Run.
- The Verifier Agent (an M5 candidate) and the Conductor Agent (after M3).
- Loops other than rejection loops ("for each", arbitrary conditions), scripts, and Agents defined in YAML (ADR 0007).
- The Workflow preview screen and the `/to-workflow` skill (M4).
- Skill Packs and per-Project Agent instructions (M4).
- Child Runs (ADR 0001, Icebox).

## Further Notes

- The `artist` type stays a coded composite. It draws every Asset Request one by one, with its Asset Checks and their retries, inside one Step, as decided in the grilling. YAML gains no "for each".
- Workflow-specific Checks, which the `assets` Workflow might want one day (for example an engine import), become possible because Checks are now just a Step type. No built-in Workflow uses them in M3a.
- The definition module is the base the M4 `/to-workflow` skill and Workflow preview will use. Its error messages should read well to a human and to an Agent.
