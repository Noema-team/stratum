// D.3c0 — deterministic structural validation for a dynamic DecisionRequest
// declared by a checkpoint step (WorkflowStep.decisionRequestArtifact — see
// workflow/types.ts). A prior 'produce' step writes this JSON payload; this
// module is the sole place that decides whether it is well-formed enough to
// become the real thing a human sees and chooses from.
//
// Deliberately NOT a template/expression system: this only validates
// structure (DecisionRequest's existing shape) — it does not interpret,
// transform, or evaluate the content in any way. Fails closed on anything
// that doesn't match, exactly as strictly as a malformed/missing artifact —
// see StratumAgentAdapter.execute(), which treats any validation failure
// here as an execution failure, never a silent fallback to approve/reject.

import { z } from 'zod';
import type { DecisionRequest } from './types.js';

const DecisionRequestOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
});

const DecisionRequestSchema = z
  .object({
    type: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().min(1),
    options: z.array(DecisionRequestOptionSchema).min(1),
  })
  .refine(
    (req) => new Set(req.options.map((o) => o.id)).size === req.options.length,
    { message: 'option ids must be unique' },
  );

export type DecisionRequestValidationResult =
  | { ok: true; value: DecisionRequest }
  | { ok: false; error: string };

// Parses and structurally validates a declared DecisionRequest artifact's
// raw file content. Fails closed (ok: false) on malformed JSON, a
// structural mismatch (missing/empty type, title, summary, or options), a
// non-empty-option-list violation, a duplicate option id, or any option
// with an empty id/label/description.
export function parseDecisionRequest(raw: string): DecisionRequestValidationResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `Malformed DecisionRequest JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = DecisionRequestSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: `Invalid DecisionRequest: ${parsed.error.message}` };
  }
  return { ok: true, value: parsed.data };
}
