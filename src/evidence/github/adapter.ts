// GitHubAdapter — seam between the evidence layer and the GitHub API.
// Concrete implementations call the REST API or use the GitHub MCP tools;
// tests inject a stub.

export interface WorkflowRunSummary {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface GithubCiStatus {
  sha: string;
  // Overall conclusion across all workflow runs for this SHA.
  // null means still pending.
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'pending' | null;
  workflowRuns: WorkflowRunSummary[];
}

export interface ReviewSummary {
  author: string;
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed';
  submittedAt: string;
}

export interface GithubReviewStatus {
  prNumber: number;
  approved: boolean;
  changesRequested: boolean;
  reviews: ReviewSummary[];
}

export interface GitHubAdapter {
  getCiStatus(remote: string, sha: string): Promise<GithubCiStatus>;
  getReviewStatus(remote: string, prNumber: number): Promise<GithubReviewStatus>;
}
