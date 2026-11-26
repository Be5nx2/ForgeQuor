# Skills

| Folder | Audience | Loaded in Forgequor repo | Installed into Godot projects |
|---|---|---|---|
| `shared/` | process skills, tracker-agnostic (grilling, to-spec, to-tickets, triage, wayfinder, review, PR, teach...) | yes | yes |
| `forgequor/` | developing the Node/Vue orchestrator (tdd, architecture, implement...) | yes | no |
| `godot/` | developing games in Godot, game design | no | yes |

## Tracker-agnostic by design
Shared skills never hard-code where specs/tickets live. They read `docs/agents/issue-tracker.md` in the current project, which maps
operations ("publish a spec", "publish tickets", "fetch", "resolve", "labels") to concrete actions.
Templates in `shared/trackers/`: `local-roadmap.md` (Forgequor: ROADMAP.md + CHANGELOG.md + docs/specs/), `codecks.md` (game projects).

Sources adapted from Matt Pocock's MIT skills (`LICENSE-mattpocock`). The generated `.claude/skills/` and `.agents/skills/` are git-ignored: run `scripts/link-skills.sh` after cloning and after any skill change.
