import { describe, expect, it } from "vitest";
import { changedSections, commandsOf, draftOf, projectSubtitle, selectProject, slotsLabel } from "../../web/src/projectsForm.js";

const project = {
  id: 1,
  checks: ["npm test"],
  setup: ["npm ci"],
  maxConcurrentRuns: 2,
  artDirectionPath: "docs/ART.md",
  artFolder: "assets/art",
  skillPacks: ["godot"],
};

describe("changedSections", () => {
  it("is empty for an untouched draft", () => {
    expect(changedSections(project, draftOf(project))).toEqual([]);
  });

  it("ignores blank rows and padding in command lists", () => {
    const d = draftOf(project);
    d.checks = [" npm test ", ""];
    expect(changedSections(project, d)).toEqual([]);
  });

  it("names each edited section, in save order", () => {
    const d = draftOf(project);
    d.skillPacks = [];
    d.artFolder = "art";
    d.maxConcurrentRuns = 3;
    d.setup = ["npm ci", "npm run gen"];
    d.checks = [];
    expect(changedSections(project, d)).toEqual(["checks", "setup", "concurrency", "art", "skillPacks"]);
  });

  it("does not share its lists with the project", () => {
    const d = draftOf(project);
    d.checks.push("lint");
    expect(project.checks).toEqual(["npm test"]);
  });
});

describe("commandsOf", () => {
  it("drops blank rows", () => {
    expect(commandsOf(["a", "  ", "b "])).toEqual(["a", "b"]);
  });
});

describe("selectProject", () => {
  const list = [{ id: 4 }, { id: 9 }];
  it("takes the first Project when the URL names none", () => {
    expect(selectProject(list, undefined)).toEqual({ id: 4 });
  });
  it("takes the named Project", () => {
    expect(selectProject(list, 9)).toEqual({ id: 9 });
  });
  it("returns null for an unknown id or an empty list", () => {
    expect(selectProject(list, 5)).toBeNull();
    expect(selectProject([], undefined)).toBeNull();
  });
});

describe("labels", () => {
  it("pluralises slots", () => {
    expect(slotsLabel(1)).toBe("1 slot");
    expect(slotsLabel(2)).toBe("2 slots");
  });
  it("joins path and slots", () => {
    expect(projectSubtitle({ localPath: "/g/sky", maxConcurrentRuns: 2 })).toBe("/g/sky · 2 slots");
  });
});
