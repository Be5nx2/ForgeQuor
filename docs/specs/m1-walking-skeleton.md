# M1 Walking skeleton

Roadmap: M1. Vocabulary: `GLOSSARY.md`. Decisions: ADR 0001 (one Run, one pull request), ADR 0002 (local-first subscription Runners), ADR 0003 (PostgreSQL from day one).

## Problem Statement

Today the human drives every coding task by hand: open Claude Code in the game repository, explain the task, watch it work, run the tests, create a branch, push, open a pull request, write up what to test. Only one task moves at a time, and the human has to stay at the keyboard for all of it. Nothing records what was asked, what ran, or how it ended.

Forgequor's promise is to hand a task to a team of Agents and only be called at the moments that matter. Before any of the team (Artist, Griller, Reviewer...) can exist, the plumbing underneath has to work end to end: isolate a task in its own worktree, have an Agent do the work through a Runner, validate it, open a pull request, and wait for the human's decision.

## Solution

A local Forgequor app (orchestrator plus a minimal web UI) where the human registers a **Project** and starts a **Run** from a free-text task. The Run follows one fixed **Workflow**:

Developer (Claude) → **Checks** → pull request with **Review Brief** → final **Gate**.

Each Run gets its own worktree and branch. The Developer Agent works there through the Claude Code **Runner** and writes a Review Brief to the **Run Notes**. Forgequor then runs the Project's Checks. If they fail, the Developer gets one more try with the Check output, up to a fixed limit. Once the Checks pass, Forgequor pushes the branch, opens the pull request and posts the Review Brief as a comment. It then waits at the final Gate, where the human approves or abandons. If the Checks keep failing, the Run opens an **Escalation** instead, and the human can only abandon it in M1.

After approval the human merges on GitHub. Forgequor never merges; it notices the merge or close and records it. Two Runs can work on the same Project at once; further Runs queue. A Run that hits the Runner's **Quota** pauses and resumes on its own.

## User Stories

### Projects

1. As the human, I want to register a Project by pointing at a local git repository, so that Forgequor can work on it.
2. As the human, I want Forgequor to read the Project's GitHub remote and default branch when I register it, so that I don't have to type them.
3. As the human, I want registration to fail with a clear message when the folder is not a git repository or has no GitHub remote, so that I fix the setup before starting a Run.
4. As the human, I want to declare the Project's Checks as an ordered list of shell commands, so that Forgequor validates the work the way this Project needs.
5. As the human, I want to edit a Project's Checks later, so that I can tighten validation as the Project grows.
6. As the human, I want to set how many Runs may work on a Project at once (default 2), so that I control Quota use and merge conflicts.
7. As the human, I want to list my registered Projects, so that I can pick one to start a Run on.
8. As the human, I want to register Forgequor itself as a Project, so that it can be dogfooded.

### Starting a Run

9. As the human, I want to start a Run on a Project from a free-text task, so that I can hand off work in one step.
10. As the human, I want to give a Run a short title, or have one derived from the task, so that I can recognise it in lists.
11. As the human, I want to optionally attach a tracker card reference (such as a Codecks card) to a Run, so that I can find the card later.
12. As the human, I want a new Run to start from the latest default branch of the Project's remote, so that it does not build on stale code.
13. As the human, I want each Run to get its own worktree and branch, so that parallel Runs never touch each other's files or my own checkout.
14. As the human, I want a Run to queue when its Project already has the maximum number of Runs working, so that I can line up work without overloading anything.
15. As the human, I want queued Runs to start automatically, in creation order, when a slot frees up, so that I don't have to babysit the queue.

### The Developer Step

