import type pg from "pg";
import type { RunnerCatalog } from "../runner/catalog.js";
import { InvalidInputError, InvalidSeatError, SeatLockedError } from "./errors.js";
import { DEFAULT_RUNNERS, RUNNER_NAMES, SEAT_NAMES, seatVariable, type RunnerName, type SeatName, type SeatSetting, type SeatSettings } from "./seats.js";

export type SettingSource = "env" | "team" | "default";

/** One field of a seat as it is in effect: its value (null means the Runner's own default model), where it comes from, and the variable that locks it. */
export interface EffectiveField {
  value: string | null;
  source: SettingSource;
  /** Set only when the environment holds the field. */
  variable?: string;
}

export interface TeamSeat {
  seat: SeatName;
  runner: EffectiveField;
  model: EffectiveField;
}

export interface Team {
  seats: TeamSeat[];
  /** What each Runner offers: its models and effort levels, and whether the list is the built-in one (the CLI could not be read). */
  catalog: RunnerCatalog;
}

/** What the Team page changes: a field left out stays as it is, null or empty clears it. */
export interface TeamChange {
  runner?: string | null;
  model?: string | null;
}

/** Each field as it is in effect: the environment's, else the Team's, else the default. */
export function effectiveSeats(env: SeatSettings, team: SeatSettings): TeamSeat[] {
  return SEAT_NAMES.map((seat) => {
    const field = (name: keyof SeatSetting, fallback: string | null): EffectiveField => {
      const variable = seatVariable(seat, name === "runner" ? "RUNNER" : "MODEL");
      const fromEnv = env[seat]?.[name];
      if (fromEnv) return { value: fromEnv, source: "env", variable };
      const fromTeam = team[seat]?.[name];
      if (fromTeam) return { value: fromTeam, source: "team" };
      return { value: fallback, source: "default" };
    };
    return { seat, runner: field("runner", DEFAULT_RUNNERS[seat]), model: field("model", null) };
  });
}

/** The refusal for a field the environment holds. */
const lockedMessage = (seat: SeatName, field: "runner" | "model") =>
  `The ${field} of seat "${seat}" is set by ${seatVariable(seat, field === "runner" ? "RUNNER" : "MODEL")}; unset it and restart Forgequor to change it here.`;

/**
 * The per-Run seat overrides a launch gives, checked like the Team page's: an unknown seat or Runner is an
 * InvalidSeatError, a field the environment holds a SeatLockedError. Returns what to keep (empty fields dropped).
 */
export function parseSeatOverrides(env: SeatSettings, given: unknown): SeatSettings {
  if (given === undefined || given === null) return {};
  if (typeof given !== "object" || Array.isArray(given)) throw new InvalidSeatError("seats must map a seat to its runner and/or model.");
  const kept: SeatSettings = {};
  for (const [name, value] of Object.entries(given)) {
    if (!SEAT_NAMES.includes(name as SeatName)) throw new InvalidSeatError(`"${name}" is not a seat; the seats are ${SEAT_NAMES.join(", ")}.`);
    const seat = name as SeatName;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidSeatError(`The override of seat "${seat}" must give a runner and/or a model.`);
    const setting: SeatSetting = {};
    for (const field of ["runner", "model"] as const) {
      const raw = (value as Record<string, unknown>)[field];
      if (raw !== undefined && raw !== null && typeof raw !== "string") throw new InvalidSeatError(`${field} must be text.`);
      if (!raw?.trim()) continue;
      if (env[seat]?.[field]) throw new SeatLockedError(lockedMessage(seat, field));
      const text = field === "runner" ? raw.trim().toLowerCase() : raw.trim();
      if (field === "runner" && !RUNNER_NAMES.includes(text as RunnerName)) throw new InvalidSeatError(`"${text}" is not a Runner; it must be ${RUNNER_NAMES.join(" or ")}.`);
      setting[field] = text;
    }
    if (setting.runner || setting.model) kept[seat] = setting;
  }
  return kept;
}

/** The effective settings with a Run's overrides laid over them, field by field: what the Run freezes. */
export function withOverrides(settings: SeatSettings, overrides: SeatSettings): SeatSettings {
  const merged: SeatSettings = { ...settings };
  for (const seat of SEAT_NAMES) if (overrides[seat]) merged[seat] = { ...merged[seat], ...overrides[seat] };
  return merged;
}

/** The settings that resolve to what `effectiveSeats` says, for `buildSeats`. */
export function settingsOf(seats: TeamSeat[]): SeatSettings {
  const settings: SeatSettings = {};
  for (const s of seats) settings[s.seat] = { runner: s.runner.value ?? undefined, model: s.model.value ?? undefined };
  return settings;
}

/** The Team settings kept in the database, laid under the environment's. */
export interface TeamStore {
  /** Each seat's effective Runner and model, read now. */
  effective(): Promise<TeamSeat[]>;
  /** The effective seats with the Runner Catalog on offer. */
  team(): Promise<Team>;
  /** Saves a seat's Runner and/or model; refuses an unknown seat or Runner, and a field the environment holds. */
  change(seat: string, change: TeamChange): Promise<Team>;
}

export function createTeamStore(pool: pg.Pool, env: SeatSettings, catalog: RunnerCatalog): TeamStore {
  async function saved(): Promise<SeatSettings> {
    const { rows } = await pool.query("SELECT seat, runner, model FROM team_seats");
    const settings: SeatSettings = {};
    for (const r of rows) if (SEAT_NAMES.includes(r.seat)) settings[r.seat as SeatName] = { runner: r.runner ?? undefined, model: r.model ?? undefined };
    return settings;
  }
  const effective = async () => effectiveSeats(env, await saved());
  const team = async (): Promise<Team> => ({ seats: await effective(), catalog });

  async function change(seatName: string, change: TeamChange): Promise<Team> {
    if (!SEAT_NAMES.includes(seatName as SeatName)) throw new InvalidInputError(`"${seatName}" is not a seat; the seats are ${SEAT_NAMES.join(", ")}.`);
    const seat = seatName as SeatName;
    const touchesRunner = change.runner !== undefined;
    const touchesModel = change.model !== undefined;
    if (!touchesRunner && !touchesModel) throw new InvalidInputError("Give a runner and/or a model.");
    for (const field of ["runner", "model"] as const) {
      const given = change[field];
      if (given !== undefined && given !== null && typeof given !== "string") throw new InvalidInputError(`${field} must be text.`);
      if (given !== undefined && env[seat]?.[field]) {
        throw new SeatLockedError(lockedMessage(seat, field));
      }
    }
    const runner = touchesRunner ? change.runner?.trim().toLowerCase() || null : undefined;
    if (runner && !RUNNER_NAMES.includes(runner as RunnerName)) throw new InvalidInputError(`"${runner}" is not a Runner; it must be ${RUNNER_NAMES.join(" or ")}.`);
    const model = touchesModel ? change.model?.trim() || null : undefined;
    // One statement: a field left out keeps its value, so two changes to one seat cannot undo each other.
    await pool.query(
      `INSERT INTO team_seats (seat, runner, model) VALUES ($1, $2, $3)
       ON CONFLICT (seat) DO UPDATE SET runner = CASE WHEN $4 THEN EXCLUDED.runner ELSE team_seats.runner END,
                                        model  = CASE WHEN $5 THEN EXCLUDED.model  ELSE team_seats.model  END`,
      [seat, runner ?? null, model ?? null, touchesRunner, touchesModel],
    );
    return team();
  }

  return { effective, team, change };
}
