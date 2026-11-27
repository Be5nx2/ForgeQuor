# M3b The team

Roadmap: M3b. Vocabulary: `GLOSSARY.md`. Decisions:
- ADR 0001: one Run, one pull request.
- ADR 0002, 0005 and 0006: subscription Runners and their permissions.
- ADR 0007: Workflows compose coded Step types in YAML.

Builds on M3a (`docs/specs/m3a-workflow-engine.md`): the engine, frozen YAML Workflows, parallel read-only Steps, Project Workflows and Escalations with choices. The decisions below come from the two M3b grilling rounds recorded in `ROADMAP.md`.

## Problem Statement

Forgequor can run one Agent, the Developer, on a task the human has already thought through, and one Artist on Asset Requests the human writes by hand. Everything before and after the code is still the human's job:

- **Thinking a feature through.** The human grills themself, writes the spec, decides the design and lists the art to draw before a Run can start. The quality of a Run depends on a task text the human wrote alone.
- **Reviewing.** The only checks before the final Gate are the Project's Checks. Nobody reads the change against the Project's standards or against what was asked; the human does all the reviewing at the final Gate.
- **Fixing bugs.** A bug is launched like any task. Nothing makes the Developer reproduce it with a failing test first, so a "fix" can pass the Checks without fixing anything.
- **Skills.** Agents work best with the shared Skills (`grill-with-docs`, `to-spec`, `code-review`, `diagnosing-bugs`, `tdd`…), but a game Project does not have them, and copying them into every Project by hand drifts.
- **One model's blind spots.** A single reviewer on one model misses what another model would catch, and two raw reviews would leave the human to reconcile them.

## Solution

Forgequor gets the rest of the team, and two Workflows that use it:

- **Every Run gets the shared Skill Pack.** At a Run's start Forgequor places its `shared` Skills in the worktree, for Claude Code and for Codex, never committed. A Skill the Project already has wins.
- **`bugfix`.** The human describes a bug. The Developer reproduces it with a failing test first (`diagnosing-bugs`), fixes it, the Checks run, a Reviewer reviews, the pull request opens, then the final Gate.
- **Review, solo or duo.** Solo is one Reviewer (Claude). Duo is two read-only Reviewers in parallel, Claude and Codex, then the **Consolidator**, who checks each remark against the code and writes one **Review**. Changes requested go back to the Developer, at most `max_attempts` times, then an Escalation. A disagreement the Consolidator cannot settle opens a Gate carrying its recommendation.
- **`feature`.** The human types a subject. The Griller grills them in a **Conversation Gate**, one round of questions at a time, in one ongoing Claude session, until they confirm its summary. The Griller updates the Project's glossary and ADRs and may order art. Then the Spec Writer writes the spec (approved at a spec Gate), the Architect writes an **Implementation Plan**, the Artist draws the art the grilling ordered (approved at the Asset Gate), the Developer builds, the Checks and the review run, the pull request opens with its Review Brief, and the final Gate closes the Run.

Each Agent's Runner has a sensible default (Claude for most, Codex for the second Reviewer and the Artist) that an environment variable can change.

## User Stories

### Skills in every Run (m3-10)

1. As the human, I want every Run's worktree to hold Forgequor's shared Skills, so that Agents can follow `tdd`, `code-review` or `grill-with-docs` in any Project.
2. As the human, I want those Skills available to Claude Code and to Codex alike, so that a Step behaves the same on either Runner.
3. As the human, I want the placed Skills never committed, so that a pull request contains only the change.
4. As the human, I want a Skill my Project already has to win over Forgequor's copy, so that a game can adapt a Skill to itself.
5. As a maintainer, I want the shared pack taken from Forgequor's own `skills/shared` folder, so that improving a Skill here improves every Run.
6. As the human, I want a Run that restarts or resumes to find its Skills still in place, so that a restart changes nothing.

### Agents and Runners

7. As the human, I want each Agent to have a default Runner (Claude for the Griller, Spec Writer, Architect, Developer, first Reviewer and Consolidator; Codex for the second Reviewer and the Artist), so that I need no setup to start.
8. As the human, I want to change an Agent's Runner and model through environment variables, so that I can move work to the subscription with Quota left.
9. As the human, I want each Step attempt to show which Runner and model ran it, so that I can compare them.
10. As the human, I want an Agent that is assigned a Runner Forgequor cannot start to stop the Run with an Escalation that says so, so that a wrong setting does not fail silently.

