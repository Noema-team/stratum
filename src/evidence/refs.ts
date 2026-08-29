// Stable, typed references to repository artefacts produced during execution.
// These travel from executor → evidence collector → Evidence records.

export interface RepoRef {
  provider: 'github';
  remote: string; // e.g. 'github.com/org/repo'
}

export interface BranchRef {
  repo: RepoRef;
  name: string;
}

export interface CommitRef {
  repo: RepoRef;
  sha: string;
}

export interface PrRef {
  repo: RepoRef;
  number: number;
  headSha: string;
  url?: string;
}

// All refs produced by one execution, passed to collectors.
export interface ArtifactRefs {
  commits?: CommitRef[];
  prs?: PrRef[];
  branches?: BranchRef[];
}