16. As the human, I want the Developer Agent to work inside the Run's worktree through Claude Code, so that it uses my subscription and the Project's own Claude configuration and Skills.
17. As the human, I want the Developer to commit its work on the Run's branch, so that the pull request has a meaningful history.
18. As the human, I want Forgequor to commit any changes the Developer left uncommitted, so that no work is lost.
19. As the human, I want the Developer to write a Review Brief (what changed, where to look closely, what to test) into the Run Notes, so that I know how to check the work.
20. As the human, I want Run Notes to stay in the worktree but never be committed, so that working files never pollute the game repository.
21. As the human, I want Forgequor to refuse to push a branch whose commits contain Run Notes, so that the rule above holds even if an Agent misbehaves.
22. As the human, I want to follow a running Step's progress live in the UI, so that I can see what the Agent is doing.

### Checks

23. As the human, I want Forgequor to run the Project's Checks in the worktree after the Developer Step, so that broken work never reaches a pull request.
24. As the human, I want a failing Check to send its output back to the Developer for another try, up to a fixed limit, so that simple mistakes get fixed without me.
25. As the human, I want a Run whose Checks still fail after the limit to open an Escalation stating which Check failed and its output, so that I know why it stopped.
26. As the human, I want to see every Check's command, exit status and output for each attempt, so that I can understand failures.
27. As the human, I want a Project with no Checks declared to go straight to the pull request, so that Checks are optional for quick experiments.

### Pull request and Review Brief

28. As the human, I want Forgequor to push the branch and open a pull request against the default branch once the Checks pass, so that the change is ready to look at on GitHub.
29. As the human, I want the pull request description to state the task and link back to the Run, so that the PR explains itself.
30. As the human, I want the Review Brief posted as a comment on the pull request, so that I read what to test right next to the diff.
31. As the human, I want Forgequor to use my existing GitHub CLI authentication, so that I don't manage another token.

### Gates

32. As the human, I want one "Waiting for you" view listing every open Gate across all Projects, so that it is the only thing I need to watch.
33. As the human, I want to approve a Run at its final Gate, so that I signal it is ready to merge.
34. As the human, I want to abandon a Run at any Gate, so that I can drop a bad idea.
35. As the human, I want an Escalation to show its reason and the evidence (failing Check and output), so that I can decide quickly.

### Lifecycle and history

36. As the human, I want every Run to show its state (Queued, Running, Waiting, Paused, Approved, Merged, Closed, Abandoned), so that I know where it stands at a glance.
37. As the human, I want to list Runs filtered by Project and state, so that I can find what needs attention.
38. As the human, I want a Run's detail page to show its Steps in order with their attempts, timings and outcomes, plus the PR link and Review Brief, so that I can see its whole history.
39. As the human, I want Forgequor to notice when an Approved Run's pull request is merged or closed on GitHub, so that its state stays true without me updating it.
40. As the human, I want to abandon a Run at any time, not only at a Gate, so that I can stop work that is going wrong.
41. As the human, I want abandoning a Run to close its pull request if one exists, while keeping the branch and the worktree, so that I can still look at what happened.
42. As the human, I want a Run whose pull request was merged or closed, or that was abandoned, to free its Project slot, so that queued Runs can start.

### Quota and resilience

43. As the human, I want a Run whose Runner reports an exhausted Quota to go Paused with the reset time, so that it doesn't fail for a temporary reason.
44. As the human, I want a Paused Run to resume on its own after the reset time by restarting its current Step, so that I don't have to restart it.
45. As the human, I want Forgequor to restart the current Step of every Running Run after Forgequor itself restarts, so that a crash or reboot loses at most one Step's work.
46. As the human, I want a Runner failure (CLI missing, crash, unreadable output) to open an Escalation with the error, so that no Run gets stuck silently.

### Setup

47. As the human, I want to start Forgequor with one command that also brings up PostgreSQL through Docker Compose, so that setup on my Mac (OrbStack) is trivial.
48. As the human, I want Forgequor to check at startup that `git`, `gh` and `claude` are installed and authenticated, and say clearly what is missing, so that I don't discover it mid-Run.

## Implementation Decisions

### Modules

