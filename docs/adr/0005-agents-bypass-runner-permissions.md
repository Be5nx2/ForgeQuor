# Agents run with the Runner's permission prompts bypassed

A headless **Step** has nobody to answer a permission prompt, so the Claude **Runner** starts every Step with permissions bypassed. The **Agent** can edit files, run commands and use git without asking, with the human's full rights on the machine. Nothing confines it to the **Run**'s worktree except its instructions (ADR 0002).

We accept this in v1. Forgequor is single-user and local, and only works on **Projects** the human owns and trusts. The human reviews every change at the final **Gate** before anything is merged.

## Considered Options

- **Bypass all prompts (chosen).** Agents can do whatever a Step needs. The cost is that a misbehaving Agent can also touch files outside its worktree or push on its own.
- **Allow-list of tools and commands.** Safer, but every Project's build, test and engine commands would need listing up front. Each missing entry stalls a Run with no one there to approve it.
- **Run each Step in a container.** Real isolation, but heavy for a local Godot workflow (engine, assets, caches) and premature for v1. It is in the Icebox with containerised Runners, and it is the way to revisit this decision.

## Consequences

- Register only Projects you trust. A Project's own instructions, Skills or Checks run with your rights.
- Forgequor guards what it can check after a Step: no **Run Notes** are pushed, and **Checks** must pass. It cannot prevent side effects outside the worktree.
- The Codex Runner (M2) follows the same rule, using its own equivalent setting.
