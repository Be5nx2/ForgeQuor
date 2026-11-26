# The Codex Runner runs sandboxed, unlike the Claude Runner

The Codex **Runner** starts each **Step** inside Codex's own sandbox. It can write only inside the **Run**'s worktree, and approval prompts are turned off so it never waits for a human. The Claude Runner, by contrast, bypasses permissions entirely (ADR 0005).

We take the safer setting wherever the tool offers one. Claude Code has no equivalent that lets a headless Step build, test and commit without a human. Codex does, and the **Artist** only needs to read references and write **Assets** in the worktree.

## Consequences

- An Agent on Codex cannot touch files outside its worktree. If a future Agent on Codex needs more (installing packages, a Developer on Codex), revisit this for that Agent rather than widening it for all.
- Codex writes generated images under its own home folder, not the worktree. Forgequor collects them itself, by thread, instead of relying on the Agent to copy them.