- **Forge core** (deep module, the main seam). Owns the Run lifecycle and the fixed M1 Workflow. Small interface:
  - commands: register or update a Project, start a Run, decide a Gate (approve or abandon), abandon a Run;
  - queries: get a Run, list Runs, list open Gates, list Projects;
  - a subscription to Run events for live UI updates.

  Internally it sequences Steps, runs the Check loop, enforces the per-Project concurrency limit and the queue, handles Pause and resume, recovers after restart, and polls pull-request state for Approved Runs. It depends on the adapters below, which are passed in, never created inside.
- **Runner** (seam with two adapters: Claude Code in M1, Codex in M2). Interface:
  - **Input:** run one Step, described by the Agent's instructions, the prompt, the working directory and the model.
  - **Output:** a stream of progress events, then a final result.
  - **Final result:** succeeded, or failed with an error, or Quota exhausted with its reset time.

  The Claude adapter drives `claude` headless as a subprocess (stream-json output) in the worktree, with the user's subscription auth (ADR 0002). Each Step is a fresh session.
- **Workspace** (git). Interface:
  - create a worktree and branch for a Run from the freshly fetched default branch;
  - commit leftover changes;
  - verify that no Run Notes are in the branch;
  - push.

  It uses the real `git` binary. Worktrees live in a Forgequor-managed folder outside the Project's checkout (configurable root).
- **Code host** (GitHub). Interface:
  - open a pull request;
  - post a comment;
  - close a pull request;
  - read a pull request's state (open, merged, closed).

  The adapter shells out to the user's authenticated `gh` CLI.
- **Check executor.** Runs a Project's Check commands in order in the worktree, stops at the first failure, and returns each command's exit status and captured output. Small enough to live inside Forge core unless it grows.
- **Store** (PostgreSQL). Persists Projects, Runs, Step attempts, Check results and Gates. Versioned SQL migrations.
- **HTTP layer.** A thin translation of the Forge core interface to JSON over HTTP, plus server-sent events for live Run updates. It holds no logic.
- **Web UI** (Vue 3). Screens:
  - Projects: list, register, edit Checks and concurrency;
  - new Run form;
  - Runs list, filterable by Project and state;
  - Run detail: Step timeline, live progress, Check output, PR link, Review Brief;
  - "Waiting for you": open Gates with their actions.

### Run lifecycle

- **States in M1:** Queued → Running ⇄ Waiting / Paused → Approved → Merged or Closed; Abandoned from any state before Merged. Archived comes with M4.
- **The fixed M1 Workflow:** Developer → Checks → (failing: Developer again, up to the limit) → push and pull request → Review Brief comment → final Gate.
- **The retry limit after failing Checks:** 2 extra Developer attempts, a fixed constant in M1 that becomes configurable in M3.
- **Gate kinds in M1:**
  - the final Gate offers approve or abandon;
  - an Escalation offers abandon only.

  Reject-with-**Feedback** and **Iterations** arrive in M2.
- **Paused:** when the Runner returns Quota exhausted. The Run resumes at the reset time by restarting the current Step from scratch.
- **On startup**, every Run recorded as Running restarts its current Step. Every Approved Run resumes pull-request polling.
- **Abandon** closes the pull request if there is one, keeps the branch and the worktree, and frees the slot.
- **Merged or Closed:** detected by polling the Code host for Approved Runs at a modest interval. A merge or close also frees the slot.

### Run Notes and Deliverables

- Run Notes live in a fixed hidden folder at the root of each worktree. That folder is ignored through the repository's local exclude file, so the Project needs no change.
- Before pushing, Workspace fails the Run with an Escalation if any commit on the branch adds a path under the Run Notes folder.
- **The Developer:**
  - receives the task, plus the previous Check output on a retry;
  - is told to commit with Conventional Commits, with a body of 5 lines at most;
  - is told to write the Review Brief to a known file in the Run Notes.
- **A missing Review Brief:** the Run still proceeds, and the comment says that no brief was written.
- **Branch name:** a Forgequor prefix plus the Run's short id and a slug of its title.
- **The pull request:** opened as ready for review. Its description holds the task, the Run's title and a reference to the Run.

### Data shape (indicative)

