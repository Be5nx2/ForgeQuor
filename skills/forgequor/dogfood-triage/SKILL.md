---
name: dogfood-triage
description: Triage a Dogfood Export, the notes the human jotted while using Forgequor, into roadmap items, specs, Icebox entries or dismissals.
disable-model-invocation: true
---

# Dogfood Triage

Turn a **Dogfood Export** into decisions. The notes were jotted with **+ Note** and exported from the Dogfood Inbox; this skill has no access to the app, so the human applies the outcome in the Inbox at the end. Vocabulary: `GLOSSARY.md`. Tracking operations: `docs/agents/issue-tracker.md`.

## Process

1. **Read the export.** The argument is a file path; without one, take the newest `export_forgequor_*.md` in `docs/dogfood/` (the human may name another folder). Confirm the file name and note count with the human. Each note is a `### Note #<id>` block: ID, Date, Nature (`feedback` or `idea`), Target, Origin, an optional Triage line, then the text in a fenced block. A note with a Triage line was handled before: list it apart and ask whether to reopen it.
2. **Read what exists.** Skim `ROADMAP.md` (Now, Next, Icebox) and `docs/specs/` so each group meets what is already planned: a note may duplicate an item, extend one, or contradict a decision in an ADR.
3. **Group by theme.** A group is one problem or one wish, whatever the Target sections of the export say; notes on the same Run or screen often belong together. Give each group a short title, its note IDs, and a one-line synthesis. Every note lands in exactly one group.
4. **Propose an outcome per group**, with a one-line reason:
   - **Roadmap item**: small, clear, fits one branch. Say whether it joins an existing section or starts a new one.
   - **Spec to write**: a feature with open design questions, or too big for one item; `/to-spec` first.
   - **Icebox**: worth keeping, not now.
   - **Dismiss**: duplicate, already done, or no longer relevant.
5. **Agree with the human.** Present the groups as a numbered table (title, note IDs, outcome, reason) and iterate on merges, splits and outcomes. Everything so far is read-only; step 6 starts only after the human approves the table.
6. **Write the kept groups.**
   - Spec to write: run `/to-spec`, then `/to-tickets` on the result.
   - Roadmap item: run `/to-tickets` with the group's notes as source material.
   - Icebox: add a line under `## Icebox` in `ROADMAP.md`.
   - Dismiss: write nothing.

   Cite note IDs in the spec or item body so the origin stays traceable.
7. **Close with the Inbox list.** Done when every note ID of the export appears once in one of two lists:
   - **Mark triaged**: ID, and the reference to enter (roadmap item ID, spec path, or `icebox: <title>`).
   - **Mark dismissed**: ID, and the reason.

   Tell the human to apply both in the Dogfood Inbox, since this skill cannot.
