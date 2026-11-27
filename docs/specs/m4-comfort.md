# M4 Comfort

Roadmap: M4a (running Forgequor day to day) then M4b (setting it up). Vocabulary: `GLOSSARY.md`. Decisions:
- ADR 0002: local-first subscription Runners.
- ADR 0007: Workflows compose coded Step types in YAML.

Builds on M3b (`docs/specs/m3b-the-team.md`): Agent seats set by environment variables, the shared Skill Pack in every Run, and the `feature` and `bugfix` Workflows. The decisions below come from the M4 grilling. The UI refresh (`docs/specs/ui-refresh/README.md`) comes later and will redo these screens, so the M4 screens stay minimal and are built on the current UI.

## Problem Statement

Forgequor now runs a whole team, but living with it is tiring:

- **Nothing is ever cleaned up.** Every finished Run keeps its worktree and local branch forever. Abandoned Runs leave their branch on GitHub. The database keeps every Run, so the Runs list only grows.
- **The human has to watch the tab.** A Run can wait at a Gate or pause on an exhausted Quota for hours before the human notices.
- **Quota is invisible.** The human learns a Runner's Quota is used up when a Run pauses. Claude Code shows the percentages in its own `/usage`, but Forgequor does not, so the human cannot choose solo or duo review, or Claude or Codex for a seat, with the numbers in front of them.
- **Seats need a restart.** Moving an Agent to another Runner or model means editing environment variables and restarting Forgequor. One Run cannot use a different model from the others.
- **Projects cannot pick Skills.** Every Run gets the shared Skill Pack, but a Godot Project cannot get the `godot` pack without copying it into its repository.
- **Workflows are opaque.** The human cannot see which Workflows a Project offers, what their Steps are, or why a Project Workflow is not offered, without reading YAML files. Writing a new Workflow means learning the Step types by reading the code.

## Solution

**M4a, running it day to day:**

- **Archive.** As soon as a Run ends (merged, closed or abandoned), Forgequor removes its worktree and local branch. The Run is then Archived: its Run Notes, reviews, Gates and transcripts stay readable. If the Run was abandoned or its pull request closed unmerged, Forgequor also deletes the remote branch it pushed. On its first start, Forgequor archives the finished Runs that still have a worktree.
- **Purge.** An Archived Run is deleted from the database 60 days after it was archived (the number of days can be changed). The purge runs at startup, then once a day.
- **Notifications.** Forgequor shows a macOS notification when a Run waits at a Gate, opens an Escalation, pauses on an exhausted Quota, or when its pull request is merged or closed by someone else. Notifications can be turned off.
- **Quota bars.** A bar per vendor (Claude, Codex) at the top of the app shows the five-hour and weekly windows: percent used and reset time. Claude's figures come from its `/usage`, read at startup, after every Claude Step and every 5 minutes, which costs no Quota. Codex's come from its session file after every Codex Step. A bar with no reading is greyed "unknown", and each says how old its reading is. New Run warns next to a seat whose Runner is exhausted.

**M4b, setting it up:**

- **Team page.** One place to set each seat's Runner and model, saved in the database and used by the next Steps without a restart. An environment variable still wins, and the page shows that seat locked with the variable's name.
- **Seats per Run.** New Run has a folded "Seats" section, filled with the current settings, to change a seat for that Run only. A Run freezes its seats when it starts, and its detail shows the Runner and model each Agent Step used.
- **Skill Packs per Project.** A Project's page lets the human pick Skill Packs on top of `shared`. New Runs get them, and a Skill the Project has itself still wins.
- **Workflows page.** A read-only list of the built-in Workflows and the selected Project's own, each with its Steps, its YAML, and the validation errors that keep an invalid one from being offered.
- **`/to-workflow`.** A shared Skill that turns a need into a Project Workflow. It first looks for a close existing Workflow to reuse or adjust. Otherwise it writes a new one from the real Step types and asks the running Forgequor to validate it.

## User Stories

### Archive and purge

