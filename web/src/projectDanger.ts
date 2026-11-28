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
