# Skills

| Folder | Audience | Loaded in Forgequor repo | Installed into Godot projects |
|---|---|---|---|
| `shared/` | process and engineering skills, tracker-agnostic (grilling, to-spec, to-tickets, to-workflow, triage, wayfinder, review, PR, tdd, diagnosing-bugs, codebase-design...) | yes | yes |
| `forgequor/` | developing the Node/Vue orchestrator (architecture, implement, prototype...) | yes | no |
| `godot/` | developing games in Godot, game design | no | yes |

## Tracker-agnostic by design
Shared skills never hard-code where specs/tickets live. They read `docs/agents/issue-tracker.md` in the current project, which maps
operations ("publish a spec", "publish tickets", "fetch", "resolve", "labels") to concrete actions.
Templates in `shared/trackers/`: `local-roadmap.md` (Forgequor: ROADMAP.md + CHANGELOG.md + docs/specs/), `codecks.md` (game projects).

Sources adapted from Matt Pocock's MIT skills (`LICENSE-mattpocock`). The generated `.claude/skills/` and `.agents/skills/` are git-ignored: run `scripts/link-skills.sh` after cloning and after any skill change.

## Dogfooding
Forgequor is built with Forgequor, so ideas and annoyances show up mid-use, in the middle of something else. The flow keeps them from being lost and from derailing the work:

**+ Note** (jot it in seconds, from any tab) → **Dogfood Inbox** (notes pile up, newest first, never edited or deleted) → **Dogfood Export** (select notes, get a Markdown file in `docs/dogfood/`) → `/dogfood-triage` (groups the notes, proposes a roadmap item, a spec, the Icebox or dismissal per group, writes nothing until the human agrees, then goes through `/to-spec` or `/to-tickets`) → roadmap.

Why this shape: capture stays cheap so the human keeps using the app, while judgement happens later in one batch, with the roadmap in view. The Inbox funnels into the existing tracker instead of becoming a second one. The skill cannot reach the app, so it ends with the note IDs to mark triaged (with where each went) or dismissed, and the human applies them in the Inbox.
