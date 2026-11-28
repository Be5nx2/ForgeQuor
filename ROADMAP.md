# Roadmap

Format and rules: `docs/agents/issue-tracker.md`. Vocabulary: `GLOSSARY.md`. Decisions: `docs/adr/`.

Milestones are specified one at a time with `/to-spec`, then split into items with `/to-tickets`.

## Now

Nothing in progress.

## Next

### Project removal and purge now

Remove a **Project** from Forgequor (active Runs abandoned, every Run deleted, the human's repository untouched beyond what Archiving removes, typed-name confirmation, resumable after a failure) and purge Archived Runs on demand, per Project or for all. Source: Dogfood Note #1. Spec: `docs/specs/project-removal.md`.

- [x] `rm-01` **Purge Archived Runs now**: the human clears Archived Runs on demand, for every Project from the top of the Projects screen or for one Project from its new Danger zone, without waiting 60 days.
  - Spec: `docs/specs/project-removal.md`
  - Blocked by: none
  - Acceptance: a Forge operation deletes the Archived Runs in scope (all Projects or one), whatever their age, with everything that belongs to them, and returns the count; active and finished-not-Archived Runs are never touched; the daily purge is unchanged; the log uses the daily purge's wording; an HTTP route (400 bad input, 404 unknown Project); "Purge Archived Runs" at the top of the Projects screen and a red Danger zone at the bottom of the Project form with "Purge its Archived Runs now"; a simple confirmation states the count; buttons disabled with "No Archived Run" at zero; a "Starting over" section in the README (stop Forgequor, drop the database or its Docker volume, empty the worktrees folder); Forge tests on the real database, route tests, front logic in a tested module, checked in a browser.
- [x] `rm-02` **Remove a Project without active Runs**: the human removes a Project from its Danger zone after typing its name; Forgequor forgets it and every Run it had, and the repository stays as it is.
  - Spec: `docs/specs/project-removal.md`
  - Blocked by: `rm-01`
  - Acceptance: a removal preview read (Runs count, active Runs with their pull request, Archived count); the Project gains a removal mark (schema change); finished Runs not yet Archived go through the Archive clean-up on disk, then every Run is deleted by cascade, then the Project with its own settings (Skill Packs and other per-Project rows, by cascade); the Project's folder, its other branches and GitHub are untouched; Dogfood Notes unchanged; re-registering the same folder gives a fresh Project; a Project with an active Run is refused with a clear message (lifted by rm-03); the confirmation enables Remove only when the typed name matches exactly and shows the Runs count; the sidebar falls back to All Projects; counts logged; Forge tests on the real database with temporary repositories, route tests (404, 400, 409), front logic tested, checked in a browser.
- [x] `rm-03` **Abandon active Runs and resume after a failure**: removing a Project with work in progress abandons it like the Abandon button, and a removal that fails half-way can be retried.
  - Spec: `docs/specs/project-removal.md`
  - Blocked by: `rm-02`
  - Acceptance: the removal abandons each Queued, Running, Waiting, Paused and Approved Run through the existing abandon (open pull request closed and remote branch deleted, a merged one ends Merged, a running Step stopped) and no longer refuses; the confirmation lists the active Runs with the pull request each will close; while the removal mark is set, launching a Run on the Project is refused and the scheduler never starts its Queued Runs; a code host failure stops the removal, keeps the Project and its mark, and names the failing step (502); the Projects screen shows "Removal interrupted" with Retry, across restarts, never resumed automatically; a retry picks up where it stopped; Forge tests with a fake code host failing then answering, route tests, checked in a browser.

### Polish

Small fixes found by dogfooding (Dogfood Notes triaged with `/dogfood-triage`).

- [x] `pol-01` **Readable Quota bars**: each vendor shows its five-hour and weekly windows as real gauges the human reads at a glance, instead of the compact "5h 25% resets …" text.
  - Spec: `docs/specs/m4-comfort.md` (Quota bars); Dogfood Note #3
  - Blocked by: none
  - Acceptance: one gauge per window (five-hour, week) with a clear label, the percent used and the reset time apart; the gauge colour follows the status system (orange from a threshold, red when exhausted); an unknown reading stays greyed "unknown" with its age; same data and refresh as today; checked in a browser at 1440 px.
- [x] `pol-02` **Codex Quota read on demand**: the Codex bar is filled at startup and every 5 minutes like Claude's, without waiting for a Codex Step.
  - Spec: `docs/specs/m4-comfort.md` (Quota Reading); Dogfood Note #3
  - Blocked by: none
  - Acceptance: the Codex Runner gains `readQuota()` that starts `codex app-server`, sends `initialize`, `initialized` then `account/rateLimits/read`, and maps `rateLimits.primary` (300 min) and `secondary` (10080 min) to the five-hour and weekly windows (`usedPercent`, `resetsAt` in epoch seconds); it costs no Quota and times out cleanly; a failure leaves the last reading and is logged, never disturbing a Step; the session-file reading after a Step stays as a fallback; unit tests on a recorded answer, plus one real call in the smoke tests.
- [ ] `pol-03` **Stable timing tests**: the full suite passes on the first run, every run, so a red run always means a real bug.
  - Spec: none (found while orchestrating, 2026-11-28)
  - Blocked by: none
  - Acceptance: the tests seen failing at random under a full run, then passing on a rerun, are made deterministic (injected clock and `every`, awaited idle points instead of sleeps or real timers, no shared state between files): at least `tests/forge/quota.test.ts` ("asks once more when a Step ends while a reading is under way"), `tests/forge/feature-art.test.ts` ("sends back Asset Requests…"), `tests/forge/parallel-steps.test.ts`, `tests/store/frozen-definitions.test.ts`; the one full run where every test hung about 10 minutes is explained (a lock, a leaked server or process, a database contention) and prevented; the full suite passes 5 runs in a row; tests keep testing through the public interfaces.

## Icebox

- Child Runs: a feature Run splitting its spec into one Run per ticket (ADR 0001).
- Verifier Agent (M5 candidate, decided in the M3 grilling): a Step that runs the real app and the opt-in smoke tests and checks each acceptance criterion before the final Gate (green unit tests missed m1-03's undecidable Gates). To think through later.
- Conductor Agent (the sprint manager), after M3: reads the roadmap, computes the frontier, spots hidden dependencies and parallel-safe items, proposes the next Runs; advisory first, then driving Child Runs. Touches ADR 0001.
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
- Animated preview of an Animation Strip in the gallery (frames played in a loop, larger than the 4x a 64 px strip gets today), to judge the motion (real strip test, m2-07).

- M2 review follow-ups (2026-11-27), small, fixed in `m3-00b`:
  - the `assets` Review Brief omits palette warnings (spec story 46);
  - Gates do not record their Iteration, so an `assets` Iteration shows no Feedback in the Run detail;
  - a read Run does not expose each attempt's Asset Check failures;
  - Replaced Art stops being given to the Artist after the Asset's first rejection;
  - the two retry budgets add up to 4 Artist Steps per Asset per Iteration: confirm or cap the Quota exposure;
  - a bare Codex `error` event on an unfinished turn is read as an exhausted Quota;
  - the UI's API types are copies of the server's and have drifted (no `rejected` Asset status); a dead "Approve all Assets" label;
  - tests that abandon a Run by SQL instead of the Forge interface; README art path omits `animations`.

## Done

### UI refresh (done 2026-11-28)

New information architecture and cinematic restyle of the web UI (direction B): Runs home with "Waiting for you" pinned, left sidebar with Project selector and Gate count, `vue-router` with a URL per Run, Gate and Project, Run detail as Step rail plus panel with fixed Gate actions, a status system (colour, glyph and label), shared loading, empty and error states, an accessibility floor, and design tokens as CSS variables. Desktop only, dark only. Spec and mockups: `docs/specs/ui-refresh/README.md`.

Every item must match its mockup in `docs/specs/ui-refresh/` (same layout, components, tokens and wording): checked by a browser screenshot next to the mockup, plus the full test suite. Where M4 shipped after the mockups: Team, Workflows and Dogfood Inbox become real sidebar entries in the mockups' order; Quotas are one bar per vendor at the top of every screen (M4 decision), not a sidebar page; Skill Packs stay in Projects, since they are chosen per Project.

- [x] `ui-01` **A URL per screen**: the human can share or refresh `/runs`, `/runs/:id`, `/new`, `/projects/:id`, `/workflows`, `/team` and `/inbox` and land on the same place; Back and Forward work.
  - Spec: `docs/specs/ui-refresh/README.md`
  - Blocked by: none
  - Acceptance: `vue-router` replaces the tab state; every current screen is reachable by its URL and a refresh keeps it; an open Gate is reachable through its Run's URL; an unknown URL or Run shows a clear not-found message; the server serves the app for these paths; **+ Note** takes its tab and Run from the route; the look is unchanged; existing tests pass.
- [x] `ui-02` **Design tokens and app shell**: every screen sits in the mockups' shell: left sidebar with logotype, **+ New Run**, Project selector placeholder, navigation and **+ Note** at the bottom, the Quota bars at the top.
  - Spec: `docs/specs/ui-refresh/README.md`
  - Blocked by: `ui-01`
  - Acceptance: `tokens.css` copied as is and `shell.css` turned into one layout component; sidebar matches `runs.html` (logotype FORGE/QUOR, New Run, Project button, nav Runs, Projects, Team, Workflows, Dogfood Inbox with its badge, **+ Note** at the bottom replacing the floating button); one Quota bar per vendor at the top of every screen; dark theme only; Orbitron, Inter and JetBrains Mono with system fallbacks; `aria-current` on the active entry and `:focus-visible` everywhere; existing screens render inside unchanged otherwise.
- [x] `ui-03` **Status system and shared states**: every status reads the same everywhere, and every screen shows the same loading, empty and error states.
  - Spec: `docs/specs/ui-refresh/README.md`
  - Blocked by: `ui-02`
  - Acceptance: one status component with colour, glyph and label (running blue ●, waiting for you orange ●, done green ✓, failed red ✕, idle grey ○, paused ‖) as in the mockups' chips; green and red used for results only; shared loading, empty (with the next step) and error (with Retry) components matching `states.html`; used on every existing screen.
- [x] `ui-04` **One live stream and the Gate count**: the whole app follows one live-events stream, and the sidebar shows how many Gates wait for the human.
  - Spec: `docs/specs/ui-refresh/README.md`
  - Blocked by: `ui-02`
  - Acceptance: a single event stream per browser tab shared by every screen (no screen opens its own); views reload what they missed on reconnection; the Runs entry carries the open-Gate count as in `runs.html`, updated live when a Gate opens or closes; fine-grained patching stays out of scope.
- [x] `ui-05` **Runs home**: the home page is the Runs list with "Waiting for you" pinned at the top, as in `runs.html`.
  - Spec: `docs/specs/ui-refresh/README.md`
  - Blocked by: `ui-03`, `ui-04`
  - Acceptance: Gate cards first, then "Waiting for your merge", then every Run with its lifecycle state, Workflow, current Step, Iteration and time, filterable by state; each row links to the Run's URL; the separate Waiting screen is gone; empty and loading states shown; matches `runs.html`.
- [x] `ui-06` **Project selector**: the human picks a Project in the sidebar and every screen narrows to it.
  - Spec: `docs/specs/ui-refresh/README.md`
  - Blocked by: `ui-05`
  - Acceptance: the selector lists the Projects plus "All Projects"; the choice is kept in the URL and survives a refresh; it filters the Runs home, the merge list and the Gate count, and preselects the Project in New Run; no Project registered shows the empty state that leads to Projects.
- [x] `ui-07` **Run detail**: a Run shows its Steps on a rail and the selected Step beside it, with the Gate actions fixed at the top while a Gate is open, as in `run-detail.html`.
  - Spec: `docs/specs/ui-refresh/README.md`
  - Blocked by: `ui-03`, `ui-04`
  - Acceptance: the rail shows each Step's state, Iteration and Runner (sub-Steps indented); selecting a Step shows its log, output, Feedback, Run Notes and the seats it used; the Gate bar stays fixed while scrolling; the review Gate shows remarks, Runner chips and the Consolidator's disagreement; the live log has `aria-live`; abandon stays available; matches `run-detail.html`.
- [x] `ui-08` **Conversation and Spec Gates**: the Conversation Gate and the Spec Gate use the Run detail pattern, as in `run-gate-conversation.html` and `run-gate-spec.html`.
  - Spec: `docs/specs/ui-refresh/README.md`
  - Blocked by: `ui-07`
  - Acceptance: the conversation with the Griller shows its rounds and recommended answers, an answer box and "Confirm summary"; the spec Gate renders the spec with approve or reject with Feedback; both keep the Gate bar fixed and the rail visible; match their mockups.
- [x] `ui-09` **Asset Gate**: the Asset Gate uses the Run detail pattern, as in `run-gate-assets.html`.
  - Spec: `docs/specs/ui-refresh/README.md`
  - Blocked by: `ui-07`
  - Acceptance: gallery at real size and magnified with pixel-sharp rendering; Asset Checks per Asset; Feedback per rejected Asset; version history; Gate bar fixed and rail visible; matches `run-gate-assets.html`.
- [x] `ui-10` **New Run**: launching a Run looks like `new-run.html` and shows what the Run will ask of the human.
  - Spec: `docs/specs/ui-refresh/README.md`
  - Blocked by: `ui-03`
  - Acceptance: Workflow choice, subject, solo or duo review, seats (with locked fields shown as locked); a preview of the Steps and of the Gates that will need the human; the Quota hint when both vendors are read; launching opens the new Run's URL; matches `new-run.html`.
- [x] `ui-11` **Projects**: the Projects screen looks like `projects.html`.
  - Spec: `docs/specs/ui-refresh/README.md`
  - Blocked by: `ui-03`
  - Acceptance: list of Projects with Checks, Setup, slots, Art Direction and Skill Packs; each Project has its own URL; the system warning banner appears when a required tool is missing; matches `projects.html`.
- [x] `ui-12` **Workflows, Team, Inbox and the note popup**: the screens M4 and the Dogfood Notes added follow the same design system.
  - Spec: `docs/specs/ui-refresh/README.md`
  - Blocked by: `ui-03`
  - Acceptance: Workflows, Team and Dogfood Inbox use the shell's panels, chips, forms and shared states; the note popup stays fully on screen at any window height; no behaviour changes; consistent with the round-2 mockups.

### Dogfood Notes (done 2026-11-28)

**Dogfood Notes** jotted from a floating **+ Note** button, a **Dogfood Inbox** tab, a Markdown **Dogfood Export** of selected notes, and a `/dogfood-triage` skill. Spec: `docs/specs/dogfood-notes.md`.

- [x] `dogfood-01` **Jot a Dogfood Note**: from any tab the human clicks **+ Note**, picks a nature (feedback or idea) and a target (workflow, feature, display, other; pre-selected from the tab), types a text and saves; the app records it with its context and closes the popup with a short "noted" message.
  - Spec: `docs/specs/dogfood-notes.md`
  - Blocked by: none
  - Acceptance: **+ Note** is visible on every tab; only the text is required and an empty text is refused with a clear message; what was typed is kept if saving fails; the tab, the Run or Project in view (shown as text, for example "Run #42") and the date are attached automatically; a note without Run or Project is accepted; an unknown Run or Project, or an invalid nature or target, is refused; notes are stored with source `internal`, status `new`, and never deleted or edited; the glossary defines **Dogfood Note**, **Dogfood Inbox** and **Dogfood Export** and says they are not a **Gate**'s **Feedback**; Forge core tests on the real database cover creation and refusals, HTTP route tests cover request shape and error mapping.
- [x] `dogfood-02` **Review notes in the Dogfood Inbox**: an Inbox tab lists the notes newest first, with a badge counting the new ones, filters, and buttons to triage or dismiss them.
  - Spec: `docs/specs/dogfood-notes.md`
  - Blocked by: `dogfood-01`
  - Acceptance: each note shows nature, target, text, date and origin; filters by status, nature and target; the badge counts `new` notes and updates after a change; a note can go `new` → `triaged` (with an optional free-text reference) or `dismissed`, and back to `new`; triaged and dismissed notes stay listed; only status and reference ever change; Forge core tests cover filters, the count, allowed transitions and the kept reference.
- [x] `dogfood-03` **Export selected notes**: the human selects notes in the Inbox and clicks **Export** to get one Markdown file, written in `docs/dogfood/` and offered for download.
  - Spec: `docs/specs/dogfood-notes.md`
  - Blocked by: `dogfood-02`
  - Acceptance: checkboxes per note plus "select all" for the current filter; the file is named `export_forgequor_<date>_<time>.md`; it has a header with the export date and note count, then one section per target with notes ordered by date, each showing ID, date, nature, target, origin as text, triage reference when present, and the text verbatim; the folder is configurable, defaults to `docs/dogfood/` and is created when missing; exporting changes no status; an empty selection and an unwritable folder give clear errors; Forge core tests cover content, grouping, ordering and file writing in a temporary folder.
- [x] `dogfood-04` **Triage notes with `/dogfood-triage`**: a Forgequor skill reads an export file, groups its notes by theme, proposes what each group becomes, and turns the kept ones into roadmap items once the human agrees.
  - Spec: `docs/specs/dogfood-notes.md`
  - Blocked by: `dogfood-03`
  - Acceptance: the skill lives with the Forgequor-only skills and is linked by `scripts/link-skills.sh`; for each group it proposes a roadmap item, a spec to write, the icebox or dismissal; nothing is written before the human agrees; kept groups go through `/to-spec` or `/to-tickets`; it ends with the note IDs to mark triaged or dismissed and where each went; `skills/README.md` has a "Dogfooding" section explaining the flow (+ Note → Inbox → Export → `/dogfood-triage` → roadmap) and why; the role table in `CLAUDE.md` mentions it; checked by hand on a real export.

### M4 Comfort (done 2026-11-28)

- Spec: `docs/specs/m4-comfort.md`. Items below.
- **M4a, running it day to day:** **Archive** as soon as a Run ends (worktree and local branch removed, remote branch too when abandoned or closed unmerged, startup catch-up), purge after `FORGEQUOR_ARCHIVE_DAYS` (60), macOS notifications (Gate, Escalation, Quota pause, pull request merged or closed; `FORGEQUOR_NOTIFICATIONS=off`), one **Quota** bar per vendor at the top (Claude from the free `claude -p "/usage"` at startup, after each Step and every 5 minutes; Codex from its session file after each Step; greyed when unknown).
- **M4b, setting it up:** Team page for seats in the database (an environment variable wins and locks the seat), per-Run seat overrides in New Run frozen at start, **Skill Packs** per Project (`forgequor` excluded), read-only Workflows page with validation errors and `POST /api/workflows/validate`, `/to-workflow` shared skill (reuse a close Workflow first, Step-type reference kept in sync by a test).

#### M4a Running it day to day

- [x] `m4-01` **Archive a Run when it ends**: a merged, closed or abandoned Run leaves no worktree or local branch behind and stays readable.
  - Spec: `docs/specs/m4-comfort.md`
  - Blocked by: none
  - Acceptance:
    - right after a Run becomes merged, closed or abandoned, whatever caused it, its worktree and local branch are removed and it gets an archived-at time; its outcome state is kept (Archived is a mark, not a state; the glossary says so);
    - an abandoned Run, or a pull request closed unmerged, also has its remote branch deleted (the Code Host gains branch deletion, the fake records it); after a merge the remote branch is left alone;
    - a target already gone counts as done; a step that fails is logged, does not stop the others, and the Run is archived anyway;
    - an Approved Run keeps its worktree;
    - an Archived Run's detail still shows its Run Notes, reviews, Gates, transcripts and attempts, and "files removed, see the pull request" where it would read the worktree (Asset previews included);
    - the Runs tab hides Archived Runs by default, with a filter to show them;
    - Forge core tests with temp repos and bare remotes cover each outcome and a worktree already gone.
- [x] `m4-02` **Startup catch-up and purge**: old finished Runs are archived and, after the delay, deleted.
  - Spec: `docs/specs/m4-comfort.md`
  - Blocked by: `m4-01`
  - Acceptance:
    - at startup, every finished Run without an archived-at time is archived the same way, before live Runs resume;
    - Runs archived more than `FORGEQUOR_ARCHIVE_DAYS` (default 60) days ago are deleted with everything that belongs to them; a Run that is not Archived is never purged;
    - the purge runs at startup and every 24 hours, and logs how many Runs it deleted;
    - Forge core takes an injectable clock; tests drive the delay with it.
- [x] `m4-12` **Keep an Archived Run's Run Notes**: archiving removes the worktree, but the Run Notes that lived only there stay readable.
  - Spec: `docs/specs/m4-comfort.md`
  - Blocked by: `m4-01`
  - Acceptance:
    - just before `archive()` removes the worktree, every text file under its `.forgequor/` is copied into a `run_notes` table (run id, path relative to `.forgequor/`, content, size), deleted with the Run by the purge; binary files (the replaced Asset images) and files over 1 MB are skipped and logged; a failed copy is logged and does not stop archiving;
    - the startup catch-up archives the same way, so old Runs get their notes copied too;
    - the Run detail (`GET /api/runs/:id`, `GET /api/runs/:id/notes?path=`) lists an Archived Run's Run Notes and the Run page shows a note (Markdown rendered, anything else as preformatted text);
    - the glossary's Archive entry says Run Notes are kept in the database;
    - Forge core test on temp repos: a Run with Markdown, JSON and binary notes is abandoned, the worktree is gone, text notes are readable through the Run detail, the binary is skipped, and the purge removes them.
- [x] `m4-03` **macOS notifications**: the human hears about a Run that needs them without watching the tab.
  - Spec: `docs/specs/m4-comfort.md`
  - Blocked by: none
  - Acceptance:
    - a Notifier port in Forge core's dependencies (title, message); `osascript` in production, a recording fake in tests, a silent one with `FORGEQUOR_NOTIFICATIONS=off`;
    - a notification when a human Gate opens, an Escalation opens, a Run pauses on an exhausted Quota (with its reset time when known), and the pull request poller finds a pull request merged or closed; none when a Step simply finishes;
    - the message names the Run (`Run #42 "Title"`) and what happened;
    - a throwing Notifier is logged and never changes a Run;
    - the BA keeps notifications off.
- [x] `m4-04` **Claude Quota bar**: the human sees Claude's five-hour and weekly percentages at the top of the app.
  - Spec: `docs/specs/m4-comfort.md`
  - Blocked by: none
  - Acceptance:
    - a Quota Reading (per window: percent used and reset time, each possibly unknown; exhausted or not; read-at time) is defined in the glossary;
    - the Runner port gains an optional reading on a Step result and an optional on-demand `readQuota()`;
    - the Claude Runner's `readQuota()` parses `claude -p "/usage" --output-format json` ("Current session", "Current week (all models)"); unparseable text gives an unknown reading, never an error; a Step's `rate_limit_event` gives a partial reading;
    - Forge core stores the latest reading per vendor in the database, reads Claude at startup, after every Claude Step and every 5 minutes (clock-driven in tests), and pushes each reading on the live-events stream;
    - `GET /api/quota` returns both vendors with the reading's age;
    - a compact bar per vendor at the top of every tab, greyed "unknown" without a reading, with its age;
    - Runner contract tests against a fake CLI replaying the real `/usage` text and an unparseable one; the Claude smoke test makes one real `readQuota()` call.
- [x] `m4-05` **Codex Quota bar and Quota pauses**: Codex's bar fills in, and a paused Run's bar reads exhausted.
  - Spec: `docs/specs/m4-comfort.md`
  - Blocked by: `m4-04`
  - Acceptance:
    - after each Step, the Codex Runner reads the last `token_count` `rate_limits` of the session file named after the thread id (`primary` five-hour, `secondary` weekly); a missing or unreadable file gives no reading;
    - a Quota pause on any Runner records an exhausted reading with its reset time;
    - Runner contract tests with a fake session file, and without one.

#### M4b Setting it up

- [x] `m4-06` **Team page**: the human sets each seat's Runner and model in the app, without a restart.
  - Spec: `docs/specs/m4-comfort.md`
  - Blocked by: none
  - Acceptance:
    - Team settings stored in the database per seat; a seat's Runner and model each resolve as environment variable, then Team setting, then default;
    - seats are resolved when a Run starts, so a change applies to the next Runs without a restart;
    - `GET /api/team` gives each seat's effective Runner and model, where each comes from, and the variable name when locked; `PUT /api/team/:seat` refuses an unknown seat or Runner and a seat locked by the environment;
    - a Team tab with a short model list per Runner plus a free identifier, locked seats read-only with their variable named;
    - a seat with a Runner Forgequor cannot start still opens an Escalation naming it.
- [x] `m4-07` **Seats per Run**: one Run can use other seats than the default, and shows what it used.
  - Spec: `docs/specs/m4-comfort.md`
  - Blocked by: `m4-06`, `m4-05`
  - Acceptance:
    - New Run has a folded "Seats" section filled from `GET /api/team`; `POST /api/runs` accepts per-seat overrides, validated like the Team page;
    - a Run freezes its effective seats at start; its Agent Steps use them, also after a restart; Runs from before M4 resolve seats as before;
    - the Run detail shows the Runner and model each Agent Step used;
    - New Run warns, without blocking, next to a seat whose Runner's Quota is exhausted, with the reset time.
- [x] `m4-08` **Skill Packs per Project**: a Project's Agents get the packs it picked on top of `shared`.
  - Spec: `docs/specs/m4-comfort.md`
  - Blocked by: none
  - Acceptance:
    - the packs offered are Forgequor's Skill folders except `shared` (always given) and `forgequor`;
    - a Project's choice is stored with it and changed from its page (`PUT /api/projects/:id/skill-packs`, refusing an unknown pack);
    - at a Run's start, `shared` then each chosen pack is placed for Claude and Codex, never committed; a Project's own Skill wins, and between packs the first placed wins;
    - a change affects only Runs launched afterwards.
- [x] `m4-09` **Workflows page and validation endpoint**: the human sees every Workflow a Project offers, and why an invalid one is not offered.
  - Spec: `docs/specs/m4-comfort.md`
  - Blocked by: none
  - Acceptance:
    - `GET /api/projects/:id/workflows` returns every Workflow with its source, whether it overrides a built-in one, its Steps (id, type, Agent, `needs`, `when`), its YAML and its validation errors; launch keeps offering only valid ones;
    - `POST /api/workflows/validate` takes YAML text (optionally a Project) and returns the full error list, empty when valid, storing nothing;
    - a read-only, minimal Workflows tab: list, Steps table, YAML, errors.
- [x] `m4-10` **`/to-workflow` skill**: a need becomes a valid Project Workflow without learning the engine.
  - Spec: `docs/specs/m4-comfort.md`
  - Blocked by: `m4-09`
  - Acceptance:
    - a `shared` Skill that first proposes reusing or adjusting a close existing Workflow, otherwise writes `<name>.yaml` in the Project's Workflows folder from the real Step types, validates it through `POST /api/workflows/validate` (configurable address, local default) and fixes it, or tells the human to open the Workflows page when Forgequor does not answer;
    - it carries a reference of the Step types and the built-in Workflows; a test checks both match the code;
    - `skills/README.md` lists it.
- [x] `m4-11` **M4 BA scenarios**: archiving and Quota readings checked for real.
  - Spec: `docs/specs/m4-comfort.md`
  - Blocked by: `m4-02`, `m4-05`
  - Acceptance:
    - a Run abandoned at its final Gate ends with no worktree, no local branch and no remote branch on the sandbox, and still shows its Run Notes and reviews;
    - after a Claude Step, `GET /api/quota` returns a Claude reading with percentages;
    - notifications stay off; the README of the BA suite lists the new scenarios.

### M3b The team (done 2026-11-28)

Griller with a **Conversation Gate** (it writes the Project's glossary and ADRs and produces Asset Requests), Spec Writer, Architect, solo or duo review (chosen at Run launch) with **Consolidator** (an unsettled reviewer disagreement opens a **Gate** with its recommendation), and the default `feature` and `bugfix` Workflows. `feature`: Griller ⇄ human → spec Gate → Spec Writer → Gate → Architect → Artist → Asset Gate (skipped without Asset Requests) → Developer → Checks → Reviewer(s) + Consolidator ⇄ Developer → pull request + Review Brief → final Gate.

- Spec: `docs/specs/m3b-the-team.md`. Items below.
- Decided in the grilling (round 1):
  - the Griller writes its transcript to the Run Notes, the Project's glossary and ADRs as Deliverables, and Asset Requests in a structured Run Note that Forgequor validates like launch input (fresh fetch), sending invalid ones back to the Griller;
  - Conversation Gate: one round of questions at a time, the human answers in one message, the Griller resumes the same Claude session (the Claude Runner gains session persistence for this only), proposes a summary at the end and the human confirms or goes on; the transcript is saved at each exchange;
  - that confirmation is the first decision point; then the Spec Writer (`to-spec`, no questions) writes `docs/specs/<slug>.md` as a Deliverable, no tickets, and a spec Gate shows it rendered: approve, or reject with Feedback to redo it;
  - the Architect writes an Implementation Plan to the Run Notes (modules, test seams, order of small steps) and a Project ADR when warranted; no Gate after it;
  - review: solo is one Reviewer on Claude; duo is two read-only Reviewers in parallel (Claude, and Codex in its read-only sandbox) plus the Consolidator, who checks each remark against the code and opens a Gate on an unsettled disagreement; each Reviewer uses `code-review` (standards and spec); changes requested go back to the Developer, capped by `max_attempts`, then an Escalation;
  - `bugfix`: a bug description, the Developer with `diagnosing-bugs` writing a failing test first, Checks, solo review by default (duo at launch), pull request, final Gate.
- Decided in the grilling (round 2):
  - default Runners: Claude for the Griller, Spec Writer, Architect, Developer, Reviewer A and Consolidator; Codex for Reviewer B and the Artist; set through environment variables until M4;
  - minimal Skill Packs move into M3b: at each Run's start Forgequor places its own `shared` pack in the worktree (`.claude/skills` and `.agents/skills`), never committed, and a skill the Project has itself wins; choosing packs per Project stays in M4;
  - the `feature` Developer gets the task, the spec, the Implementation Plan and the approved Assets' paths; a final Gate rejection sends it back with the Feedback; an Escalation can go back to any earlier Step, the Griller included, which reopens the conversation;
  - a `feature` Run starts from a free-text subject and a solo or duo review choice (duo by default; solo by default for `bugfix`).
- [x] `m3-10` **Shared Skill Pack in every Run**: Agents find the skills they need in any Project.
  - Spec: `docs/specs/m3b-the-team.md`
  - Blocked by: none
  - Acceptance:
    - at a Run's start Forgequor places its `shared` Skill Pack in the worktree, for Claude and for Codex, never committed;
    - a skill the Project already has wins over the pack's;
    - tested with a Project that has none of the skills and one that overrides one.
- [x] `m3-11` **`bugfix` with a solo Reviewer**: a bug goes from description to reviewed pull request.
  - Spec: `docs/specs/m3b-the-team.md`
  - Blocked by: `m3-04`, `m3-10`
  - Acceptance:
    - a Reviewer Agent (Claude by default) uses `code-review` against the Project's standards and the Run's task or spec, and writes a Review ending in pass or changes requested;
    - changes requested loops back to the Developer, capped by `max_attempts`, then an Escalation;
    - `bugfix` takes a bug description; the Developer uses `diagnosing-bugs` and writes a failing test first; then Checks, review, pull request, final Gate;
    - the Run form offers solo or duo review, solo by default for `bugfix`.
- [x] `m3-12` **Duo review and Consolidator**: two models review, one review reaches the Developer.
  - Spec: `docs/specs/m3b-the-team.md`
  - Blocked by: `m3-11`, `m3-06`
  - Acceptance:
    - duo runs a Claude Reviewer and a Codex Reviewer in parallel, both read-only (Codex in its read-only sandbox);
    - the Consolidator (Claude) checks each remark against the code and writes one Review;
    - a disagreement it cannot settle opens a Gate carrying its recommendation;
    - Runners per Agent default as decided and can be changed through environment variables.
- [x] `m3-13` **`feature` v0: Griller and Conversation Gate**: a subject becomes code after a grilling.
  - Spec: `docs/specs/m3b-the-team.md`
  - Blocked by: `m3-11`, `m3-10`, `m3-08`
  - Acceptance:
    - the Claude Runner can keep and resume a session, for Conversation Gates only;
    - the Griller uses `grill-with-docs`, asks one round at a time; the Run waits; the human answers in one message in a chat in the UI; the same session resumes;
    - the transcript is saved to the Run Notes at each exchange and survives a restart;
    - the Griller ends with a summary the human confirms or continues from; the Project's glossary and ADRs it changed are committed;
    - `feature` v0 is Griller → Developer → Checks → review (duo by default) → pull request → final Gate, launched from a free-text subject;
    - going back to the Griller from an Escalation reopens the conversation.
- [x] `m3-14` **Spec Writer and spec Gate**: the grilling becomes a spec the human approves.
  - Spec: `docs/specs/m3b-the-team.md`
  - Blocked by: `m3-13`
  - Acceptance:
    - the Spec Writer uses `to-spec` without asking questions and writes `docs/specs/<slug>.md` in the Project, committed in the pull request, with no tickets;
    - a spec Gate shows the spec rendered; approve goes on, reject with Feedback has it redone;
    - the Developer is given the spec.
- [x] `m3-15` **Architect and Implementation Plan**: the Developer follows a plan.
  - Spec: `docs/specs/m3b-the-team.md`
  - Blocked by: `m3-14`
  - Acceptance:
    - the Architect reads the spec and the code and writes an Implementation Plan to the Run Notes (modules, test seams, order of small steps);
    - it writes a Project ADR when a decision warrants one; no Gate follows it;
    - the Developer is given the plan.
- [x] `m3-16` **Art inside `feature`**: the grilling can order art that the code then uses.
  - Spec: `docs/specs/m3b-the-team.md`
  - Blocked by: `m3-13`, `m3-05`
  - Acceptance:
    - the Griller produces Asset Requests in a structured Run Note, validated like launch input on the fresh branch, invalid ones going back to it;
    - the Artist and the Asset Gate run only when there are Asset Requests;
    - the Developer is given the approved Assets' paths.

### M3a Workflow engine (done 2026-11-28)

The engine behind every Workflow, with no change visible to the human: a deeper Workflow seam, YAML **Workflows** with parallel **Steps**, a configurable cap on automatic attempts (default 3), **Escalation** with more choices than abandon, and the `developer` and `assets` Workflows rewritten as YAML with unchanged behaviour.

- Spec: `docs/specs/m3a-workflow-engine.md`. Items below.
- Decided in the grilling: built-in Workflows live in Forgequor, a Project adds or overrides one in `forgequor/workflows/` at its root; a Run freezes the Workflow it started with; an invalid YAML is not offered at launch; Escalations offer retry (optional Feedback), go back to an earlier Step (with Feedback) or abandon; order: m3-00a, m3-00b, seam, engine, `developer` then `assets` in YAML with existing tests unchanged, richer Escalations.
- Workflow YAML (ADR 0007): Steps with `id`, a coded type (`agent`, `checks`, `gate` with its kind, `publish`, coded composites such as `artist`), `needs` (independent Steps run in parallel), `on_reject` with `max_attempts` (default 3) for automatic loops, Iterations (human-driven) staying uncapped, and one `when` condition; only `readonly` Steps run in parallel and fail if they change anything outside the Run Notes; a slot is per Run; going back to an earlier Step replays the Steps after it without reverting files.
- Prefactor in M3a (M2 branch review): deepen the Workflow seam. The core imports a dozen asset helpers and `startRun` writes asset rows itself, `WorkflowContext` has ~17 members, and Step-result handling is copied in both Workflows; YAML Workflows need a seam where adding one touches no core code.
- [x] `m3-00a` **Approved Runs free their slot**: a Run releases its Project slot as soon as it is Approved, and Approved Runs stay easy to find until merged (from the M2 real tests, where open sandbox PRs blocked the queue twice).
  - Spec: `docs/specs/m3a-workflow-engine.md`
  - Blocked by: none
  - Acceptance:
    - an Approved Run no longer counts against its Project's concurrency limit, and becoming Approved starts the next Queued Run;
    - "Waiting for you" gains a "Waiting for your merge" list: every Approved Run, all Projects, with its pull-request link, until merged or closed;
    - the Runs list shows every Run in every state (the human once could not find a Run there; check it by hand and fix what hides one).
- [x] `m3-00b` **M2 review follow-ups**: the small gaps the M2 branch review found (listed below under "M2 review follow-ups").
  - Spec: `docs/specs/m3a-workflow-engine.md`
  - Blocked by: `m3-00a`
- [x] `m3-01` **One Step executor, a small context**: how a Step's result becomes progress, an Escalation or a Pause is written once and used by both Workflows.
  - Spec: `docs/specs/m3a-workflow-engine.md`
  - Blocked by: `m3-00b`
  - Acceptance:
    - one executor runs every Agent Step, records its attempts and streams progress; success moves on, failure or timeout opens an Escalation, Quota exhaustion pauses;
    - the copies in the `developer` and `assets` Workflows are gone;
    - the context handed to a Step holds the Run (Project, worktree, branch), the stop signal, the Agent seat it needs and a few operations, with no raw database pool;
    - every existing test passes unchanged.
- [x] `m3-02` **Assets out of the core**: the Forge core knows nothing about Assets.
  - Spec: `docs/specs/m3a-workflow-engine.md`
  - Blocked by: `m3-01`
  - Acceptance:
    - each Gate kind (final, asset, escalation) is a module that knows its choices, validates and records a decision and says where the Run goes next; the core's decide operation delegates to it;
    - a Workflow declares its launch inputs, and the Step types that use one validate and store it at launch inside the core's transaction;
    - Asset Request validation, Asset rows, verdicts and Asset images live behind the `artist` Step type and the `asset` Gate kind;
    - every existing test passes unchanged.
- [x] `m3-03` **Workflow definitions**: a YAML Workflow turns into a validated definition or a full list of errors.
  - Spec: `docs/specs/m3a-workflow-engine.md`
  - Blocked by: none
  - Acceptance:
    - steps with `id`, `type` (`agent` with `agent`, `checks`, `gate` with `final` or `asset`, `publish`, `artist`), optional `needs`, `readonly`, `on_reject`, `max_attempts` (default 3), `when`; the Workflow's name, description and launch inputs;
    - errors, each with its location and all at once: duplicate id, unknown type, unknown id in `needs` or `on_reject`, a `needs` cycle, Steps that can run together without both being read-only, a `when` input neither given at launch nor produced by a Step it depends on;
    - the built-in `developer` and `assets` YAML files ship with Forgequor and validate;
    - tested directly at the module's interface; a pure-JavaScript YAML parser is the only new dependency.
- [x] `m3-04` **The engine runs `developer` from YAML**: Runs follow a frozen definition, starting with `developer`.
  - Spec: `docs/specs/m3a-workflow-engine.md`
  - Blocked by: `m3-02`, `m3-03`
  - Acceptance:
    - a Run stores the definition it started with; Runs created before M3a get their built-in definition at migration;
    - Steps start when what they need is done or skipped; `when` is evaluated when a Step is ready, on inputs given at launch or produced by earlier Steps (a produced input is validated like launch input and an invalid one goes back to its Step);
    - a rejecting Step loops back to its `on_reject` target and replays what follows; automatic loops past `max_attempts` open an Escalation saying so; Gate rejections start a new Iteration with no cap;
    - each Step's state (waiting, running, done, skipped, failed, attempts) is persisted per Iteration and shown in order in the Run detail;
    - a restart or a resume after a Pause restarts only the Steps that were running;
    - `developer` runs from its YAML (`max_attempts: 3` on Checks) and every existing test passes unchanged.
- [x] `m3-05` **`assets` runs from YAML**: the art Workflow follows its definition too.
  - Spec: `docs/specs/m3a-workflow-engine.md`
  - Blocked by: `m3-04`
  - Acceptance:
    - `assets` is `artist` → asset Gate (`on_reject: artist`) → `publish`, the Run being Approved after Publish;
    - `artist` is a coded composite that still draws each Asset Request in turn with its Asset Checks and retries;
    - every existing test passes unchanged.
- [x] `m3-06` **Parallel read-only Steps**: independent read-only Steps run at the same time.
  - Spec: `docs/specs/m3a-workflow-engine.md`
  - Blocked by: `m3-04`
  - Acceptance:
    - read-only Steps whose needs are met start together and really overlap (tested with a test Workflow);
    - after a read-only Step, any change outside the Run Notes fails it and opens an Escalation naming the files;
    - a Run counts once against its Project's limit however many of its Steps run.
- [x] `m3-07` **Project Workflows and the Run form**: a game can bring its own Workflows.
  - Spec: `docs/specs/m3a-workflow-engine.md`
  - Blocked by: `m3-04`
  - Acceptance:
    - a Project's Workflows are read from `forgequor/workflows/*.yaml` on the freshly fetched default branch, at form load and at launch;
    - a Project Workflow named like a built-in one replaces it for that Project; the form marks each Workflow built-in or Project;
    - an invalid Workflow is listed with its errors and refused at launch;
    - the Run form builds itself from the chosen Workflow's launch inputs;
    - a Run keeps its frozen Workflow after the YAML changes.
- [x] `m3-08` **Escalations with choices**: the human can retry, go back or abandon.
  - Spec: `docs/specs/m3a-workflow-engine.md`
  - Blocked by: `m3-04`
  - Acceptance:
    - retry runs the failed Step again with a fresh attempt budget and the optional Feedback;
    - go back lists the done Steps before the failed one; the chosen one and every Step after it replay in order with the required Feedback, without reverting files;
    - abandon stays available;
    - Feedback reaches replayed Agent Steps like Gate Feedback does.


### M2 Assets (done 2026-11-27)

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
- [x] `m2-07` **Animation Strips**: the human can order animations, frames side by side in one image.
  - Spec: `docs/specs/m2-assets.md`
  - Blocked by: `m2-05`
  - Acceptance:
    - an Asset Request can be an Animation Strip with a frame count; frames have the chosen size and sit side by side horizontally;
    - Animation Strips land in the `animations` kind folder;
    - the Asset Checks expect a width of frame width × frame count;
    - the gallery shows the strip and its frame count, and the Review Brief gives it.
    - in the gallery, an Asset's past versions are shown magnified like the current one, not only at real size, so they can be compared by eye (found in the real Feedback loop test).
- [x] `m2-08` **References, default size and safe replacement**: new art matches existing art, and nothing is overwritten by accident.
  - Spec: `docs/specs/m2-assets.md`
  - Blocked by: `m2-04`
  - Acceptance:
    - reference images named in the Art Direction are always given to the Artist; an Art Direction without any works the same;
    - an Asset Request can name existing repository images as style references;
    - a `Default size: WxH` line in the Art Direction presets the size in the Run form;
    - an Asset Request can be marked as replacing an existing file;
    - starting a Run is refused, before anything is generated, when a file would be overwritten without that mark, when two Asset Requests would produce the same file, or when a reference does not exist;
    - the README documents the Art Direction contract (Palette heading, Default size line, reference images).
- [x] `m2-09` **Resilient, live assets Runs**: an `assets` Run survives limits and restarts, and shows its progress.
  - Spec: `docs/specs/m2-assets.md`
  - Blocked by: `m2-04`
  - Acceptance:
    - an exhausted Codex Quota pauses the Run and resumes it like a `developer` Run, at the Asset it was on;
    - after a Forgequor restart, a running `assets` Run picks up at its current Asset, keeping the Assets already produced;
    - abandoning the Run kills the running Codex process group;
    - the Run detail shows progress live, Asset by Asset.
    - tests cover resuming a `developer` Run in the middle of a Feedback Iteration (after a Quota pause and after a restart), and a rejection racing an abandon (left untested by m2-02).
- [x] `m2-10` **Launch checks on fresh repository state**: what is validated at launch is what the Run will start from (found in the final real M2 test).
  - Spec: `docs/specs/m2-assets.md`
  - Blocked by: `m2-08`
  - Acceptance:
    - starting a Run fetches the Project's default branch before validating Asset Requests, so a reference or an existing file merged on GitHub since the last fetch is seen;
    - a file merged on GitHub since the last fetch can no longer be overwritten without the replace mark (tested: merge on the remote, then start a Run naming that file without the mark, and it is refused);
    - the Run form's list of repository PNGs and the Art Direction facts it shows come from the freshly fetched default branch;
    - a replacement's commit says it replaces (e.g. `feat(art): replace 1 asset`, or add and replace counted apart), and the Review Brief marks each replaced Asset;
    - the Asset Gate shows the image being replaced beside the new version, magnified alike, so they can be compared.
- [x] `m2-11` **Overwrite check when an assets Run really starts**: a Run that waited in the queue cannot overwrite art merged in the meantime.
  - Spec: `docs/specs/m2-assets.md`
  - Blocked by: `m2-10`
  - Acceptance:
    - when an `assets` Run starts (or restarts), after its worktree is made from the freshly fetched default branch, an Asset not marked as replacing whose target path already holds a file opens an Escalation naming that file, before anything is generated;
    - tested: start a Run that has to wait Queued, merge a file at one of its target paths on the remote meanwhile, free a slot; the Run escalates instead of overwriting;
    - an Asset marked as replacing still proceeds, and the Asset the Artist itself wrote in an earlier attempt of the same Run is never taken for existing art.

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
