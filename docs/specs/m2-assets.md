# M2 Assets

Roadmap: M2. Vocabulary: `GLOSSARY.md`. Decisions:
- ADR 0001: one Run, one pull request.
- ADR 0002: local-first subscription Runners.
- ADR 0005: Claude bypasses permissions.
- ADR 0006: the Codex Runner is sandboxed.

Builds on M1 (`docs/specs/m1-walking-skeleton.md`).

## Problem Statement

The human's first game needs 2D pixel-art: sprites, tiles and animations. Codex can draw them from a good prompt, but today that means opening Codex by hand and asking for each **Asset** one by one. Each time the human has to:
- re-explain the game's style;
- copy files into the right folder;
- check sizes and transparency;
- ask again for the ones that came out wrong;
- commit and open a pull request.

Nothing keeps the style consistent from one session to the next, and nothing records what was asked or why a version was rejected.

Forgequor M1 can hand a coding task to a Developer, but the human's only choices at its final **Gate** are approve or abandon. When the work is close but not right, the human has to throw it away or fix it by hand.

## Solution

**Choosing a Workflow.** When starting a **Run**, the human picks its **Workflow**: `developer`, the M1 one, or the new `assets`.

**An `assets` Run.** The human describes a list of **Asset Requests**: a sprite, a tile or an **Animation Strip**, each with a name, a description, a size and, for an animation, a frame count.

**Generation.** The **Artist**, working through the Codex **Runner**, produces them one after the other in the Run's worktree. It follows the **Project**'s **Art Direction** and its reference images.

**Asset Checks.** Forgequor validates every file against its request: PNG with transparency, exact size, right place. A failure goes back to the Artist; colours outside the palette only warn.

**The Asset Gate.** The human sees a gallery: each Asset at real size and magnified with crisp pixels, on a background colour they can change. Each Asset is approved, or rejected with its own **Feedback**. The Artist then redoes only the rejected ones, as many **Iterations** as the human wants.

**The end of an `assets` Run.** When everything is approved:
1. Forgequor commits the Assets under the Project's art folder;
2. it opens the pull request with a factual **Review Brief** it writes itself;
3. the Run is Approved.

The Asset Gate is that Run's final Gate.

**Rejecting a `developer` Run with Feedback.** The `developer` Workflow's final Gate gains a third choice: reject with Feedback. The Developer goes back to work in the same worktree with that Feedback, the Checks run again, and new commits land on the same pull request with a fresh Review Brief. The final Gate then opens again.

## User Stories

### Workflows

1. As the human, I want to pick a Run's Workflow (`developer` or `assets`) when I start it, so that one tool covers code and art.
2. As the human, I want every Run to show its Workflow in lists and in its detail, so that I know what kind of work it is.
3. As the human, I want existing Runs to keep working as `developer` Runs after the upgrade, so that nothing in flight breaks.

### Asset Requests

4. As the human, I want to describe an `assets` Run as a list of Asset Requests, so that one Run can produce a whole batch.
5. As the human, I want each Asset Request to have a name, a kind (sprite, tile or Animation Strip) and a description of what it shows, so that the Artist knows what to draw.
6. As the human, I want to pick an Asset's size among 16×16, 18×18 and 32×32, or type a custom one, so that it fits my game's grid.
7. As the human, I want the size to default to the one in the Art Direction, so that I rarely have to set it.
8. As the human, I want to give an Animation Strip its frame count, with frames of the chosen size laid side by side horizontally, so that the result drops straight into my engine.
9. As the human, I want to point an Asset Request at Assets already in the repository as style references, so that new art matches what exists.
10. As the human, I want to mark an Asset Request as replacing an existing file, so that I can redo an Asset on purpose.
10b. As the human, I want to mark an Asset Request as filling its whole square (every pixel opaque, edge to edge, like a ground tile), and leave it unmarked when the Asset may use transparency (an item, a decoration on a tile), so that the Artist knows which one I want and Feedback handles the rest.
11. As the human, I want starting a Run to be refused when an Asset Request would overwrite an existing file I did not mark for replacement, so that nothing is lost by accident.
12. As the human, I want starting a Run to be refused when two Asset Requests in it would produce the same file, so that they cannot overwrite each other.
13. As the human, I want Asset Request names turned into tidy file names, so that the repository stays consistent.
14. As the human, I want the optional tracker reference and the title on `assets` Runs too, so that they read like any other Run.

