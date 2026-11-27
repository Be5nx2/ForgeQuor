# UI refresh

Status: **mockups approved (direction B, cinematic)**; in `ROADMAP.md` as "UI refresh", tickets to be cut with `/to-tickets` when scheduled. Implementation is planned after M4 (with the Dogfood work), not before. M3b screens are built on the current UI until then.

Vocabulary: `GLOSSARY.md`. Brand: `docs/BRAND_IDENTITY.md`. Decisions below come from a grilling session.

## Decisions

**Goal and scope**
- Find what the human likes; no deadline before M4.
- Scope: information architecture first, then an incremental restyle of the existing Vue code (about 1,000 lines). No rewrite, no new component library.
- Users: the human today, a few colleagues later. No accounts. **Desktop only.**
- Main uses: launch a Run, watch it, review its result.

**Structure**
- Home is the **Runs** list. "Waiting for you" (open Gates, then the merge list) is pinned at its top. "New Run" is a permanent button.
- Left sidebar: Runs, Projects, and (greyed in the mockups only) Team, Workflows, Quotas, Skill Packs, Dogfood Inbox. A Project selector sets the context that filters everything. A global "+ Note" button. A count of open Gates on Runs.
- `vue-router`: every Run, Gate and Project has a URL (`/runs/:id`), so links can be shared and a refresh keeps its place.
- **Run detail**: Steps on the left (state, Iteration, Runner), selected Step on the right. The Gate actions stay fixed at the top while a Gate is open.
- One shared live-events stream and the Gate count in the sidebar are in scope. Fine-grained updates (patching instead of reloading) stay in the backlog.

**Design system**
- Dark theme only. The brand palette is a set of CSS variables (`tokens.css`); a light theme stays possible later.
- The brand is an accent, not decoration: blue for AI work, orange for "a human is needed", Orbitron for the logotype and a few titles, Inter for text, JetBrains Mono for logs.
- **Status system.** The only colours outside the brand palette: a desaturated green (done, passed) and red (failed, changes requested), used for results only. Every status carries a glyph and a label as well as a colour: running (blue ●), waiting for you (orange ●), done (green ✓), failed (red ✕), idle (grey ○).
- Three shared states on every screen: empty (with the next step), loading, error (with Retry).
- Accessibility floor: `role="tab"` and `aria-current` on navigation, `:focus-visible`, `aria-live` on the live log, checked contrast.
- Logotype in text with a placeholder mark; the emblem is a separate task (nothing exists in `assets/branding/` yet).

## Mockups

Static HTML and CSS, no build, open them in a browser. They share `tokens.css` (the future design system, copied as is into `web/`). Fonts load from Google Fonts and fall back to system fonts offline.

Round 1, the same screen in three directions: the Run detail of a `feature` Run waiting at a review Gate (duo review, Consolidator disagreement), chosen because it exercises the Step rail, the fixed Gate actions, Runner chips, remarks and live events.

| File | Direction |
|---|---|
| `run-detail-a-dense.html` | A. Sober and dense, like a CI tool: flat, 1 px borders, table of remarks |
| `run-detail-b-cinematic.html` | B. Cinematic: blue and orange lighting, glowing Step rail, Orbitron titles |
| `run-detail-c-cards.html` | C. Airy cards: large type, rounded cards, one idea per card |

**Chosen: B.** A and C stay as round-1 reference only.

Round 2, all in direction B on the shared `shell.css` (sidebar, panels, Gate bar, Step rail, chips, forms, states). The sidebar is repeated in each file; in Vue it becomes one layout component.

| File | Screen |
|---|---|
| `runs.html` | Home: "Waiting for you" cards (Gates), "Waiting for your merge", filterable list of all Runs with every lifecycle state |
| `new-run.html` | New Run: Workflow choice, subject, solo/duo review, preview of the Steps and the Gates that will need the human |
| `projects.html` | Projects: list, Checks, Setup, slots, Art Direction, and the system warning banner (missing tool) |
| `run-detail.html` | Run detail at a review disagreement Gate (round-1 screen, now on the shared shell) |
| `run-gate-conversation.html` | Conversation Gate: chat with the Griller, rounds of questions with recommended answers, answer box, "Confirm summary" |
| `run-gate-spec.html` | Spec Gate: spec rendered, approve or reject with Feedback |
| `run-gate-assets.html` | Asset Gate: gallery at real size and magnified, Asset Checks, Feedback per rejected Asset, version history |
| `states.html` | Shared loading, empty (no Project, nothing waiting) and error components |

Every Gate screen uses the same pattern: the Gate bar stays fixed at the top with the actions, and the Step rail shows where the Run stands.

## Out of scope

Mobile or responsive layouts, a light theme, accounts and permissions, the emblem artwork, fine-grained live updates, the visual Workflow editor.

## Open

- Cut the implementation tickets (`/to-tickets`) when the work is scheduled, after M4.
- The `CHANGELOG.md` line is added by the pull request that implements it, not by this spec.
