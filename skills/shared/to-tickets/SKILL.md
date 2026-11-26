---
name: to-tickets
description: Break a plan, spec, or the current conversation into tracer-bullet tickets (a roadmap item, a Codecks card, an issue, depending on the project's tracker), each declaring what blocks it.
disable-model-invocation: true
---

# To Tickets

Break a plan, spec, or conversation into **tickets**: tracer-bullet vertical slices, each declaring the tickets that **block** it. Adapted from Matt Pocock's `to-tickets` (MIT).

**Where and how tickets are stored is project-specific.** Read `docs/agents/issue-tracker.md`; use its "publish tickets", "blocked by" and label operations. If it is missing, ask the user which tracker to use (templates in `skills/shared/trackers/`). In this skill "ticket" means whatever the tracker calls it.

## Process

1. **Gather context**: use the conversation; if given a reference (spec path, card code, URL), fetch it per the tracker's "fetch" operation.
2. **Explore the codebase** if needed. Use `GLOSSARY.md` vocabulary, respect ADRs. Look for prefactoring: make the change easy, then make the easy change.
3. **Draft vertical slices**:
   - Each slice cuts a narrow but COMPLETE path through every layer: vertical, not horizontal.
   - Each is demoable or verifiable on its own and fits one fresh context window.
   - Prefactoring first. **Wide refactors** are sequenced expand → migrate in batches → contract.
4. **Quiz the user**: numbered list with **Title**, **Blocked by**, **What it delivers**. Ask about granularity, genuine dependencies, merge/split. Iterate until approved.
5. **Publish** in dependency order (blockers first) using the tracker's operations. If the source was a spec/parent, link the tickets to it; never close or modify the parent. Apply the "ready for agent" label if the tracker defines one.

<ticket-body>

## What to build

The end-to-end behaviour this makes work, from the user's perspective, not a layer-by-layer list.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Blocked by

Only if the tracker has no native dependency: the blockers, or "None (can start immediately)".

</ticket-body>

Avoid file paths and code snippets: they go stale. Exception: a prototype snippet that encodes a decision more precisely than prose, trimmed to the decision-rich parts.
