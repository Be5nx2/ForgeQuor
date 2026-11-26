import { copyFileSync, existsSync, mkdirSync, rmSync, openSync, readFileSync, readSync, closeSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type pg from "pg";
import { describeDuration } from "../duration.js";
import { checkAssetFile, parsePalette, type AssetCheckResult } from "./asset-checks.js";
import { publishPullRequest } from "./publish.js";
import { runAgentStep } from "./step.js";
import type { RunInput, RunPlan, Workflow, WorkflowContext } from "./workflow.js";
import { commitPaths, RUN_NOTES_DIR, slugify } from "./workspace.js";

export type AssetKind = "sprite" | "tile";
/** Where an Asset is: not drawn yet, being drawn, drawn and waiting for the human's verdict, approved, or rejected (to be redone in the next Iteration). */
export type AssetStatus = "pending" | "generating" | "waiting" | "approved" | "rejected";

/** The human's description of one Asset to produce. */
export interface AssetRequest {
  name: string;
  kind: AssetKind;
  description: string;
  width: number;
  height: number;
  /** The Asset fills its whole square, fully opaque (a ground tile). Off by default; any transparent pixel then fails the Asset Checks. */
  fill?: boolean;
}

/** One version of an Asset that reached the human: the Artist's last passing attempt of an Iteration, and the Feedback it got. */
export interface AssetVersion {
  id: number;
  iteration: number;
  attempt: number;
  feedback: string | null;
}

/** The human's verdict on one Asset. */
export interface Verdict {
  assetId: number;
  action: "approve" | "reject";
  /** Required, and non-empty, to reject. */
  feedback?: string;
}

/** A recorded verdict, as the Gate it was given at shows it. */
export interface GateVerdict {
  assetId: number;
  verdict: "approve" | "reject";
  feedback: string | null;
}

export interface Asset extends AssetRequest {
  id: number;
  fill: boolean;
  /** Order in which the Artist handles the Run's Assets, from 0. */
  position: number;
  /** Where the Artist writes the final Asset, relative to the Run's worktree. */
  targetPath: string;
  status: AssetStatus;
  /** What the Asset Checks warned about in its current version (colours outside the palette). Warnings never fail an Asset. */
  warnings: string[];
  /** The versions the human saw, oldest first; the last is the current one once the Asset has been drawn. */
  versions: AssetVersion[];
}

/** An error in the verdicts the human gave. */
export class VerdictError extends Error {}

/** No such Asset in that Run, or nothing servable recorded for it. */
export class AssetNotFoundError extends Error {}

/** The kind subfolder of the art folder each kind of Asset goes to. */
const KIND_FOLDERS: Record<AssetKind, string> = { sprite: "sprites", tile: "tiles" };

const size = (a: { width: number; height: number }) => `${a.width}x${a.height}`;

/** A repository-relative path, tidied: no leading or trailing slash. Throws when it is empty, absolute or climbs out of the repository. */
export function repositoryPath(value: string): string {
  const path = value.trim().replace(/\/+$/, "");
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new Error(`"${value.trim()}" is not a path inside the repository.`);
  }
  return path;
}

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
    if (raw.kind !== "sprite" && raw.kind !== "tile") throw new Error(`${at} ("${name}") must be a sprite or a tile.`);
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    if (!description) throw new Error(`${at} ("${name}") needs a description of what it shows.`);
    const { width, height } = raw;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error(`${at} ("${name}") needs a size of whole pixels, at least 1x1.`);
    }
    if (raw.fill !== undefined && typeof raw.fill !== "boolean") throw new Error(`${at} ("${name}"): fill must be yes or no.`);
    return { name, kind: raw.kind, description, width, height, fill: raw.fill === true };
  });
}

export function toAsset(r: Record<string, any>): Asset {
  return {
    id: Number(r.id),
    position: r.position,
    name: r.name,
    kind: r.kind,
    description: r.description,
    width: r.width,
    height: r.height,
    fill: r.fill,
    targetPath: r.target_path,
    status: r.status,
    warnings: r.warnings ?? [],
    versions: [],
  };
}