- **Project:** name, local path, remote owner/name, default branch, ordered Check commands, max concurrent Runs.
- **Run:** Project, title, task, optional tracker reference, state, branch, worktree path, pull-request number, timestamps.
- **Step attempt:** Run, Step name, attempt number, Runner and model, status, started/ended, error or Quota reset time, captured event log.
- **Check result:** Step attempt or Run, command, exit status, output.
- **Gate:** Run, kind (final or Escalation), reason, evidence, opened/decided timestamps, decision.

### Configuration and setup

- **One start command** brings up PostgreSQL through Docker Compose, applies migrations and serves the API and the UI.
- **A startup check** verifies that `git`, `gh` (authenticated) and `claude` are present, and reports anything missing.
- **The Runner model** for the Developer is one setting with a sensible default. One-click assignment comes with M4.
- **No authentication:** the server listens on localhost only (ADR 0002).

## Testing Decisions

- **What a good test is.** It drives behaviour through a public interface and asserts outcomes the human would care about: Run states, Gates opened, pull requests opened, comments posted, commits on the branch. It never asserts internal calls or reads the database behind the interface's back. Expected values come from the spec, never recomputed the way the code computes them.
- **Seam 1, the Forge core (primary):**
  - Tests register a Project on a temporary git repository with a temporary bare remote, start Runs, and follow them to their end through the Forge core interface.
  - **Real:** `git` and PostgreSQL (the Docker Compose instance, one isolated schema or database per test run).
  - **Fakes:** the Runner, a scripted Developer that edits files, commits, writes a Review Brief, fails or reports Quota exhaustion on demand; and the Code host, an in-memory GitHub that records pull requests and comments and whose merge state the test can flip.
  - **Covers:** the full lifecycle, the Check retry loop and Escalation, the Run Notes guard, concurrency and queueing, Pause and resume, restart recovery, abandon, and merge/close detection.
- **Seam 2, the Runner contract:**
  - The Claude adapter is tested against a fake `claude` executable placed first on the PATH. It replays recorded stream-json outputs: success, error, Quota exhaustion, garbage output, crash.
  - The same contract suite will run against the Codex adapter in M2.
- **Opt-in smoke tests,** off by default and never run in CI:
  - one runs the real `claude` on a trivial task;
  - one opens and closes a real pull request on a sandbox repository through `gh`.

  They catch format drift in the real tools.
- **Not tested in M1:** the HTTP layer and the Vue UI, which stay thin by design.
- **Prior art:** none, since the codebase is new. These tests set the pattern for later milestones. Follow the `tdd` skill: one vertical slice at a time, at these two seams only.

## Out of Scope

- Rejecting a Gate with Feedback, Iterations, and the asset Gate and gallery (M2).
- Codex Runner and Artist (M2).
- YAML Workflows, parallel Steps, Griller and chat, Spec Writer, Architect, Reviewer and Consolidator, rich Escalation choices, configurable iteration limit (M3).
- Quota gauges, Archive and purge, macOS notifications, Skill Packs, one-click Runner assignment, Workflow preview, `/to-workflow` (M4).
- Everything in the Icebox, including reading GitHub comments as Feedback, Codecks sync and containerised Runners.
- Merging pull requests, which Forgequor never does (ADR 0001).
- Authentication and multi-user use (ADR 0002).
- Rebasing a Run whose pull request conflicts.
- Removing worktrees after merge (comes with Archive in M4).

## Further Notes

- The Developer relies on whatever Claude configuration and Skills the Project's repository already carries. Forgequor-managed Skill Packs come with M4. For a Godot Project in M1, the Godot Skills must already be in the game repository.
- The Claude adapter should keep the raw event stream of each Step attempt. That costs nothing now, and M4's Quota gauge can read rate-limit events from it. Whether a headless `/usage` call consumes Quota is still unconfirmed and belongs to the M4 spike.
- Checks run on the host as the user, like the Developer. There is no sandbox beyond the worktree in M1 (ADR 0002).
- M2 builds directly on this. The Gate mechanism grows a reject-with-Feedback choice, and the Runner seam gains its second adapter.
