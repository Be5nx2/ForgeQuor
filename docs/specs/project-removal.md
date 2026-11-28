# Project removal and purge now

Source: Dogfood Note #1 ("supprimer / clean des projets existants, et purger les données Forgequor"), grilled on 2026-11-28. Vocabulary: `GLOSSARY.md`. Builds on the Archive and purge of `docs/specs/m4-comfort.md`.

## Problem Statement

Once a **Project** is registered, the human cannot get rid of it: a test repository, a renamed folder or an abandoned game stays in every list, every Project selector and every New Run form forever. The database refuses to delete a Project that has **Runs**, and nothing in the app offers it.

The human also cannot clear old history on demand. **Archived** Runs are only deleted by the daily purge once they are 60 days old, so a burst of test Runs clutters the Runs home and the database for two months.

## Solution

On the Projects screen, each Project gets a red **Danger** zone with two actions:

- **Remove this Project**: Forgequor forgets the Project. Its active Runs are abandoned exactly as if the human clicked Abandon on each (a running Step stops, an open pull request is closed unmerged and its remote branch deleted), then every Run of the Project is deleted with everything that belongs to it, after the usual Archive clean-up on disk. The human's own git repository, on disk and on GitHub, is never touched beyond what Archiving already removes (worktrees and `forgequor/*` branches). The human confirms by typing the Project's name; the confirmation shows how many Runs will be deleted and lists the active Runs that will be abandoned, with the pull request each will close.
- **Purge its Archived Runs now**: deletes the Project's Archived Runs at once, without waiting for the 60 days.

At the top of the Projects screen, **Purge Archived Runs** does the same for every Project.

If a step of a removal fails (GitHub unreachable while closing a pull request, for example), the removal stops, the Project stays, the error is shown, and the Project reads "Removal interrupted" with a **Retry** button; retrying picks up where it stopped.

A short "Starting over" section in the README explains how to wipe Forgequor entirely (drop the database, empty the worktrees folder); the app itself has no full reset.

## User Stories

### Removing a Project

1. As the human, I want a "Remove this Project" action on each Project, so that a Project I no longer use stops appearing everywhere.
2. As the human, I want removing a Project to never touch my repository on disk or on GitHub beyond what Archiving already removes, so that removing it from Forgequor cannot cost me my game.
3. As the human, I want the Run worktrees and `forgequor/*` branches of the Project cleaned the same way Archiving cleans them, so that nothing of Forgequor is left behind in my repository.
4. As the human, I want the Project's active Runs (Queued, Running, Waiting, Paused, Approved) abandoned automatically during the removal, so that I do not have to abandon them one by one first.
5. As the human, I want each automatic abandon to behave exactly like clicking Abandon, so that there is a single, known meaning of "abandoned".
6. As the human, I want a Running Step stopped immediately when its Run is abandoned by the removal, so that no Agent keeps working on a Project that is going away.
7. As the human, I want an Approved Run's open pull request closed unmerged and its remote branch deleted by the removal, so that GitHub does not keep a pull request nobody will merge.
8. As the human, I want a Run whose pull request was already merged to end as Merged, not Abandoned, as the Abandon button already does, so that history stays truthful until it is deleted.
9. As the human, I want every Run of the Project deleted with its Gates, attempts, Checks, Assets, reviews, conversation and Run Notes, so that a removed Project leaves nothing in the database.
10. As the human, I want Runs that were not yet Archived to go through the Archive clean-up on disk before they are deleted, so that their worktrees and local branches are removed too.
11. As the human, I want the Project's own settings (Checks, Setup, slots, Art Direction, Skill Packs) deleted with it, so that re-registering the same folder later starts clean.
12. As the human, I want to re-register the same folder after removing it, so that a mistaken removal can be undone in Forgequor (its history is gone, its repository is not).

### Confirming a removal

13. As the human, I want to type the Project's name to confirm a removal, so that I cannot remove a Project by a stray click.
14. As the human, I want the confirmation to say how many Runs will be deleted, so that I know what I am about to lose.
15. As the human, I want the confirmation to list the active Runs that will be abandoned, each with the pull request it will close, so that nothing on GitHub changes by surprise.
16. As the human, I want the Remove button disabled until the typed name matches exactly, so that the confirmation means something.
17. As the human, I want to cancel the confirmation without any change, so that opening it is safe.

