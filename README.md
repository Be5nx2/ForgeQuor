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
- Codex CLI (only for the `assets` Workflow, from M2), logged in with your ChatGPT subscription: `codex login`. `CODEX_HOME` is honoured.

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
4. Checks that `git`, `gh`, `claude` and `codex` are installed and authenticated. A missing tool shows as a ✗ in the console and as a banner in the UI.
5. Serves the app at <http://127.0.0.1:4170>.

Stop it with Ctrl+C. PostgreSQL keeps running in the background. To stop it:

```bash
docker compose down
```

### Try a Run

1. **Projects**: register a local git repository that has a GitHub remote. Its owner/name and default branch are read for you.
2. **Runs**: pick the Project, describe a task and press **Start Run**. Forgequor fetches the default branch and creates a worktree on a `forgequor/<id>-<title>` branch under `~/.forgequor/worktrees/`. A Developer Agent (Claude Code, headless) then does the task there and commits.
3. **Waiting for you**: the Run stops at its final Gate. Approve or abandon it. If something went wrong, it stops at an Escalation instead, which you can only abandon.

#### An `assets` Run

For 2D pixel art, pick the **assets** Workflow in the Run form and list **Asset Requests** (name, sprite, tile or animation, what it shows, size) instead of a task. The Artist (Codex, headless, sandboxed to the worktree) draws them one after the other, following the Project's **Art Direction**, and writes each at `<art folder>/<sprites|tiles|animations>/<name>.png`. An attempt that fails the Asset Checks, or writes nothing, goes back to the Artist with the reason; one Asset costs at most 3 Artist Steps per Iteration (2 when it writes nothing twice), then the Run stops at an Escalation, so a stubborn Asset cannot drain the Quota. The Run page lists each attempt the Asset Checks sent back, and why. The Run then stops at an **Asset Gate**: a gallery shows each Asset at real size and magnified with crisp pixels, on a background colour you can change. Give a verdict on every Asset at once: approve it, or reject it with its own Feedback. The Artist then redoes only the rejected ones (with your Feedback and the rejected version as a reference), as many Iterations as you want; past versions stay in the gallery. Once everything is approved Forgequor commits the Assets in one commit, opens the pull request with a Review Brief it writes itself (with each Asset's palette warnings and the Feedback behind it), and the Run is Approved. Setup commands and Checks are skipped.

On the Projects screen, set where the Project keeps its **Art Direction** document (default `docs/ART_DIRECTION.md`) and its **art folder** (default `assets/art`). A Run stops at an Escalation, before generating anything, when the Art Direction is missing from the repository's default branch. The Runner's raw images are kept under `.forgequor/assets/` as a trace. An `assets` Run survives a used-up Codex Quota (it pauses, then resumes at the Asset it was on) and a restart of Forgequor (it picks up at the current Asset, keeping the ones already drawn); the Run page shows how many Assets are drawn and the Artist's live progress on the current one.

##### The Art Direction contract