### Art Direction

15. As the human, I want each Project to have an Art Direction document at a path I can change (default `docs/ART_DIRECTION.md`), so that the style lives with the game.
16. As the human, I want an `assets` Run to stop at once with an Escalation when the Art Direction is missing, so that no Quota is spent on art without a style.
17. As the human, I want the reference images named in the Art Direction always given to the Artist, so that every Asset follows the same look.
18. As the human, I want an Art Direction without reference images to work just as well, so that references stay optional.
19. As the human, I want the palette listed in the Art Direction to be used to warn me about off-palette colours, so that I spot drift early.

### The Artist and the Codex Runner

20. As the human, I want the Artist to work through Codex on my own subscription, so that art does not need an extra account or key.
21. As the human, I want the Artist to run in Codex's sandbox, writing only inside the Run's worktree, so that art generation cannot touch anything else on my machine (ADR 0006).
22. As the human, I want the Artist to handle the Asset Requests one at a time, so that a batch does not burn through the Quota at once.
23. As the human, I want each Asset written by the Artist at its exact target path in the worktree, and Forgequor to validate that file, so that what I review is exactly what gets committed.
24. As the human, I want an Asset Request for which nothing was written at its target path to be tried once more, then to open an Escalation with the Artist's last message, so that I know what went wrong.
25. As the human, I want an exhausted Codex Quota to pause the Run when Forgequor can tell, and resume it later as in M1, so that a limit is not treated as a failure.
26. As the human, I want to follow the Artist's progress live, Asset by Asset, so that I see how far the batch is.
27. As the human, I want to choose the model Codex uses for the Artist through a setting, like the Developer's, so that I can trade quality for Quota.
28. As the human, I want startup to tell me when `codex` is missing or not logged in, so that I fix it before starting an `assets` Run.

### Asset Checks

29. As the human, I want each Asset checked to be a PNG with transparency, so that it works in my engine as is.
30. As the human, I want each Asset checked to have exactly the requested size (frame size × frame count for an Animation Strip), so that it fits the grid.
30b. As the human, I want an Asset marked as filling its whole square to fail the checks when any pixel is transparent, so that it goes back to the Artist before I see it.
31. As the human, I want each Asset checked to be where its Asset Request says, so that the repository layout stays clean.
32. As the human, I want an Asset that fails these checks sent back to the Artist with the reason, up to twice, then escalated, so that broken files never reach me at the Asset Gate.
33. As the human, I want colours outside the Art Direction's palette shown as a warning on that Asset, not a failure, so that I decide whether it matters.

### The Asset Gate

34. As the human, I want one Asset Gate per Iteration showing every Asset waiting for my decision, so that I review a batch in one place.
35. As the human, I want each Asset shown at its real size and magnified with crisp, unblurred pixels, so that I judge pixel art properly.
36. As the human, I want an Animation Strip shown as its strip and its frame count, so that I can check every frame.
37. As the human, I want a tool beside the preview to change the background colour, defaulting to the UI's grey, so that I can check transparency and contrast against any backdrop.
38. As the human, I want to approve or reject each Asset separately, with its own Feedback when rejected, so that good work is kept and only the bad is redone.
39. As the human, I want the Artist to redo only the rejected Assets, with my Feedback and the rejected version as context, so that each Iteration converges.
40. As the human, I want no limit on how many Iterations I ask for, so that I stop when the art is right.
41. As the human, I want the Asset Gate to show any palette warnings and past Feedback for each Asset, so that I remember why it changed.
42. As the human, I want to abandon the Run from the Asset Gate, so that I can drop a batch.

### Ending an `assets` Run

43. As the human, I want all approved Assets committed in one commit under the Project's art folder, with one folder per kind (sprites, tiles, animations), so that the history stays clean.
44. As the human, I want the art folder to default to `assets/art` and be changeable per Project, so that I can move it later.
45. As the human, I want the pull request opened as soon as every Asset is approved, so that I can merge the art.
46. As the human, I want the Review Brief for an `assets` Run written by Forgequor, listing each Asset's path, kind, size, frame count, palette warnings and the Feedback that led to it, so that the PR explains itself without spending Quota.
47. As the human, I want an `assets` Run to become Approved once its pull request is open, with no second Gate, so that I do not approve the same art twice.
48. As the human, I want `assets` Runs to skip the Project's setup commands and Checks, so that art is not held up by code tooling.
49. As the human, I want `assets` Runs to take a Project slot like any other Run, so that the concurrency limit still protects my Quota.

