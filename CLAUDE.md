# Forgequor

Multi-agent AI game development orchestrator. Brand/vision: @docs/BRAND_IDENTITY.md

## What we're building

A Node.js + Vue (front TBD) app with a PostgreSQL store that drives the **Claude Code** and **Codex** CLIs to generate/execute work. Users define workflows (simple to complex) that loop: produce → validate → iterate.

Principles: model-agnostic (runners behind one interface), engine-agnostic (Godot is just a target), modular and extensible.

## Stack (initial)

- Node.js (TypeScript), Vue 3 front, PostgreSQL. Confirm choices before scaffolding; record decisions as ADRs.

## Working agreements

- Language: code, commits and docs in English; chat with the user in French.
- Shared vocabulary lives in `GLOSSARY.md`; decisions in `docs/adr/`. Use glossary terms in names and prose.
- Tracking is local files: @ROADMAP.md, @CHANGELOG.md, specs in `docs/specs/`. Conventions: @docs/agents/issue-tracker.md, @docs/agents/domain.md. Shared skills read that file, so they stay tracker-agnostic; generated game projects use a Codecks variant (`skills/shared/trackers/codecks.md`).
- Prefer deep modules with small interfaces; test through the interface (see `codebase-design`, `tdd`).
- Never commit secrets. Never run destructive git commands (guardrails skill available).

## Skills (team simulation)

After cloning or changing skills, run `scripts/link-skills.sh` (generated folders are git-ignored). Three audiences, see `skills/README.md`: `skills/shared/` (process, used here and in Godot projects), `skills/forgequor/` (building this JS orchestrator only), `skills/godot/` (game projects only, not loaded here). Only shared + forgequor are linked into `.claude/skills/` and `.agents/skills/` by `scripts/link-skills.sh`. Adapted from Matt Pocock's MIT skills (`skills/LICENSE-mattpocock`).

| Role | Skill (shared unless noted) |
|---|---|
| Product / alignment | `/grill-me`, `/grill-with-docs`, `/wait-what` |
| Spec writer | `/to-spec` |
| Project manager | `/to-tickets`, `/triage`, `/wayfinder`, `/to-workflow` |
| Architect | forgequor: `/codebase-architect`, `/improve-codebase-architecture`; shared: `codebase-design`, `domain-modeling` |
| Developer | forgequor: `/implement`, `/implement-spec`, `prototype`; shared: `tdd` |
| Debugger | `diagnosing-bugs` |
| Reviewer | `code-review` |
| Release | `pr` |
| Research / mentor | `research`, `/teach`, `/handoff`, `/retro` |
| Meta | `writing-for-agents`, `/to-questionnaire`, `git-guardrails-claude-code` |

Typical flow: `/grill-with-docs` → `/to-spec` → `/to-tickets` → `/implement` (TDD) → `code-review` → `pr`.

## Git workflow

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org). `type(scope): subject`, imperative, English, no trailing period, max 72 chars. Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `ci`. Breaking change: `!` after the type or a `BREAKING CHANGE:` footer. Body explains the why, in 5 lines at most (trailers not counted).
- **Branches**: `main` stays releasable. Work on `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`. `<slug>` matches the spec or roadmap ID when one exists.
- **Granularity**: one roadmap item = one branch = one PR. Small, focused commits; each leaves tests green.
- **Roadmap and changelog**: when an item is resolved, tick it in `ROADMAP.md` and add a line under `Unreleased` in `CHANGELOG.md` in the same PR.
- **PRs**: body written with the `pr` skill. Run `code-review` before opening. Squash-merge so `main` keeps one conventional commit per item.
- **Safety**: never force-push `main`, never `reset --hard` or `clean -fd` without asking, never commit secrets or `.env`. Hooks from `git-guardrails-claude-code` enforce the destructive-command rules.
