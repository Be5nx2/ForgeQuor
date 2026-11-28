/** The logic of the Projects screen's destructive actions (purge now), free of DOM and Vue so the root tests can load it. */

/** What a purge button shows and asks, from the server's Archived count. */
export interface PurgeOffer {
  /** Nothing to purge: the button is disabled. */
  disabled: boolean;
  /** The button's text: its action, or "No Archived Run" at zero. */
  label: string;
  /** The simple confirmation, stating how many Runs will go; empty at zero. */
  question: string;
}

const runs = (n: number) => `${n} Archived Run${n === 1 ? "" : "s"}`;

/** The offer of one purge: `scope` is the button's wording ("Purge Archived Runs"), `of` what it covers in the question. */
export function purgeOffer(count: number, scope: string, of: string): PurgeOffer {
  if (count < 1) return { disabled: true, label: "No Archived Run", question: "" };
  return { disabled: false, label: scope, question: `Delete ${runs(count)} ${of} now? This cannot be undone.` };
}

/** How many Archived Runs every Project holds together. */
export function totalArchived(projects: Array<{ archivedRuns: number }>): number {
  return projects.reduce((sum, p) => sum + p.archivedRuns, 0);
}

/** The offer of the global purge (top of the Projects screen). */
export function purgeAllOffer(projects: Array<{ archivedRuns: number }>): PurgeOffer {
  return purgeOffer(totalArchived(projects), "Purge Archived Runs", "of every Project");
}

/** The offer of one Project's purge (its Danger zone). */
export function purgeProjectOffer(project: { name: string; archivedRuns: number }): PurgeOffer {
  return purgeOffer(project.archivedRuns, "Purge its Archived Runs now", `of ${project.name}`);
}

/** What the human reads once a purge is done. */
export function purgedMessage(deleted: number): string {
  return `${runs(deleted)} deleted.`;
}

/** What the removal confirmation needs from the server's removal preview. */
export interface RemovalPreviewLike {
  runs: number;
  activeRuns: Array<{ id: number; title: string; state: string; prNumber: number | null }>;
}

/** What the "Remove this Project" confirmation shows, and whether Remove is enabled. */
export interface RemovalOffer {
  /** Remove is enabled: the typed name matches exactly. */
  canRemove: boolean;
  /** Says how many Runs will be deleted. */
  runsText: string;
  /** One line per active Run the removal will abandon, with the pull request it will close; empty when none. */
  abandons: string[];
}

/** The typed confirmation matches the Project's name exactly (case and spaces count). */
export function nameMatches(project: { name: string }, typed: string): boolean {
  return typed === project.name;
}

/** The offer of "Remove this Project", from the preview read and what the human has typed so far. */
export function removalOffer(project: { name: string }, preview: RemovalPreviewLike, typed: string): RemovalOffer {
  const n = preview.runs;
  const abandons = preview.activeRuns.map((r) => `Run ${r.id} "${r.title}" (${r.state}) will be abandoned${r.prNumber ? `: pull request #${r.prNumber} will be closed` : ""}`);
  return {
    canRemove: nameMatches(project, typed),
    runsText:
      n === 0
        ? `${project.name} has no Run. Removing it forgets its settings only.`
        : `This deletes ${n} Run${n === 1 ? "" : "s"} of ${project.name}, with their Gates, attempts, Assets and Run Notes. The repository stays as it is.`,
    abandons,
  };
}

/** What the Projects screen shows on a Project whose removal began and did not finish. */
export interface InterruptedBanner {
  title: string;
  text: string;
  /** The Retry button's text. */
  retry: string;
}

/** The "Removal interrupted" banner of a marked Project, or null for a Project that is not being removed. Never resumes by itself. */
export function interruptedBanner(project: { name: string; removingSince: string | null }): InterruptedBanner | null {
  if (!project.removingSince) return null;
  return {
    title: "Removal interrupted",
    text: `The removal of ${project.name} stopped before it finished. Nothing starts on this Project until it is removed. What was already abandoned stays abandoned.`,
    retry: "Retry",
  };
}
