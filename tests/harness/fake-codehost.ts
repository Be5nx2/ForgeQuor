import type { CodeHost, PullRequestInput } from "../../src/codehost/codehost.js";

export interface RecordedPullRequest extends PullRequestInput {
  number: number;
  url: string;
  comments: string[];
}

/** An in-memory GitHub: records the pull requests opened and the comments posted on them. */
export function createFakeCodeHost(): CodeHost & { pullRequests: RecordedPullRequest[]; failWith: (message: string | null) => void } {
  const pullRequests: RecordedPullRequest[] = [];
  let failure: string | null = null;
  return {
    pullRequests,
    failWith: (message) => {
      failure = message;
    },
    async openPullRequest(input) {
      if (failure) throw new Error(failure);
      const number = pullRequests.length + 1;
      const url = `https://github.com/${input.owner}/${input.repo}/pull/${number}`;
      pullRequests.push({ ...input, number, url, comments: [] });
      return { number, url };
    },
    async comment({ number, body }) {
      pullRequests.find((p) => p.number === number)!.comments.push(body);
    },
  };
}
