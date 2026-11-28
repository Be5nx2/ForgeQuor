import { describe, expect, it } from "vitest";
import { navTabs, placeOf, screens, sidebarNav } from "../../web/src/navigation.js";

describe("placeOf", () => {
  it("puts the Runs home on the Runs tab", () => {
    expect(placeOf("runs")).toEqual({ tab: "runs", runId: null, projectId: null, target: "workflow" });
  });

  it("takes the Run from a Run route and keeps the Runs tab", () => {
    expect(placeOf("run", { id: "42" })).toEqual({ tab: "runs", runId: 42, projectId: null, target: "workflow" });
  });

  it("takes the Project from a Project route and keeps the Projects tab", () => {
    expect(placeOf("project", { id: "7" })).toEqual({ tab: "projects", runId: null, projectId: 7, target: "feature" });
  });

  it("gives the list screens no Run", () => {
    expect(placeOf("runs").runId).toBeNull();
    expect(placeOf("inbox")).toMatchObject({ tab: "inbox", target: "feature" });
  });

  it("names the not-found screen with a tab the note API accepts", () => {
    expect(placeOf("not-found")).toEqual({ tab: "not-found", runId: null, projectId: null, target: "other" });
  });
});

describe("screens", () => {
  it("lists the navigation in the established order, one URL each", () => {
    expect(navTabs.map((t) => [t.name, t.path])).toEqual([
      ["new", "/new"],
      ["runs", "/runs"],
      ["projects", "/projects"],
      ["workflows", "/workflows"],
      ["team", "/team"],
      ["inbox", "/inbox"],
    ]);
  });

  it("lists the sidebar entries in order, without New Run (its own button)", () => {
    expect(sidebarNav.map((t) => t.label)).toEqual(["Runs", "Projects", "Team", "Workflows", "Dogfood Inbox"]);
  });

  it("has unique names and paths", () => {
    expect(new Set(screens.map((s) => s.name)).size).toBe(screens.length);
    expect(new Set(screens.map((s) => s.path)).size).toBe(screens.length);
  });
});
