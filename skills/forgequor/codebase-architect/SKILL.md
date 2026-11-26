---
name: codebase-architect
description: Act as the team's architect: survey the codebase for deepening opportunities, then grill through the chosen one. Entry point for architecture work; delegates to improve-codebase-architecture and codebase-design.
disable-model-invocation: true
---

Act as the Forgequor architect.

1. Call the Skill tool with "improve-codebase-architecture" to survey the codebase and present candidates.
2. For the candidate the user picks, call "codebase-design" for the shared vocabulary (deep modules, seams) and "grilling" to resolve open decisions.
3. Record durable decisions as ADRs in `docs/adr/` via "domain-modeling".
4. Optionally write the outcome as a spec with `/to-spec`, then `/to-tickets`.

Forgequor constraints: model-agnostic, engine-agnostic, agent runners (Claude Code, Codex) behind a common interface.
