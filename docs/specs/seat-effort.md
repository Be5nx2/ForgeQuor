# Effort per Seat

Source: Dogfood Note #2 ("Team : il faut pouvoir décider de quel effort on veut mettre, et ça existe sur les 2 (Claude et Codex)"), grilled on 2026-11-28. Vocabulary: `GLOSSARY.md`. Builds on the Seats of `docs/specs/m3b-the-team.md` and the per-Run overrides of `docs/specs/m4-comfort.md`.

## Problem Statement

Each **Seat** sets a **Runner** and a model, but not how hard the model thinks. Claude Code and Codex both take an effort level, and the right one differs per **Agent**: a Griller or a Consolidator gains from deep reasoning, a Developer on a small ticket burns **Quota** for nothing at the highest level. Today the only control is outside Forgequor (Codex's own config file, Claude Code's own default), the same for every Seat and invisible in the app.

The Team page also offers Codex model aliases written into Forgequor by hand, and they are already out of date: the models the installed Codex actually serves are different.

## Solution

Each Seat gains a third setting, **effort**, next to its Runner and model, set the same way: an environment variable `FORGEQUOR_<SEAT>_EFFORT`, the Team page, or the Seats section of New Run for one Run, in that order of precedence. An environment-held effort is locked in the UI, like a model.

The effort is always picked from a closed list, never typed. The list is the Runner's own levels, with no translation between vendors: Claude Code's `--effort` levels, and Codex's reasoning efforts for the chosen model. Left empty, the Seat passes nothing and the Runner applies its own default; the UI reads "Runner default".

Forgequor learns the levels from the CLIs once, at startup: Codex answers `model/list` through `codex app-server` (each model with its reasoning efforts and its default), Claude Code lists its levels in `claude --help`. If a reading fails, a built-in list is used and the Team page says so. The same Codex answer replaces the hand-written Codex model aliases.

A Step records the effort it ran with, and the Run detail shows it next to the Runner and model.

## User Stories

### Setting the effort

1. As the human, I want to set an effort level on each Seat of the Team page, so that every Agent thinks as hard as its role deserves.
2. As the human, I want to pick the effort from a list, never type it, so that a typo cannot break a Step later.
3. As the human, I want the list to show only the levels the Seat's Runner accepts, so that I never pick a level the CLI would refuse.
4. As the human, I want Codex's list to follow the Seat's model, so that I only see the efforts that model supports.
5. As the human, I want a Seat with no model set to offer the levels of the Runner's default model, so that the choice still matches what will run.
6. As the human, I want to leave the effort empty to keep the Runner's own default, shown as "Runner default", so that I only set it where it matters.
7. As the human, I want to clear an effort I set, so that the Seat goes back to the Runner's default.
8. As the human, I want the Team page to show where each effort comes from (environment, Team, default), so that I know why a Seat behaves as it does.
9. As the human, I want an effort set by `FORGEQUOR_<SEAT>_EFFORT` to be locked in the UI with the variable named, so that I know where to change it.
10. As the human, I want the environment to win over the Team page, as for the Runner and the model, so that one rule covers every Seat setting.

### Keeping settings coherent

11. As the human, I want changing a Seat's Runner to be refused when its effort does not exist for the new Runner, with a clear message, so that a Seat is never left in a state that cannot run.
12. As the human, I want changing a Seat's Codex model to be refused when its effort does not exist for the new model, with a clear message, so that the same rule holds for models.
13. As the human, I want the server to refuse an unknown or mismatched effort even when the UI is bypassed, so that the stored settings are always valid.
14. As the human, I want Forgequor to refuse to start when `FORGEQUOR_<SEAT>_EFFORT` holds a level the Seat's Runner does not accept, naming the variable and the accepted levels, so that I fix it before any Run, not halfway through one.

### One Run's effort

