# Acceptance (BA) suite

End-to-end checks of Forgequor as the human uses it, replayed from time to time (after a milestone, before a release).
Never part of `npm test`: it starts the real app, talks to GitHub and runs real Agents.

## What it covers

| File | Scenario |
|---|---|
| `migration.ba.ts` | A copy of the real database (`forgequor`, never the original) is migrated to the current code and every Run is read back: Steps present, frozen definitions filled, merge list right. |
| `forgequor.ba.ts` §1–2 | Slots and merge list: two Runs on a Project limited to one; the second stays Queued until the first is Approved; final Gate rejection starts Iteration 2 with its Feedback; approval frees the slot; a real merge on GitHub drops the Run from the merge list; abandon closes the pull request; the Runs list shows every state. |
| `forgequor.ba.ts` §3 | Project Workflows: `forgequor/workflows/*.yaml` pushed to the sandbox are listed (added, overriding `developer`, invalid with errors); an invalid one is refused at launch; a Run keeps its frozen definition after the YAML changes. |
| `forgequor.ba.ts` §4 | Escalations with choices: retry re-runs only the failed Step with a fresh budget; go back is refused without Feedback or to a later/unknown Step; go back to the Developer replays it and what follows, files kept; a passing retry reaches the final Gate; abandon still works. |
| `forgequor.ba.ts` §5 | Opt-in (`BA_ASSETS=1`, uses Codex): an `assets` Run drawn, rejected with Feedback, redrawn, approved, published. |
| `team.ba.ts` `bugfix` | A buggy script pushed to the sandbox, a bug description, solo review: the Developer fixes it, the Check passes, the Reviewer passes it, the PR holds only the fix and its Review Brief has the Review. |
| `team.ba.ts` `feature` | A subject; the suite answers the Griller's rounds in the Conversation Gate and confirms its summary, approves the spec at the spec Gate; the Architect plans, the Developer builds, duo review (Reviewers + Consolidator); the PR holds the code and the spec, no Skills or Run Notes; abandon closes it. |

## Running it

Needs Docker (PostgreSQL), `gh` signed in, `claude` (and `codex` for §5), and `FORGEQUOR_SMOKE_REPO=owner/name` in `.env`
pointing at a throwaway repository you own (the suite merges and closes pull requests and pushes to its default branch).

```bash
npx vitest run -c tests/acceptance/vitest.config.ts
```

One file only: append its path, e.g. `tests/acceptance/migration.ba.ts`.

Settings (environment):

- `BA_MODEL` (default `haiku`): the Developer's model. Quality does not matter here.
- `BA_ASSETS=1`: also run the `assets` scenario (Codex quota).
- `BA_CODEX=1`: keep the second Reviewer on Codex (its default); otherwise the BA moves it to Claude. Every Claude seat runs on `BA_MODEL`.
- `BA_DATABASE` (default `forgequor_ba`), `BA_PORT` (default `4180`): the app under test. The database is dropped and
  recreated at each run, then left in place so the UI can be inspected afterwards
  (`FORGEQUOR_DATABASE_URL=postgres://forgequor:forgequor@localhost:5433/forgequor_ba FORGEQUOR_PORT=4180 npm start`).
- `BA_SHOW_LOG=1`: print the app's log at the end.

A full run takes roughly 10–30 minutes, mostly Agent time. An Escalation fails the scenario at once with its reason.

## What it leaves behind

- On the sandbox: files `ba-<stamp>-*.txt` merged on its default branch, closed pull requests, Run branches.
  `forgequor/workflows/` is removed at the end (and at the start, in case a previous run stopped half-way).
- Locally: the `forgequor_ba` and `forgequor_ba_migration` databases, and worktrees under a temporary folder.
