# One Run, one worktree, one branch, one pull request

Each **Run** works in its own git worktree on its own branch and ends as exactly one pull request on its **Project**, from grilling to final review. We chose this over a two-level model (a feature Run that splits its spec into child Runs, one pull request per ticket) because it is simpler to build and to supervise; splitting large specs into child Runs is deferred, not rejected.

Forgequor never merges. It opens the pull request and handles its comments; the human alone merges and chooses the merge order.

## Considered Options

- **One Run per feature, one PR (chosen).**
- **Feature Run spawning one child Run per ticket.** Matches this repo's own "one roadmap item = one PR" rule, but needs parent/child state, cross-PR ordering and a sprint-manager Agent before anything ships. Parked in the Icebox.
