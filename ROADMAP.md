# Roadmap

Format and rules: `docs/agents/issue-tracker.md`. Vocabulary: `GLOSSARY.md`. Decisions: `docs/adr/`.

Milestones are specified one at a time with `/to-spec`, then split into items with `/to-tickets`.

## Now

### M2 Assets

Codex **Runner**, **Artist**, an `assets` **Workflow** (Artist → asset **Gate** → PR), generic Gate + **Feedback** + **Iteration** mechanism, **Art Direction** read from the Project, asset gallery in the UI. Unblocks the first game.

- Spec: `docs/specs/m2-assets.md`.

- [x] `m2-01` **Workflows out of the core**: the M1 sequence moves behind an internal Workflow interface, ready for a second Workflow.
  - Spec: `docs/specs/m2-assets.md`
  - Blocked by: none
  - Acceptance:
    - the Run lifecycle (slots, queue, Pause, restart, Gates, pull-request follow-up) stays in the Forge core, while the `developer` Workflow owns its Steps;
    - every Run carries its Workflow name; existing Runs are `developer` Runs;
    - the Workflow shows in the Runs list and the Run detail;
    - behaviour is unchanged: every existing test passes untouched.
- [x] `m2-02` **Reject a developer Run with Feedback**: the human can ask for changes instead of abandoning.
  - Spec: `docs/specs/m2-assets.md`
  - Blocked by: `m2-01`
  - Acceptance:
    - a `developer` Run's final Gate offers approve, abandon, or reject with a required written Feedback; an Escalation stays abandon-only;
    - rejecting starts a new Iteration: the Developer works in the same worktree with the task, this Feedback and earlier ones;
    - the Checks run again with a fresh retry budget;
    - new commits are pushed to the same pull request, and a new Review Brief comment is posted;
    - the final Gate opens again, with no limit on Iterations;
    - the Run detail lists the Iterations.
- [x] `m2-03` **Codex Runner adapter**: a Step can run through Codex headless, sandboxed, behind the Runner seam (ADR 0006).
  - Spec: `docs/specs/m2-assets.md`
  - Blocked by: none
  - Acceptance:
    - runs `codex exec` with JSON output in the worktree, in the workspace-write sandbox, with approval prompts off, the Agent's instructions and the configured model, one fresh session per Step;
    - it runs in its own process group and can be cancelled like the Claude Runner;
    - a succeeded result carries the generated images, which the adapter collects itself from Codex's home folder by thread; the Claude Runner returns none;
    - a usage-limit turn failure with a retry time becomes Quota exhausted with that reset time; an image limit reported in the final message becomes Quota exhausted without one; anything else is a failure;
    - startup reports a missing or logged-out `codex`;
    - the contract suite passes against a fake `codex` with a temporary `CODEX_HOME` (success with and without an image, both limits, unreadable output, crash, cancellation, instructions and model passed through);
    - `npm run smoke:codex` (opt-in) generates one real 16x16 sprite.
- [x] `m2-04` **First assets Run**: the human orders sprites and tiles, reviews them in a gallery and gets a pull request.
  - Spec: `docs/specs/m2-assets.md`
  - Blocked by: `m2-01`, `m2-03`
  - Acceptance:
    - each Project has an Art Direction path (default `docs/ART_DIRECTION.md`) and an art folder (default `assets/art`), editable in the UI;
    - the Run form offers the Workflow; for `assets` it takes a list of Asset Requests (name, sprite or tile, description, size from 16x16, 18x18, 32x32 or custom);
    - a missing Art Direction opens an Escalation before anything is generated;
    - a Workflow gets a Runner and a model per Agent (Developer on Claude, Artist on Codex) instead of the single Runner and developer model m2-01 hands it;
    - the Artist (Codex) handles the Asset Requests one after the other, following the Art Direction; the Artist is given each Asset's target path (art folder / kind folder / kebab-case name `.png`) and writes the final Asset there itself; the Runner's raw images are kept in the Run Notes as a trace;
    - the Project's setup commands and Checks are skipped, and the Run takes a Project slot;
    - the Asset Gate shows each Asset at real size and magnified with crisp pixels, with a background colour tool beside the preview (UI grey by default, not saved);
    - the image route serves only the Assets recorded for that Run, never a path taken from the request (tested at the HTTP seam);
    - at the Asset Gate the human approves everything or abandons;
    - an `assets` Run waits at an Asset Gate, never a final Gate, so the developer-style reject with Feedback never applies to it;
    - a Gate decision refused for bad input (such as an empty Feedback) answers 400, not 409 (left by m2-02);
    - once approved: one commit, push, pull request, a Review Brief written by Forgequor (path, kind, size of each Asset), and the Run is Approved with no second Gate.
- [x] `m2-05` **Asset Checks**: broken files never reach the Asset Gate.
  - Spec: `docs/specs/m2-assets.md`
  - Blocked by: `m2-04`
  - Acceptance:
    - each Asset is checked to be a readable PNG with an alpha channel, of the exact requested size, at the expected path;
    - a failing Asset goes back to the Artist with the reason, for at most 2 extra attempts, then an Escalation names the Asset and the failure;
    - an Asset Request with nothing written at its target path gets one more try, then an Escalation with the Artist's last message;
    - `npm run smoke:codex` also checks the file the Artist wrote in the working directory: a PNG with transparency at exactly 16x16 (today it only checks the raw image is a PNG);
    - an Asset Request has a fill flag, off by default, for any kind: when on, the Artist fills the whole square edge to edge, and any transparent pixel fails the Asset Checks; when off, the Artist may use transparency as it sees fit (found in the first real assets Run, where a ground tile came back mostly transparent);
    - the Asset Gate's text no longer says Assets are waiting once it is decided, and the Projects screen's Art Direction path field is wide enough to show the whole path;
    - colours outside the Art Direction palette (the `#RRGGBB` codes under its "Palette" heading) are shown as a warning on the Asset, never a failure; no palette, no warning.
