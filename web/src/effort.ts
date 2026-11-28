import type { CatalogEntry } from "./api.js";

/** What an effort select offers for one Seat, and whether the level now picked still fits. */
export interface EffortChoice {
  /** The Runner's own levels for the Seat's current Runner and model: the options after "Runner default". */
  levels: string[];
  /** Why the picked level no longer fits (a Runner or model that does not accept it); null when it fits or none is picked. */
  invalid: string | null;
}

/** The levels a Runner and model accept: the model's own when the Catalog knows it, else the default model's (as the server does). */
export function effortLevels(catalog: Record<string, CatalogEntry> | undefined, runner: string, model: string | null | undefined): string[] {
  const entry = catalog?.[runner];
  if (!entry) return [];
  return entry.models.find((m) => m.id === model)?.efforts ?? entry.efforts;
}

/**
 * The effort select of one Seat: the levels on offer, recomputed from its current Runner and model, and the picked level
 * flagged invalid (never silently dropped) when they no longer accept it. Empty `picked` is the Runner's default.
 */
export function effortChoice(catalog: Record<string, CatalogEntry> | undefined, runner: string, model: string | null | undefined, picked: string | null | undefined): EffortChoice {
  const levels = effortLevels(catalog, runner, model);
  if (!picked || levels.includes(picked)) return { levels, invalid: null };
  return { levels, invalid: `"${picked}" is not an effort level of ${runner}${model ? ` with model ${model}` : ""}; pick ${levels.join(", ")} or Runner default.` };
}

/** The options of the select: the picked level is kept in the list when invalid so the select still shows it. */
export function effortOptions(choice: EffortChoice, picked: string | null | undefined): string[] {
  return picked && choice.invalid ? [picked, ...choice.levels] : choice.levels;
}
