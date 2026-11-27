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

export type PullRequestState = "open" | "merged" | "closed";

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
  /** Closes a pull request without merging it. The branch is left alone. */
  closePullRequest(input: { owner: string; repo: string; number: number }): Promise<void>;
  /** Deletes a branch from the remote repository. A branch that is already gone counts as deleted. */
  deleteBranch(input: { owner: string; repo: string; branch: string }): Promise<void>;
  /** Reads whether a pull request is still open, was merged, or was closed without merging. */
  pullRequestState(input: { owner: string; repo: string; number: number }): Promise<PullRequestState>;
}
