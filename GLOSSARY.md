# Forgequor

Forgequor orchestrates a team of AI **Agents** that design, build and review changes to game projects, with a human supervising at chosen points.

## Work

**Project**:
A git repository Forgequor works on, usually a game, possibly Forgequor itself.
_Avoid_: Repo, target, workspace

**Workflow**:
A reusable, versioned definition of the graph of **Steps** (sequential or in parallel) that turns a task into a reviewed change.
_Avoid_: Pipeline, process, template

**Run**:
One execution of a **Workflow** on one task of a **Project**, isolated in its own worktree, branch and pull request.
_Avoid_: Job, execution, pipeline run

**Step**:
One stage of a **Workflow**, performed either by an **Agent** or by the human at a **Gate**.
_Avoid_: Stage, phase, task

**Gate**:
A **Step** where the **Run** waits for the human, who answers, approves or rejects before it continues.
_Avoid_: Checkpoint, approval, human-in-the-loop

**Escalation**:
A **Gate** a **Run** opens on its own when it cannot go on (iteration limit reached, **Runner** failure, **Check** failing repeatedly), stating why.
_Avoid_: Error, alert, failure

**Feedback**:
The human's written reason for rejecting a **Gate**, or one **Asset** at an **Asset Gate**, handed to the **Step** the **Run** goes back to.
_Avoid_: Comment, review notes

**Deliverable**:
Anything a **Run** commits into its pull request: code, assets, the spec, the **Project**'s own ADRs.
_Avoid_: Output, artefact, result

**Run Notes**:
The working files **Agents** leave for each other during a **Run** (grilling transcript, asset prompts, inter-Step reviews); never committed, kept in the **Run**'s **Archive**.
_Avoid_: Agent files, scratch files, handoff files

**Check**:
A command a **Project** declares to validate a **Run**'s **Deliverables** automatically; a **Run** cannot reach its final **Gate** while a **Check** fails.
_Avoid_: Test, CI, validation

**Setup**:
A command a **Project** declares to prepare a **Run**'s new worktree (installing dependencies, linking skills) before the **Developer** starts; a failing one opens an **Escalation** and the **Developer** never starts.
_Avoid_: Bootstrap, install step, init

**Review Brief**:
The comment a **Run** posts on its pull request for the final **Gate**: what the change does, where to look closely, and what to test.
_Avoid_: PR summary, PR description, review comment

**Archive**:
What remains of a **Run** once its pull request is merged or closed, or the **Run** is abandoned: its **Run Notes** and metadata, kept for a limited time.
_Avoid_: Backup, snapshot

**Iteration**:
One pass through the produce → review loop within a **Run**; a **Run** may take several before its final **Gate**.
_Avoid_: Retry, attempt, cycle

## Run lifecycle

A **Run** moves Queued → Running ⇄ Waiting / Paused → Approved → Merged, Closed or Abandoned → Archived. An Approved **Run** goes back to Running when asked to rebase.

**Queued**: created, waiting for a free slot on its **Project**.

**Running**: an **Agent** is performing one of its **Steps**.

**Waiting**: stopped at a **Gate** until the human answers.

**Paused**: stopped because a **Runner**'s **Quota** is exhausted; resumes on its own when the window reopens.

**Approved**: final **Gate** accepted; its pull request awaits the human's merge.

**Merged** / **Closed**: its pull request was merged, or closed without merging.

**Abandoned**: stopped for good by the human before its pull request was merged.

**Archived**: reduced to its **Archive**; its worktree is gone.

## Team

**Agent**:
A specialised role (Griller, Spec Writer, Architect, Artist, Developer, Reviewer, Consolidator) that performs **Steps** using **Skills** through the **Runner** it is assigned.
_Avoid_: Bot, worker, assistant

**Runner**:
The AI tool that actually executes an **Agent**'s work, such as Claude Code or Codex, set to one of its models.
_Avoid_: Provider, backend, engine

**Consolidator**:
The **Agent** that merges two Reviewers' reviews into one and checks each remark against the code; a disagreement it cannot settle opens a **Gate** carrying its recommendation.
_Avoid_: Merger, aggregator, judge

**Quota**:
The share of a **Runner**'s subscription usage limits still available in its rolling windows (five-hour and weekly).
_Avoid_: Credits, rate limit, usage

**Skill**:
A packaged set of instructions an **Agent** follows for one kind of work.
_Avoid_: Prompt, command, recipe

**Skill Pack**:
A named group of **Skills** for one audience (shared, godot, forgequor); a **Project** picks the packs its **Agents** use, plus any **Skills** of its own.
_Avoid_: Skill set, bundle, plugin

**Artist**:
The **Agent** that produces game art assets from prompts settled during spec grilling, following the **Project**'s **Art Direction**.
_Avoid_: Graphiste, designer, illustrator

**Asset**:
One piece of game art an **Artist** delivers as a **Deliverable**: a sprite, a tile or an **Animation Strip**, in pixel art at the size it was asked for.
_Avoid_: Image, picture, graphic, resource

**Animation Strip**:
An **Asset** holding the frames of one animation side by side in a single image.
_Avoid_: Sprite sheet, spritesheet, animation file

**Asset Request**:
The human's description of one **Asset** to produce (name, what it shows, its size); the **Artist** turns it into a prompt.
_Avoid_: Prompt, asset spec, brief

**Asset Check**:
An automatic validation of one **Asset** against its **Asset Request** before the **Asset Gate** (format, size, place); a failure sends it back to the **Artist**, while colours outside the **Art Direction**'s palette only warn.
_Avoid_: Asset test, lint, Check (a **Check** is a command the **Project** declares)

**Asset Gate**:
The **Gate** where the human approves each **Asset** of a batch, or rejects it with its own **Feedback** so the **Artist** redoes only the rejected ones.
_Avoid_: Art review, gallery gate

**Verdict**:
The human's decision on one **Asset** at an **Asset Gate**: approve, or reject with its own **Feedback**. The Gate takes one for every **Asset** waiting for one, all at once.
_Avoid_: Review, vote

**Style Reference**:
An existing image of the **Project** shown to the **Artist** so new **Assets** match it: those the **Art Direction** names are always given, and an **Asset Request** can name more.
_Avoid_: Mood board, inspiration

**Asset Version**:
What the **Artist** delivered for an **Asset** in one **Iteration** (its last attempt that passed the **Asset Checks**), kept so the human can look at past versions beside the **Feedback** each got.
_Avoid_: Revision, draft

**Art Direction**:
The document inside a game **Project** that fixes its visual style (palette, resolution, sprite sizes) for the **Artist**.
_Avoid_: Style guide, art bible

## Tracking

**Sprint**:
A time box in a game **Project**'s own tracker (Codecks calls it a "run"); unrelated to a **Run**.
_Avoid_: Run (in this sense), iteration
