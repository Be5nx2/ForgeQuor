import { describe, expect, it } from "vitest";
import { carryProject, inProject, projectIdOf, projectLabels, resolveProject, withProject, type Query } from "../../web/src/projectScope.js";

describe("project scope in the URL", () => {
  it("reads a Project id and treats anything else as all Projects", () => {
    expect(projectIdOf({ project: "7" })).toBe(7);
    expect(projectIdOf({ project: ["3", "4"] })).toBe(3);
    for (const bad of <Query[]>[{}, { project: "all" }, { project: "0" }, { project: "-2" }, { project: "1.5" }, { project: "x" }, { project: null }]) {
      expect(projectIdOf(bad)).toBeNull();
    }
  });

  it("falls back to all Projects when the named Project is not registered", () => {
    expect(resolveProject({ project: "2" }, [{ id: 2 }])).toBe(2);
    expect(resolveProject({ project: "9" }, [{ id: 2 }])).toBeNull();
    expect(resolveProject({ project: "2" }, [])).toBeNull();
  });

  it("sets the choice and keeps the other query keys", () => {
    expect(withProject({ tab: "x" }, 5)).toEqual({ tab: "x", project: "5" });
    expect(withProject({ project: "5" }, null)).toEqual({ project: "all" });
  });

  it("carries the choice to a destination that does not say, never over one that does", () => {
    expect(carryProject({ project: "5" }, {})).toEqual({ project: "5" });
    expect(carryProject({ project: "all", x: "1" }, { y: "2" })).toEqual({ y: "2", project: "all" });
    expect(carryProject({ project: "5" }, { project: "6" })).toBeNull();
    expect(carryProject({}, { y: "2" })).toBeNull();
  });

  it("labels same-named Projects with their path only", () => {
    const labels = projectLabels([
      { id: 1, name: "Game", localPath: "/a" },
      { id: 2, name: "Game", localPath: "/b" },
      { id: 3, name: "Tools", localPath: "/c" },
    ]);
    expect([...labels.values()]).toEqual(["Game (/a)", "Game (/b)", "Tools"]);
  });

  it("narrows items to the chosen Project", () => {
    const items = [{ projectId: 1, n: "a" }, { projectId: 2, n: "b" }];
    expect(inProject(items, 2)).toEqual([items[1]]);
    expect(inProject(items, null)).toEqual(items);
  });
});
