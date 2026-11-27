import type pg from "pg";
import type { QuotaReading, Runner } from "../runner/runner.js";
import type { Every } from "./clock.js";
import type { QuotaStatus, QuotaVendor, RunUpdate } from "./types.js";

export const QUOTA_VENDORS: QuotaVendor[] = ["claude", "codex"];

/** How often a Runner that can be asked is asked for its Quota, when nothing else prompted it. */
export const QUOTA_REFRESH_MS = 5 * 60 * 1000;

export interface QuotaKeeperDeps {
  pool: pg.Pool;
  now: () => Date;
  every: Every;
  /** Tells the live-events stream about each new reading. */
  emit: (update: RunUpdate) => void;
}

/**
 * Keeps the latest Quota Reading per vendor: stores it (so it survives a restart), pushes it live, and refreshes the
 * vendors whose Runner can be asked for it. Nothing here ever disturbs a Step: a Runner that fails to answer, or a store
 * that fails, is logged and the Step goes on.
 */
export interface QuotaKeeper {
  /** The Runner as it should be used: every Step it finishes records the reading the Step carried and, if the Runner can be asked, refreshes it. */
  watch(vendor: QuotaVendor, runner: Runner): Runner;
  /** Both vendors' latest readings, with how old each is. A vendor never read has a null reading. */
  status(): Promise<QuotaStatus[]>;
  /** Reads the vendors that can be asked now, then again every 5 minutes. Returns the function that stops the refreshing. */
  start(): Promise<() => void>;
  /** Resolves once no reading is being taken. */
  whenIdle(): Promise<void>;
}

function toReading(r: Record<string, any>): QuotaReading {
  return {
    fiveHour: { percentUsed: r.five_hour_percent, resetsAt: r.five_hour_resets_at },
    weekly: { percentUsed: r.weekly_percent, resetsAt: r.weekly_resets_at },
    exhausted: r.exhausted,
    readAt: r.read_at,
  };
}

export function createQuotaKeeper(deps: QuotaKeeperDeps): QuotaKeeper {
  const { pool, now, every, emit } = deps;
  const askable = new Map<QuotaVendor, Runner>();
  const reading = new Map<QuotaVendor, Promise<void>>();
  /** Vendors a Step finished on while they were being read: that reading may predate it, so they are read once more. */
  const again = new Set<QuotaVendor>();

  async function record(vendor: QuotaVendor, r: QuotaReading) {
    await pool.query(
      `INSERT INTO quota_readings (vendor, five_hour_percent, five_hour_resets_at, weekly_percent, weekly_resets_at, exhausted, read_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (vendor) DO UPDATE SET five_hour_percent = $2, five_hour_resets_at = $3, weekly_percent = $4,
         weekly_resets_at = $5, exhausted = $6, read_at = $7`,
      [vendor, r.fiveHour.percentUsed, r.fiveHour.resetsAt, r.weekly.percentUsed, r.weekly.resetsAt, r.exhausted, r.readAt],
    );
    emit({ type: "quota", vendor, reading: r });
  }

  /** Asks the vendor's Runner for a full reading; a request made while one is under way makes it ask once more after. */
  function refresh(vendor: QuotaVendor): Promise<void> {
    const runner = askable.get(vendor);
    if (!runner?.readQuota) return Promise.resolve();
    const active = reading.get(vendor);
    if (active) {
      again.add(vendor);
      return active;
    }
    const task = (async () => {
      do {
        again.delete(vendor);
        try {
          const r = await runner.readQuota!();
          if (r) await record(vendor, r);
        } catch (e) {
          console.error(`Could not read the ${vendor} Quota:`, e);
        }
      } while (again.has(vendor));
    })().finally(() => reading.delete(vendor));
    reading.set(vendor, task);
    return task;
  }

  return {
    watch(vendor, runner) {
      if (runner.readQuota) askable.set(vendor, runner);
      return {
        ...runner,
        async run(step, onEvent) {
          const result = await runner.run(step, onEvent);
          try {
            if (result.quota) await record(vendor, result.quota);
          } catch (e) {
            console.error(`Could not record the ${vendor} Quota:`, e);
          }
          void refresh(vendor);
          return result;
        },
      };
    },

    async status() {
      const { rows } = await pool.query("SELECT * FROM quota_readings");
      const at = now().getTime();
      return QUOTA_VENDORS.map((vendor) => {
        const row = rows.find((r) => r.vendor === vendor);
        const r = row ? toReading(row) : null;
        return { vendor, reading: r, ageSeconds: r ? Math.max(0, Math.round((at - r.readAt.getTime()) / 1000)) : null };
      });
    },

    async start() {
      await Promise.all(QUOTA_VENDORS.map(refresh));
      return every(() => void Promise.all(QUOTA_VENDORS.map(refresh)), QUOTA_REFRESH_MS);
    },

    async whenIdle() {
      while (reading.size) await Promise.all([...reading.values()]);
    },
  };
}
