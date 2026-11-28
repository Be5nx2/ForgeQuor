/** The logic of the Projects screen's form, free of DOM and Vue so the root tests can load it. */

/** The parts of a Project the form edits (a structural subset of the API's Project). */
export interface ProjectFields {
  id: number;
  checks: string[];
  setup: string[];
  maxConcurrentRuns: number;
  artDirectionPath: string;
  artFolder: string;
  skillPacks: string[];
}

/** What the human is editing for one Project: command lists as rows, one command per row. */
export interface Draft {
  checks: string[];
  setup: string[];
  maxConcurrentRuns: number;
  artDirectionPath: string;
  artFolder: string;
  skillPacks: string[];
}

/** The independent saves a Project has; each maps to one API call. */
export type Section = "checks" | "setup" | "concurrency" | "art" | "skillPacks";

export function draftOf(p: ProjectFields): Draft {
  return {
    checks: [...p.checks],
    setup: [...p.setup],
    maxConcurrentRuns: p.maxConcurrentRuns,
    artDirectionPath: p.artDirectionPath,
    artFolder: p.artFolder,
    skillPacks: [...p.skillPacks],
  };
}

/** The commands a list of rows stands for: blank rows are dropped. */
export function commandsOf(rows: string[]): string[] {
  return rows.map((r) => r.trim()).filter((r) => r !== "");
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** The sections whose draft differs from what is saved, in the order they are saved. */
export function changedSections(p: ProjectFields, d: Draft): Section[] {
  const out: Section[] = [];
  if (!sameList(commandsOf(d.checks), p.checks)) out.push("checks");
  if (!sameList(commandsOf(d.setup), p.setup)) out.push("setup");
  if (Number(d.maxConcurrentRuns) !== p.maxConcurrentRuns) out.push("concurrency");
  if (d.artDirectionPath !== p.artDirectionPath || d.artFolder !== p.artFolder) out.push("art");
  if (!sameList(d.skillPacks, p.skillPacks)) out.push("skillPacks");
  return out;
}

/** The Project a URL selects: the one it names, else the first; null when there is none (or the named one does not exist). */
export function selectProject<T extends { id: number }>(projects: T[], id: number | undefined): T | null {
  if (id === undefined) return projects[0] ?? null;
  return projects.find((p) => p.id === id) ?? null;
}

/** "2 slots": how many Runs a Project may run at once. */
export function slotsLabel(max: number): string {
  return `${max} ${max === 1 ? "slot" : "slots"}`;
}

/** The list's second line: where the repository is and its slots. */
export function projectSubtitle(p: { localPath: string; maxConcurrentRuns: number }): string {
  return `${p.localPath} · ${slotsLabel(p.maxConcurrentRuns)}`;
}
