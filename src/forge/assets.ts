import { copyFileSync, existsSync, mkdirSync, rmSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkAssetFile, parsePalette, type AssetCheckResult } from "./asset-checks.js";
import { replacedCopyPath, servableAssetFile } from "./asset-files.js";
import { createAssetStore, VerdictError, verdictFeedback, type AssetStore } from "./asset-store.js";
import { parseReferences } from "./art-direction.js";
import { AssetNotFoundError, InvalidInputError } from "./errors.js";
import type { GateKindModule } from "./gates.js";
import { runAgentStep } from "./step.js";
import { loadBuiltInWorkflow } from "./workflow-definition.js";
import type { RunInput, RunPlan, Workflow, WorkflowContext } from "./workflow.js";
import type { Asset, AssetKind, AssetRequest } from "./types.js";
import { commitPaths, existsAtHead, repositoryPath, RUN_NOTES_DIR, slugify } from "./workspace.js";
import type { Extension, RunDetailPart } from "./extension.js";
import type pg from "pg";

export type { Asset, AssetAttempt, AssetKind, AssetRequest, AssetStatus, AssetVersion, GateVerdict, Verdict } from "./types.js";
export { AssetNotFoundError, VerdictError, replacedCopyPath, servableAssetFile };

/** The kind subfolder of the art folder each kind of Asset goes to. */
const KIND_FOLDERS: Record<AssetKind, string> = { sprite: "sprites", tile: "tiles", animation: "animations" };

/** A frame's (or a single Asset's) size, as 16x16. */
const size = (a: { width: number; height: number }) => `${a.width}x${a.height}`;
/** The whole image's size: an Animation Strip is its frames side by side. */
const imageSize = (a: { width: number; height: number; frames?: number }) => `${a.width * (a.frames ?? 1)}x${a.height}`;
/** The size as the human reads it: 16x16, or 16x16 × 4 frames for a strip. */
const describeSize = (a: { width: number; height: number; kind: AssetKind; frames?: number }) =>
  a.kind === "animation" ? `${size(a)} × ${a.frames} frames` : size(a);

/** The art folder, then the kind subfolder, then the request name in kebab-case with `.png`. */
export function assetTargetPath(artFolder: string, kind: AssetKind, name: string): string {
  return `${artFolder}/${KIND_FOLDERS[kind]}/${slugify(name, 60)}.png`;
}

/** Checks the Asset Requests a human gave, tidied; throws an error saying what is wrong with which request. */
export function validateAssetRequests(assets: unknown): AssetRequest[] {
  if (!Array.isArray(assets) || !assets.length) throw new Error("An assets Run needs at least one Asset Request.");
  return assets.map((raw, i) => {
    const at = `Asset Request ${i + 1}`;
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    if (!name) throw new Error(`${at} needs a name.`);
    if (!slugify(name, 60)) throw new Error(`${at}: the name "${name}" has no letter or digit to make a file name from.`);
    if (raw.kind !== "sprite" && raw.kind !== "tile" && raw.kind !== "animation") {
      throw new Error(`${at} ("${name}") must be a sprite, a tile or an animation.`);
    }
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    if (!description) throw new Error(`${at} ("${name}") needs a description of what it shows.`);
    const { width, height } = raw;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error(`${at} ("${name}") needs a size of whole pixels, at least 1x1.`);
    }
    if (raw.fill !== undefined && typeof raw.fill !== "boolean") throw new Error(`${at} ("${name}"): fill must be yes or no.`);
    if (raw.kind === "animation" && (!Number.isInteger(raw.frames) || raw.frames < 2)) {
      throw new Error(`${at} ("${name}") is an animation: it needs a whole number of frames, at least 2.`);
    }
    if (raw.replace !== undefined && typeof raw.replace !== "boolean") throw new Error(`${at} ("${name}"): replace must be yes or no.`);
    const references = raw.references ?? [];
    if (!Array.isArray(references)) throw new Error(`${at} ("${name}"): references must be a list of repository paths.`);
    for (const reference of references) {
      try {
        if (typeof reference !== "string" || !reference.endsWith(".png")) throw new Error("not a PNG");
        repositoryPath(reference);
      } catch {
        throw new Error(`${at} ("${name}"): the reference "${reference}" is not a repository path to a PNG image.`);
      }
    }
    return {
      name, kind: raw.kind, description, width, height,
      fill: raw.fill === true,
      frames: raw.kind === "animation" ? raw.frames : 1,
      references: [...new Set<string>(references)],
      replace: raw.replace === true,
    };
  });
}