### Rejecting a `developer` Run with Feedback

50. As the human, I want a third choice at a `developer` Run's final Gate, reject with Feedback, so that I can ask for changes instead of abandoning.
51. As the human, I want rejecting to require a written Feedback, so that the Developer knows what to change.
52. As the human, I want the Developer to go back to work in the same worktree and branch with my Feedback, so that it builds on what it did.
53. As the human, I want the Checks to run again after the Developer's new work, with the usual retries, so that the reworked change is still valid.
54. As the human, I want the new commits pushed to the same pull request and a new Review Brief comment posted, so that the PR's history tells the whole story.
55. As the human, I want the final Gate to open again afterwards, so that I decide again.
56. As the human, I want every round counted as an Iteration and visible in the Run's detail, so that I see how much back-and-forth a change took.
57. As the human, I want an Escalation to stay abandon-only, so that only real decisions offer rework.

## Implementation Decisions

### Prefactoring

- **Extract the M1 Workflow first.** The Forge core today mixes the Run lifecycle (slots, queue, Pause, restart, Gates, pull-request follow-up) with the M1 sequence of Steps. Before M2 adds anything, that sequence moves behind a small internal Workflow interface.
  - Each Workflow (`developer`, `assets`) owns its sequence of Steps, Iterations and Gate handling.
  - The core keeps the lifecycle.
  - Behaviour is unchanged and every existing test stays green.
- **Workflows stay in code.** The two Workflows are code, not data. YAML definitions replace them in M3.

### Forge core interface

- **Starting a Run.**
  - A Run gains a Workflow name. Existing Runs are `developer` Runs.
  - For `assets`, the input carries the Asset Requests instead of a free-text task. Each one has a name, a kind, a description, a size (width and height), a frame count for an Animation Strip, reference paths, a replace flag, and a fill flag (the Asset fills its whole square, fully opaque; off by default, for any kind).
  - Starting a Run validates everything up front and refuses with a clear error on any of these:
    - a missing field or a size below 1;
    - an existing file without the replace flag;
    - two Asset Requests producing the same file;
    - a reference that does not exist.
- **Gate decisions.**
  - The final Gate of a `developer` Run accepts approve, abandon, or reject with a non-empty Feedback.
  - The Asset Gate accepts abandon, or a verdict for **every** pending Asset at once: approve, or reject with a non-empty Feedback. A partial set of verdicts is refused.
  - An Escalation stays abandon-only.
- **Project settings.** A Project gains two settings, with setters like its Checks: the Art Direction path (default `docs/ART_DIRECTION.md`) and the art folder (default `assets/art`).
- **Reading a Run.** It exposes its Workflow, its current Iteration and, for `assets`, its Assets. Each Asset carries its request, status, current version, Asset Check results, palette warnings and Feedback history.

### The `assets` Workflow

**Sequence:**
1. Read the Art Direction from the fresh worktree. If it is missing, open an Escalation and stop.
2. For each Asset Request still pending, in order, run one Artist Step, giving it the Asset's exact target path. The Artist writes the final Asset there itself (the image tool's raw output is far larger, so Codex scales it down to the requested size). Forgequor then runs the Asset Checks on that file and keeps the Runner's raw images in the Run Notes as a trace.
   - When the Checks fail, the Artist redoes it with the failure, up to 2 extra attempts. After that, an Escalation opens.
   - When nothing is written at the target path, the Artist gets one more try. After that, an Escalation opens with the Artist's last message.
3. Open the Asset Gate.
4. If anything is rejected, start a new Iteration on the rejected Assets only, each with its Feedback and its rejected version as a reference, and go back to step 2.
5. When everything is approved:
   - commit all Assets in one commit, `feat(art): add <n> assets`;
   - push and open the pull request;
   - post the Review Brief;
   - move the Run to Approved.

**What it skips:** the Project's setup commands and Checks.

**The target path:** the art folder, then a kind subfolder (`sprites`, `tiles` or `animations`), then the request name in kebab-case with `.png`.

**The Art Direction contract,** documented in the README:
- the palette is every `#RRGGBB` code listed under a "Palette" heading;
- the default size is a `Default size: WxH` line;
- the reference images are repository paths to image files mentioned in the document.

