import { describe, expect, it } from "vitest";
import { envEffortFaults, seatSettingsFromEnv } from "../../src/forge/seats.js";
import { fallbackCatalog } from "../../src/runner/catalog.js";

/** The startup check on environment efforts: a pure answer from the environment's settings and the Catalog. */

const catalog = () => {
  const c = fallbackCatalog();
  c.codex = {
    models: [
      { id: "gpt-terra", efforts: ["low", "high"], defaultEffort: "low" },
      { id: "gpt-sol", efforts: ["low", "ultra"], defaultEffort: "low" },
    ],
    defaultModel: "gpt-terra",
    efforts: ["low", "high"],
    fallback: false,
  };
  return c;
};
const faults = (env: Record<string, string>) => envEffortFaults(seatSettingsFromEnv(env), catalog());

describe("envEffortFaults", () => {
  it("is fine with no effort, an empty one, or levels the Seats can run", () => {
    expect(faults({})).toEqual([]);
    expect(faults({ FORGEQUOR_DEVELOPER_EFFORT: "  " })).toEqual([]);
    expect(faults({ FORGEQUOR_DEVELOPER_EFFORT: "max", FORGEQUOR_REVIEWER_B_MODEL: "gpt-sol", FORGEQUOR_REVIEWER_B_EFFORT: "ultra" })).toEqual([]);
  });

  it("names the variable and the accepted levels of a level the Seat's default Runner cannot run", () => {
    const [fault, ...rest] = faults({ FORGEQUOR_DEVELOPER_EFFORT: "ultra" });
    expect(rest).toEqual([]);
    expect(fault).toMatch(/^FORGEQUOR_DEVELOPER_EFFORT: .*low, medium, high, xhigh, max/);
  });

  it("checks against the environment's Runner and model, and lists every fault", () => {
    const found = faults({ FORGEQUOR_REVIEWER_A_RUNNER: "codex", FORGEQUOR_REVIEWER_A_EFFORT: "max", FORGEQUOR_REVIEWER_B_MODEL: "gpt-sol", FORGEQUOR_REVIEWER_B_EFFORT: "high" });
    expect(found).toHaveLength(2);
    expect(found[0]).toMatch(/^FORGEQUOR_REVIEWER_A_EFFORT: .*low, high/);
    expect(found[1]).toMatch(/^FORGEQUOR_REVIEWER_B_EFFORT: .*gpt-sol.*low, ultra/);
  });

  it("skips a Seat whose environment Runner is not a known Runner", () => {
    expect(faults({ FORGEQUOR_DEVELOPER_RUNNER: "gemini", FORGEQUOR_DEVELOPER_EFFORT: "turbo" })).toEqual([]);
  });
});
