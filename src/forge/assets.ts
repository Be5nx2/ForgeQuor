import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type pg from "pg";
import { describeDuration } from "../duration.js";
import { publishPullRequest } from "./publish.js";
import { runAgentStep } from "./step.js";
import type { RunInput, RunPlan, Workflow, WorkflowContext } from "./workflow.js";
import { commitPaths, RUN_NOTES_DIR, slugify } from "./workspace.js";

export type AssetKind = "sprite" | "tile";
/** Where an Asset is: not drawn yet, being drawn, drawn and waiting for the human's verdict, or approved. */
export type AssetStatus = "pending" | "generating" | "waiting" | "approved";

/** The human's description of one Asset to produce. */
export interface AssetRequest {
  name: string;
  kind: AssetKind;
  description: string;
  width: number;
  height: number;
}

export interface Asset extends AssetRequest {
  id: number;
  /** Order in which the Artist handles the Run's Assets, from 0. */
  position: number;
  /** Where the Artist writes the final Asset, relative to the Run's worktree. */
  targetPath: string;
  status: AssetStatus;
}

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
    return { name, kind: raw.kind, description, width, height };
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
    targetPath: r.target_path,
    status: r.status,
  };
}

async function loadAssets(pool: pg.Pool, runId: number): Promise<Asset[]> {
  const { rows } = await pool.query("SELECT * FROM assets WHERE run_id = $1 ORDER BY position", [runId]);
  return rows.map(toAsset);
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
- Use a transparent background.
- Do not commit anything.
- When you are done, say in one or two sentences what you saved.`;

/** The Artist's prompt for one Asset. */
export function artistPrompt(asset: Asset, artDirectionPath: string, artDirection: string): string {
  return `Asset to draw: ${asset.name}
Kind: ${asset.kind}
Size: ${size(asset)} pixels
Target path: ${asset.targetPath}

What it shows:
${asset.description}

Art Direction (${artDirectionPath}):
${artDirection}`;
}

/** The Art Direction text, or null when the Project has none at its path. */
function readArtDirection(worktreePath: string, path: string): string | null {
  const file = join(worktreePath, path);
  return existsSync(file) && statSync(file).isFile() ? readFileSync(file, "utf8") : null;
}

/** The Review Brief of an `assets` Run: Forgequor writes it from what it stored, no Agent is involved. */
function reviewBrief(assets: Asset[]): string {
  const rows = assets.map((a) => `| \`${a.targetPath}\` | ${a.name} | ${a.kind} | ${size(a)} |`);
  return [
    "## Assets",
    "",
    `${assets.length} ${assets.length === 1 ? "Asset" : "Assets"} drawn by the Artist and approved by the human at the Asset Gate.`,
    "",
    "| Path | Name | Kind | Size |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

/** Keeps the Runner's raw images in the Run Notes, as a trace, and records them as this attempt's version of the Asset. */
async function keepTrace(ctx: WorkflowContext, asset: Asset, attempt: number, files: string[]) {
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
  await ctx.pool.query("INSERT INTO asset_versions (asset_id, iteration, attempt, raw_images) VALUES ($1, $2, $3, $4)", [
    asset.id,
    ctx.run.iteration,
    attempt,
    JSON.stringify(kept),
  ]);
}

/** One Artist Step for one Asset. False when the Run cannot go on (it paused, opened an Escalation, or was abandoned). */
async function drawAsset(ctx: WorkflowContext, asset: Asset, artDirection: string): Promise<boolean> {
  const { run, project, pool, worktreePath } = ctx;
  const seat = ctx.agents.artist;
  if (!seat) throw new Error("Forgequor has no Runner for the Artist.");
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
    prompt: artistPrompt(asset, project.artDirectionPath, artDirection),
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

  await keepTrace(ctx, asset, attempt, result.files ?? []);
  if (!servableAssetFile(worktreePath, asset.targetPath)) {
    await ctx.openGate("escalation", `The Artist wrote no PNG at the target path of "${asset.name}" (${asset.targetPath}).`, result.summary);
    return false;
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
  const pr = await publishPullRequest(ctx, () => reviewBrief(assets));
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

    const todo = assets.filter((a) => a.status === "pending" || a.status === "generating");
    if (todo.length) {
      const artDirection = readArtDirection(worktreePath, project.artDirectionPath);
      if (artDirection === null) {
        return ctx.openGate(
          "escalation",
          "The Art Direction is missing, so nothing was generated.",
          `Expected a file at ${project.artDirectionPath} in the repository, on its default branch.`,
        );
      }
      for (const asset of todo) {
        if (!(await drawAsset(ctx, asset, artDirection))) return;
      }
    }

    const { rows: gates } = await pool.query("SELECT decision FROM gates WHERE run_id = $1 AND kind = 'asset' ORDER BY id DESC LIMIT 1", [run.id]);
    if (gates[0]?.decision === "approve") return finish(ctx, assets);
    if (!(await ctx.stillRunning())) return;
    const waiting = assets.length;
    await ctx.openGate("asset", `${waiting} ${waiting === 1 ? "Asset is" : "Assets are"} waiting for your verdict.`);
  },
};
