// DDR-041 — trusted Definition → execution handoff.
//
// E5 preflight (static, at main 4607af8) falsified H1: define-work commits
// .sle/work/<wi>/definition.md and stops; full-build work items receive a
// caller-authored goal and builder context assembled from project-doc
// slices. NOTHING connects the two authority chains — the only ways to pass
// a Definition into execution were operator paraphrase, a "read this path"
// pointer, or manual copying, all forbidden.
//
// This module is the narrow fix: the execution WorkItem carries an exact
// reference to the source define-work WorkItem
//
//   workflowParameters: { definitionSource: { workItemId: <A> } }
//
// which the SYSTEM (never the model, never a filename search) resolves at
// dispatch through the existing D.1 artifact-provenance chain — the same
// discipline resolveCheckpointDecisionRequests already uses for dynamic
// decision requests:
//
//   source WorkItem exists (same project, matching Objective, completed)
//     → latest-per-ref Artifact rows for that WorkItem
//     → exactly one of type 'definition' (zero or many ⇒ fail closed)
//     → recorded path is safe and canonical
//     → on-disk bytes hash-match the recorded sha256 (post-commit mutation
//       fails closed)
//     → bytes parse as a canonical Definition
//     → bytes fit the authoritative-context boundary (explicit failure, never
//       silent truncation)
//
// The reference is frozen into WorkflowRun.resolvedParameters at initial
// dispatch (the engine never re-reads it from the WorkItem on resume), and
// the sha256 pin proves byte-identical authority across resume without
// re-selection. Identity is never inferred from filename, recency, title,
// or Objective similarity — a caller supplies the exact id; Stratum
// validates it or fails closed.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import type { WorkItemRepository, ArtifactRepository } from '../storage/repositories.js';
import { toSafeRelativePath } from '../path-safety.js';
import { parseDefinition } from '../workflow/methodology/definition-artifact.js';

/** Hard boundary for authoritative context. Fail explicitly; never truncate. */
export const MAX_AUTHORITATIVE_DEFINITION_BYTES = 131_072;

export interface DefinitionSourceRef {
  workItemId: string;
}

/** The resolved, integrity-pinned authoritative Definition for an execution run. */
export interface ResolvedDefinitionSource {
  sourceWorkItemId: string;
  artifactId: string;
  ref: string | null;
  path: string;
  sha256: string;
  content: string;
}

export interface DefinitionSourceFailure {
  code: string;
  message: string;
}

export interface DefinitionSourceDeps {
  workItemRepository?: WorkItemRepository;
  artifactRepository?: ArtifactRepository;
  projectRoot: string;
}

type ResolveResult =
  | { ok: true; value: ResolvedDefinitionSource }
  | { ok: false; failure: DefinitionSourceFailure };

const fail = (code: string, message: string): ResolveResult => ({
  ok: false,
  failure: { code, message },
});

/** Strict shape validation for the declared reference — exactly one key. */
export function parseDefinitionSourceRef(raw: unknown): DefinitionSourceRef | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== 'workItemId') return undefined;
  const workItemId = (raw as Record<string, unknown>)['workItemId'];
  if (typeof workItemId !== 'string' || workItemId.trim().length === 0) return undefined;
  return { workItemId };
}

/**
 * Resolve and fully validate an execution WorkItem's declared Definition
 * source. Pure with respect to inputs; performs exactly the reads needed for
 * validation. Every failure is fail-closed — there is no fallback path.
 */