15. As the human, I want the Seats section of New Run to offer the effort next to the Runner and model, so that one Run can think harder or lighter than the Team without changing the Team.
16. As the human, I want that effort to come from the same closed list with the same rules, so that a Run cannot be launched with a combination that fails.
17. As the human, I want an environment-locked effort to stay locked in New Run, so that the environment always wins.
18. As the human, I want a Run's effort frozen with its other Seat settings when it starts, so that changing the Team later does not change a Run already going.

### Seeing what ran

19. As the human, I want each Step attempt to record the effort it ran with, so that I can tell afterwards why a Step was slow, costly or shallow.
20. As the human, I want the Run detail to show the effort next to the Runner and model, in the Step rail and in "Seats used", so that I read it where I already read the model.
21. As the human, I want a Step that ran with the Runner's default to say so, so that "no effort set" is never mistaken for a missing value.
22. As the human, I want older Step attempts, recorded before this feature, to show nothing rather than a wrong value, so that the history stays honest.

### Where the levels come from

23. As the human, I want Forgequor to read Codex's models and their efforts from the installed Codex at startup, so that the lists match my Codex version.
24. As the human, I want Forgequor to read Claude Code's effort levels from the installed CLI at startup, so that a new level appears without a Forgequor release.
25. As the human, I want that reading to cost no Quota, so that starting Forgequor is free.
26. As the human, I want a failed reading to fall back to a built-in list, with the Team page saying the list is the built-in one, so that I can still work and know the list may be stale.
27. As the human, I want the levels read only at startup, so that nothing changes under me while I work; after updating a CLI, I restart Forgequor.
28. As the human, I want the Team page's Codex model suggestions to come from the same reading, so that I am offered the models my Codex really serves.
29. As the human, I want the model field to stay free text, so that I can still use an identifier the list does not have.

### What does not change

30. As the human, I want the Quota readings (`/usage`, `codex app-server` rate limits) untouched by the effort, since they call no model.
31. As the human, I want a Seat with no effort to run exactly as it does today, so that this feature changes nothing until I use it.

## Implementation Decisions