1. As the human, I want a Run's worktree removed as soon as its pull request is merged, so that my disk does not fill up with finished work.
2. As the human, I want a Run's worktree removed as soon as its pull request is closed unmerged, so that rejected work does not linger.
3. As the human, I want a Run's worktree removed as soon as I abandon it, so that abandoning really cleans up.
4. As the human, I want the Run's local branch deleted with its worktree, so that the Project's checkout is not cluttered with `forgequor/` branches.
5. As the human, I want the remote branch of an abandoned Run deleted, so that GitHub does not collect dead branches Forgequor pushed.
6. As the human, I want the remote branch of a pull request closed unmerged deleted, so that a rejected change leaves nothing behind.
7. As the human, I want the remote branch of a merged pull request left to GitHub's own setting, so that Forgequor does not fight the repository's rules.
8. As the human, I want an Archived Run to keep its Run Notes, reviews, Gates, Feedback, transcripts and Step attempts, so that I can still read why it went the way it did.
9. As the human, I want an Archived Run to keep its outcome (merged, closed or abandoned), so that the history says how each Run ended.
10. As the human, I want an Archived Run's Asset previews replaced by "files removed, see the pull request", so that the page does not show broken images.
11. As the human, I want an Approved Run to keep its worktree until its pull request is merged or closed, so that a rebase is still possible.
12. As the human, I want Forgequor to archive, at its first start, the finished Runs that still have a worktree, so that the leftovers from before M4 are cleaned up too.
13. As the human, I want a worktree that cannot be removed (already gone, locked) not to block archiving, so that one odd folder does not keep a Run unarchived forever.
14. As the human, I want Archived Runs hidden from the Runs tab by default, with a filter to show them, so that the list shows what is alive.
15. As the human, I want an Archived Run deleted from the database 60 days after it was archived, so that the database does not grow forever.
16. As the human, I want to change that delay with an environment variable, so that I can keep history longer or shorter.
17. As the human, I want the purge to run at startup and then once a day, so that it happens without me thinking about it.
18. As the human, I want a purged Run to take its Gates, reviews, Run Notes, attempts and Assets records with it, so that nothing dangling stays in the database.
19. As the human, I want the purge to say in the log how many Runs it deleted, so that I can tell it ran.
20. As the human, I want a Run that is not Archived never purged, however old, so that live or Approved work is never lost.

### Notifications

21. As the human, I want a macOS notification when a Run waits at a Gate for me, so that I do not have to watch the tab.
22. As the human, I want a macOS notification when a Run opens an Escalation, so that I know an Agent is stuck.
23. As the human, I want a macOS notification when a Run pauses on an exhausted Quota, with the reset time, so that I know nothing will move before then.
24. As the human, I want a macOS notification when a Run's pull request is merged or closed outside Forgequor, so that I know the Run ended.
25. As the human, I want each notification to name the Run's number and title and what happened, so that I know which Run needs me without opening the app.
26. As the human, I want no notification when a Step simply finishes, so that notifications stay rare enough to matter.
27. As the human, I want to turn notifications off with an environment variable, so that tests and demos stay quiet.
28. As the human, I want a failing notification never to affect the Run, so that a missing `osascript` cannot break a Workflow.

### Quota bars

29. As the human, I want a bar per vendor at the top of every tab, so that I always see how much Quota is left.
30. As the human, I want Claude's bar to show the percent used of the five-hour window and of the week, with their reset times, so that I see the same figures as in Claude Code.
31. As the human, I want Codex's bar to show the percent used of its five-hour and weekly windows, with their reset times, so that I can compare both vendors.
32. As the human, I want Claude's reading refreshed at startup, after every Claude Step and every 5 minutes, so that it stays current without spending Quota.
33. As the human, I want Codex's reading refreshed after every Codex Step, so that it follows what Forgequor spends.
34. As the human, I want each bar to say how old its reading is, so that I do not trust an old Codex figure as if it were live.
35. As the human, I want a bar with no reading shown greyed as "unknown", so that a missing figure is not mistaken for zero.
36. As the human, I want a reading Forgequor cannot parse to show "unknown" instead of an error, so that a CLI update does not break the app.
37. As the human, I want a Runner that pauses a Run for Quota to show its bar as exhausted until the reset time, so that the bar agrees with the pause.
38. As the human, I want New Run to warn next to a seat whose Runner's Quota is exhausted, with the reset time, so that I can move that seat before launching.
39. As the human, I want that warning not to block the launch, so that I can still queue work for after the reset.
40. As the human, I want the bars updated live, without reloading the page, so that they follow the Runs.