The Art Direction is a Markdown document in the Project (default `docs/ART_DIRECTION.md`, read from the Run's worktree). Forgequor reads three things from it, none required:

- **Palette**: every `#RRGGBB` code under a `Palette` heading (up to the next heading of the same or a higher level). Opaque colours outside it only show as a warning on the Asset. Without a palette there is no warning.
- **Default size**: a `Default size: WxH` line (for example `Default size: 16x16`). The Run form presets new Assets to it. Without one, the form starts at 16x16.
- **Reference images**: repository paths to PNG files mentioned anywhere in the document (for example `assets/art/ref/style.png`). Those that exist are always shown to the Artist, so every Asset follows the same look. An Art Direction without any works just as well. An Asset Request can add its own style references, picked from the repository's PNGs.

An Asset Request never overwrites an existing file by accident: starting the Run is refused when its target file already exists, unless the request is marked as **replacing** it (the existing art is then shown to the Artist as a reference, in every Iteration). Two requests that would produce the same file, or a reference that does not exist, are refused too.

To inspect what the Developer did, open the Run's worktree. The path is shown in the Run detail. Its `.forgequor/` folder holds the Run Notes, including the Review Brief. Git ignores that folder.

> M1 (walking skeleton) and M2 (Assets) are done: a `developer` Run goes from its own worktree to a pull request and your final Gate, where you can approve, abandon or reject with Feedback; an `assets` Run has Codex draw sprites, tiles and Animation Strips that you judge one by one at the Asset Gate. M3 (full loop) is next. The Run page shows the Developer's progress live. On the Projects screen, declare a Project's **Setup** (shell commands run in each new worktree before the Developer, in order; a failing one opens an Escalation and the Developer never starts) and its **Checks** (run after the Developer, in order; without any, a Run goes straight to the pull request). See [ROADMAP.md](ROADMAP.md).

#### Preparing your own Project

Everything a repository needs to work with Forgequor (required files, Setup and Checks, Skill Packs, Art Direction, a copy-paste prompt that does the preparation for you) is in [ForgeQuor_must_have.md](ForgeQuor_must_have.md).

#### Registering Forgequor itself

To let Forgequor run its own roadmap items, register this repository as a Project with:

- Setup: `npm ci`, then `scripts/link-skills.sh`
- Checks: `npm run typecheck`, then `npm test`

The Docker Compose project has a fixed name (`forgequor`), so tests run from a Run's worktree reuse the one PostgreSQL instance instead of starting a second one on the same port.

> Agents run with Claude Code's permission prompts bypassed, with your rights on this machine ([ADR 0005](docs/adr/0005-agents-bypass-runner-permissions.md)). Tools that wait for a human (asking a question, plan mode) are disabled, so an Agent never stalls on one. Only register Projects you trust.

### Configuration

All settings are optional environment variables. Set them in the shell that runs `npm start`, or in a `.env` file at the repo root (copy `.env.example`); a variable set in the shell wins over the file.

| Variable | Default | Purpose |
|---|---|---|
| `FORGEQUOR_PORT` | `4170` | Port of the API and UI |
| `FORGEQUOR_DATABASE_URL` | `postgres://forgequor:forgequor@localhost:5433/forgequor` | PostgreSQL connection |
| `FORGEQUOR_WORKTREES` | `~/.forgequor/worktrees` | Where Run worktrees are created |
| `FORGEQUOR_<SEAT>_RUNNER` | per seat: Claude Code, except `REVIEWER_B` and `ARTIST` (Codex) | Runner (`claude` or `codex`) of an Agent seat. Seats: `GRILLER`, `SPEC_WRITER`, `ARCHITECT`, `DEVELOPER`, `REVIEWER_A`, `REVIEWER_B`, `CONSOLIDATOR`, `ARTIST`. A seat whose Runner cannot be started opens an Escalation naming it when a Step needs it |
| `FORGEQUOR_<SEAT>_MODEL` | the Runner's default | Model of an Agent seat, such as `FORGEQUOR_DEVELOPER_MODEL` or `FORGEQUOR_ARTIST_MODEL` |
| `FORGEQUOR_<SEAT>_EFFORT` | the Runner's default | Effort level of an Agent seat, one of its Runner's own levels (Claude Code `--effort`, Codex reasoning effort), such as `FORGEQUOR_ARCHITECT_EFFORT=high`. Locked on the Team page when set |
| `FORGEQUOR_STEP_TIMEOUT_MINUTES` | `60` | An Agent's Step running longer is killed and escalated |
| `FORGEQUOR_ARCHIVE_DAYS` | `60` | An archived Run is deleted, with everything that belongs to it, after this many days |
| `FORGEQUOR_DOGFOOD_FOLDER` | `docs/dogfood` | Where a Dogfood Export is written (relative to the Forgequor checkout; created when missing; git-ignored) |
| `FORGEQUOR_CHECK_TIMEOUT_MINUTES` | `10` | A Check command running longer is killed and counts as failed |

### Starting over

The app has no "reset everything" button, on purpose. To wipe Forgequor entirely (every Project, Run and Dogfood Note), do it by hand:

1. Stop Forgequor (and any running Run).
2. Drop its database. With the bundled Docker Compose, `docker compose down -v` stops PostgreSQL and deletes its volume (`forgequor_pgdata`); with your own PostgreSQL, drop the `forgequor` database.
3. Empty the worktrees folder (`~/.forgequor/worktrees` unless `FORGEQUOR_WORKTREES` says otherwise). If a Run left a worktree attached to one of your repositories, run `git worktree prune` there afterwards.
4. Start Forgequor again: the migrations rebuild an empty database.

To clear only old history, use **Purge Archived Runs** on the Projects screen instead (all Projects at once, or per Project in its Danger zone).

### Tests

```bash
npm run typecheck
```

```bash
npm test
```

The tests use the Docker PostgreSQL, so `npm test` starts it if needed. Each test run gets its own isolated schema. Tests never call the real Claude Code: a smoke test that does is skipped unless you opt in, and it uses a little of your Claude Quota.

```bash
npm run smoke:claude
```

The Codex Runner has its own opt-in smoke test, which reads the Codex Quota on demand (free) and generates one real 16x16 sprite (one image of your Codex Quota):

```bash
npm run smoke:codex
```

Another opt-in smoke test opens, comments on and closes a real pull request on a throwaway GitHub repository you own, with a `main` branch (`gh` must be signed in). Name that repository once in your `.env` (see `.env.example`):

```bash
FORGEQUOR_SMOKE_REPO=owner/name
```

Then run it. A plain `npm test` never runs it.

```bash
npm run smoke:gh
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
