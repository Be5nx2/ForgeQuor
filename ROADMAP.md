# Roadmap

Format and rules: `docs/agents/issue-tracker.md`. Vocabulary: `GLOSSARY.md`. Decisions: `docs/adr/`.

Milestones are specified one at a time with `/to-spec`, then split into items with `/to-tickets`.

## Now

### M1 Walking skeleton

One **Project**, one **Run** going Developer (Claude) → **Checks** → pull request with **Review Brief** → final **Gate** in Forgequor. Worktree, branch and PR per Run (ADR 0001), Runners as local subprocesses (ADR 0002), PostgreSQL through Docker Compose (ADR 0003), minimal Vue UI.

- Spec: `docs/specs/m1-walking-skeleton.md`.

- [x] `m1-01` **Scaffold and Project registration**: one command brings Forgequor up, and the human registers a Project from the UI.
  - Spec: `docs/specs/m1-walking-skeleton.md`
  - Blocked by: none
  - Acceptance:
    - one start command brings up PostgreSQL (Docker Compose), applies migrations and serves API and UI;
    - startup reports a missing or unauthenticated `git`, `gh` or `claude`;
    - registering a local repo reads its GitHub remote and default branch;
    - registering a non-git folder, or one without a GitHub remote, is refused with a clear message;
    - Projects are listed in the UI;
    - the Forge core test harness runs against real PostgreSQL and temporary git repos.
- [x] `m1-02` **Claude Runner adapter**: a Step can be run through Claude Code headless behind the Runner seam.
  - Spec: `docs/specs/m1-walking-skeleton.md`
  - Blocked by: none
  - Acceptance:
    - runs `claude` headless in a given working directory with a fresh session per Step;
    - streams progress events, then returns succeeded, failed with an error, or Quota exhausted with its reset time;
    - the contract suite passes against a fake `claude` replaying success, error, Quota exhaustion, unreadable output and crash;
    - an opt-in smoke test, off by default, runs the real `claude` on a trivial task.
- [x] `m1-03` **First Run to the final Gate**: the human starts a Run, the Developer works in its own worktree, and the Run waits at the final Gate.
  - Spec: `docs/specs/m1-walking-skeleton.md`
  - Blocked by: `m1-01`, `m1-02`
  - Acceptance:
    - a Run starts from the UI (task, title, optional tracker reference);
    - each Run gets its own worktree and branch from the freshly fetched default branch;
    - the Project's default branch is refreshed from the remote at Run start, so a stale `origin/HEAD` is never used;
    - the Forge core test harness gains a bare remote, used to test the fetch (and the push in `m1-04`);
    - the Developer works there through the Claude Runner and commits, and Forgequor commits whatever is left;
    - the Run Notes folder is excluded from git without changing the Project;
    - the Run reaches a final Gate offering approve or abandon;
    - the Runs list, the Run detail (Steps, attempts, outcomes) and the "Waiting for you" screens work.
- [x] `m1-10` **Clean-ups from the first real Run**: small rough edges found running m1-03 for real, fixed before m1-04.
  - Spec: `docs/specs/m1-walking-skeleton.md`
  - Blocked by: none
  - Acceptance:
    - a `.env` file at the repo root, if present, sets Forgequor's settings, as `.env.example` says; without one, the defaults apply;
    - Projects with the same name can be told apart wherever one is picked (Run form, Runs filter), for example by showing their local path;
    - the Developer's headless session cannot use tools that wait for a human (such as asking a question), so it never stalls on one;
    - the README matches the result.
- [x] `m1-04` **Pull request and Review Brief**: an approved-ready Run has a pull request with its Review Brief on GitHub.
  - Spec: `docs/specs/m1-walking-skeleton.md`
  - Blocked by: `m1-03`
  - Acceptance:
    - the push is refused, and an Escalation opened, if a commit adds Run Notes;
    - the branch is pushed and a ready pull request opened through `gh`, with the task and a Run reference;
    - the Review Brief is posted as a comment, or a note says none was written;
    - the final Gate comes after the pull request, and the PR link shows in the UI;
    - an opt-in smoke test opens and closes a real PR on a sandbox repository.
- [x] `m1-05` **Checks with retry and Escalation**: broken work never reaches a pull request.
  - Spec: `docs/specs/m1-walking-skeleton.md`
  - Blocked by: `m1-03`
  - Acceptance:
    - a Project's ordered Check commands are editable in the UI;
    - Checks run in the worktree after the Developer and stop at the first failure;
    - a failure sends its output back to the Developer, for at most 2 extra attempts;
    - when the Checks still fail, an Escalation offering abandon only opens with the failing Check and its output;
    - every attempt's commands, exit statuses and outputs show in the Run detail;
    - a Project with no Checks skips them.
