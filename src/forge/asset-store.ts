import type pg from "pg";
import { replacedCopyPath, servableAssetFile } from "./asset-files.js";
import { AssetNotFoundError } from "./errors.js";
import type { Asset, AssetRequest, AssetStatus, GateVerdict, Verdict } from "./types.js";

/** An error in the verdicts the human gave. */
export class VerdictError extends Error {}

/** A version that passed the Asset Checks (the last of each Iteration is the one the human judges). */
const PASSING = "v.written AND jsonb_array_length(v.failures) = 0";

function toAsset(r: Record<string, any>): Asset {
  return {
    id: Number(r.id),
    position: r.position,
    name: r.name,
    kind: r.kind,
    description: r.description,
    width: r.width,
    height: r.height,
    fill: r.fill,
    frames: r.frames,
    references: r.style_references,
    replace: r.replace,
    targetPath: r.target_path,
    status: r.status,
    warnings: r.warnings ?? [],
    versions: [],
    attempts: [],
  };
}

/** One recorded Artist attempt at an Asset, as the Artist step reads it back to know where to go on. */
export interface RecordedAttempt {
  /** When it was recorded. */
  at: Date;
  written: boolean;
  failures: string[];
  summary: string;
}

/** What an Artist attempt leaves of itself for the human and for the next attempt. */
export interface NewVersion {
  assetId: number;
  iteration: number;
  attempt: number;
  rawImages: string[];
  written: boolean;
  failures: string[];
  warnings: string[];
  summary: string;
  imagePath: string | null;
}

/**
 * Every query on the Asset tables (assets, asset_versions, asset_verdicts), and the only place that knows them. The
 * Forge core never sees one: what it needs of Assets comes through the Asset extension's interface.
 */
export interface AssetStore {
  /** Writes a Run's Asset Requests as Asset rows, inside the launch transaction. */
  insertRequests(client: pg.PoolClient, runId: number, requests: AssetRequest[], targetPath: (a: AssetRequest) => string): Promise<void>;
  /** A Run's Assets, in order, each with the warnings of its latest version, the versions the human saw and every attempt. */
  load(runId: number): Promise<Asset[]>;
  setStatus(assetId: number, status: AssetStatus): Promise<void>;
  /** Every Asset of the Run is approved. */
  approveAll(runId: number): Promise<void>;
  /** The Artist attempts at an Asset in one Iteration, oldest first. */
  attemptsIn(assetId: number, iteration: number): Promise<RecordedAttempt[]>;
  /** The next Step attempt number of an Asset in an Iteration. */
  nextStepAttempt(runId: number, iteration: number, assetId: number): Promise<number>;
  addVersion(version: NewVersion): Promise<void>;
  /** The image path of the latest passing version of an earlier Iteration, or null. */
  earlierPassingImage(assetId: number, beforeIteration: number): Promise<string | null>;
  /** The Feedback of every rejection of an Asset, oldest first. */
  rejectionFeedbacks(assetId: number): Promise<string[]>;
  /** The same for several Assets at once; an Asset never rejected is absent. */
  rejectionFeedbacksOf(assetIds: number[]): Promise<Map<number, string[]>>;

  /**
   * Checks the verdicts given at an Asset Gate against the Assets waiting for one: a verdict for each of them, all at
   * once, none twice, a Feedback for each rejection. Throws a VerdictError saying what is wrong.
   */
  checkVerdicts(runId: number, given: unknown): Promise<Verdict[]>;
  /** Records the verdicts of a decided Asset Gate and moves each Asset to approved or rejected. Run inside the decision's transaction. */
  recordVerdicts(client: pg.PoolClient, gateId: number, verdicts: Verdict[]): Promise<void>;
  gateVerdicts(gateIds: number[]): Promise<Map<number, GateVerdict[]>>;

  /**
   * The file of an Asset's current image, or of one of its past versions, as an absolute path: only what this Run recorded
   * for that Asset, only a PNG, only inside the Run's worktree. Throws an AssetNotFoundError otherwise.
   */
  imageFile(runId: number, assetId: number, which?: number | "replaced"): Promise<string>;
}