/**
 * Checks Asset Requests against what the repository already holds, so a Run is refused before anything is generated: two
 * requests producing the same file, an existing file that was not marked for replacement, a reference that is not there.
 * `exists` says whether a repository path exists on the default branch.
 */
export async function checkAgainstRepository(assets: AssetRequest[], artFolder: string, exists: (path: string) => Promise<boolean>) {
  const targets = new Map<string, number>();
  for (const [i, a] of assets.entries()) {
    const target = assetTargetPath(artFolder, a.kind, a.name);
    const other = targets.get(target);
    if (other !== undefined) {
      throw new Error(`Asset Requests ${other + 1} ("${assets[other]!.name}") and ${i + 1} ("${a.name}") would produce the same file: ${target}.`);
    }
    targets.set(target, i);
  }
  for (const [i, a] of assets.entries()) {
    const target = assetTargetPath(artFolder, a.kind, a.name);
    if (!a.replace && (await exists(target))) {
      throw new Error(`Asset Request ${i + 1} ("${a.name}") would overwrite the existing file ${target}: mark it as replacing that file, or rename it.`);
    }
    for (const reference of a.references ?? []) {
      if (!(await exists(reference))) {
        throw new Error(`Asset Request ${i + 1} ("${a.name}"): the reference ${reference} does not exist in the repository's default branch.`);
      }
    }
  }
}

/** The Artist Agent's standing instructions. */
export const ARTIST_INSTRUCTIONS = `You are the Artist on a Forgequor Run. Work only inside the current directory, which is this Run's own git worktree.

- You are given one Asset to draw, with its Target path, size and description, and the project's Art Direction. Follow the Art Direction.
- Use your image tool for exactly this one Asset.
- Save the final Asset at the exact Target path you are given, and nowhere else in the worktree. Create the folders if needed.
- Deliver pixel art at exactly the requested image size. For an Animation Strip, lay its frames side by side horizontally in that one image, each frame at the requested frame size. The image tool's output is much larger: scale it down yourself, keeping the pixels crisp (nearest neighbour).
- When the Asset says "Fill: yes", fill the whole square (every frame of an Animation Strip) edge to edge with no transparent pixel. Otherwise use a transparent background wherever the Asset does not need to cover it.
- Do not commit anything.
- When you are done, say in one or two sentences what you saved.`;

/** Why the Artist's previous attempt at an Asset has to be redone. */
export type Redo = { unwritten: true } | { failures: string[] };

/** The version the human rejected in an earlier Iteration, kept in the Run Notes, and all the Feedback it led to, oldest first. */
export interface Rejected {
  imagePath: string;
  feedbacks: string[];
}

/**
 * The Artist's prompt for one Asset. Redoing a rejected Asset it carries the rejected version as a reference and the
 * Feedback; on a retry it says what was wrong with the previous attempt.
 */