### Review (m3-11, m3-12)

11. As the human, I want a Reviewer Agent to read the change against the Project's standards and against the Run's task or spec, using `code-review`, so that obvious problems are caught before I look.
12. As the human, I want each Review to end in "pass" or "changes requested", so that the Run knows whether to go on.
13. As the human, I want changes requested to go back to the Developer with the Review, so that it fixes what the Reviewer found.
14. As the human, I want that loop capped by the Workflow's `max_attempts`, then an Escalation saying so, so that a Developer and a Reviewer cannot argue forever.
15. As the human, I want the Checks to run again after the Developer reworks, before the next Review, so that a rework never skips the Checks.
16. As the human, I want to choose solo or duo review when I launch a Run, with the Workflow's default preselected, so that I spend Quota only where it matters.
17. As the human, I want duo review to run a Claude Reviewer and a Codex Reviewer at the same time, so that two models look at the change without doubling the wait.
18. As the human, I want both Reviewers read-only (Codex in its read-only sandbox), so that a Reviewer never edits the code it reviews.
19. As the human, I want the Consolidator to check each remark against the code and drop the ones that are wrong, so that the Developer gets one Review it can trust.
20. As the human, I want a disagreement the Consolidator cannot settle to open a Gate with its recommendation, so that I decide only the real disputes.
21. As the human, I want that Gate to let me go on as if the Review passed, send the Developer back with my Feedback, or abandon, so that I keep control.
22. As the human, I want every Review kept in the Run Notes and visible in the Run detail, so that I can read what each Reviewer said.
23. As the human, I want the final Review summarised in the Review Brief, so that the pull request says what was reviewed and what remains doubtful.

### `bugfix` (m3-11)

24. As the human, I want to launch a `bugfix` Run from a bug description, so that a bug goes from report to reviewed pull request.
25. As the human, I want the Developer to follow `diagnosing-bugs` and write a failing test that reproduces the bug before fixing it, so that the fix is proven.
26. As the human, I want `bugfix` to default to solo review, so that a small fix stays cheap.
27. As the human, I want `bugfix` to go Developer → Checks → review → pull request → final Gate, so that it follows the same path as other changes.

### The Griller and the Conversation Gate (m3-13)

28. As the human, I want to launch a `feature` Run from a free-text subject, so that I start from an idea, not a finished task.
29. As the human, I want the Griller to ask me one round of questions at a time, using `grill-with-docs`, so that the questions build on my answers.
30. As the human, I want the Run to wait for me at a Conversation Gate while I think, so that the Griller's Quota is not spent waiting.
31. As the human, I want to answer a whole round in one message, in a chat in the Run detail, so that answering feels like a conversation.
32. As the human, I want the Griller to resume the same session after my answer, so that it remembers everything said so far.
33. As the human, I want the whole transcript saved in the Run Notes at each exchange, so that nothing is lost if Forgequor restarts.
34. As the human, I want a Run restarted mid-conversation to pick up where it was, so that a restart does not make me answer again.
35. As the human, I want the Griller to end with a summary I confirm or continue from, so that the grilling ends when I agree it is complete.
36. As the human, I want the Griller to update the Project's glossary and ADRs as Deliverables, so that the decisions we reach are recorded in the Project.
37. As the human, I want the Conversation Gate listed in "Waiting for you" like any Gate, so that I see a Griller waiting for me.
38. As the human, I want to abandon a Run from the Conversation Gate, so that I can drop an idea mid-grilling.
39. As the human, I want an Escalation to be able to go back to the Griller, reopening the conversation with my Feedback, so that a misunderstanding found late can be talked through.

### The Spec Writer and the spec Gate (m3-14)

