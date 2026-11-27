# Dogfood Notes

Roadmap: after M4. Vocabulary: `GLOSSARY.md` (new terms: **Dogfood Note**, **Dogfood Inbox**, **Dogfood Export**). Builds on M1 and M2; independent of the Asset work.

## Problem Statement

The human uses Forgequor to build their game and keeps noticing things: a Workflow that behaves oddly, a screen that is awkward, a missing feature, a better idea. Today those observations are lost, because writing them down means leaving the app, finding a place and phrasing the context again (which page, which Run). Later, when the human wants to improve Forgequor, there is nothing to review and no trace of what annoyed them.

## Solution

A way to jot a **Dogfood Note** in a few seconds from anywhere in the app, kept in a **Dogfood Inbox** to be reviewed later, then exported as one Markdown file to be analysed with Claude and turned into roadmap items.

- A floating **+ Note** button, visible on every tab, opens a small popup form. The human picks a nature (feedback or idea), a target (workflow, feature, display, other; pre-selected from the tab they are on) and types free text. Only the text is required.
- The app attaches the context itself: the tab and the Run or Project being looked at, and the date. No screenshot.
- A **Dogfood Inbox** tab lists the notes, with a badge counting the new ones, filters, and buttons to mark a note as triaged or dismissed.
- Selecting one or more notes and clicking **Export** produces one Markdown file, written in the repository's `docs/dogfood/` folder and offered for download.
- A `/dogfood-triage` skill reads such a file, groups the notes, proposes what each group should become, and, once the human agrees, turns the kept ones into roadmap items.

No chat, no agent reply: the form only records. The Inbox is a funnel into the existing triage flow, not a second tracker.

## User Stories

1. As the human, I want a **+ Note** button on every tab, so that I can jot something without leaving what I am doing.
2. As the human, I want the popup to open instantly and need only a text to save, so that capturing costs a few seconds.
3. As the human, I want to choose whether my note is a feedback or an idea, so that I can tell complaints from suggestions when I review.
4. As the human, I want to choose what the note is about (workflow, feature, display, other), so that I can group notes by area.
5. As the human, I want the target pre-selected from the tab I am on, so that I rarely have to pick it.
6. As the human, I want the tab and the Run or Project in view attached automatically, so that I do not have to retype the context.
7. As the human, I want the date recorded automatically, so that I can see how recent a note is.
8. As the human, I want a short confirmation after saving and the popup to close, so that I know it was recorded and can carry on.
9. As the human, I want an empty text to be refused with a clear message, so that I never store a blank note by mistake.
10. As the human, I want what I typed kept if saving fails, so that a network or server hiccup does not lose my thought.
11. As the human, I want a **Dogfood Inbox** tab listing every note, newest first, so that I can review them in one place.
12. As the human, I want a badge on the Inbox tab counting the new notes, so that I know when there is something to review.
13. As the human, I want each note to show its nature, target, text, date and context, so that I understand it without opening anything.
14. As the human, I want the context to name the Run or Project (for example "Run #42"), so that I can find the place the note was written about.
15. As the human, I want to filter the Inbox by status, nature and target, so that I can focus on what I am reviewing.
16. As the human, I want to mark a note as triaged, so that it leaves my pile of new notes once handled.
17. As the human, I want to mark a note as dismissed, so that I can set aside what is no longer relevant without deleting it.
18. As the human, I want to optionally record where a triaged note went (an item ID or a spec), so that I can find the outcome later.
19. As the human, I want dismissed and triaged notes to stay consultable, so that I never lose the history of what I noticed.
20. As the human, I want a note never to change after it is saved, so that the record of what I thought stays honest.
21. As the human, I want to select one or many notes with checkboxes, so that I can choose what to analyse together.
22. As the human, I want to select all the notes matching the current filter at once, so that I can export a whole batch quickly.
23. As the human, I want an **Export** action on the selection, so that I get one file for the whole batch.
24. As the human, I want the file named `export_forgequor_<date>_<time>.md`, so that I can tell exports apart and know where they come from.
25. As the human, I want the file written into the repository's `docs/dogfood/` folder, so that Claude can read it right away.
26. As the human, I want the same file offered for download, so that I can also keep or move a copy.
27. As the human, I want exporting not to change the notes' status, so that "exported" is never confused with "triaged".
28. As the human, I want the exported notes grouped by target and ordered by date, so that related remarks sit together.
29. As the human, I want each exported note to show its ID, date, nature, target, origin and text as written, so that nothing is reworded or lost.
30. As the human, I want the origin written as text ("Run #42", project name, tab), so that the file stays readable even without links into the app.
31. As the human, I want a clear error if the export folder cannot be written, so that I know why no file appeared.
32. As the human, I want to run `/dogfood-triage` on an export file, so that the analysis is done for me.
33. As the human, I want the skill to group the notes by theme, so that duplicates and related ideas are seen together.
34. As the human, I want the skill to propose, for each group, a roadmap item, a spec to write, the icebox, or dismissal, so that I only have to decide.
35. As the human, I want the skill to wait for my agreement before writing anything, so that my roadmap is never changed without me.
36. As the human, I want the kept groups turned into roadmap items through the usual ticket flow, so that they follow the project's conventions.
37. As the human, I want the skill to end with the list of note IDs to mark triaged or dismissed (and where each went), so that I can update the Inbox.
38. As the human, I want a README section explaining the flow and why it exists, so that I remember how to use it later.
39. As the human, I want the notes to carry a source and an optional Project, so that the same mechanism can later serve Forgequor's other users.
40. As the human, I want the Inbox to work when a note has no Run or Project, so that notes written on general tabs are not second class.

