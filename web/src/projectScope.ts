// The Project the human works in, kept in the URL as the `project` query parameter. Plain functions, no DOM and no Vue,
// so the root tests can load it; router.ts wires `carryProject` into navigation and AppShell reads the rest.

/** What vue-router calls a query: values are text, null (a bare key) or lists of those. */
export type Query = Record<string, string | null | (string | null)[]>;

/** The query key that carries the choice. */
export const PROJECT_QUERY = "project";
/** The explicit "All Projects" value: it keeps the choice of "no Project" through navigation instead of falling back to the last Project. */
export const ALL_PROJECTS = "all";

/** The Project the query names, or null (all Projects) when it names none or something that is not a Project id. */
export function projectIdOf(query: Query): number | null {
  const raw = query[PROJECT_QUERY];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : null;
}

/** Like `projectIdOf`, but a Project that is not registered (any more) counts as "All Projects" instead of an empty screen. */
export function resolveProject(query: Query, projects: readonly { id: number }[]): number | null {
  const id = projectIdOf(query);
  return id !== null && projects.some((p) => p.id === id) ? id : null;
}

/** The query with the choice set; null picks "All Projects". The other keys stay. */
export function withProject(query: Query, projectId: number | null): Query {
  return { ...query, [PROJECT_QUERY]: projectId === null ? ALL_PROJECTS : String(projectId) };
}

/** The query to give a navigation that left the choice out so it survives, or null when the destination already says (or nothing was chosen). */
export function carryProject(from: Query, to: Query): Query | null {
  const chosen = from[PROJECT_QUERY];
  if (chosen === undefined || to[PROJECT_QUERY] !== undefined) return null;
  return { ...to, [PROJECT_QUERY]: chosen };
}

/** What the selector shows for each Project: its name, with the local path when another Project has the same name. */
export function projectLabels(projects: readonly { id: number; name: string; localPath: string }[]): Map<number, string> {
  const uses = new Map<string, number>();
  for (const p of projects) uses.set(p.name, (uses.get(p.name) ?? 0) + 1);
  return new Map(projects.map((p) => [p.id, uses.get(p.name)! > 1 ? `${p.name} (${p.localPath})` : p.name]));
}

/** The items of the chosen Project; all of them when none is chosen. */
export function inProject<T extends { projectId: number }>(items: readonly T[], projectId: number | null): T[] {
  return projectId === null ? [...items] : items.filter((i) => i.projectId === projectId);
}