### Team page and seats

41. As the human, I want a Team page listing every seat with its Runner and model, so that I see who does what.
42. As the human, I want to change a seat's Runner and model on the Team page, so that I do not edit environment variables and restart.
43. As the human, I want to pick a model from a short list per Runner (Claude: opus, sonnet, haiku; Codex: its known models), so that I do not have to remember names.
44. As the human, I want to type an exact model identifier when the one I want is not listed, so that a new model does not need a Forgequor update.
45. As the human, I want my Team settings saved in the database, so that they survive a restart.
46. As the human, I want a seat set by an environment variable shown locked, with the variable's name, so that I understand why I cannot change it there.
47. As the human, I want the environment variable to win over the Team page, so that the BA suite and scripted setups keep working.
48. As the human, I want a changed seat used by the next Steps of new Runs, so that a change takes effect without a restart.
49. As the human, I want a folded "Seats" section in New Run, filled with the current settings, so that most launches stay one click.
50. As the human, I want to change a seat's Runner or model for one Run only, so that I can try a model on one task without changing the default.
51. As the human, I want a Run to freeze its seats when it starts, so that changing the Team page does not change a Run in progress.
52. As the human, I want the Run detail to show the Runner and model each Agent Step used, so that I know which model wrote what.
53. As the human, I want a seat with a Runner Forgequor cannot start to still open an Escalation naming it, so that a wrong setting is explained where it bites.

### Skill Packs per Project

54. As the human, I want a Project's page to list the Skill Packs Forgequor ships, so that I see what I can give its Agents.
55. As the human, I want to pick Skill Packs for a Project on top of `shared`, so that a Godot Project's Agents get the `godot` Skills.
56. As the human, I want the `forgequor` pack left out of that list, so that Forgequor's own development Skills never land in a game.
57. As the human, I want a Run to get the Project's packs at its start, for Claude Code and for Codex, never committed, so that they behave like the shared pack.
58. As the human, I want a Skill the Project has itself to win over any pack's, so that a Project can override a Skill.
59. As the human, I want changing a Project's packs to affect only the Runs launched afterwards, so that a Run in progress keeps the Skills it started with.

### Workflows page

60. As the human, I want a Workflows page listing the built-in Workflows and the selected Project's own, so that I know what I can launch.
61. As the human, I want each Workflow shown with its Steps in order, their type, Agent, `needs` and `when`, so that I understand what it does without reading YAML.
62. As the human, I want to see a Workflow's YAML, so that I can copy or check it.
63. As the human, I want an invalid Project Workflow listed with its validation errors, so that I know why it is not offered at launch.
64. As the human, I want to see which Project Workflow overrides a built-in one, so that I am not surprised by what runs.
65. As the human, I want the page to be read-only, so that Workflows stay files under version control.

### `/to-workflow`

66. As an Agent or the human in a game Project, I want a `/to-workflow` Skill that turns a need into a Workflow, so that writing one does not mean learning the engine.
67. As its user, I want it to look first for a close existing Workflow, built-in or the Project's, and propose reusing or adjusting it, so that Workflows do not multiply.
68. As its user, I want it to write a new Workflow in the Project's Workflows folder using only the real Step types, so that the result can run.
69. As its user, I want it to ask the running Forgequor to validate the file and fix what is reported, so that I get a Workflow that is offered at launch.
70. As its user, I want it to tell me to open the Workflows page when Forgequor is not running, so that I still have a way to check the file.
71. As the maintainer, I want the Skill's reference of Step types kept in sync with the code by a test, so that it never describes Step types that do not exist.

## Implementation Decisions

### Archive (M4a)