- [x] `m1-06` **Abandon anytime, merge and close detection**: Run states stay true to what happens on GitHub.
  - Spec: `docs/specs/m1-walking-skeleton.md`
  - Blocked by: `m1-04`
  - Acceptance:
    - a Run can be abandoned in any state before Merged;
    - abandoning closes the pull request if there is one, and keeps the branch and the worktree;
    - polling moves Approved Runs to Merged or Closed;
    - Merged, Closed and Abandoned Runs free their Project slot.
- [x] `m1-07` **Concurrency limit and queue**: the human can line up Runs without overloading a Project.
  - Spec: `docs/specs/m1-walking-skeleton.md`
  - Blocked by: `m1-06`
  - Acceptance:
    - each Project has a max concurrent Runs setting (default 2), editable in the UI;
    - a Run over the limit is Queued;
    - Queued Runs start automatically, in creation order, when a slot frees up;
    - a test shows that a Run becoming Merged, Closed or Abandoned frees its slot and starts the next Queued Run (left untested by m1-06).
- [ ] `m1-08` **Quota pause, restart recovery, Runner failures**: no Run fails or gets stuck for a temporary reason.
  - Spec: `docs/specs/m1-walking-skeleton.md`
  - Blocked by: `m1-05`, `m1-06` (PR polling to resume on startup)
  - Acceptance:
    - when the Quota is exhausted, the Run goes Paused with its reset time and restarts its current Step after the reset;
    - on Forgequor startup, Running Runs restart their current Step, Approved Runs resume PR polling, and each Project starts the Queued Runs that fit its free slots (a Run Queued before a restart must not stay stuck);
    - a Runner failure opens an Escalation with the error;
    - a Step running longer than a configurable timeout has its Runner process killed and opens an Escalation saying so;
    - killing a timed-out Step or Check ends its whole process group, so no child process (such as a headless engine) survives it;
    - abandoning a Run while a Step or Check is running kills it the same way (today the Developer keeps running after m1-06's abandon).
- [ ] `m1-09` **Live Step progress**: the human watches the Agent work in real time.
  - Spec: `docs/specs/m1-walking-skeleton.md`
  - Blocked by: `m1-03`
  - Acceptance:
    - the Run detail shows the running Step's events live through server-sent events;
    - the Run's state updates without a page reload.

## Next

### M2 Assets

Codex **Runner**, **Artist**, an `assets` **Workflow** (Artist → asset **Gate** → PR), generic Gate + **Feedback** + **Iteration** mechanism, **Art Direction** read from the Project, asset gallery in the UI. Unblocks the first game.

### M3 Full loop

YAML **Workflows** with parallel **Steps**, Griller with chat, Spec Writer, Architect, solo or duo review (chosen at Run launch) with **Consolidator** (an unsettled reviewer disagreement opens a **Gate** with its recommendation), **Escalation**, configurable iteration limit (default 3), default `feature` and `bugfix` Workflows.

### M4 Comfort

**Quota** gauges refreshed after every Step (unknown shown greyed), **Archive** and purge after 60 days, macOS notifications, **Skill Packs** per Project plus the Project's own Skills, one-click Runner assignment (default and per Run), read-only Workflow preview, `/to-workflow` skill (checks for a close existing Workflow before writing a new one).

## Icebox

- Child Runs: a feature Run splitting its spec into one Run per ticket (ADR 0001).
- Verifier Agent: a Step that runs the real app and the opt-in smoke tests and checks each acceptance criterion before the final Gate (green unit tests missed m1-03's undecidable Gates). To grill.
- Conductor Agent (the sprint manager): reads the roadmap, computes the frontier, spots hidden dependencies and parallel-safe items, proposes the next Runs; advisory first, then driving Child Runs. Touches ADR 0001. To grill.
- Runner fallback when a Quota is exhausted.
- Competing Runs: the same Step on two Runners, then pick.
- Codecks sync: import cards, update status.
- Reading the human's GitHub PR comments as Feedback.
- Automatic solo/duo review choice from diff size.
- Visual Workflow editor.
- Containerised or API-key Runners, multi-user studio instance.
- Project registration accepts a GitHub remote not named `origin` (today refused as "no GitHub remote").
- Lock migrations so two Forgequor starts at once cannot apply them twice.
- Test the startup tool checks and the `ls-remote` default-branch fallback.

## Done