export function artistPrompt(
  asset: Asset,
  artDirectionPath: string,
  artDirection: string,
  extra: { redo?: Redo; rejected?: Rejected; references?: string[]; replaced?: string } = {},
): string {
  const { redo, rejected, references = [], replaced } = extra;
  let prompt = `Asset to draw: ${asset.name}
Kind: ${asset.kind}
Size: ${size(asset)} pixels${asset.kind === "animation" ? " per frame" : ""}${
    asset.kind === "animation" ? `\nFrames: ${asset.frames}, laid side by side horizontally in one image, in order, with no gap` : ""
  }
Image size: ${imageSize(asset)} pixels
Fill: ${asset.fill ? "yes, every pixel opaque" : "no"}
Target path: ${asset.targetPath}

What it shows:
${asset.description}

Art Direction (${artDirectionPath}):
${artDirection}`;
  if (references.length) {
    prompt += `\n\nReference images (attached to this message; match their style): ${references.join(", ")}`;
  }
  if (replaced) {
    prompt += `\n\nYou are replacing an existing Asset. Its current version is the reference image at ${replaced} (attached): keep what works, change what the description asks. Save the new one at the target path.`;
  }
  if (rejected) {
    const history = rejected.feedbacks.map((f, i) => `${i + 1}. ${f}`).join("\n");
    prompt += `\n\nThe human rejected your earlier version of this Asset. Rejected version (reference image, to look at, not to edit or commit): ${rejected.imagePath}\nDraw the Asset again at the target path, addressing the latest Feedback (the last one) and keeping the earlier ones satisfied.\n\nFeedback so far, oldest first:\n${history}`;
  }
  if (redo && "unwritten" in redo) {
    prompt += `\n\nYour previous attempt left nothing at the target path. Draw the Asset again and save it at exactly ${asset.targetPath}.`;
  } else if (redo) {
    prompt += `\n\nYour previous attempt failed the Asset Checks. Fix this and save the final Asset again at the same target path:\n${redo.failures.map((f) => `- ${f}`).join("\n")}`;
  }
  return prompt;
}

/** The Art Direction text, or null when the Project has none at its path. */
function readArtDirection(worktreePath: string, path: string): string | null {
  const file = join(worktreePath, path);
  return existsSync(file) && statSync(file).isFile() ? readFileSync(file, "utf8") : null;
}

/** `feat(art): add 2 assets`, `feat(art): replace 1 asset`, or both counted apart. */
export function commitMessage(assets: Asset[]): string {
  const replaced = assets.filter((a) => a.replace).length;
  const added = assets.length - replaced;
  const count = (n: number, verb: string) => `${verb} ${n} ${n === 1 ? "asset" : "assets"}`;
  return `feat(art): ${[added && count(added, "add"), replaced && count(replaced, "replace")].filter(Boolean).join(" and ")}`;
}

