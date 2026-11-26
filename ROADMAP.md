# Roadmap

Format and rules: `docs/agents/issue-tracker.md`. Vocabulary: `GLOSSARY.md`. Decisions: `docs/adr/`.

Milestones are specified one at a time with `/to-spec`, then split into items with `/to-tickets`.

## Now

### M1 Walking skeleton

One **Project**, one **Run** going Developer (Claude) → **Checks** → pull request with **Review Brief** → final **Gate** in Forgequor. Worktree, branch and PR per Run (ADR 0001), Runners as local subprocesses (ADR 0002), PostgreSQL through Docker Compose (ADR 0003), minimal Vue UI.

- Spec: `docs/specs/m1-walking-skeleton.md`. Items to come from `/to-tickets`.

## Next

### M2 Assets

Codex **Runner**, **Artist**, an `assets` **Workflow** (Artist → asset **Gate** → PR), generic Gate + **Feedback** + **Iteration** mechanism, **Art Direction** read from the Project, asset gallery in the UI. Unblocks the first game.

### M3 Full loop

YAML **Workflows** with parallel **Steps**, Griller with chat, Spec Writer, Architect, solo or duo review (chosen at Run launch) with **Consolidator** (an unsettled reviewer disagreement opens a **Gate** with its recommendation), **Escalation**, configurable iteration limit (default 3), default `feature` and `bugfix` Workflows.

### M4 Comfort

**Quota** gauges refreshed after every Step (unknown shown greyed), **Archive** and purge after 60 days, macOS notifications, **Skill Packs** per Project plus the Project's own Skills, one-click Runner assignment (default and per Run), read-only Workflow preview, `/to-workflow` skill (checks for a close existing Workflow before writing a new one).

## Icebox

- Child Runs: a feature Run splitting its spec into one Run per ticket (ADR 0001).
- Runner fallback when a Quota is exhausted.
- Competing Runs: the same Step on two Runners, then pick.
- Codecks sync: import cards, update status.
- Reading the human's GitHub PR comments as Feedback.
- Automatic solo/duo review choice from diff size.
- Visual Workflow editor.
- Containerised or API-key Runners, multi-user studio instance.

## Done
