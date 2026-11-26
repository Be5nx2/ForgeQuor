# FORGEQUOR

**Many Minds. One Forge. Infinite Worlds.**

Multi-Agent AI Game Development Orchestrator: a Node.js + Vue app with a PostgreSQL store that drives the Claude Code and Codex CLIs through looping workflows (produce, validate, iterate). Brand and vision: [docs/BRAND_IDENTITY.md](docs/BRAND_IDENTITY.md).

## Getting started

### Link the agent skills (after every clone and every skill change)

Skills live in `skills/` (the tracked sources). Claude Code and Codex read them from `.claude/skills/` and `.agents/skills/`, which are generated symlinks and **not committed**.

```bash
scripts/link-skills.sh
```

Run it after cloning, and again whenever you add, rename or remove a skill. Only edit files under `skills/`, never the generated folders.

## Project layout

| Path | Purpose |
|---|---|
| `skills/` | Agent skills: `shared/`, `forgequor/`, `godot/` (see [skills/README.md](skills/README.md)) |
| `docs/specs/` | One spec per feature |
| `docs/adr/` | Architecture decision records |
| `docs/agents/` | Conventions skills read (tracker, domain docs) |
| `ROADMAP.md` / `CHANGELOG.md` | Planned work and shipped changes |
| `CLAUDE.md` / `AGENTS.md` | Instructions for Claude Code and Codex |

## Contributing

Commit and branch conventions are in [CLAUDE.md](CLAUDE.md#git-workflow).