- **Seat setting.** The Seat setting gains an optional `effort` beside `runner` and `model`, everywhere the two travel: the environment reading (`FORGEQUOR_<SEAT>_EFFORT`, empty means unset), the saved Team (a new nullable effort column on the Team's Seat table, through a migration), the per-Run overrides and the frozen Seats of a Run (both JSON, no migration), and the built Agent Seat handed to Steps. Precedence and locking reuse the existing per-field rule (environment, then Team, then default); the default effort is null.
- **Runner Catalog (new module).** A deep module that answers, for each Runner, the models it offers and the effort levels a given model (or the Runner's default model) accepts, plus whether its answer came from the CLI or the built-in fallback. It is read once at startup and kept in memory; no refresh while Forgequor runs.
  - Codex: `codex app-server`, `initialize`, `initialized`, then `model/list`. Each model gives `supportedReasoningEfforts` and `defaultReasoningEffort`; the model marked `isDefault` is the one used when a Seat sets no model. Hidden models are skipped. Same process handling as the Quota reading (timeout, process group always killed).
  - Claude Code: the `--effort` line of `claude --help` gives the levels; they do not depend on the model.
  - Fallback per Runner when the reading fails or parses to nothing: Claude `low, medium, high, xhigh, max`; Codex `low, medium, high, xhigh, max, ultra` with no model list beyond what the Team already accepts. The failure is logged once.
  - An identifier typed as a Codex model that the Catalog does not know gets the default model's levels.
- **Validation.** One rule, used by the Team change, the per-Run overrides and the startup check: an effort is valid when it is in the Catalog's levels for the Seat's effective Runner and model. A Team or override change that would leave an invalid combination (new effort, new Runner, new model) is an invalid-input error naming the accepted levels (400). An environment-held effort is locked (409), as today for the other fields.
- **Startup check.** After the Catalog is read and before the server listens, each environment-held effort is checked against its Seat's effective Runner and model; any failure stops Forgequor with a message naming the variable and the accepted levels. Invalid environment Runners keep today's behaviour (an Escalation when a Step needs the Seat); aligning them is out of scope.
- **Runner request.** The Step request gains an optional effort. Claude Code adds `--effort <level>`; Codex adds `-c model_reasoning_effort="<level>"`. No effort, no option: the CLI's own default (and Codex's config file) applies.
- **Step records.** Step attempts gain a nullable effort column, written when the attempt starts, like the model. Attempts recorded before the migration read null.
- **Team API.** `GET /api/team` gives each Seat's effort as an effective field (value, source, locking variable) and replaces the hand-written model aliases with the Catalog: per Runner, the models offered, the default model, the effort levels per model, and whether the list is the built-in fallback. `PUT /api/team/:seat` accepts `effort` (null or empty clears it). `POST /api/runs` accepts `effort` in each Seat override.
- **Front.** The Team page and New Run's Seats section gain an effort select per Seat: "Runner default" first, then the levels for the Seat's current Runner and model, recomputed when either changes; a selected level that no longer fits is shown as invalid and blocks Save or Launch rather than being silently dropped. The fallback is flagged on the Team page. The Run detail shows the effort after the model ("claude · opus · high"; nothing added when the default ran) in the Step rail and in "Seats used", which groups by Runner, model and effort.
- **Glossary.** Add **Effort** (a Seat's setting for how hard its Runner's model reasons, from the Runner's own levels) and extend **Seat** to mention it; add **Runner Catalog**.

## Testing Decisions

- Test external behaviour through the highest seam; no test reaches into the Catalog's parsing or the arg arrays' order beyond what the CLI receives.
- **Forge and HTTP** (prior art: the Team and run-seats tests on the real database): effort set, cleared and reported with its source; environment lock; refusal of an unknown level, of a Runner or model change that strands the effort, and of a bad override; the effort frozen into a Run at start and recorded on each attempt; the Team answer carries the Catalog.
- **Runners** (prior art: the Claude and Codex Runner tests with the fake CLI): an effort reaches the CLI as its own option; no effort adds no option.
- **Runner Catalog** (prior art: the Codex Quota tests' fake `app-server`): a recorded `model/list` answer gives the models, levels and default model; a fake `claude --help` gives Claude's levels; a failing, slow or garbled CLI gives the fallback flagged as such; one real reading of each in the opt-in smoke tests.
- **Startup check**: a pure function from environment settings and Catalog to "fine" or the list of faults, tested directly; `main` only acts on its answer.
- **Front**: the effort list per Seat and the invalid-selection rule live in a tested logic module shared by Team and New Run; `runDetail.ts` tests cover the effort in the rail label and the "Seats used" grouping. Checked in a browser on the BA database.
- **BA**: the Team acceptance test sets an effort and sees it on the next Step attempt.

## Out of Scope

- A common effort scale translated between Claude and Codex.
- Refreshing the Catalog while Forgequor runs; a restart is needed after a CLI update.
- A default effort chosen by Forgequor per Agent; empty always means the Runner's default.
- Effort per Step or per Workflow; the Seat (and a Run's override) is the only place.
- Validating environment Runners or models at startup.
- A Claude model list read from the CLI (none exists); Claude's aliases stay as they are.
- Codex's other per-model options (speed tiers, service tiers, personality).

## Further Notes

- Facts checked on 2026-11-28 with Claude Code's `--help` (levels `low, medium, high, xhigh, max`) and `codex-cli 0.163.0`, whose `model/list` returned `gpt-6.1-terra` (default, default effort `low`), `gpt-6.1-sol` and `gpt-6-astra`, each with `low, medium, high, xhigh, max, ultra`. The Team page's current Codex aliases do not match.
- The human's `~/.codex/config.toml` sets `model_reasoning_effort = "high"`; a Seat with an effort overrides it for that Step only.
