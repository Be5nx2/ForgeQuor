# Tracking: local files

Forgequor is tracked with plain files, no external tracker.

- `ROADMAP.md`: what is planned, in progress, done. One section per spec; items are checkboxes with IDs and `Blocked by`.
- `CHANGELOG.md`: what shipped ([Keep a Changelog](https://keepachangelog.com) format, `Unreleased` on top).
- `docs/specs/<slug>.md`: one spec per feature (written by `/to-spec`). Items in the roadmap link to it.
- `docs/adr/`: decisions. `GLOSSARY.md`: vocabulary.

## Skill vocabulary mapping

| Skill says | Do |
|---|---|
| publish a spec | write `docs/specs/<slug>.md`, add a line in ROADMAP |
| publish tickets | `/to-tickets`: items under the spec's section in ROADMAP, format below |
| fetch the ticket | read the item by ID in ROADMAP + its spec |
| resolve / close | tick the checkbox, add a CHANGELOG line under `Unreleased` |
| blocked by | `Blocked by:` line on the item |
| triage labels | not used here: unchecked item = open; move to `## Icebox` to park |

## Roadmap item format

```
- [ ] `<slug>-01` **Title**: end-to-end behaviour this makes work.
  - Spec: `docs/specs/<slug>.md`
  - Blocked by: none | `<slug>-00`
  - Acceptance: criterion; criterion
```

Frontier = unchecked items whose blockers are all checked. Resolving also adds a line under `Unreleased` in `CHANGELOG.md`.

Other trackers (Codecks for game projects): templates in `skills/shared/trackers/`.
