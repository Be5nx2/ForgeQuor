/** The targets a Dogfood Note can be about (mirrors DogfoodTarget in api.ts; this module stays free of DOM imports so the root tests can load it). */
type DogfoodTarget = "workflow" | "feature" | "display" | "other";

/** The screens of the app: the single place that says which URL shows which screen. */
export const screens = [
  { name: "waiting", path: "/", label: "Waiting for you", target: "workflow" },
  { name: "new", path: "/new", label: "New Run", target: "workflow" },
  { name: "runs", path: "/runs", label: "Runs", target: "workflow" },
  { name: "run", path: "/runs/:id(\\d+)", tab: "runs", target: "workflow" },
  { name: "projects", path: "/projects", label: "Projects", target: "feature" },
  { name: "project", path: "/projects/:id(\\d+)", tab: "projects", target: "feature" },
  { name: "workflows", path: "/workflows", label: "Workflows", target: "workflow" },
  { name: "team", path: "/team", label: "Team", target: "feature" },
  { name: "inbox", path: "/inbox", label: "Dogfood Inbox", target: "feature" },
] as const satisfies readonly { name: string; path: string; label?: string; tab?: string; target: DogfoodTarget }[];

/** The navigation entries, in order: the screens that have a label. */
export const navTabs = screens.filter((s) => "label" in s);

/** The sidebar's navigation, in order: "New Run" has its own button, so it is not listed here. */
export const sidebarNav = (["waiting", "runs", "projects", "team", "workflows", "inbox"] as const).map((name) => navTabs.find((t) => t.name === name)!);

export interface Place {
  /** The navigation tab to highlight, and the origin tab of a Dogfood Note. */
  tab: string;
  /** The Run in view, when the route names one. */
  runId: number | null;
  /** The Project the route names, when it does. */
  projectId: number | null;
  /** What the screen is most likely about, for the note popup's pre-selected target. */
  target: DogfoodTarget;
}

/** Where a route puts the human; a route that is not a screen (not found) is the "not-found" tab with no Run. */
export function placeOf(routeName: unknown, params: Record<string, unknown> = {}): Place {
  const screen = screens.find((s) => s.name === routeName);
  if (!screen) return { tab: "not-found", runId: null, projectId: null, target: "other" };
  const id = Number(params.id);
  return {
    tab: "tab" in screen ? screen.tab : screen.name,
    runId: screen.name === "run" ? id : null,
    projectId: screen.name === "project" ? id : null,
    target: screen.target,
  };
}