export async function resolveDefinitionSource(
  rawRef: unknown,
  execution: { workItemId: string },
  deps: DefinitionSourceDeps,
): Promise<ResolveResult> {
  const ref = parseDefinitionSourceRef(rawRef);
  if (!ref) {
    return fail(
      'invalid_definition_source',
      `definitionSource must be an object with exactly one key 'workItemId' (non-empty string); got: ${JSON.stringify(rawRef)}`,
    );
  }

  if (!deps.workItemRepository || !deps.artifactRepository) {
    return fail(
      'missing_definition_source_dependencies',
      'A definitionSource was declared but WorkItemRepository/ArtifactRepository are not configured — authoritative Definition resolution cannot be provenance-verified',
    );
  }

  // The execution WorkItem itself defines the project/Objective authority the
  // source must belong to — never caller-asserted fields.
  const executionItem = deps.workItemRepository.findById(execution.workItemId);
  if (!executionItem) {
    return fail(
      'execution_work_item_not_found',
      `Execution WorkItem '${execution.workItemId}' not found — cannot validate its definitionSource`,
    );
  }

  const source = deps.workItemRepository.findById(ref.workItemId);
  if (!source) {
    return fail(
      'source_work_item_not_found',
      `definitionSource WorkItem '${ref.workItemId}' not found`,
    );
  }
  if (source.projectId !== executionItem.projectId) {
    return fail(
      'source_project_mismatch',
      `definitionSource WorkItem '${ref.workItemId}' belongs to project '${source.projectId}', not the execution WorkItem's project '${executionItem.projectId}'`,
    );
  }
  if (
    executionItem.objectiveId !== undefined &&
    source.objectiveId !== executionItem.objectiveId
  ) {
    return fail(
      'objective_mismatch',
      `definitionSource WorkItem '${ref.workItemId}' is bound to Objective '${source.objectiveId ?? '(none)'}', but the execution WorkItem expects '${executionItem.objectiveId}'`,
    );
  }
  if (source.state !== 'completed') {
    return fail(
      'source_work_item_not_completed',
      `definitionSource WorkItem '${ref.workItemId}' is in state '${source.state}', not 'completed' — its Definition is not a settled canonical artifact`,
    );
  }

  // Provenance join: the source must have RECORDED production of a canonical
  // Definition (D.1 artifact rows). Latest row per distinct ref, then require
  // exactly one of type 'definition' — no filename/recency/text search.
  const definitionArtifacts = deps.artifactRepository
    .listLatestByWorkItem(ref.workItemId)
    .filter((a) => a.type === 'definition');
  if (definitionArtifacts.length === 0) {
    return fail(
      'source_definition_not_found',
      `definitionSource WorkItem '${ref.workItemId}' has no recorded 'definition' artifact — it did not (provably) produce a canonical Definition`,
    );
  }
  if (definitionArtifacts.length > 1) {
    return fail(
      'ambiguous_source_definition',
      `definitionSource WorkItem '${ref.workItemId}' has ${definitionArtifacts.length} distinct recorded 'definition' artifacts (${definitionArtifacts.map((a) => a.ref).join(', ')}) — exactly one is required`,
    );
  }
  const artifact = definitionArtifacts[0];
  if (!artifact.hash) {
    return fail(
      'source_definition_not_hashed',
      `Recorded definition artifact for WorkItem '${ref.workItemId}' has no content hash — integrity cannot be pinned`,
    );
  }

  // Path safety, defense in depth: the recorded path must be a canonical
  // safe project-root-relative path inside the work-item artifact area.
  const canonical = artifact.path !== undefined ? toSafeRelativePath(artifact.path) : null;
  if (canonical === null || !canonical.startsWith('.sle/work/')) {
    return fail(
      'unsafe_definition_path',
      `Recorded definition artifact path '${artifact.path}' is not a safe work-item artifact path`,
    );
  }

  let content: string;
  try {
    content = await fs.readFile(path.join(deps.projectRoot, canonical), 'utf-8');
  } catch (err) {
    return fail(
      'definition_file_missing',
      `Recorded definition artifact '${canonical}' could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (Buffer.byteLength(content, 'utf-8') > MAX_AUTHORITATIVE_DEFINITION_BYTES) {
    return fail(
      'definition_too_large',
      `Authoritative Definition '${canonical}' is ${Buffer.byteLength(content, 'utf-8')} bytes, exceeding the ${MAX_AUTHORITATIVE_DEFINITION_BYTES}-byte authoritative-context boundary — this is a real boundary limitation, not silently degraded`,
    );
  }

  const sha256 = createHash('sha256').update(content).digest('hex');
  if (sha256 !== artifact.hash) {
    return fail(
      'definition_hash_mismatch',
      `Definition artifact '${canonical}' content does not match its recorded provenance hash — the canonical Definition was mutated after recording`,
    );
  }

  try {
    parseDefinition(content);
  } catch (err) {
    return fail(
      'invalid_definition',
      `Definition artifact '${canonical}' failed canonical structural validation: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    ok: true,
    value: {
      sourceWorkItemId: ref.workItemId,
      artifactId: artifact.id,
      ref: artifact.ref ?? null,
      path: canonical,
      sha256,
      content,
    },
  };
}