## Implementation Decisions

**Vocabulary** (to add to `GLOSSARY.md`):
- **Dogfood Note**: a short remark the human records while using Forgequor itself, a feedback or an idea about a Workflow, a feature or the display. Not the **Feedback** of a **Gate**.
- **Dogfood Inbox**: the place where Dogfood Notes wait to be reviewed.
- **Dogfood Export**: the single Markdown file produced from a selection of Dogfood Notes.

**Dogfood Note**:
- Fields: nature (`feedback` or `idea`), target (`workflow`, `feature`, `display`, `other`), text (required, non-empty after trimming), origin tab, optional Run and Project, source (`internal` in v1, kept generic for future users), status, optional triage reference (free text), creation date.
- The origin tab is supplied by the front; the Run and Project come from what the human is viewing. Run and Project, when given, are checked to exist; their names or titles are stored as written at the time, so an export stays readable if they later change or disappear.
- Statuses: `new` at creation, then `triaged` or `dismissed`. Only these transitions; a triaged or dismissed note can go back to `new`, so a misclick is recoverable. Notes are never deleted and their content is never edited; only status and triage reference change.

**Forge core** (the facade, single main seam): operations to create a note, list notes with optional filters (status, nature, target) and the count of new ones, change a note's status with an optional reference, and export a list of notes. Invalid input and unknown IDs use the existing error classes that the HTTP layer maps to 4xx codes.

**Export**:
- Builds one Markdown document: a header with the export date and note count, then one section per target, each with its notes ordered by date, each note showing ID, date, nature, target, origin as text, optional triage reference, and the text verbatim.
- The file name is `export_forgequor_<date>_<time>.md`. It is written into a configurable export folder, default `docs/dogfood/` of the Forgequor repository, created if missing, and the same content is returned for download.
- Exporting never changes any status. Exporting an empty selection is refused.

**HTTP**: thin routes over the Forge operations: create a note, list with filters (including the new count), change status, export. The export route returns the file content with the file name, for download.

**Front**:
- A floating **+ Note** button mounted once at the app shell level, on every tab; a popup form built from scratch (the app has no dialog component today); after saving, the popup closes and a short inline "noted" message appears (no toast component exists).
- The target is pre-selected from the active tab (waiting, runs, projects, inbox) and the Run or Project in view.
- A new **Inbox** tab with a count badge of new notes, status/nature/target filters, per-note status buttons, checkboxes with "select all matching", and the **Export** action.
- Text-only references to Runs and Projects (no deep links), because the app has no router.

**Storage**: a new table for the notes added by the next numbered migration, following the existing migration convention.

**Skill** `/dogfood-triage` in the Forgequor-only skills folder: reads an export file, groups notes by theme, proposes for each group a roadmap item, a spec to write, the icebox, or dismissal, waits for the human's agreement, then hands the kept ones to the ticket flow (`/to-tickets`, or `/to-spec` first when a spec is needed). It ends by listing the note IDs with their outcome so the human can update the Inbox. It has no access to the app.

**Documentation**: a "Dogfooding" section in the skills README explaining the flow (+ Note → Inbox → Export → `/dogfood-triage` → roadmap) and why; one line in the role table of `CLAUDE.md`.

**Roadmap slicing** (after M4, each its own branch and pull request, chained):
- `dogfood-01` capture: storage, Forge operations to create and list, route, **+ Note** button and popup with automatic context.
- `dogfood-02` Inbox: statuses and filters in the core and routes, Inbox tab, badge, status buttons.
- `dogfood-03` export: selection, Markdown generation, file writing, download.
- `dogfood-04` skill and documentation: `/dogfood-triage`, README section, `CLAUDE.md` line. Blocked by `dogfood-03` because it needs the real export format.

## Testing Decisions

- A good test checks behaviour seen from outside: what a note looks like after being created, what a list returns, what the exported document contains. It does not check how the code is arranged inside.
- **Main seam: the Forge facade**, tested against the real database through the existing harness. Cases: creating a note with and without Run or Project; empty text refused; invalid nature or target refused; unknown Run or Project refused; list filters and the new-notes count; allowed and refused status transitions; the triage reference kept; export content (grouping by target, ordering by date, text verbatim, origin as text, status untouched); empty selection refused; file written to the export folder with the expected name pattern, using a temporary folder.
- **HTTP**: thin tests with a simulated Forge, in the style of the existing route tests: request shape, response shape, error-to-status mapping, export returns the file name and content.
- **No automated tests** for the Vue front (none exist today; each item is checked by hand in the browser) nor for the skill (checked by hand on a real export).
- Prior art: the existing Forge core tests on the real database and the existing HTTP route tests.

## Out of Scope

- A chat or any agent reply to a note; automatic deduplication or reformulation by an agent (possible later).
- Screenshots or attachments on notes.
- Deleting or editing a note's content.
- Deep links into the app (needs a router) and a router itself.
- Notes written by users other than the human running Forgequor (the model keeps `source` and Project so this stays possible).
- Syncing notes to an external tracker, or writing to the Inbox from the skill.
- Keyboard shortcut for the popup.
- Naming refinements of the glossary terms beyond the three above.

## Further Notes

- The feature is most useful once Forgequor is used daily, which is why it is placed after M4.
- The word **Feedback** already means the human's written reason for rejecting a **Gate** or an **Asset**; the new terms must not reuse it, and the glossary entries say so.
- The text-only origin in exports is a deliberate v1 choice; adding a router later could add links without changing the note data.
