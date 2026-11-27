import type pg from "pg";
import { InvalidInputError, SeatLockedError } from "./errors.js";
import { DEFAULT_RUNNERS, RUNNER_NAMES, SEAT_NAMES, seatVariable, type RunnerName, type SeatName, type SeatSetting, type SeatSettings } from "./seats.js";

/** The model aliases the Team page offers per Runner. Any other identifier is accepted as typed. */
export const MODEL_ALIASES: Record<RunnerName, string[]> = {
  claude: ["opus", "sonnet", "haiku"],
  codex: ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6-luna"],
};

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
  /** The aliases offered per Runner. */
  models: Record<RunnerName, string[]>;
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
  /** The effective seats with the aliases on offer. */
  team(): Promise<Team>;
  /** Saves a seat's Runner and/or model; refuses an unknown seat or Runner, and a field the environment holds. */
  change(seat: string, change: TeamChange): Promise<Team>;
}

export function createTeamStore(pool: pg.Pool, env: SeatSettings): TeamStore {
  async function saved(): Promise<SeatSettings> {
    const { rows } = await pool.query("SELECT seat, runner, model FROM team_seats");
    const settings: SeatSettings = {};
    for (const r of rows) if (SEAT_NAMES.includes(r.seat)) settings[r.seat as SeatName] = { runner: r.runner ?? undefined, model: r.model ?? undefined };
    return settings;
  }
  const effective = async () => effectiveSeats(env, await saved());
  const team = async (): Promise<Team> => ({ seats: await effective(), models: MODEL_ALIASES });

  async function change(seatName: string, change: TeamChange): Promise<Team> {
    if (!SEAT_NAMES.includes(seatName as SeatName)) throw new InvalidInputError(`"${seatName}" is not a seat; the seats are ${SEAT_NAMES.join(", ")}.`);
    const seat = seatName as SeatName;
    const touchesRunner = change.runner !== undefined;
    const touchesModel = change.model !== undefined;
    if (!touchesRunner && !touchesModel) throw new InvalidInputError("Give a runner and/or a model.");
    for (const [field, name] of [["runner", "RUNNER"], ["model", "MODEL"]] as const) {
      const given = change[field];
      if (given !== undefined && given !== null && typeof given !== "string") throw new InvalidInputError(`${field} must be text.`);
      if (given !== undefined && env[seat]?.[field]) {
        throw new SeatLockedError(`The ${field} of seat "${seat}" is set by ${seatVariable(seat, name)}; unset it and restart Forgequor to change it here.`);
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