/** The Review Brief of an `assets` Run: Forgequor writes it from what it stored, no Agent is involved. */
function reviewBrief(assets: Asset[], feedbacks: Map<number, string[]>): string {
  const replaced = assets.some((a) => a.replace);
  const rows = assets.map((a) => `| \`${a.targetPath}\` | ${a.name} | ${a.kind} | ${describeSize(a)} |${replaced ? ` ${a.replace ? "**replaces** the existing file" : "new"} |` : ""}`);
  const lines = [
    "## Assets",
    "",
    `${assets.length} ${assets.length === 1 ? "Asset" : "Assets"} drawn by the Artist and approved by the human at the Asset Gate.`,
    "",
    `| Path | Name | Kind | Size |${replaced ? " Change |" : ""}`,
    `|---|---|---|---|${replaced ? "---|" : ""}`,
    ...rows,
    "",
  ];
  const warned = assets.filter((a) => a.warnings.length);
  if (warned.length) {
    lines.push("## Palette warnings", "", "Colours outside the Art Direction's palette, accepted by the human with the Asset.", "");
    for (const a of warned) lines.push(...a.warnings.map((w) => `- **${a.name}**: ${w}`));
    lines.push("");
  }
  const redone = assets.filter((a) => feedbacks.get(a.id)?.length);
  if (redone.length) {
    lines.push("## Feedback that led to these Assets", "");
    for (const a of redone) {
      lines.push(`- **${a.name}**`, ...feedbacks.get(a.id)!.map((f, i) => `  ${i + 1}. ${f}`));
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Records one Artist attempt as a version of the Asset: the Runner's raw images, kept in the Run Notes as a trace, and
 * what the Asset Checks found.
 */
async function recordVersion(store: AssetStore, ctx: WorkflowContext, asset: Asset, attempt: number, files: string[], summary: string, check: AssetCheckResult) {
  const dir = join(ctx.worktreePath, RUN_NOTES_DIR, "assets");
  const kept: string[] = [];
  mkdirSync(dir, { recursive: true });
  files.forEach((file, i) => {
    const copy = `${RUN_NOTES_DIR}/assets/${asset.id}-i${ctx.run.iteration}-a${attempt}-${i + 1}.png`;
    try {
      copyFileSync(file, join(ctx.worktreePath, copy));
      kept.push(copy);
    } catch {
      // The trace is only a convenience: a vanished raw image never fails the Run.
    }
  });
  // Keep the Asset itself too: the next Iteration overwrites the target path, and the human can look at past versions.
  let imagePath: string | null = null;
  const real = servableAssetFile(ctx.worktreePath, asset.targetPath);
  if (real) {
    imagePath = `${RUN_NOTES_DIR}/assets/versions/${asset.id}-i${ctx.run.iteration}-a${attempt}.png`;
    mkdirSync(join(ctx.worktreePath, RUN_NOTES_DIR, "assets", "versions"), { recursive: true });
    copyFileSync(real, join(ctx.worktreePath, imagePath));
  }
  await store.addVersion({
    assetId: asset.id,
    iteration: ctx.run.iteration,
    attempt,
    rawImages: kept,
    written: check.written,
    failures: check.failures,
    warnings: check.warnings,
    summary,
    imagePath,
  });
}

/**
 * The version of this Asset the human rejected in an earlier Iteration, with all the Feedback so far; undefined when the
 * Asset was never rejected. When the Artist is about to start over (`starting`), the rejected file is cleared from the
 * target path, so that a missing file means nothing was written this time.
 */
async function rejectedBefore(store: AssetStore, ctx: WorkflowContext, asset: Asset, starting: boolean): Promise<Rejected | undefined> {
  const imagePath = await store.earlierPassingImage(asset.id, ctx.run.iteration);
  if (!imagePath) return undefined;
  if (starting) rmSync(join(ctx.worktreePath, asset.targetPath), { force: true });
  return { imagePath, feedbacks: await store.rejectionFeedbacks(asset.id) };
}

/**
 * Before the first attempt at an Asset that replaces an existing file, moves that file out of the way into the Run Notes:
 * it becomes a reference, and a missing file at the target path again means nothing was written (`clear`; later attempts
 * only look the copy up). Returns the copy's path relative to the worktree. A restarted Run keeps the first copy.
 */
function setAsideReplaced(ctx: WorkflowContext, asset: Asset, clear: boolean): string | undefined {
  const copy = replacedCopyPath(asset.id);
  const target = join(ctx.worktreePath, asset.targetPath);
  if (!existsSync(join(ctx.worktreePath, copy))) {
    // Only the file that was there before the Artist started is the existing art: later, the target holds the Artist's own work.
    if (!clear || !existsSync(target)) return undefined;
    mkdirSync(dirname(join(ctx.worktreePath, copy)), { recursive: true });
    copyFileSync(target, join(ctx.worktreePath, copy));
  }
  if (clear) rmSync(target, { force: true });
  return copy;
}

/**
 * The most Artist Steps one Asset can cost in one Iteration (1 try + 2 more), whatever went wrong with each: this caps
 * the Quota a stubborn Asset can spend before the human hears of it. A Step cut short by a used-up Quota or a restart
 * is not counted, since it produced nothing to check.
 */
export const MAX_ARTIST_ATTEMPTS = 3;
/** An Artist that wrote nothing at the target path twice will not: the Run escalates without spending a third Step. */
const MAX_UNWRITTEN_ATTEMPTS = 2;

/**
 * Has the Artist draw one Asset until it passes the Asset Checks, sending it back with the reason when it does not. What
 * was tried is read from the recorded versions, so a restarted Run goes on from there. False when the Run cannot go on
 * (it paused, opened an Escalation, or was abandoned).
 */
async function drawAsset(store: AssetStore, ctx: WorkflowContext, asset: Asset, artDirection: string, artReferences: string[], palette: string[] | null): Promise<boolean> {
  const { run, project, worktreePath } = ctx;
  const seat = ctx.agents.artist;
  if (!seat) throw new Error("Forgequor has no Runner for the Artist.");
  for (;;) {
    const versions = await store.attemptsIn(asset.id, run.iteration);
    const last = versions.at(-1);
    const rejected = await rejectedBefore(store, ctx, asset, !versions.length);
    // Only the first attempt of the Run sets the existing art aside (and clears the target): later passes must not clear
    // what the Artist just wrote, and an Iteration after a rejection finds the target cleared already. Every attempt of
    // every Iteration is still shown the Replaced Art.
    const replaced = asset.replace ? setAsideReplaced(ctx, asset, !versions.length && !rejected) : undefined;
    // What the Artist is shown: the Art Direction's references, then the Asset's own, then the art it is redoing.
    const references = [...new Set([...artReferences, ...asset.references])].filter((p) => existsSync(join(worktreePath, p)));
    const images = [...references, ...(rejected ? [rejected.imagePath] : []), ...(replaced ? [replaced] : [])].map((p) => join(worktreePath, p));
    let redo: Redo | undefined;
    if (last?.written && !last.failures.length) break;
    if (last) {
      const unwritten = versions.filter((v) => !v.written).length;
      if (versions.length >= MAX_ARTIST_ATTEMPTS || unwritten >= MAX_UNWRITTEN_ATTEMPTS) {
        const afterAttempts = `after ${versions.length} attempts`;
        await (last.written
          ? ctx.openGate("escalation", `"${asset.name}" still fails the Asset Checks ${afterAttempts}.`, last.failures.join("\n"))
          : ctx.openGate("escalation", `The Artist wrote nothing at the target path of "${asset.name}" (${asset.targetPath}) ${afterAttempts}.`, last.summary));
        return false;
      }
      redo = last.written ? { failures: last.failures } : { unwritten: true };
    }

    const attempt = await store.nextStepAttempt(run.id, run.iteration, asset.id);
    await store.setStatus(asset.id, "generating");
    ctx.changed();

    const done = await runAgentStep(ctx, seat, {
      name: "artist",
      attempt,
      assetId: asset.id,
      instructions: ARTIST_INSTRUCTIONS,
      prompt: artistPrompt(asset, project.artDirectionPath, artDirection, { redo, rejected, references, replaced }),
      images,
    });
    if (!done) return false;
    await recordVersion(store, ctx, asset, attempt, done.files ?? [], done.summary, checkAssetFile(worktreePath, asset, palette));
  }
  await store.setStatus(asset.id, "waiting");
  ctx.changed();
  return true;
}

/** The human approved the Asset Gate: commit the Assets, open the pull request with Forgequor's own Review Brief, approve the Run. */
async function finish(store: AssetStore, ctx: WorkflowContext, assets: Asset[]) {
  const { worktreePath, run } = ctx;
  await store.approveAll(run.id);
  await commitPaths(worktreePath, assets.map((a) => a.targetPath), commitMessage(assets));
  const feedbacks = await store.rejectionFeedbacksOf(assets.map((a) => a.id));
  const pr = await ctx.publishPullRequest(() => reviewBrief(assets, feedbacks));
  if (!pr) return;
  await ctx.approve();
}

/**
 * The `artist` Step type's launch input: the Asset Requests. Validated when the Run is launched and stored with it, so
 * the Run is refused before any Quota is spent.
 */
function launchAssetRequests(store: AssetStore, input: unknown): Pick<RunPlan, "check" | "store"> & { requests: AssetRequest[] } {
  const requests = validateAssetRequests(input);
  return {
    requests,
    // What the requests would overwrite or lean on must be right on the default branch as it is on the remote now.
    check: ({ project, exists }) => checkAgainstRepository(requests, project.artFolder, exists),
    store: (client, runId, project) => store.insertRequests(client, runId, requests, (a) => assetTargetPath(project.artFolder, a.kind, a.name)),
  };
}

/** The `assets` Workflow: the Artist draws each Asset in turn, the human judges them at the Asset Gate, then the pull request opens. */
export function createAssetsWorkflow(store: AssetStore): Workflow {
  return {
  name: "assets",
  inputs: ["assets"],
  // Frozen with each Run; the Workflow still runs as code until m3-05 moves it to the engine.
  definition: loadBuiltInWorkflow("assets"),

  plan(input: RunInput): RunPlan {
    const { requests: assets, ...launch } = launchAssetRequests(store, input.assets);
    const lines = assets.map((a) => `- ${a.name}: ${a.kind} ${describeSize(a)}. ${a.description}`);
    const names = assets.map((a) => a.name).join(", ");
    const title = names.length > 60 ? `Art: ${names.slice(0, 54).trimEnd()}...` : `Art: ${names}`;
    return {
      task: `Draw ${assets.length} ${assets.length === 1 ? "Asset" : "Assets"}:\n${lines.join("\n")}`,
      title: input.title?.trim() || title,
      ...launch,
    };
  },

  async run(ctx) {
    const { run, project, worktreePath } = ctx;
    const assets = await store.load(run.id);

    const todo = assets.filter((a) => a.status === "pending" || a.status === "generating" || a.status === "rejected");
    if (todo.length) {
      // The Run may have waited in the queue: what the launch check saw can have changed on the remote since.
      const existingTargets: string[] = [];
      for (const a of todo) if (!a.replace && (await existsAtHead(worktreePath, a.targetPath))) existingTargets.push(a.targetPath);
      if (existingTargets.length) {
        return ctx.openGate(
          "escalation",
          `${existingTargets.join(", ")} ${existingTargets.length === 1 ? "exists" : "exist"} in the repository already, so nothing was generated.`,
          "The file was added after this Run was started. Abandon the Run, then start it again with the Asset marked as replacing that file, or under another name.",
        );
      }
      const artDirection = readArtDirection(worktreePath, project.artDirectionPath);
      if (artDirection === null) {
        return ctx.openGate(
          "escalation",
          "The Art Direction is missing, so nothing was generated.",
          `Expected a file at ${project.artDirectionPath} in the repository, on its default branch.`,
        );
      }
      const palette = parsePalette(artDirection);
      const artReferences = parseReferences(artDirection);
      for (const asset of todo) {
        if (!(await drawAsset(store, ctx, asset, artDirection, artReferences, palette))) return;
      }
    }

    if ((await ctx.records.lastDecision("asset")) === "approve") return finish(store, ctx, assets);
    if (!(await ctx.stillRunning())) return;
    const waiting = (await store.load(run.id)).filter((a) => a.status === "waiting").length;
    await ctx.openGate("asset", `${waiting} ${waiting === 1 ? "Asset is" : "Assets are"} waiting for your verdict.`);
  },
  };
}

/**
 * The `asset` Gate kind: the human gives a verdict for every Asset waiting for one, all at once. When all are approved
 * the Run goes on to its commit and pull request; otherwise the next Iteration redoes the rejected Assets only.
 */
export function createAssetGate(store: AssetStore): GateKindModule {
  return {
    kind: "asset",
    label: "An Asset Gate",
    actions: ["judge", "abandon"],
    async decide(gate, { action, verdicts }) {
      if (action === "abandon") return { next: "abandon" };
      let given;
      try {
        given = await store.checkVerdicts(gate.runId, verdicts);
      } catch (e) {
        throw e instanceof VerdictError ? new InvalidInputError(e.message) : e;
      }
      // The Asset Gate is not the end of its Run: approved Assets are still to be committed and sent as a pull request.
      const rejected = given.some((v) => v.action === "reject");
      return {
        next: "continue",
        decision: rejected ? "reject" : "approve",
        nextIteration: rejected,
        record: (client) => store.recordVerdicts(client, gate.id, given),
      };
    },
  };
}

/**
 * Everything the Forge core gets of Assets: the `assets` Workflow (its `artist` Step type), the `asset` Gate kind, the
 * Asset rows and verdicts of a Run's detail, and Asset images. The Asset tables stay behind it.
 */
export function createAssetsExtension(pool: pg.Pool): Extension {
  const store = createAssetStore(pool);
  return {
    workflows: [createAssetsWorkflow(store)],
    gateKinds: [createAssetGate(store)],
    async detail(runId, gateIds) {
      const assets = await store.load(runId);
      const verdicts = await store.gateVerdicts(gateIds);
      const gates: RunDetailPart["gates"] = new Map();
      for (const id of gateIds) gates.set(id, { verdicts: verdicts.get(id) ?? [], feedback: verdictFeedback(verdicts.get(id) ?? [], assets) });
      return { assets, gates };
    },
    assetImage: (runId, assetId, which) => store.imageFile(runId, assetId, which),
  };
}
