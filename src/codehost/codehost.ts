export interface PullRequestInput {
  owner: string;
  repo: string;
  /** Branch the pull request targets (the Project's default branch). */
  base: string;
  /** Branch holding the work, already pushed. */
  head: string;
  title: string;
  body: string;
}

export interface PullRequestRef {
  number: number;
  url: string;
}

/** The seam between Forge core and a code host (GitHub through `gh`). */
export interface CodeHost {
  /** Opens a pull request, ready for review. Rejects with the host's error message. */
  openPullRequest(input: PullRequestInput): Promise<PullRequestRef>;
  /** Posts a comment on a pull request. */
  comment(input: { owner: string; repo: string; number: number; body: string }): Promise<void>;
}
