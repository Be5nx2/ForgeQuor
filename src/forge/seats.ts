import type { Runner } from "../runner/runner.js";
import type { AgentSeat, WorkflowContext } from "./workflow.js";

/** The tools Forgequor can drive, as an Agent's seat names them. */
export const RUNNER_NAMES = ["claude", "codex"] as const;
export type RunnerName = (typeof RUNNER_NAMES)[number];

/** One seat per Agent: the place its Runner and model are set. */
export const SEAT_NAMES = ["griller", "spec-writer", "architect", "developer", "reviewer-a", "reviewer-b", "consolidator", "artist"] as const;
export type SeatName = (typeof SEAT_NAMES)[number];

/** The Runner each seat works through when nothing says otherwise: Claude Code, except the second Reviewer and the Artist. */
export const DEFAULT_RUNNERS: Record<SeatName, RunnerName> = {
  griller: "claude",
  "spec-writer": "claude",
  architect: "claude",
  developer: "claude",
  "reviewer-a": "claude",
  "reviewer-b": "codex",
  consolidator: "claude",
  artist: "codex",
};

/** What the human set for a seat; `runner` is kept as written so that a wrong name can be told back to them. */
export interface SeatSetting {
  runner?: string;
  model?: string;
  /** One of the Runner's own effort levels; absent means the Runner's default. */
  effort?: string;
}
export type SeatSettings = Partial<Record<SeatName, SeatSetting>>;

/** The environment variable that sets a seat's Runner, model or effort: `FORGEQUOR_REVIEWER_A_RUNNER`, `FORGEQUOR_DEVELOPER_MODEL`, `FORGEQUOR_ARCHITECT_EFFORT`. */
export const seatVariable = (seat: SeatName, setting: "RUNNER" | "MODEL" | "EFFORT") => `FORGEQUOR_${seat.toUpperCase().replace(/-/g, "_")}_${setting}`;

/** The seat settings the environment holds. An empty variable counts as unset. */
export function seatSettingsFromEnv(env: NodeJS.ProcessEnv): SeatSettings {
  const settings: SeatSettings = {};
  for (const seat of SEAT_NAMES) {
    const runner = env[seatVariable(seat, "RUNNER")]?.trim();
    const model = env[seatVariable(seat, "MODEL")]?.trim();
    const effort = env[seatVariable(seat, "EFFORT")]?.trim();
    if (runner || model || effort) settings[seat] = { runner: runner?.toLowerCase() || undefined, model: model || undefined, effort: effort || undefined };
  }
  return settings;
}

/** The seats a Run's Agents work through, and why each seat that has no usable Runner has none. */
export interface Seats {
  agents: Partial<Record<SeatName, AgentSeat>>;
  problems: Partial<Record<SeatName, string>>;
}

/**
 * Gives each seat its Runner: the one it is set to, else its default. A seat whose Runner is unknown, or one Forgequor
 * was not given, is not usable; it is only a problem when a Step needs it, so Workflows that do not use it keep working.
 */
export function buildSeats(runners: Partial<Record<RunnerName, Runner>>, settings: SeatSettings = {}): Seats {
  const agents: Seats["agents"] = {};
  const problems: Seats["problems"] = {};
  for (const seat of SEAT_NAMES) {
    const setting = settings[seat] ?? {};
    const name = setting.runner ?? DEFAULT_RUNNERS[seat];
    if (!RUNNER_NAMES.includes(name as RunnerName)) {
      problems[seat] = `"${name}" is not a Runner; it must be ${RUNNER_NAMES.join(" or ")}`;
      continue;
    }
    const runner = runners[name as RunnerName];
    if (!runner) problems[seat] = `Forgequor has no ${name} Runner`;
    else agents[seat] = { runner, runnerName: name, model: setting.model, effort: setting.effort };
  }
  return { agents, problems };
}

/**
 * The seat's Runner for a Step, or null after opening an Escalation that names the seat and says why it has none
 * (the Step then stops, and the human can fix the setting and retry).
 */
export async function requireSeat(ctx: WorkflowContext, seat: SeatName, agent: string): Promise<AgentSeat | null> {
  const found = ctx.agents[seat];
  if (found) return found;
  const why = ctx.seatProblems?.[seat];
  const variable = seatVariable(seat, "RUNNER");
  await ctx.openGate(
    "escalation",
    `The ${agent} has no usable Runner on seat "${seat}"${why ? ` (${why})` : ""}, so nothing was generated.`,
    `Set the seat's Runner on the Team page (or ${variable}) to claude or codex, and make sure that tool is installed, then retry.`,
  );
  return null;
}