- **Archived is a mark, not a new Run state.** A Run keeps its outcome state (merged, closed, abandoned) and gains an archived-at time. "Archived" in the UI and the glossary means a finished Run that has that time; the glossary's lifecycle line is reworded accordingly. This keeps the outcome readable after archiving and adds no state to the transition rules.
- **When.** Archiving happens in Forge core right after a Run reaches merged, closed or abandoned, whatever caused it (a Gate decision, the pull request poller, an abandon). It removes the worktree (`git worktree remove --force`, then the folder if it is still there), deletes the local branch, prunes the Project's worktree list, and records the archived-at time. Any step that finds its target already gone counts as done; a step that fails is logged and does not stop the others, and the Run is marked archived anyway, since what is left is a stray folder.
- **Remote branch.** For an abandoned Run, or a pull request closed unmerged, the Code Host deletes the remote branch, if Forgequor pushed one. After a merge, Forgequor leaves it to the repository's own setting. The Code Host port gains the branch deletion; the fake Code Host records it.
- **Startup catch-up.** At startup, Forgequor archives every finished Run without an archived-at time, the same way, before resuming live Runs.
- **Archived Run detail.** The Run detail works from the database alone: Run Notes, reviews, Gates, transcripts and attempts are already stored there. Anything read from the worktree (Asset previews, a Run Note file) shows "files removed, see the pull request" when the worktree is gone.
- **Runs list.** The Runs tab hides Archived Runs by default; a filter shows them.

### Purge (M4a)

- `FORGEQUOR_ARCHIVE_DAYS` (default 60) sets how long an Archived Run stays.
- A purge deletes the Runs archived more than that many days ago, and everything that belongs to them (cascading deletes from the Run). It never touches a Run without an archived-at time.
- It runs at startup and then every 24 hours while Forgequor runs, and logs how many Runs it deleted.
- Forge core takes an injectable clock (`now`) so tests drive the delay without waiting.
- Griller sessions in the Claude data folder stay out of scope (M3b decision).

### Notifications (M4a)

- **A new Notifier port** in Forge core's dependencies: one method taking a title and a message. Production uses `osascript` (`display notification`), with no click action and no new dependency. Tests use a fake that records what it was given.
- `FORGEQUOR_NOTIFICATIONS=off` swaps in a Notifier that does nothing. The default is on.
- **Events that notify:** a Gate opens (any human Gate kind), an Escalation opens, a Run pauses on an exhausted Quota (with the reset time when known), and the pull request poller finds a Run's pull request merged or closed. A Step finishing does not notify.
- **Message:** the title is "Forgequor"; the message names the Run (`Run #42 "Title"`) and what happened (for example "spec Gate open", "Escalation: …", "paused until 16:00", "pull request merged").
- **Never fatal.** Notify is fire-and-forget: an error is logged and swallowed, and never changes a Run.
- A click that opens the Run needs a URL per Run, which comes with `vue-router` in the UI refresh. It is left for then.

### Quota readings (M4a)

- **A Quota Reading** is what Forgequor last learned about one vendor's Quota: for each window (five-hour, weekly), the percent used and the reset time, both possibly unknown; plus whether it is exhausted, and when it was read. A new glossary entry defines it.
- **The Runner port gains two things.**
  - A Step result may carry a Quota Reading.
  - Runners gain an optional on-demand `readQuota()` that returns a Quota Reading or nothing.
- **Claude.**
  - `readQuota()` runs `claude -p "/usage" --output-format json`, which answers without calling a model (0 token, 0 cost), and parses the "Current session" and "Current week (all models)" lines: percent used and reset time in the local time zone.
  - After each Step, the Claude Runner also turns the stream's `rate_limit_event` into a partial reading: allowed or rejected, the window type and its reset time. Forge core then asks for a full `readQuota()`.
  - Text it cannot parse yields an unknown reading, never an error.
- **Codex.**
  - After each Step, the Codex Runner finds the session file named after the thread id that `thread.started` gave, in Codex's sessions folder. It reads the last `token_count` event's `rate_limits`: `primary` is the five-hour window and `secondary` the weekly one, each with a percent used and an epoch reset time.
  - It has no on-demand reading, since nothing found so far gives one for free.
  - A missing or unreadable file yields no reading.