None of these is required. Without a palette, the palette warning is skipped. Without a default size, the form asks for a size.

**The Artist's instructions** live in Forgequor, like the Developer's. They tell it to:
- follow the Art Direction;
- use Codex's image tool for exactly one Asset;
- save the final Asset at the exact target path it is given, and nowhere else in the worktree;
- deliver pixel art at the exact size, scaling the raw image down itself when needed;
- when the Asset Request has the fill flag, fill the whole square edge to edge with no transparent pixel; otherwise use a transparent background wherever the Asset does not need to cover it;
- for an Animation Strip, lay the frames side by side.

**The Review Brief** is generated by Forgequor from what it stored. No Agent is involved.

### Asset Checks

- **What they are.** A small deep module: given an image file and its Asset Request, it returns failures and warnings.
- **Failures:**
  - not a readable PNG;
  - no alpha channel;
  - wrong width or height (frame width × frame count for an Animation Strip);
  - not at the expected path;
  - any transparent pixel in an Asset whose Asset Request has the fill flag.
- **Warning:** colours outside the Art Direction palette. Only opaque pixels are checked, and the warning reports the count and up to a few sample colours.
- **Decoding** uses a small pure-JavaScript PNG library added as a dependency. No native modules.

### The Codex Runner

**How it runs Codex.**
- It is a second adapter behind the existing Runner seam. It drives `codex exec` with JSON output:
  - in the Run's worktree;
  - in the workspace-write sandbox;
  - with approval prompts off (ADR 0006);
  - with the Agent's instructions passed as developer instructions;
  - with the configured model;
  - as one fresh session per Step.
- It runs in its own process group and is cancellable exactly like the Claude Runner (m1-08).

**The Runner interface.** A succeeded result can carry generated files, as absolute paths in creation order. The Claude Runner returns none.

**Collecting images.**
- The adapter reads the thread id from the event stream.
- After the Step, it collects the images Codex wrote under its home folder for that thread: the image tool's raw output, typically 1254×1254.
- These raw images are a trace, not the Asset. Forgequor keeps them in the Run Notes (useful as a reference for a later Iteration). The Asset is the file the Artist wrote at its target path.

**Progress.** Image generation does not appear in Codex's event stream. The adapter reports progress from the events that do appear, plus one event per collected image.

**Quota detection is best effort.**
- A turn failure saying the usage limit was hit, with a retry time, becomes Quota exhausted with that reset time.
- An image-only limit reaches the model as a tool failure. It is recognised from the final message when that message mentions a usage limit, and becomes Quota exhausted without a reset time.
- Anything else is a failure.

**Settings and startup.**
- A model setting for the Artist, mirroring the Developer's.
- `CODEX_HOME` is honoured.
- Preflight gains `codex`: installed and logged in.

### Rejecting a `developer` Run with Feedback

When the human rejects, the Run starts a new Iteration:
1. The Developer runs in the same worktree. Its prompt holds the task and the Feedback, and the history of earlier Feedback.
2. The Checks loop runs as in M1. Its retry budget restarts for each Iteration.
3. Forgequor pushes to the same branch, so the pull request updates.
4. A new Review Brief comment is posted.
5. The final Gate opens again.

Iterations have no limit. The Run detail lists them.

### Data (indicative)

- **Run:** its Workflow name and current Iteration number.
- **Project:** the Art Direction path and the art folder.
- **Asset:**
  - the Run;
  - the request fields;
  - its order;
  - a status: pending, generating, waiting for its verdict, approved or rejected;
  - its target path.
- **Asset version:**
  - the Asset;
  - its Iteration and attempt;
  - where the raw image is kept in the Run Notes;
  - the Asset Check failures and palette warnings;
  - the Feedback it received.
- **Step attempts and Gates** record the Iteration they belong to.
- **Gate kinds:** final, Escalation and asset.

### HTTP and UI

- **Routes.** New routes mirror the new Forge core operations:
  - start a Run with a Workflow and Asset Requests;
  - set the Art Direction path and the art folder;
  - decide with reject and Feedback;
  - decide an Asset Gate with per-Asset verdicts.
- **The image route.** One route serves a Run's Asset image by Asset (and version) id.
  - It resolves the file only from what the Forge core recorded for that Run.
  - It never takes a path from the request.
  - It serves only PNGs inside that Run's worktree or Run Notes.
