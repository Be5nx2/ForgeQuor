# Forgequor must-haves: preparing a Project

What a **Project** (a git repository, usually a game) needs so that a Forgequor **Run** works from start to pull request. Three levels:

- **Required**: without it, registration or the Run is refused.
- **Strongly recommended**: the Run starts, but the Agents work blind or the loop cannot validate anything.
- **Optional**: unlocks a feature (assets, custom Workflows, Codecks).

Vocabulary is in [GLOSSARY.md](GLOSSARY.md). Decisions are in [docs/adr/](docs/adr/).

## 0. Quick checklist (copy and tick)

```markdown
### Required
- [ ] Git repository with an `origin` remote on GitHub
- [ ] Default branch pushed to `origin` (at least one commit)
- [ ] `gh auth status` OK, with the right to push branches and open PRs on that repository
- [ ] Everything a Run needs is COMMITTED and PUSHED (a Run starts from `origin/<default branch>`)
- [ ] Registered in Forgequor (Projects screen)

### Strongly recommended
- [ ] `CLAUDE.md` (and `AGENTS.md` pointing to it): stack, commands, conventions, commit rules
- [ ] Checks declared (tests, lint, headless build) and they pass on a fresh clone
- [ ] Setup declared (everything a fresh worktree needs before it can build or test)
- [ ] `GLOSSARY.md` at the root
- [ ] `docs/adr/` (even empty, with a first ADR for the stack)
- [ ] `docs/specs/` folder (the Spec Writer writes `docs/specs/<slug>.md`)
- [ ] `docs/agents/issue-tracker.md` (where specs and tickets go)
- [ ] `docs/agents/domain.md` (where the glossary and ADRs live)
- [ ] Skill Packs picked (for a Godot game: `godot`)

### Optional
- [ ] `docs/ART_DIRECTION.md` + art folder `assets/art` (needed for `assets` Runs)
- [ ] Reference PNGs for the Artist
- [ ] `forgequor/workflows/<name>.yaml` (Project-specific Workflows)
- [ ] `ROADMAP.md` / `CHANGELOG.md` (if tracking is local files)
```

## 1. Required

### 1.1 The repository

Registration (`inspectRepository`) refuses the Project unless:

| Condition | Why | Fix |
|---|---|---|
| The path exists and is inside a git repository | Forgequor creates a worktree per Run | `git init` |
| An `origin` remote exists and points at **GitHub** | The pull request is opened with `gh` | `git remote add origin git@github.com:<owner>/<name>.git` |
| The default branch can be determined | Every Run branches from it | `git remote set-head origin -a` |

Other requirements:

- **The default branch must be pushed.** A Run is created with `git worktree add -b <branch> <path> origin/<default branch>`. Local, unpushed work is invisible to a Run.
- **`gh` must be able to push and open pull requests** on the repository (`gh auth login`, `repo` scope).
- A Run pushes `forgequor/<id>-<title>` and opens the pull request against the default branch. The branch name and the pull request title come from the Run.

### 1.2 A fresh worktree must be enough

A Run works in a **fresh checkout** of `origin/<default branch>`. Only committed files exist there. Anything git-ignored or generated on your machine is absent:

- `.env`, local secrets, API keys: absent. **Never commit them.** The Run must work without them.
- Dependencies (`node_modules`, build caches, the engine's import cache): absent. Declare them as **Setup** (section 2.2).
- Generated or imported resources: absent. Rebuild them in **Setup**.

> Test it: `git clone <your repo> /tmp/fresh && cd /tmp/fresh`, run your Setup commands, then your Check commands. If that fails, a Run fails too.

### 1.3 Registration in Forgequor

On the **Projects** screen, register the local path. Forgequor reads the owner, the name and the default branch for you. For each Project you can then set:

| Setting | Purpose |
|---|---|
| **Setup** | Shell commands run in each new worktree, in order, before the Developer. A failing one opens an Escalation and the Developer never starts. |
| **Checks** | Shell commands run after the Developer, in order. A failure goes back to the Developer (3 attempts, then an Escalation). |
| **Skill Packs** | Packs beyond `shared` (which every Run gets). |
| **Art Direction path** | Default `docs/ART_DIRECTION.md`. |
| **Art folder** | Default `assets/art`. |
| **Max concurrent Runs** | Default 2. Extra Runs wait in Queued. |

**Setup and Checks live in Forgequor (its database), not in the repository.** They are not versioned with the Project, so keep a copy in your `CLAUDE.md` (section 2.1).

## 2. Strongly recommended

### 2.1 `CLAUDE.md` and `AGENTS.md`

Claude Code reads `CLAUDE.md` and Codex reads `AGENTS.md`. The Developer is told to "follow the repository's own conventions and instructions", and the Reviewer judges the change against **the standards documented here** (CLAUDE.md, AGENTS.md, CONTRIBUTING.md and what they point to). Without them, the Reviewer has no standards to check.

`AGENTS.md`, one line:

```markdown
# AGENTS.md

See @CLAUDE.md (shared instructions for Claude Code and Codex).
```

`CLAUDE.md`, a skeleton to fill in:

```markdown
# <Game name>

<One sentence: what the game is.>

## Stack

- Engine: Godot <version>, language: GDScript (or C#)
- Tests: <GUT / gdUnit4 / ...>, command: `<headless test command>`

## Commands (the Checks and Setup Forgequor runs)

- Setup: `<command>`, then `<command>`
- Checks: `<test command>`, then `<lint / headless build command>`

## Working agreements

- Language: code, commits and docs in English.
- Shared vocabulary in `GLOSSARY.md`; decisions in `docs/adr/`.
- Tracking: see `docs/agents/issue-tracker.md`.
- Never commit secrets or `.env`.

## Git workflow

- Conventional Commits: `type(scope): subject`, imperative, no trailing period, max 72 chars. Body: 5 lines at most.
- One task = one branch = one pull request. Squash-merge.
- Never force-push the default branch.

## Code conventions

- <Naming, folder layout, scene structure, signals, autoloads...>
- <Where tests live, how to name them.>
```

### 2.2 Checks and Setup that actually run headless

The loop **produce → validate → iterate** only works if validation is automatic.

- **Checks** must run without a human, without a display, and exit non-zero on failure. A timeout kills them after 10 minutes (`FORGEQUOR_CHECK_TIMEOUT_MINUTES`). **Without any Check, a Run goes straight to the pull request**: nothing validates the Developer's work.
- **Setup** prepares the fresh worktree. For a Godot project, that typically means importing resources headless, so the first test run does not fail on a missing import cache.
- Commands are shell commands: the engine binary must be on the `PATH` of the shell that runs `npm start`.

Illustrative values for a Godot project (to adapt, not verified for your setup):

```text
Setup:  godot --headless --import
Checks: godot --headless -s addons/gut/gut_cmdln.gd -gdir=res://tests -gexit
```

### 2.3 Documents the Agents read

| File | Who reads it | What happens without it |
|---|---|---|
| `GLOSSARY.md` | Griller, Spec Writer, Architect (all use "the Project's vocabulary") | Agents invent terms. The Griller also updates it during grilling. |
| `docs/adr/` | Griller, Spec Writer, Architect | No recorded decisions to respect. The Griller and the Architect write new ADRs here. |
| `docs/specs/` | Spec Writer writes `docs/specs/<slug>.md` | Created on first use. |
| `docs/agents/issue-tracker.md` | The shared Skills (`to-spec`, `to-tickets`, `triage`, `wayfinder`) | The Skills do not know where a spec or a ticket goes. |
| `docs/agents/domain.md` | `grill-with-docs`, `domain-modeling` | The Skills guess where the glossary and ADRs are. |

During a `feature` Run, the Griller may only change `GLOSSARY.md` and `docs/adr/`. The Architect may only write the Implementation Plan and `docs/adr/`. Forgequor puts back any other change and fails the Step.

`docs/agents/domain.md`:

```markdown
# Domain docs

- Glossary (ubiquitous language): `GLOSSARY.md` at repo root.
- ADRs: `docs/adr/NNNN-<slug>.md`.
- Brand and product identity: `docs/<...>.md` (optional).
```

`docs/agents/issue-tracker.md`, local-files variant:

```markdown
# Tracking: local files

- `ROADMAP.md`: what is planned, in progress, done. One section per spec; items are checkboxes with IDs and `Blocked by`.
- `CHANGELOG.md`: what shipped ([Keep a Changelog](https://keepachangelog.com), `Unreleased` on top).
- `docs/specs/<slug>.md`: one spec per feature. Roadmap items link to it.

| Skill says | Do |
|---|---|
| publish a spec | write `docs/specs/<slug>.md`, add a line in ROADMAP |
| publish tickets | items under the spec's section in ROADMAP |
| fetch the ticket | read the item by ID in ROADMAP + its spec |
| resolve / close | tick the checkbox, add a CHANGELOG line under `Unreleased` |
| blocked by | `Blocked by:` line on the item |
```

Codecks variant: copy [skills/shared/trackers/codecks.md](skills/shared/trackers/codecks.md) to `docs/agents/issue-tracker.md` and fill in the organization, the project and the decks (Specs, Backlog, Bugs). The Codecks MCP server must be available to the Runner. Note: during a `feature` Run, "publish a spec" means writing the spec file only, so the Spec Writer never pushes to the tracker.

### 2.4 Skills

- Every Run gets the **`shared`** pack (grilling, `to-spec`, `tdd`, `diagnosing-bugs`, `code-review`, `codebase-design`, ...).
- Pick the other packs per Project. For a game, pick **`godot`** (a placeholder for now: see [skills/godot/README.md](skills/godot/README.md)). The `forgequor` pack is never offered: it is for building Forgequor itself.
- Skills are **copied** into the worktree (`.claude/skills/` for Claude Code, `.agents/skills/` for Codex) and excluded through the repository's local exclude file, so they are never committed. **A Skill your Project already has in those folders wins** over a pack's Skill of the same name.
- Do not edit the copies in a worktree. Edit the sources under `skills/`.

## 3. Optional

### 3.1 Assets (the `assets` Workflow, pixel art through Codex)

For an `assets` Run to start, the repository's **default branch** must contain the Art Direction document.

- **Art Direction**: `docs/ART_DIRECTION.md` (or the path set on the Projects screen). A Run stops at an Escalation, before generating anything, when it is missing.
- **Art folder**: `assets/art` (or the one set on the Projects screen). Assets are written at `<art folder>/<sprites|tiles|animations>/<name>.png`.
- Format: PNG, pixel art, at the size asked.
- **Codex** installed and logged in (`codex login`), on this machine.

Forgequor reads three things from the Art Direction, none required:

| What | How it is read |
|---|---|
| Palette | Every `#RRGGBB` code under a `Palette` heading. Opaque colours outside it only warn. |
| Default size | A line `Default size: 16x16`. Without it, the form starts at 16x16. |
| Reference images | Repository paths to PNGs mentioned anywhere in the document. Those that exist are always shown to the Artist. |

Skeleton for `docs/ART_DIRECTION.md`:

```markdown
# Art Direction

Pixel art, top-down, readable at small sizes. <One or two lines on the mood.>

Default size: 16x16

## Palette

- `#1A1C2C`
- `#5D275D`
- `#B13E53`
- `#EF7D57`
- `#FFCD75`
- `#F4F4F4`

## Reference images

- `assets/art/ref/style.png`
```

Rules enforced by Forgequor: no overwriting an existing file unless the request is marked as replacing it, no two requests for the same file, and every reference must exist.

### 3.2 Project Workflows

A Project can ship its own Workflows in `forgequor/workflows/<name>.yaml`, read from the **remote default branch** (as last fetched). Rules:

- The `name:` inside the file equals the file name (lowercase letters, digits, dashes).
- It only composes Step types Forgequor has code for (`agent`, `conversation`, `checks`, `gate`, `publish`, `artist`, `review`).
- Its launch `inputs` must be one of: `task`, `assets`, or `task` + `review`.
- A Project Workflow named like a built-in (`developer`, `bugfix`, `feature`, `assets`) **replaces** it, even an invalid one: the Run is then refused instead of silently started from the built-in.

Start from a built-in rather than from scratch: use the `/to-workflow` skill or copy one from [src/forge/workflows/](src/forge/workflows/). The full list of what a Workflow can contain is in [skills/shared/to-workflow/REFERENCE.md](skills/shared/to-workflow/REFERENCE.md).

### 3.3 Roadmap and changelog

If tracking is local files, create `ROADMAP.md` and `CHANGELOG.md` (Keep a Changelog format, `Unreleased` on top) and match the format in `docs/agents/issue-tracker.md`.

## 4. What Forgequor does to your repository

- **Never** commits the `.forgequor/` folder (Run Notes). It is excluded through the repository's local exclude file, which is not versioned. You do not need to edit `.gitignore`, but adding `.forgequor/` there does no harm.
- Creates worktrees under `~/.forgequor/worktrees/` (`FORGEQUOR_WORKTREES`) and removes the worktree and the local branch once a Run is Merged, Closed or Abandoned.
- Pushes `forgequor/<id>-<title>` branches to `origin`. An Abandoned Run, or one whose pull request was closed unmerged, also loses its remote branch.
- Commits the Developer's work in Conventional Commits, and anything left uncommitted at the end.

## 5. What the machine needs

- Node.js 22 or later, Docker with Compose (PostgreSQL on port 5433), `git`.
- `gh`, authenticated (`gh auth login`).
- `claude`, logged in with your subscription (run `claude` once).
- `codex`, logged in (`codex login`): only for the `assets` Workflow, and for the second Reviewer by default.
- The tools your Checks and Setup call (game engine, test runner), on the `PATH`.
- `npm start` checks `git`, `gh`, `claude` and `codex` at startup. A missing one shows as a ✗ in the console and as a banner in the UI.

> **Security**: Agents run with the Runner's permission prompts bypassed, with your rights on this machine ([ADR 0005](docs/adr/0005-agents-bypass-runner-permissions.md)). Only register Projects you trust.

## 6. Copy-paste: make an existing project Forgequor-ready

Paste this into Claude Code, opened at the root of the game repository:

```text
Make this repository ready to be a Forgequor Project. Read ForgeQuor_must_have.md first (copy it into this repository, or I will paste it below), then:

1. Check that the repository has an `origin` remote on GitHub, that its default branch is pushed, and that `gh auth status` works. Report anything missing; do not change remotes yourself.
2. Create what is missing, without overwriting anything that exists: AGENTS.md (one line pointing to CLAUDE.md), CLAUDE.md (stack, commands, conventions, Conventional Commits), GLOSSARY.md, docs/adr/ with a first ADR recording the stack, docs/specs/, docs/agents/issue-tracker.md, docs/agents/domain.md. Infer the stack and the commands from the repository; mark with TODO what you cannot infer.
3. List the Setup and Check commands a fresh clone needs, and verify them in a fresh clone (git clone into a temporary folder). Put them in CLAUDE.md under "Commands". I will enter them on Forgequor's Projects screen.
4. If the project has pixel art, create docs/ART_DIRECTION.md (palette, `Default size: WxH`, reference images) and the art folder.
5. Never commit secrets or .env. Do not commit anything: show me the diff.
```

## 7. Source of truth

This document summarises behaviour implemented in:

- Registration and worktrees: [src/forge/workspace.ts](src/forge/workspace.ts)
- Skill Packs: [src/forge/skill-pack.ts](src/forge/skill-pack.ts)
- Project Workflows: [src/forge/project-workflows.ts](src/forge/project-workflows.ts)
- Art Direction: [src/forge/art-direction.ts](src/forge/art-direction.ts)
- Startup checks: [src/startup/preflight.ts](src/startup/preflight.ts)
- Configuration and Runs: [README.md](README.md)

If the code and this document disagree, the code wins: fix this document.