- [x] `m2-06` **Per-Asset verdicts and Iterations**: only the Assets the human rejects are redone.
  - Spec: `docs/specs/m2-assets.md`
  - Blocked by: `m2-04`, `m2-02`
  - Acceptance:
    - at the Asset Gate each pending Asset is approved, or rejected with its own required Feedback; the whole batch is submitted at once and a partial set is refused;
    - a new Iteration redoes only the rejected Assets, each with its Feedback and its rejected version as a reference image;
    - approved Assets are kept as they are;
    - the gallery shows each Asset's past versions and Feedback;
    - the Review Brief lists the Feedback that led to each Asset.
- [ ] `m2-07` **Animation Strips**: the human can order animations, frames side by side in one image.
  - Spec: `docs/specs/m2-assets.md`
  - Blocked by: `m2-05`
  - Acceptance:
    - an Asset Request can be an Animation Strip with a frame count; frames have the chosen size and sit side by side horizontally;
    - Animation Strips land in the `animations` kind folder;
    - the Asset Checks expect a width of frame width × frame count;
    - the gallery shows the strip and its frame count, and the Review Brief gives it.
- [ ] `m2-08` **References, default size and safe replacement**: new art matches existing art, and nothing is overwritten by accident.
  - Spec: `docs/specs/m2-assets.md`
  - Blocked by: `m2-04`
  - Acceptance:
    - reference images named in the Art Direction are always given to the Artist; an Art Direction without any works the same;
    - an Asset Request can name existing repository images as style references;
    - a `Default size: WxH` line in the Art Direction presets the size in the Run form;
    - an Asset Request can be marked as replacing an existing file;
    - starting a Run is refused, before anything is generated, when a file would be overwritten without that mark, when two Asset Requests would produce the same file, or when a reference does not exist;
    - the README documents the Art Direction contract (Palette heading, Default size line, reference images).
- [ ] `m2-09` **Resilient, live assets Runs**: an `assets` Run survives limits and restarts, and shows its progress.
  - Spec: `docs/specs/m2-assets.md`
  - Blocked by: `m2-04`
  - Acceptance:
    - an exhausted Codex Quota pauses the Run and resumes it like a `developer` Run, at the Asset it was on;
    - after a Forgequor restart, a running `assets` Run picks up at its current Asset, keeping the Assets already produced;
    - abandoning the Run kills the running Codex process group;
    - the Run detail shows progress live, Asset by Asset.
    - tests cover resuming a `developer` Run in the middle of a Feedback Iteration (after a Quota pause and after a restart), and a rejection racing an abandon (left untested by m2-02).

## Next

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
- After a hard crash of Forgequor (kill -9, power loss), detached Runner and Check process groups survive; on restart, kill or wait for them before restarting the Step, so two Developers never share a worktree.
- Keep the partial Check results of an interrupted attempt (marked interrupted) instead of deleting them before the Checks run again.
- Live progress survives a page reload or reconnection mid-Step (events kept as they come, not only at the end of the Step).
- Stream Check output live, like the Developer's events.
- Coalesce live "changed" updates so a chatty Agent does not make the UI reload the Run on every event.
- Tileset atlas: an Asset Request for N tiles delivered as one atlas image (Godot TileSet), instead of one file per tile (M2 grilling).
- Produce a Run's Asset Requests in parallel instead of one after the other (image generation burns Quota 3-5x faster, so sequential first).

## Done

### M1 Walking skeleton (done 2026-11-26)

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
- [x] `m1-08` **Quota pause, restart recovery, Runner failures**: no Run fails or gets stuck for a temporary reason.
  - Spec: `docs/specs/m1-walking-skeleton.md`
  - Blocked by: `m1-05`, `m1-06` (PR polling to resume on startup)
  - Acceptance:
    - when the Quota is exhausted, the Run goes Paused with its reset time and restarts its current Step after the reset;
    - on Forgequor startup, Running Runs restart their current Step, Approved Runs resume PR polling, and each Project starts the Queued Runs that fit its free slots (a Run Queued before a restart must not stay stuck);
    - a Runner failure opens an Escalation with the error;
    - a Step running longer than a configurable timeout has its Runner process killed and opens an Escalation saying so;
    - killing a timed-out Step or Check ends its whole process group, so no child process (such as a headless engine) survives it;
    - abandoning a Run while a Step or Check is running kills it the same way (today the Developer keeps running after m1-06's abandon).
- [x] `m1-09` **Live Step progress**: the human watches the Agent work in real time.
  - Spec: `docs/specs/m1-walking-skeleton.md`
  - Blocked by: `m1-03`
  - Acceptance:
    - the Run detail shows the running Step's events live through server-sent events;
    - the Run's state updates without a page reload.
- [x] `m1-11` **Dogfooding readiness**: Forgequor can run its own roadmap items as Runs, starting with M2.
  - Spec: `docs/specs/m1-walking-skeleton.md`
  - Blocked by: `m1-05`
  - Acceptance:
    - the Docker Compose project has a fixed name, so tests run from any checkout or Run worktree reuse the one PostgreSQL instead of starting a second one on the same port;
    - a Project declares ordered setup commands, editable in the UI like its Checks, that run in a new worktree before the Developer;
    - a failing setup command opens an Escalation with its output, and the Developer never starts;
    - the README shows how to register Forgequor itself: setup `npm ci` then `scripts/link-skills.sh`, Checks `npm run typecheck` then `npm test`;
    - a real Run on Forgequor itself, on a trivial task, gets through setup, Developer and Checks to a pull request.