- **The Run form** gains a Workflow picker. For `assets`, it shows an editable list of Asset Requests instead of the task field. It includes the size presets, a custom size, frames for an Animation Strip, references picked from the repository's existing PNGs, and a replace toggle.
- **The Asset Gate view** shows a gallery:
  - each Asset at 1× and magnified with nearest-neighbour rendering;
  - a background colour tool beside the preview, defaulting to the UI grey and not saved per Project;
  - per-Asset approve, or reject with a Feedback field;
  - one submit for the whole batch, plus abandon.
- **The final Gate of a `developer` Run** gains reject with a Feedback field.

## Testing Decisions

**What a good test is.** As in M1: drive behaviour through a public interface and assert what the human would see. That means Run states, Gates, Assets and their verdicts, files in the worktree, commits, pull requests and comments. Never assert internal calls. Expected values come from this spec. Test images are built in the test with the same PNG library, from literal pixel data.

### Seam 1, the Forge core (primary)

Real git and PostgreSQL, a fake code host, the fake Developer, and a new fake Artist Runner. The fake Artist writes, on demand:
- a valid PNG;
- a wrong-size one;
- one without alpha;
- an off-palette one;
- nothing at all;
- Quota exhaustion.

It covers:
- the `assets` sequence end to end;
- launch-time validation;
- a missing Art Direction;
- Asset Check retries and Escalation;
- the no-image retry;
- per-Asset verdicts, and redoing only the rejected Assets;
- the single commit and pull request;
- the factual Review Brief;
- Approved without a second Gate;
- skipped setup and Checks;
- slot use;
- Pause and resume;
- the `developer` reject-with-Feedback Iteration: same worktree, Checks, same PR, new Review Brief, Gate reopened, Iteration count.

After the prefactoring, all existing Forge core tests must still pass unchanged.

### Seam 2, the Runner contract

The Codex adapter is tested against a fake `codex` executable placed first on the PATH, with a temporary `CODEX_HOME`. The fake replays recorded JSON event streams and drops PNGs under `generated_images/<thread>/`.

Cases:
- success with an image;
- success without one;
- a turn failure on the usage limit, with a retry time;
- a final message reporting an image limit;
- unreadable output;
- a crash;
- cancellation, which kills the process group;
- instructions and model passed through.

The Claude adapter's suite keeps passing, and gains the "no generated files" expectation.

### Seam 3, the image route (HTTP)

It serves a Run's Asset image by id. It returns not-found for another Run's Asset, an unknown id, or anything not recorded. It cannot be made to read an arbitrary path. The prior art is the live-events HTTP test from m1-09.

### Opt-in smoke test

`npm run smoke:codex` generates one real 16×16 sprite through the real `codex`, then runs the Asset Checks on it. It is off by default and uses a little image Quota.

### Not tested

The Vue gallery, the background colour tool and the Run form stay thin by design.

## Out of Scope

- **Chaining Workflows.** Artist, then Asset Gate, then Developer in one Run, with Asset Requests produced by a Griller from spec grilling (M3).
- **YAML Workflows,** Workflow-specific Checks, and any other Agent (M3).
- **Tileset atlases.** One image per tile only. Atlases are in the Icebox.
- **Producing a Run's Asset Requests in parallel** (Icebox).
- **Post-processing images.** Forgequor validates; it never resizes, recolours or repairs an image.
- **Engine-specific import files** (for example Godot `.import`). They are the engine's or the Developer's concern.
- **Quota gauges** for Codex or images (M4).
- **Per-Project overrides of the Artist's instructions** (Skill Packs, M4).
- **Reading GitHub comments as Feedback** (Icebox).

## Further Notes

- Image generation uses the ChatGPT plan's limits 3 to 5 times faster than text. There may also be a separate image cap; that is reported but not officially confirmed. Sequential Asset Requests and the concurrency limit are the M2 answer. Watch real usage on the first game.
- Codex's image tool writes a raw, much larger image under Codex's home folder; Codex then scales it down and saves the Asset in the worktree itself. The real smoke run on 2026-11-26 showed this: a 1254×1254 raw image and a clean 16×16 sprite written by the Agent. So the Asset is the file at the target path; the raw images are only a trace.
- The human has had Codex produce exact-size pixel art and Animation Strips directly. M2 builds on that premise, and the Asset Checks catch the times it does not hold.
- After merge, the engine may generate import files next to new Assets. Leave them to the next `developer` Run.