/** The versions of an Asset's Iterations that passed the Asset Checks (the last of each Iteration), with the Feedback each got. */
const PASSING = "v.written AND jsonb_array_length(v.failures) = 0";

/** Reads a Run's Assets, in order, each with the warnings of its latest version and the versions the human saw. */
export async function loadAssets(pool: pg.Pool, runId: number): Promise<Asset[]> {
  const { rows } = await pool.query(
    `SELECT a.*, (SELECT v.warnings FROM asset_versions v WHERE v.asset_id = a.id ORDER BY v.id DESC LIMIT 1) AS warnings
     FROM assets a WHERE a.run_id = $1 ORDER BY a.position`,
    [runId],
  );
  const assets: Asset[] = rows.map(toAsset);
  if (!assets.length) return assets;
  const { rows: versions } = await pool.query(
    `SELECT v.id, v.asset_id, v.iteration, v.attempt, d.feedback
     FROM asset_versions v LEFT JOIN asset_verdicts d ON d.version_id = v.id
     WHERE v.asset_id = ANY($1) AND ${PASSING} AND v.image_path IS NOT NULL ORDER BY v.id`,
    [assets.map((a) => a.id)],
  );
  for (const v of versions) {
    const asset = assets.find((a) => a.id === Number(v.asset_id))!;
    // Only the last passing attempt of an Iteration is the one the human judged.
    if (asset.versions.at(-1)?.iteration === v.iteration) asset.versions.pop();
    asset.versions.push({ id: Number(v.id), iteration: v.iteration, attempt: v.attempt, feedback: v.feedback });
  }
  return assets;
}

/**
 * Checks the verdicts the human gave at an Asset Gate against the Assets waiting for one: a verdict for each of them,
 * all at once, none twice, a Feedback for each rejection. Throws a VerdictError saying what is wrong.
 */
export async function checkVerdicts(pool: pg.Pool, runId: number, given: unknown): Promise<Verdict[]> {
  if (!Array.isArray(given)) throw new VerdictError("An Asset Gate needs a verdict for each Asset waiting for one.");
  const { rows } = await pool.query("SELECT id FROM assets WHERE run_id = $1 AND status = 'waiting'", [runId]);
  const waiting = new Set<number>(rows.map((r) => Number(r.id)));
  const seen = new Set<number>();
  for (const v of given) {
    if (typeof v !== "object" || v === null) throw new VerdictError("Each verdict names an Asset and approves or rejects it.");
    if (seen.has(v?.assetId)) throw new VerdictError(`Asset ${v.assetId} has more than one verdict: give each Asset's verdict once.`);
    seen.add(v?.assetId);
    if (!waiting.has(v?.assetId)) throw new VerdictError(`Asset ${v?.assetId} is not waiting for a verdict at this Gate.`);
  }
  if (seen.size !== waiting.size) throw new VerdictError("Give a verdict for every Asset waiting for one, all at once.");
  return given.map((v) => {
    if (v.action !== "approve" && v.action !== "reject") throw new VerdictError("A verdict is approve or reject.");
    const feedback = typeof v.feedback === "string" ? v.feedback.trim() : "";
    if (v.action === "reject" && !feedback) throw new VerdictError("Rejecting an Asset needs a Feedback saying what to change.");
    return { assetId: v.assetId, action: v.action, ...(v.action === "reject" ? { feedback } : {}) };
  });
}

/** Records the verdicts of a decided Asset Gate and moves each Asset to approved or rejected. Run inside the decision's transaction. */
export async function recordVerdicts(client: pg.PoolClient, gateId: number, verdicts: Verdict[]) {
  for (const v of verdicts) {
    await client.query(
      `INSERT INTO asset_verdicts (gate_id, asset_id, version_id, verdict, feedback)
       VALUES ($1, $2, (SELECT v.id FROM asset_versions v WHERE v.asset_id = $2 AND ${PASSING} ORDER BY v.id DESC LIMIT 1), $3, $4)`,
      [gateId, v.assetId, v.action, v.feedback ?? null],
    );
    await client.query("UPDATE assets SET status = $2 WHERE id = $1", [v.assetId, v.action === "approve" ? "approved" : "rejected"]);
  }
}

