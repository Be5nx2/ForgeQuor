import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../../web/src/api.js";
import { effortChoice, effortLevels, effortOptions } from "../../web/src/effort.js";

const catalog: Record<string, CatalogEntry> = {
  claude: { models: [{ id: "opus", efforts: ["low", "high", "max"], defaultEffort: null }], defaultModel: null, efforts: ["low", "high", "max"], fallback: false },
  codex: {
    models: [
      { id: "terra", efforts: ["low", "medium"], defaultEffort: "low" },
      { id: "sol", efforts: ["low", "ultra"], defaultEffort: "low" },
    ],
    defaultModel: "terra",
    efforts: ["low", "medium"],
    fallback: false,
  },
};

describe("effortLevels", () => {
  it("gives the Runner's levels, the model's own when the Catalog knows it, else the default model's", () => {
    expect(effortLevels(catalog, "claude", null)).toEqual(["low", "high", "max"]);
    expect(effortLevels(catalog, "codex", "sol")).toEqual(["low", "ultra"]);
    expect(effortLevels(catalog, "codex", "typed-by-hand")).toEqual(["low", "medium"]);
    expect(effortLevels(catalog, "codex", "")).toEqual(["low", "medium"]);
    expect(effortLevels(catalog, "gemini", null)).toEqual([]);
  });
});

describe("effortChoice", () => {
  it("accepts the Runner default (nothing picked) and a level that fits", () => {
    expect(effortChoice(catalog, "codex", "sol", "").invalid).toBeNull();
    expect(effortChoice(catalog, "codex", "sol", null).invalid).toBeNull();
    expect(effortChoice(catalog, "codex", "sol", "ultra")).toEqual({ levels: ["low", "ultra"], invalid: null });
  });

  it("flags a level the current Runner or model no longer accepts, naming what is accepted", () => {
    const changedModel = effortChoice(catalog, "codex", "terra", "ultra");
    const changedRunner = effortChoice(catalog, "claude", "", "ultra");

    expect(changedModel.invalid).toMatch(/"ultra" is not an effort level of codex with model terra; pick low, medium or Runner default/);
    expect(changedRunner.invalid).toMatch(/of claude; pick low, high, max/);
  });
});

describe("effortOptions", () => {
  it("lists the levels, and keeps an invalid pick in view rather than dropping it", () => {
    expect(effortOptions(effortChoice(catalog, "codex", "terra", "low"), "low")).toEqual(["low", "medium"]);
    expect(effortOptions(effortChoice(catalog, "codex", "terra", "ultra"), "ultra")).toEqual(["ultra", "low", "medium"]);
  });
});
