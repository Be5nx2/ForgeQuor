# Issue tracker: Codecks

Cards, specs and planning live in **Codecks** (not GitHub issues). Access goes through the Codecks MCP server.

> TODO(user): fill in the values below once, then every skill can rely on them.

- **Organization (subdomain):** `<org>`
- **Project:** `Forgequor`
- **Spec deck (doc cards):** `Specs`
- **Work deck (task cards):** `Backlog`
- **Bugs deck:** `Bugs`

Run `get_context` and `list_decks` to discover the real names; update this file.

## Mapping from skill vocabulary

| Skill says | Codecks operation |
|---|---|
| "publish a spec to the tracker" | `create_cards` in the Specs deck with `doc: true` (doc card, holds information, no status) |
| "publish tickets" (`/to-tickets`) | `create_cards` in the Work deck, sub-cards of the spec card (`heroCard`), then `dependsOn` via `update_card` |
| "sub-issue of the parent" | `heroCard` = the spec / epic card (sub card of a hero card) |
| "blocked by" | `update_card` → `dependsOn: [codes]` |
| "triage label" | project tag, see "Triage labels" below |
| "fetch the ticket" | `get_card` with code (`$12a`), URL or id |
| "comment" | `add_comment` |
| "close / resolve" | `update_card` → `status: done` |
| "claim / start" | `update_card` → `status: started`, `assignee: me` |
| "frontier" | `search_cards` with `state: ["assigned","unassigned"]` and tag `ready-for-agent`; skip cards in state `blocked` |
| "wayfinder map" | a hero card tagged `wayfinder-map`; child tickets are its sub-cards |

Card codes look like `$12a`. Refer to cards by code in commit messages and PRs.

## Fallback

If the Codecks MCP is unavailable, use local markdown: `.scratch/<feature-slug>/spec.md` and `.scratch/<feature-slug>/cards/<NN>-<slug>.md` with `Status:` and `Blocked by:` lines.

---

## Triage labels (Codecks tags)

Canonical role → Codecks tag. Tags must exist in the Codecks project tag list before use.

| Role | Codecks tag | Meaning |
|---|---|---|
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate |
| `needs-info` | `needs-info` | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | Will not be actioned |

Category roles: `bug`, `enhancement`.