40. As the human, I want the Spec Writer to turn the grilling into a spec with `to-spec`, without asking me anything, so that I do not repeat myself.
41. As the human, I want the spec written to `docs/specs/<slug>.md` in the Project and committed in the pull request, so that the spec lives with the code.
42. As the human, I want no tickets written, so that one Run stays one pull request (ADR 0001).
43. As the human, I want a spec Gate that shows the spec rendered, so that I review it comfortably.
44. As the human, I want to approve the spec or reject it with Feedback to have it redone, so that the code is built from a spec I agree with.
45. As the human, I want the Developer given the approved spec, so that it builds what was agreed.

### The Architect (m3-15)

46. As the human, I want the Architect to read the spec and the code and write an Implementation Plan (modules, test seams, order of small steps) in the Run Notes, so that the Developer follows a design.
47. As the human, I want the Architect to write a Project ADR when a decision warrants one, so that design decisions are recorded.
48. As the human, I want no Gate after the Architect, so that the plan does not slow me down.
49. As the human, I want the Developer given the Implementation Plan, so that it builds in the planned order.

### Art inside `feature` (m3-16)

50. As the human, I want the Griller to write the Asset Requests the feature needs in a structured Run Note, so that art is ordered during the grilling.
51. As the human, I want those Asset Requests validated like launch input, on the freshly fetched default branch, so that a request that would overwrite art is caught.
52. As the human, I want invalid Asset Requests sent back to the Griller with the reasons, so that it fixes them.
53. As the human, I want the Artist and the Asset Gate to run only when the grilling ordered art, so that a feature without art does not stop at an empty Gate.
54. As the human, I want the Developer given the approved Assets' paths, so that the code uses the art.

### The `feature` Workflow as a whole

55. As the human, I want `feature` to run Griller ⇄ me → Spec Writer → spec Gate → Architect → Artist → Asset Gate → Developer → Checks → review → pull request with Review Brief → final Gate, so that a subject becomes a reviewed change.
56. As the human, I want a final Gate rejection to send the Developer back with my Feedback, so that I can ask for changes without re-grilling.
57. As the human, I want `feature` to default to duo review, so that features get the most thorough review.
58. As the human, I want the Run detail to show every Step of `feature` in order with its state, so that I see where a long Run stands.
59. As a Workflow author, I want the new Step types and Gate kinds usable in my Project's Workflows, so that a game can compose its own team.

## Implementation Decisions

### Order of work