export async function loadGateVerdicts(pool: pg.Pool, gateIds: number[]): Promise<Map<number, GateVerdict[]>> {
  const { rows } = await pool.query("SELECT * FROM asset_verdicts WHERE gate_id = ANY($1) ORDER BY id", [gateIds]);
  const byGate = new Map<number, GateVerdict[]>();
  for (const r of rows) {
    const list = byGate.get(Number(r.gate_id)) ?? [];
    list.push({ assetId: Number(r.asset_id), verdict: r.verdict, feedback: r.feedback });
    byGate.set(Number(r.gate_id), list);
  }
  return byGate;
}

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

/**
 * The file of an Asset's current version, only when it is a PNG that really lives inside the worktree (a link leading
 * out of it does not count). Null otherwise.
 */
export function servableAssetFile(worktreePath: string, targetPath: string): string | null {
  try {
    const root = realpathSync(worktreePath);
    const real = realpathSync(resolve(root, targetPath));
    if (!real.startsWith(root + sep) || !statSync(real).isFile()) return null;
    const head = Buffer.alloc(PNG_SIGNATURE.length);
    const fd = openSync(real, "r");
    try {
      readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
    return head.equals(PNG_SIGNATURE) ? real : null;
  } catch {
    return null;
  }
}

/** The Artist Agent's standing instructions. */
export const ARTIST_INSTRUCTIONS = `You are the Artist on a Forgequor Run. Work only inside the current directory, which is this Run's own git worktree.

- You are given one Asset to draw, with its Target path, size and description, and the project's Art Direction. Follow the Art Direction.
- Use your image tool for exactly this one Asset.
- Save the final Asset at the exact Target path you are given, and nowhere else in the worktree. Create the folders if needed.
- Deliver pixel art at exactly the requested size. The image tool's output is much larger: scale it down yourself, keeping the pixels crisp (nearest neighbour).
- When the Asset says "Fill: yes", fill the whole square edge to edge with no transparent pixel. Otherwise use a transparent background wherever the Asset does not need to cover it.
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
export function artistPrompt(asset: Asset, artDirectionPath: string, artDirection: string, extra: { redo?: Redo; rejected?: Rejected } = {}): string {
  const { redo, rejected } = extra;
  let prompt = `Asset to draw: ${asset.name}
Kind: ${asset.kind}
Size: ${size(asset)} pixels
Fill: ${asset.fill ? "yes, every pixel opaque" : "no"}
Target path: ${asset.targetPath}

What it shows:
${asset.description}

Art Direction (${artDirectionPath}):
${artDirection}`;
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

/** The Review Brief of an `assets` Run: Forgequor writes it from what it stored, no Agent is involved. */
function reviewBrief(assets: Asset[], feedbacks: Map<number, string[]>): string {
  const rows = assets.map((a) => `| \`${a.targetPath}\` | ${a.name} | ${a.kind} | ${size(a)} |`);
  const lines = [
    "## Assets",
    "",
    `${assets.length} ${assets.length === 1 ? "Asset" : "Assets"} drawn by the Artist and approved by the human at the Asset Gate.`,
    "",
    "| Path | Name | Kind | Size |",
    "|---|---|---|---|",
    ...rows,
    "",
  ];
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
async function recordVersion(ctx: WorkflowContext, asset: Asset, attempt: number, files: string[], summary: string, check: AssetCheckResult) {
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
  await ctx.pool.query(
    `INSERT INTO asset_versions (asset_id, iteration, attempt, raw_images, written, failures, warnings, summary, image_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [asset.id, ctx.run.iteration, attempt, JSON.stringify(kept), check.written, JSON.stringify(check.failures), JSON.stringify(check.warnings), summary, imagePath],
  );
}

/**
 * The version of this Asset the human rejected in an earlier Iteration, with all the Feedback so far; undefined when the
 * Asset was never rejected. When the Artist is about to start over (`starting`), the rejected file is cleared from the
 * target path, so that a missing file means nothing was written this time.
 */
async function rejectedBefore(ctx: WorkflowContext, asset: Asset, starting: boolean): Promise<Rejected | undefined> {
  const { rows: earlier } = await ctx.pool.query(
    `SELECT v.image_path FROM asset_versions v WHERE v.asset_id = $1 AND v.iteration < $2 AND ${PASSING} AND v.image_path IS NOT NULL
     ORDER BY v.id DESC LIMIT 1`,
    [asset.id, ctx.run.iteration],
  );
  if (!earlier[0]) return undefined;
  if (starting) rmSync(join(ctx.worktreePath, asset.targetPath), { force: true });
  const { rows } = await ctx.pool.query("SELECT feedback FROM asset_verdicts WHERE asset_id = $1 AND verdict = 'reject' ORDER BY id", [asset.id]);
  return { imagePath: earlier[0].image_path, feedbacks: rows.map((r) => r.feedback) };
}

/** An Asset the Artist did not write at its target path gets this many attempts in all (1 try + 1 more). */
const MAX_UNWRITTEN_ATTEMPTS = 2;
/** An Asset that fails the Asset Checks gets this many attempts in all (1 try + 2 extra). */
const MAX_FAILING_ATTEMPTS = 3;
// The two budgets are counted apart: an attempt that wrote nothing does not use up the failing one.

/**
 * Has the Artist draw one Asset until it passes the Asset Checks, sending it back with the reason when it does not. What
 * was tried is read from the recorded versions, so a restarted Run goes on from there. False when the Run cannot go on
 * (it paused, opened an Escalation, or was abandoned).
 */
async function drawAsset(ctx: WorkflowContext, asset: Asset, artDirection: string, palette: string[] | null): Promise<boolean> {
  const { run, project, pool, worktreePath } = ctx;
  const seat = ctx.agents.artist;
  if (!seat) throw new Error("Forgequor has no Runner for the Artist.");
  for (;;) {
    const { rows: versions } = await pool.query(
      "SELECT written, failures, summary FROM asset_versions WHERE asset_id = $1 AND iteration = $2 ORDER BY id",
      [asset.id, run.iteration],
    );
    const last = versions.at(-1);
    const rejected = await rejectedBefore(ctx, asset, !versions.length);
    let redo: Redo | undefined;
    if (last?.written && !last.failures.length) break;
    if (last && !last.written) {
      if (versions.filter((v) => !v.written).length >= MAX_UNWRITTEN_ATTEMPTS) {
        await ctx.openGate("escalation", `The Artist wrote nothing at the target path of "${asset.name}" (${asset.targetPath}) after ${MAX_UNWRITTEN_ATTEMPTS} attempts.`, last.summary);
        return false;
      }
      redo = { unwritten: true };
    } else if (last) {
      if (versions.filter((v) => v.written && v.failures.length).length >= MAX_FAILING_ATTEMPTS) {
        await ctx.openGate("escalation", `"${asset.name}" still fails the Asset Checks after ${MAX_FAILING_ATTEMPTS} attempts.`, last.failures.join("\n"));
        return false;
      }
      redo = { failures: last.failures };
    }

    const { rows } = await pool.query(
      "SELECT coalesce(max(attempt), 0) + 1 AS attempt FROM step_attempts WHERE run_id = $1 AND iteration = $2 AND asset_id = $3",
      [run.id, run.iteration, asset.id],
    );
    const attempt: number = rows[0].attempt;
    await pool.query("UPDATE assets SET status = 'generating' WHERE id = $1", [asset.id]);
    ctx.changed();

    const { result, timedOut } = await runAgentStep(ctx, seat, {
      name: "artist",
      attempt,
      assetId: asset.id,
      instructions: ARTIST_INSTRUCTIONS,
      prompt: artistPrompt(asset, project.artDirectionPath, artDirection, { redo, rejected }),
    });
    if (!(await ctx.stillRunning())) return false;
    // A Step that finished on its own just as the timeout fired keeps its real result.
    if (timedOut && result.status === "failed") {
      await ctx.openGate("escalation", `The Artist's Step timed out after ${describeDuration(ctx.stepTimeoutMs)} and was killed.`);
      return false;
    }
    if (result.status === "failed") {
      await ctx.openGate("escalation", "The Artist failed.", result.error);
      return false;
    }
    if (result.status === "quota_exhausted") {
      await ctx.pause(result.resetsAt);
      return false;
    }
    await recordVersion(ctx, asset, attempt, result.files ?? [], result.summary, checkAssetFile(worktreePath, asset, palette));
  }
  await pool.query("UPDATE assets SET status = 'waiting' WHERE id = $1", [asset.id]);
  ctx.changed();
  return true;
}