- **Storage.** Forge core keeps the latest reading per vendor in the database (one row per vendor, replaced on each reading), so the bars survive a restart. A Quota pause also records an exhausted reading with its reset time.
- **Refresh.** Forge core calls Claude's `readQuota()` at startup, after every Claude Step, and every 5 minutes. Codex is read after every Codex Step. Each new reading is pushed on the live-events stream.
- **HTTP.** `GET /api/quota` returns both vendors' readings with their age. The New Run form uses them to warn next to a seat whose Runner is exhausted, without blocking.
- **UI.**
  - A compact bar per vendor sits at the top of the app, on every tab. It shows both windows' percent used and reset times, greyed "unknown" without a reading, and the reading's age.
  - The Team page shows no Quota.

### Seats (M4b)

- **Team settings in the database:** one row per seat with its Runner and model, both optional. A seat's effective setting is, in order:
  1. its environment variable (`FORGEQUOR_<SEAT>_RUNNER` / `_MODEL`), when set;
  2. else the Team setting;
  3. else the code's default.
  Runner and model are resolved separately.
- **Read when a Run starts, not at startup,** so a Team change applies to the next Runs without a restart.
- **Frozen per Run.** At start, a Run records its effective seats, after the per-Run overrides from New Run. Every Agent Step of that Run uses the frozen seats, and a restart resumes with them. Runs started before M4 have none frozen and keep resolving them as today.
- **Model lists:** each Runner exposes a short list of model aliases to offer (Claude: opus, sonnet, haiku; Codex: its known models); any other identifier is accepted as typed.
- **HTTP:**
  - `GET /api/team` returns each seat with its effective Runner and model, where each comes from (environment, Team, default) and the variable name when it comes from the environment;
  - `PUT /api/team/:seat` saves a seat, refusing an unknown seat or Runner and a seat locked by the environment;
  - `POST /api/runs` accepts optional per-seat overrides, validated the same way.
- **UI:**
  - a Team tab, with the locked seats read-only and naming their variable;
  - a folded "Seats" section in New Run, filled from `GET /api/team`, with the Quota warning beside each seat;
  - the Run detail shows each Agent Step's Runner and model.
- Seat Runner failures keep opening an Escalation naming the seat (M3b behaviour).

### Skill Packs per Project (M4b)

- **The packs offered** are the folders of Forgequor's `skills/` that hold Skills, minus `shared` (always given) and `forgequor` (Forgequor's own).
- **A Project's chosen packs are stored with the Project,** like its Checks and concurrency, and changed through the Project's page (`PUT /api/projects/:id/skill-packs`, refusing an unknown pack).
- **At a Run's start,** the Skill Pack module places `shared` and then each chosen pack. A Skill the Project already has still wins. When two packs have a Skill of the same name, the first placed wins: `shared`, then the chosen packs in the order offered. Everything stays excluded from commits, as in M3b.
- **The choice is read at the Run's start,** so a change affects only later Runs.

### Workflows page and validation (M4b)

- **`GET /api/projects/:id/workflows` returns every Workflow,** not only the valid ones. For each it gives its source (built-in or Project), whether it overrides a built-in one, its Steps (id, type, Agent, `needs`, `when`), its YAML text, and its validation errors. The launch list keeps offering only the valid ones.
- **`POST /api/workflows/validate`** takes YAML text (and optionally a Project, to resolve what it may reference). It returns the full list of validation errors, empty when valid, using the same definition validation as launch. It never stores anything.
- **The Workflows tab** is read-only and minimal: a list, each Workflow's Steps as a table, its YAML and its errors. The UI refresh redraws it later.

### `/to-workflow` (M4b)