### A removal that fails half-way

18. As the human, I want a removal that fails on one step to stop there and keep the Project, so that I never end with a half-removed Project that is invisible.
19. As the human, I want the error to say which step failed and why (for example, which pull request could not be closed), so that I can fix the cause.
20. As the human, I want what was already done (Runs already abandoned or deleted) to stay done, so that a retry does not redo or undo it.
21. As the human, I want a Project whose removal was interrupted to read "Removal interrupted" with a Retry button, so that I can finish it once GitHub answers again.
22. As the human, I want a retry to pick up where the removal stopped, so that it is always safe to retry.
23. As the human, I want no new Run launched on a Project while it is being removed or after a removal was interrupted, so that the removal cannot race a fresh Run.
24. As the human, I want Queued Runs of that Project never started by the scheduler once its removal has begun, so that a freed slot does not start work that is about to be abandoned.
25. As the human, I want an interrupted removal to stay interrupted across a restart of Forgequor, so that I see it and decide, rather than having it resume silently.

### After a removal

26. As the human, I want the removed Project gone from the Projects list, the sidebar's Project selector, New Run and the Workflows page, so that it no longer distracts me.
27. As the human, I want the sidebar to fall back to "All Projects" when the removed Project was the one selected, so that the app never filters by a Project that no longer exists.
28. As the human, I want a link to a deleted Run or Project to show the usual not-found message, so that old links fail clearly.
29. As the human, I want my Dogfood Notes that mention the removed Project or its Runs kept as they are, so that my journal is not rewritten.
30. As the human, I want the log to say what a removal did (Runs abandoned, Runs deleted), so that I can tell afterwards.

### Purging Archived Runs now

31. As the human, I want a "Purge its Archived Runs now" action in each Project's Danger zone, so that I can clear one Project's history without waiting 60 days.
32. As the human, I want a "Purge Archived Runs" action at the top of the Projects screen, so that I can clear the history of every Project at once.
33. As the human, I want the purge now to delete only Archived Runs, never an active or a finished-but-not-yet-Archived one, so that it cannot hurt work in progress.
34. As the human, I want the purge now to ignore the 60-day delay, so that it does what it says.
35. As the human, I want a simple confirmation stating how many Archived Runs will be deleted, so that I know the scope before I click.
36. As the human, I want the purge buttons disabled with "No Archived Run" when there is nothing to purge, so that I do not confirm an empty action.
37. As the human, I want the purge now to take everything that belongs to each Run with it, as the daily purge does, so that nothing dangling stays.
38. As the human, I want the daily purge to keep running unchanged, so that the purge now is an addition, not a replacement.
39. As the human, I want the purge now to log how many Runs it deleted, like the daily purge, so that both read the same.

### Where it lives

40. As the human, I want the Danger zone at the bottom of a Project's form, set apart and in red, so that destructive actions are never confused with Save.
41. As the human, I want the global purge at the top of the Projects screen next to "+ Register Project", so that it is found where Projects are managed.
42. As the human, I want these screens to use the shared loading, empty and error states and the existing design system, so that they look like the rest of the app.

### Starting over

43. As the human, I want a "Starting over" section in the README that explains how to drop Forgequor's database and empty its worktrees folder, so that I can wipe everything on the rare day I need to, without an app button that could be clicked by mistake.

## Implementation Decisions

- **Forge facade.** Two new operations:
  - *remove a Project* (by id): marks the Project as being removed, abandons each active Run through the existing abandon path, archives every finished Run not yet Archived, deletes every Run of the Project, then deletes the Project. Each step is idempotent, so the same operation is the retry.
  - *purge Archived Runs now* (one Project, or all): deletes the Archived Runs in scope, whatever their age, and returns how many were deleted.
  - A read the confirmation needs: for a Project, the number of its Runs, its active Runs with their pull request, and the number of its Archived Runs (a field on the Project read, or a small "removal preview" read).
