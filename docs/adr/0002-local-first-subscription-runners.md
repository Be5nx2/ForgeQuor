# Local-first, Runners as subprocesses on the user's subscriptions

Forgequor v1 runs on the user's own machine for a single user. It drives the Claude Code and Codex CLIs as headless subprocesses, authenticated with the user's own subscriptions rather than metered API keys. This keeps cost flat and reuses everything the CLIs already do (tools, skills, sessions), at the price of shared usage limits (a **Run** pauses when a limit is hit) and no isolation between Runs beyond git worktrees.

## Consequences

- No authentication or multi-tenancy in v1.
- The **Runner** interface must stay narrow enough to add containerised or API-key Runners later, for the studio and an open-source release.