- **A new Skill in the `shared` pack,** so every Run and the human in a game Project have it.
- **Its process:**
  1. understand the need;
  2. list the existing Workflows (the Project's Workflows folder, and the built-in ones described in the Skill) and propose reusing or adjusting a close one;
  3. otherwise write the Project's Workflows folder `<name>.yaml` using only the Step types in its reference;
  4. validate through `POST /api/workflows/validate` on the running Forgequor (its address is configurable, the local default otherwise), and fix until valid;
  5. if Forgequor does not answer, tell the human to open the Workflows page.
- **The Skill carries a reference of the Step types** (each type, its fields, and what it does) and of the built-in Workflows.

## Testing Decisions

- **What makes a good test:**
  - it drives a public interface and checks what the human or another module can observe: a Run's state, an archived-at time, a removed folder, a recorded notification, a reading returned by the API;
  - it never checks how that was done.
  - Tests follow `tdd`: one behaviour, red, green, refactor.
- **Forge core (the main seam):** `createForge` on the real test database, with the fake Runner, the fake Code Host, temp git repos with bare remotes, a fake Notifier and an injected clock. It covers:
  - archiving on each outcome, the remote branch rules, and the startup catch-up;
  - a worktree already gone;
  - purge timing and cascade, and that non-archived Runs are never purged;
  - each event that notifies and each that does not, and a throwing Notifier changing nothing;
  - Quota readings stored after Steps, a Quota pause recording an exhausted reading, and the 5-minute Claude refresh driven by the clock;
  - seat resolution order, per-Run overrides and frozen seats across a restart;
  - Skill Packs per Project placed at a Run's start, with precedence.

  Prior art: `tests/forge/runs.test.ts`, `step-display.test.ts`, `skill-pack.test.ts`, `review.test.ts`.
- **Runner contract:** the Claude and Codex Runners against fake CLIs (`tests/harness/fake-cli.ts`). They cover:
  - Claude's `readQuota()` parsing the real `/usage` text, then unknown on unparseable text;
  - the `rate_limit_event` partial reading;
  - Codex's reading from a fake session file named after the thread id, then no reading when it is missing.

  Prior art: `tests/runner/claude.test.ts`, `codex.test.ts`. The existing smoke tests gain one real `readQuota()` call each, where the Runner has one.
- **HTTP routes:** `GET /api/quota`, `GET`/`PUT /api/team`, per-seat overrides on `POST /api/runs`, `PUT /api/projects/:id/skill-packs`, the richer `GET /api/projects/:id/workflows`, and `POST /api/workflows/validate`. They check request shapes, refusals and error mapping. Prior art: `tests/http/workflows.test.ts`.
- **`/to-workflow` reference:** one test checks that the Step types named in the Skill's reference are exactly the registered Step types, and that its built-in Workflows list matches the built-in ones.
- **BA suite:** real Forgequor, sandbox repository, cheap models. A Run abandoned at its final Gate ends with no worktree, no local branch and no remote branch, and still shows its Run Notes and reviews. After a Claude Step, `GET /api/quota` returns a Claude reading with percentages. Notifications stay off in the BA. Prior art: `tests/acceptance/team.ba.ts`.
- **The macOS Notifier itself** (the `osascript` call) is a thin adapter, checked by hand once; it is not run in the suite.

## Out of Scope

- Clicking a notification to open the Run (needs a URL per Run, UI refresh).
- Runner fallback on an exhausted Quota, and any blocking based on Quota (Icebox).
- An on-demand Codex reading (no free source found; `codex app-server` untested).
- Per-Project seat settings (global Team settings only).
- Editing Workflows in the UI, and a graph view of Workflows (UI refresh).
- Purging Griller sessions in the Claude data folder.
- Notifications on other systems than macOS, and Web Notifications.
- Restoring an Archived Run, or keeping its Asset files.

## Further Notes

- **Item order:**
  - M4a: Archive first (it also cleans the leftovers on disk), then purge, notifications and Quota readings;
  - M4b: Team settings and frozen seats before the New Run Seats section, then Skill Packs per Project, the Workflows page and validation endpoint, and `/to-workflow` last, since it needs the endpoint.
- **Claude `/usage` text is a contract we do not own.** It is a human-readable text that a Claude Code update may change. The parser and its contract test make such a change show up as "unknown" bars and one failing test, not a broken app.
- Each `claude -p "/usage"` call creates a tiny session record in the Claude data folder; at one every 5 minutes this is acceptable, and it is noted here in case it grows.
- The M4 screens (Team, Workflows, Seats section, Quota bars) are deliberately plain: the UI refresh redraws them with the design tokens and the router.
