import type { StepRunContext } from './types.js';

// ============================================================================
// D.3b0 — minimal declarative-artifact-ref placeholder materialization.
//
// D.1's declared outputArtifact/inputArtifactRefs contract (see
// docs/developmentPlan/d1a-declarative-contract-spike.md §5) assumed every
// declaration was already a concrete ref/path. D.3's accepted Definition
// identity is `definition:<objectiveId>` with a physical path under
// `.sle/work/<workItemId>/...` (docs/developmentPlan/d3a-definition-readiness-methodology.md
// §1) — both per-run values, not literals a WorkflowStep can hardcode without
// colliding across every other WorkItem/Objective using the same workflow.
//
// This is deliberately NOT an expression/template language: exactly two
// placeholders are supported (`{workItemId}`, `{objectiveId}`), substituted
// once, before ContextManager or AgentRunner ever sees the context — see
// materializeStepRunContext's call site in WorkflowEngine.run(). Any other
// placeholder name fails closed, and a supported placeholder with no value
// for this run fails closed too, rather than being silently left in the
// declaration or substituted with an empty string.
// ============================================================================

const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;

export type MaterializeResult<T> = { ok: true; value: T } | { ok: false; error: string };

// Substitutes every `{name}` occurrence in `template` from `values`.
// Fails closed on an unknown placeholder name (not a key of `values`) or a
// known name whose value is `undefined` for this run. A template with no
// `{...}` placeholders at all is returned unchanged — this is the identity
// function for every workflow that doesn't use this mechanism.
export function materializeTemplate(
  template: string,
  values: Record<string, string | undefined>,
): MaterializeResult<string> {
  let error: string | undefined;
  const value = template.replace(PLACEHOLDER_RE, (match, name: string) => {
    if (error) return match;
    if (!(name in values)) {
      error = `Unknown placeholder '{${name}}' in '${template}'`;
      return match;
    }
    const v = values[name];
    if (v === undefined) {
      error = `Required placeholder '{${name}}' has no value in '${template}'`;
      return match;
    }
    return v;
  });
  if (error) return { ok: false, error };
  return { ok: true, value };
}

// Materializes a StepRunContext's declared outputArtifact.ref/.path and every
// inputArtifactRefs entry in one pass. A context with neither field set is
// returned unchanged (no cloning, no-op) — workflows that never declare
// placeholders behave exactly as before D.3b0. The returned context's
// outputArtifact/inputArtifactRefs are the values everything downstream
// (path-safety canonicalization, the role ceiling, the filesystem write,
// ArtifactRecord provenance) must use — see AgentRunner.run().
export function materializeStepRunContext(ctx: StepRunContext): MaterializeResult<StepRunContext> {
  if (!ctx.outputArtifact && !ctx.inputArtifactRefs) {
    return { ok: true, value: ctx };
  }

  const values: Record<string, string | undefined> = {
    workItemId: ctx.workItemId,
    objectiveId: ctx.objectiveId,
  };

  let outputArtifact = ctx.outputArtifact;
  if (outputArtifact) {
    const ref = materializeTemplate(outputArtifact.ref, values);
    if (!ref.ok) return ref;
    const declaredPath = materializeTemplate(outputArtifact.path, values);
    if (!declaredPath.ok) return declaredPath;
    outputArtifact = { ...outputArtifact, ref: ref.value, path: declaredPath.value };
  }

  let inputArtifactRefs = ctx.inputArtifactRefs;
  if (inputArtifactRefs) {
    const materialized: string[] = [];
    for (const ref of inputArtifactRefs) {
      const r = materializeTemplate(ref, values);
      if (!r.ok) return r;
      materialized.push(r.value);
    }
    inputArtifactRefs = materialized;
  }

  return { ok: true, value: { ...ctx, outputArtifact, inputArtifactRefs } };
}