export function createAssetStore(pool: pg.Pool): AssetStore {
  return {
    async insertRequests(client, runId, requests, targetPath) {
      for (const [position, a] of requests.entries()) {
        await client.query(
          `INSERT INTO assets (run_id, position, name, kind, description, width, height, fill, frames, style_references, replace, target_path)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [runId, position, a.name, a.kind, a.description, a.width, a.height, a.fill === true, a.frames ?? 1, JSON.stringify(a.references ?? []), a.replace === true, targetPath(a)],
        );
      }
    },

    async load(runId) {
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
      const { rows: attempts } = await pool.query(
        "SELECT asset_id, iteration, attempt, written, failures, warnings FROM asset_versions WHERE asset_id = ANY($1) ORDER BY id",
        [assets.map((a) => a.id)],
      );
      for (const v of attempts) {
        assets.find((a) => a.id === Number(v.asset_id))!.attempts.push({
          iteration: v.iteration,
          attempt: v.attempt,
          written: v.written,
          failures: v.failures,
          warnings: v.warnings,
        });
      }
      return assets;
    },

    async setStatus(assetId, status) {
      await pool.query("UPDATE assets SET status = $2 WHERE id = $1", [assetId, status]);
    },

    async approveAll(runId) {
      await pool.query("UPDATE assets SET status = 'approved' WHERE run_id = $1", [runId]);
    },

    async attemptsIn(assetId, iteration) {
      const { rows } = await pool.query("SELECT written, failures, summary, created_at AS at FROM asset_versions WHERE asset_id = $1 AND iteration = $2 ORDER BY id", [
        assetId,
        iteration,
      ]);
      return rows;
    },

    async nextStepAttempt(runId, iteration, assetId) {
      const { rows } = await pool.query(
        "SELECT coalesce(max(attempt), 0) + 1 AS attempt FROM step_attempts WHERE run_id = $1 AND iteration = $2 AND asset_id = $3",
        [runId, iteration, assetId],
      );
      return rows[0].attempt;
    },

    async addVersion(v) {
      await pool.query(
        `INSERT INTO asset_versions (asset_id, iteration, attempt, raw_images, written, failures, warnings, summary, image_path)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [v.assetId, v.iteration, v.attempt, JSON.stringify(v.rawImages), v.written, JSON.stringify(v.failures), JSON.stringify(v.warnings), v.summary, v.imagePath],
      );
    },

    async earlierPassingImage(assetId, beforeIteration) {
      const { rows } = await pool.query(
        `SELECT v.image_path FROM asset_versions v WHERE v.asset_id = $1 AND v.iteration < $2 AND ${PASSING} AND v.image_path IS NOT NULL
         ORDER BY v.id DESC LIMIT 1`,
        [assetId, beforeIteration],
      );
      return rows[0]?.image_path ?? null;
    },

    async rejectionFeedbacks(assetId) {
      const { rows } = await pool.query("SELECT feedback FROM asset_verdicts WHERE asset_id = $1 AND verdict = 'reject' ORDER BY id", [assetId]);
      return rows.map((r) => r.feedback);
    },

    async rejectionFeedbacksOf(assetIds) {
      const { rows } = await pool.query("SELECT asset_id, feedback FROM asset_verdicts WHERE verdict = 'reject' AND asset_id = ANY($1) ORDER BY id", [assetIds]);
      const byAsset = new Map<number, string[]>();
      for (const r of rows) byAsset.set(Number(r.asset_id), [...(byAsset.get(Number(r.asset_id)) ?? []), r.feedback]);
      return byAsset;
    },

    async checkVerdicts(runId, given) {
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
    },

    async recordVerdicts(client, gateId, verdicts) {
      for (const v of verdicts) {
        await client.query(
          `INSERT INTO asset_verdicts (gate_id, asset_id, version_id, verdict, feedback)
           VALUES ($1, $2, (SELECT v.id FROM asset_versions v WHERE v.asset_id = $2 AND ${PASSING} ORDER BY v.id DESC LIMIT 1), $3, $4)`,
          [gateId, v.assetId, v.action, v.feedback ?? null],
        );
        await client.query("UPDATE assets SET status = $2 WHERE id = $1", [v.assetId, v.action === "approve" ? "approved" : "rejected"]);
      }
    },

    async gateVerdicts(gateIds) {
      const { rows } = await pool.query("SELECT * FROM asset_verdicts WHERE gate_id = ANY($1) ORDER BY id", [gateIds]);
      const byGate = new Map<number, GateVerdict[]>();
      for (const r of rows) {
        const list = byGate.get(Number(r.gate_id)) ?? [];
        list.push({ assetId: Number(r.asset_id), verdict: r.verdict, feedback: r.feedback });
        byGate.set(Number(r.gate_id), list);
      }
      return byGate;
    },

    async imageFile(runId, assetId, which) {
      const versionId = which === "replaced" ? undefined : which;
      const { rows } = which === "replaced"
        ? await pool.query(
            "SELECT $3::text AS path, r.worktree_path FROM assets a JOIN runs r ON r.id = a.run_id WHERE a.id = $1 AND a.run_id = $2 AND a.replace",
            [assetId, runId, replacedCopyPath(assetId)],
          )
        : versionId === undefined
        ? await pool.query(
            "SELECT a.target_path AS path, r.worktree_path FROM assets a JOIN runs r ON r.id = a.run_id WHERE a.id = $1 AND a.run_id = $2",
            [assetId, runId],
          )
        : await pool.query(
            `SELECT v.image_path AS path, r.worktree_path FROM asset_versions v JOIN assets a ON a.id = v.asset_id JOIN runs r ON r.id = a.run_id
             WHERE v.id = $3 AND a.id = $1 AND a.run_id = $2`,
            [assetId, runId, versionId],
          );
      const file = rows[0]?.path && rows[0].worktree_path && servableAssetFile(rows[0].worktree_path, rows[0].path);
      if (!file) throw new AssetNotFoundError(`No such Asset ${assetId} in Run ${runId}, or it has no image yet.`);
      return file;
    },
  };
}

/** The Feedback of an Asset Gate's rejected verdicts, one `name: Feedback` line each; null when it rejected nothing. */
export function verdictFeedback(verdicts: GateVerdict[], assets: Asset[]): string | null {
  const lines = verdicts
    .filter((v) => v.verdict === "reject")
    .map((v) => `${assets.find((a) => a.id === v.assetId)?.name ?? `Asset ${v.assetId}`}: ${v.feedback}`);
  return lines.join("\n") || null;
}