- **Abandon is reused, not copied.** The removal calls the same abandon the Abandon button uses (pull request state read, closed if open, Merged kept, Run settled, its work stopped, then Archived). A failure of the code host there stops the removal with that error.
- **Removal mark.** The Project gains a "removing since" timestamp (schema change). While it is set: launching a Run on the Project is refused, the scheduler never starts its Queued Runs, and Project reads expose it so the UI can show "Removal interrupted" with Retry. It is never cleared automatically: only a successful removal (which deletes the row) ends it. It survives restarts; startup does not resume a removal.
- **Deleting Runs.** Runs are deleted with the existing cascade (migration 025 and later: Gates, attempts, Checks, Assets and versions, verdicts, step states, reviews, conversation, Run Notes, run seats). Anything that still references a Run without a cascade gets one in the same schema change.
- **Deleting the Project.** Its own rows (Skill Pack choices and any other per-Project table) are removed with it, by cascade from the Project row.
- **The human's repository.** Only what Archiving already removes is touched: each Run's worktree, local `forgequor/*` branch, and the remote branch of a Run abandoned or closed unmerged. The Project's folder, its other branches and its GitHub repository are never touched.
- **Dogfood Notes.** Unchanged: they hold no foreign key to Runs or Projects (by design, dogfood-01), so their origin text stays.
- **Purge now** reuses the daily purge's delete, without the age condition and with an optional Project scope; the daily purge is unchanged.
- **HTTP.** A route to remove a Project, a route to purge Archived Runs now (all or one Project), and the preview read. Errors map as elsewhere: unknown Project 404, a code host failure during removal 502 with the step that failed, invalid input 400.
- **UI.** Projects screen (ui-11 layout): a Danger zone at the bottom of the Project form with the two actions and their confirmations; the global purge at the top next to "+ Register Project"; an interrupted Project shows a banner with Retry. The confirmation logic (name matches, counts and lists to display) lives in a plain TS module. The sidebar's Project selector already falls back to All Projects for an unknown Project (ui-06).
- **Logging.** Removal and purge now log their counts in the daily purge's wording.
- **README.** A "Starting over" section: stop Forgequor, drop its database (or the Docker volume), empty `~/.forgequor/worktrees`, start again.

## Testing Decisions

- A good test drives the public interface (the Forge facade, the HTTP routes) and checks what the human would see: Run and Project reads, the database contents, the folders and branches on disk, the calls made to the code host. It never reaches into internals.
- **Forge facade on the real database**, with temporary git repositories and a fake code host (prior art: the Archive and purge tests, the Runs tests):
  - removing a Project with Queued, Running, Waiting, Paused and Approved Runs abandons each (pull requests closed, a merged one kept as Merged), stops the running Step, and leaves no Run and no Project row;
  - finished Runs not yet Archived have their worktree and local branch removed before deletion; already Archived ones are deleted;
  - the Project's folder, its other branches and its own files are untouched;
  - a code host failure on the second Run stops the removal: the first Run stays abandoned, the Project stays with its removal mark, the error names the failing pull request; a retry with the code host back finishes it;
  - while the mark is set, launching a Run is refused and a Queued Run is not started when a slot frees;
  - Dogfood Notes referencing the Project and its Runs are unchanged;
  - re-registering the same folder afterwards gives a fresh Project;
  - purge now deletes only Archived Runs (all Projects, or one), whatever their age, returns the count, and leaves active and finished-not-Archived Runs alone;
  - the removal preview counts Runs and lists active Runs with their pull request.
- **HTTP routes** with a simulated Forge (prior art: the existing route tests): request shapes, 404, 400 and 502 mapping, counts returned.
- **Front logic** in a plain module (prior art: the web module tests): the typed name must match exactly; counts and lists shown; purge disabled at zero.
- The screens themselves are checked in a browser against the design system, as in the UI refresh.

## Out of Scope

- A full reset button in the app (documented in the README instead).
- Removing anything from the human's repository beyond what Archiving already removes, or deleting the GitHub repository.
- Undo of a removal (the history is gone; re-registering the folder starts fresh).
- Deleting or editing Dogfood Notes, Team seats or Quota readings.
- Changing the daily purge's delay or schedule.
- Resuming an interrupted removal automatically at startup.

## Further Notes

- Dogfood Note #1 can be marked triaged in the Dogfood Inbox with this spec's path once it is published.
- The Archive and purge decisions of M4 (`docs/specs/m4-comfort.md`) stay as they are; this spec only adds the on-demand paths and the Project removal.
