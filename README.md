# FORGEQUOR

**Many Minds. One Forge. Infinite Worlds.**

Multi-Agent AI Game Development Orchestrator: a Node.js + Vue app with a PostgreSQL store that drives the Claude Code and Codex CLIs through looping workflows (produce, validate, iterate). Brand and vision: [docs/BRAND_IDENTITY.md](docs/BRAND_IDENTITY.md).

## Getting started

### Prerequisites

- Node.js 22 or later.
- Docker with Compose. On macOS, OrbStack works; it must be running.
- `git`.
- The GitHub CLI, authenticated: `gh auth login`.
- Claude Code, logged in with your subscription: run `claude` once.

### Install

```bash
npm install
```

```bash
scripts/link-skills.sh
```

### Run Forgequor

```bash
npm start
```

This one command does five things, in order:

1. Starts PostgreSQL in Docker on port 5433.
2. Builds the UI.
3. Applies the database migrations.
4. Checks that `git`, `gh` and `claude` are installed and authenticated. A missing tool shows as a ✗ in the console and as a banner in the UI.
5. Serves the app at <http://127.0.0.1:4170>.

Stop it with Ctrl+C. PostgreSQL keeps running in the background. To stop it:

```bash
docker compose down
```

### Try a Run

1. **Projects**: register a local git repository that has a GitHub remote. Its owner/name and default branch are read for you.
2. **Runs**: pick the Project, describe a task and press **Start Run**. Forgequor fetches the default branch and creates a worktree on a `forgequor/<id>-<title>` branch under `~/.forgequor/worktrees/`. A Developer Agent (Claude Code, headless) then does the task there and commits.
3. **Waiting for you**: the Run stops at its final Gate. Approve or abandon it. If something went wrong, it stops at an Escalation instead, which you can only abandon.

To inspect what the Developer did, open the Run's worktree. The path is shown in the Run detail. Its `.forgequor/` folder holds the Run Notes, including the Review Brief. Git ignores that folder.

> M1 is in progress. Gates show their choices but cannot be decided from the UI yet. Runs do not push branches or open pull requests yet (`m1-04`), Checks do not run yet (`m1-05`), and progress is not shown live (`m1-09`): refresh the Run page to see it. See [ROADMAP.md](ROADMAP.md).

> Agents run with Claude Code's permission prompts bypassed, with your rights on this machine ([ADR 0005](docs/adr/0005-agents-bypass-runner-permissions.md)). Only register Projects you trust.

### Configuration

All settings are optional environment variables. Set them in the shell that runs `npm start`.

| Variable | Default | Purpose |
|---|---|---|
| `FORGEQUOR_PORT` | `4170` | Port of the API and UI |
| `FORGEQUOR_DATABASE_URL` | `postgres://forgequor:forgequor@localhost:5433/forgequor` | PostgreSQL connection |
| `FORGEQUOR_WORKTREES` | `~/.forgequor/worktrees` | Where Run worktrees are created |
| `FORGEQUOR_DEVELOPER_MODEL` | Claude Code's default | Model used by the Developer Agent |

### Tests

```bash
npm run typecheck
```

```bash
npm test
```

The tests use the Docker PostgreSQL, so `npm test` starts it if needed. Each test run gets its own isolated schema. Tests never call the real Claude Code: a smoke test that does is skipped unless you opt in, and it uses a little of your Claude Quota.

```bash
FORGEQUOR_SMOKE_CLAUDE=1 npx vitest run tests/runner/claude.smoke.test.ts
```

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