/** The human approved the Asset Gate: commit the Assets, open the pull request with Forgequor's own Review Brief, approve the Run. */
async function finish(ctx: WorkflowContext, assets: Asset[]) {
  const { pool, run, worktreePath } = ctx;
  await pool.query("UPDATE assets SET status = 'approved' WHERE run_id = $1", [run.id]);
  const n = assets.length;
  await commitPaths(worktreePath, assets.map((a) => a.targetPath), `feat(art): add ${n} ${n === 1 ? "asset" : "assets"}`);
  const { rows } = await pool.query(
    "SELECT asset_id, feedback FROM asset_verdicts WHERE verdict = 'reject' AND asset_id = ANY($1) ORDER BY id",
    [assets.map((a) => a.id)],
  );
  const feedbacks = new Map<number, string[]>();
  for (const r of rows) feedbacks.set(Number(r.asset_id), [...(feedbacks.get(Number(r.asset_id)) ?? []), r.feedback]);
  const pr = await publishPullRequest(ctx, () => reviewBrief(assets, feedbacks));
  if (!pr) return;
  await ctx.approve();
}

/** The `assets` Workflow: the Artist draws each Asset in turn, the human judges them at the Asset Gate, then the pull request opens. */
export const assetsWorkflow: Workflow = {
  name: "assets",

  plan(input: RunInput): RunPlan {
    const assets = validateAssetRequests(input.assets);
    const lines = assets.map((a) => `- ${a.name}: ${a.kind} ${size(a)}. ${a.description}`);
    const names = assets.map((a) => a.name).join(", ");
    const title = names.length > 60 ? `Art: ${names.slice(0, 54).trimEnd()}...` : `Art: ${names}`;
    return {
      task: `Draw ${assets.length} ${assets.length === 1 ? "Asset" : "Assets"}:\n${lines.join("\n")}`,
      title: input.title?.trim() || title,
      assets,
    };
  },

  async run(ctx) {
    const { run, project, worktreePath, pool } = ctx;
    const assets = await loadAssets(pool, run.id);

    const todo = assets.filter((a) => a.status === "pending" || a.status === "generating" || a.status === "rejected");
    if (todo.length) {
      const artDirection = readArtDirection(worktreePath, project.artDirectionPath);
      if (artDirection === null) {
        return ctx.openGate(
          "escalation",
          "The Art Direction is missing, so nothing was generated.",
          `Expected a file at ${project.artDirectionPath} in the repository, on its default branch.`,
        );
      }
      const palette = parsePalette(artDirection);
      for (const asset of todo) {
        if (!(await drawAsset(ctx, asset, artDirection, palette))) return;
      }
    }

    const { rows: gates } = await pool.query("SELECT decision FROM gates WHERE run_id = $1 AND kind = 'asset' ORDER BY id DESC LIMIT 1", [run.id]);
    if (gates[0]?.decision === "approve") return finish(ctx, assets);
    if (!(await ctx.stillRunning())) return;
    const waiting = (await loadAssets(pool, run.id)).filter((a) => a.status === "waiting").length;
    await ctx.openGate("asset", `${waiting} ${waiting === 1 ? "Asset is" : "Assets are"} waiting for your verdict.`);
  },
};