As in the roadmap:
1. **m3-10**, the shared Skill Pack: no blocker, and every later Agent relies on it.
2. **m3-11**, the Reviewer and `bugfix` with solo review: the first new Agent, the review loop, and the per-Agent Runner settings.
3. **m3-12**, duo review and the Consolidator (needs m3-06's parallel read-only Steps). It can run alongside m3-13.
4. **m3-13**, the Griller, the Conversation Gate and `feature` v0 (needs m3-08's go back): the largest item, with the Claude Runner's session persistence.
5. **m3-14**, Spec Writer and spec Gate; then **m3-15**, Architect.
6. **m3-16**, art inside `feature` (needs m3-05).

### Skill Pack placement (m3-10)

- A small module places a **Skill Pack** in a worktree. It takes the pack's folder (Forgequor's `skills/shared`) and a worktree, and for each Skill folder in the pack it creates the Skill under both `.claude/skills/` and `.agents/skills/`, **unless the Project already has a Skill of that name** in that folder.
- What it adds is never committed. Each added path is written to the repository's local exclude file, as the Run Notes folder already is. The Project's own files are never changed.
- Forgequor places the pack when a Run's worktree is created, and again when a Run restarts or resumes, so a missing Skill is repaired. Placing twice changes nothing.
- The Skill is a copy, not a link. A link would point outside the worktree, where the Codex sandbox may not read it.
- Choosing packs per Project (godot, forgequor) stays in M4. M3b places the shared pack only.

### Agents and their Runners

- Each Agent is a coded Agent module (ADR 0007: no Agents in YAML), with its name, its standing instructions, its Runner **seat**, whether it may run read-only, and what it produces.
- **Seats.** The fixed seats (Developer, Artist) become one seat per Agent: `griller`, `spec-writer`, `architect`, `developer`, `reviewer-a`, `reviewer-b`, `consolidator`, `artist`.
- **Defaults.** Claude for every seat except `reviewer-b` and `artist`, which default to Codex.
- **Settings.** An environment variable per seat sets its Runner (`claude` or `codex`), and another sets its model. The existing Developer and Artist model variables keep working.
- **A seat with no usable Runner** (an unknown name, or a Runner that is not installed) opens an Escalation naming the seat when a Step needs it. It does not fail at startup, so Workflows that do not use the seat keep working.
- **The read-only Step request.** Steps marked `readonly` pass `readonly: true` to the Runner. Codex runs read-only Steps in its read-only sandbox. Claude Code keeps its permissions (ADR 0005), and the engine's after-Step check (m3-06) is what enforces read-only there.

### Reviews (m3-11, m3-12)

- **A coded `review` Step type**, read-only, with `on_reject` (normally the Developer) and `max_attempts` (default 3).
- **The mode comes from the Run.** A new launch input `review` takes `solo` or `duo`. Each Workflow declares its default (`bugfix`: solo; `feature`: duo), and the Run form offers both. The choice is a composite Step's parameter rather than two branches in YAML, because `when` only tests whether an input is present.
- **Solo.** The `reviewer-a` seat runs a Reviewer Agent with `code-review`. It is given the Project's standards, the Run's task or spec, and the diff against the default branch.
- **Duo.**
  - `reviewer-a` and `reviewer-b` run in parallel, both read-only. Then the `consolidator` seat runs the Consolidator Agent, which reads both Reviews and the code.
  - The Consolidator writes the one Review the Run acts on. When it cannot settle a disagreement, it says so in a structured way instead.
- **Where the Review goes.**
  - Each Reviewer and the Consolidator write their Review as a Run Note in a fixed format. The format has a free-text body and a final verdict line: `pass` or `changes requested`. The Consolidator's format adds `disagreement` with a recommendation.
  - Forgequor reads the verdict line. A missing or malformed verdict is a failed attempt of that Agent, retried within the Step like other Agent failures.
- **Outcomes.**
  - `pass`: the Step is done.
  - `changes requested`: the Step rejects to its `on_reject` target with the Review as the reason. The Developer's prompt receives it the way it receives a failed Check, and every Step after the Developer replays, Checks included.
  - `disagreement`: a **review Gate** opens, a new Gate kind. It shows the Consolidator's recommendation and both Reviews. Its choices:
    - approve: go on as if the Review passed;
    - reject with Feedback: the Developer reworks, which counts like changes requested;
    - abandon.
- **The Review Brief.** The pull request's Review Brief gains a section with the final Review's summary and anything left doubtful.

### `bugfix` (m3-11)

- **Built-in Workflow `bugfix`.** Launch inputs: `task` (the bug description) and `review` (default solo). Steps: Developer (bug-fixing mode) → Checks → review → publish → final Gate. Checks and review both `on_reject` the Developer.
- **The Developer in bug-fixing mode** is the same Developer Agent under its own catalogue name. Its instructions require `diagnosing-bugs` and a failing test that reproduces the bug, committed before the fix. Forgequor does not verify the test order; the Reviewer's spec axis does.

### The Conversation Gate and the Griller (m3-13)

- **Runner sessions.** The Runner seam gains optional session continuity: a Step can ask to start a session, and the result carries a session id. A later Step can resume that session with a new message.
  - Only the Claude Runner implements it, with the CLI's own resume.
  - A Runner without sessions refuses a session request, and the Step fails with an Escalation saying so. The `griller` seat therefore needs Claude.
- **A coded `conversation` Step type** drives the loop. It names its Agent (`griller`). Each turn:
  1. The Griller runs one turn and ends it with either a round of questions or a proposed summary, in a structured Run Note.
  2. The Step opens a **Conversation Gate**, a new Gate kind, showing the questions or the summary.
  3. The human answers in one message, or confirms the summary.
  4. An answer resumes the same session with the message as the next user turn. A confirmation ends the Step as done.
- **What is persisted.** The session id and the transcript (questions, answers, summary) are saved at every exchange: the transcript in the Run Notes (`grilling.md`), the session id with the Run's Step state.
  - A restart during the Griller's turn resumes the session with the last human message again.
  - A restart while the Gate is open just keeps waiting.
- **Conversation Gate choices:** answer (a non-empty message), confirm (only when the Griller proposed a summary), abandon.
  - The Gate shows the conversation so far as a chat.
  - It appears in "Waiting for you" with the Run's title.
- **Deliverables.** The Griller may change the Project's `GLOSSARY.md` and `docs/adr/`. Its changes are committed on the Run's branch when the conversation is confirmed. It writes no other Project file; anything else it changed is reverted with an Escalation naming the files.
- **Going back.** An Escalation that goes back to the Griller reopens the same session with the Feedback as the next human message. A Run created before session persistence, or whose session the CLI no longer has, starts a new session from the saved transcript.
- **`feature` v0.** Built-in Workflow `feature`: launch inputs `task` (the subject) and `review` (default duo). Steps: `conversation` (Griller) → Developer → Checks → review → publish → final Gate. The Developer is given the subject and the confirmed summary.

### The Spec Writer and the spec Gate (m3-14)

- **The Spec Writer Agent** runs `to-spec` with the transcript and the summary as its context. It never asks questions; its instructions forbid it.
- **Its output** is `docs/specs/<slug>.md` in the Project, committed, with no tickets. The slug comes from the Run's title. If a spec already exists at that path the Run escalates rather than overwrite it, and the human can go back to the Griller to change the subject or retry after renaming.
- **The spec Gate** is a new Gate kind that renders the spec's Markdown.
  - Approve goes on.
  - Reject with Feedback goes back to the Spec Writer (`on_reject: spec-writer`) in a new Iteration, uncapped like every Gate rejection.
- `feature` becomes: Griller → Spec Writer → spec Gate → Developer → …, and the Developer is given the spec's path.

### The Architect (m3-15)

- **The Architect Agent** reads the spec and the code. It writes the Implementation Plan to the Run Notes (`implementation-plan.md`) and may add one or more Project ADRs (Deliverables, committed).
- **No Gate follows it.** A missing plan is a failed attempt of the Architect.
- `feature` becomes: … spec Gate → Architect → Developer → …, and the Developer is given the plan.

### Art inside `feature` (m3-16)

- **The Griller's Agent module declares that it produces the `assets` input.** Its Run Note `asset-requests.json` holds Asset Requests in the launch shape.
- **Validation** uses the existing produced-input path (m3-04), checked against the freshly fetched default branch like launch input (m2-10). Invalid requests send the Griller back with the reasons, and count as one of its attempts.
- **`feature` becomes:** … Architect → `artist` (`when: assets`) → asset Gate (`when: assets`, `on_reject: artist`) → Developer → …
  - Without Asset Requests both art Steps are skipped.
  - The Developer is given the approved Assets' paths.
  - Approved Assets are committed by the Artist's Step as in `assets`, but the pull request opens only at the end of `feature`.

### What the Developer is given

The Developer Agent's prompt is built from what the Run has, in this order:
1. the task or subject;
2. the confirmed grilling summary;
3. the spec's path;
4. the Implementation Plan;
5. the approved Assets' paths;
6. the latest Review or failed Check;
7. the Feedback.

Each part is present only when the Run has it, so `developer`, `bugfix` and `feature` share one Developer.

### Project Workflows

- The new Step types (`review`, `conversation`) and Gate kinds (`conversation`, `spec`, `review`) are in the catalogue, so Project Workflows may use them.
- The launch-rule borrowing from m3-07 extends to the new inputs: a Project Workflow with inputs `task` + `review` launches like `bugfix` or `feature`, with the default `review` its YAML gives.

### Data (indicative)

- Per Run Step state: the conversation session id and the round count.
- Gates: the new kinds. A Conversation Gate records the human's message as its Feedback.
- Step attempts: the seat and the read-only flag, beside the Runner and model.

### HTTP and UI

- **Gate decisions** take the new actions: `answer` with a message and `confirm`. The review and spec Gates reuse approve, reject and abandon.
- **Run form:** a review choice (solo or duo) when the chosen Workflow takes it.
- **Run detail:**
  - the conversation shown as a chat, with a reply box while the Conversation Gate is open;
  - the spec rendered at the spec Gate;
  - each Review readable;
  - the Consolidator's recommendation at the review Gate.

## Testing Decisions

**What a good test is.** As in M1 to M3a: drive behaviour through a public interface and assert what the human would see, such as Run states, Steps in order, Gates and their choices, files and commits, pull requests and Review Briefs. Never assert internal calls or read the database behind the interface. Expected values come from this spec.

### Seam 1, the Forge core (primary)

Real git and PostgreSQL, the fake Runners (extended to play several seats and to keep sessions) and the fake code host.

- **Skill Pack:**
  - a Project with none of the Skills gets them all, for both Runners, never committed;
  - a Project that has one keeps its own;
  - a restart repairs a missing one.
- **Runner settings:**
  - an Agent seat routed to the other Runner shows it on its Step attempts;
  - an unusable seat opens an Escalation naming it.
- **Review:**
  - solo pass reaches the pull request;
  - changes requested loops to the Developer, with the Review in its prompt and the Checks run again, up to `max_attempts`, then an Escalation;
  - duo runs both Reviewers overlapping, read-only, then the Consolidator;
  - a disagreement opens a review Gate whose three choices do what they say;
  - a missing verdict line retries the Agent.
- **`bugfix`:** the Developer's instructions ask for a failing test first; solo is the default; the whole path reaches the final Gate.
- **Conversation Gate:**
  - several rounds, each answer resuming the same session;
  - the transcript is saved at each exchange;
  - a restart during a turn and during the Gate;
  - confirm ends the Step;
  - abandon;
  - an Escalation going back reopens the conversation;
  - glossary and ADR changes are committed, and any other file the Griller wrote triggers an Escalation.
- **Spec Writer and spec Gate:** the spec is committed at its path, an existing spec escalates, rejection redoes it with the Feedback, and the Developer gets its path.
- **Architect:** the plan reaches the Developer; a missing plan retries; an ADR it writes is committed.
- **Art in `feature`:** valid Asset Requests run the Artist and the Asset Gate; none skips both; invalid ones go back to the Griller; the Developer gets the approved paths.
- **The existing suite** keeps passing. Tests whose subject changes on purpose may be updated, and each such change is named in its pull request: the fixed Developer and Artist seats, and the Review Brief's new section.

### Seam 2, the Claude Runner

With the fake CLI used today:
- starting a session returns its id;
- resuming passes the id and the new message;
- a missing session is reported as such.

The opt-in real smoke test gains a two-turn conversation.

### Seam 3, the acceptance (BA) suite

`tests/acceptance`, run by hand, real GitHub sandbox and Agents on a cheap model:
- **`bugfix`:** solo, through to the final Gate.
- **`feature`:** a two-round grilling answered by the suite, a spec approved, duo review, the final Gate.

Art inside `feature` stays behind the existing `BA_ASSETS` switch.

### Not tested

- The quality of what Agents write (questions, specs, plans, Reviews). That is for dogfooding.
- The Vue screens.
- HTTP routes beyond the decision payloads already covered.

**Prior art:**
- the Forge core suites;
- the engine and escalation-choices tests from M3a for the new loops;
- the Claude Runner tests and smoke test;
- `tests/acceptance` for the BA scenarios.

## Out of Scope

- **M4:** choosing Skill Packs per Project, Quota gauges, Runner assignment in the UI, Archive.
- **ADR 0001:** splitting a spec into tickets or Child Runs.
- **Later candidates:**
  - the Verifier Agent (M5) and the Conductor Agent;
  - Runner fallback on an exhausted Quota, and the same Step on two Runners;
  - sessions on Codex (the Griller stays on Claude);
  - reading the human's GitHub comments as Feedback.
- **Other Agents:** writing Agents in YAML, or per-Project Agent instructions.

## Further Notes

- The Conversation Gate is the first Gate where the human writes more than a Feedback. Its transcript is the source the Spec Writer works from, so the format must read well to an Agent: one heading per round, the questions, then the answer verbatim.
- The review composite and the conversation composite follow the `artist` precedent (ADR 0007): a loop the YAML cannot express lives in a coded Step type, not in the YAML.
- Duo review doubles review Quota. If dogfooding shows the Consolidator rarely changes anything, `feature` may default to solo later; that is a one-line YAML change.
- The BA suite is the place where the whole team is seen working for real. Run it after m3-13 and after m3-16.
