import type { DeclaredOutputArtifact, WorkflowDefinition } from '../types.js';

// E19 — scoping.produce's exact, narrow output contract (D.1b). Before A8,
// this step declared NO outputArtifact: the facilitator chose its own output
// path inside the transport envelope (A8 declared .sle/work/<wi>/scoping.md),
// the step runner REPORTED docs/cycle-charter.md as written regardless, and
// ScopingService.approve later failed no_scoping_draft because nothing had
// materialized the file. Declaring the artifact wires the step into the
// machinery every define-work step already uses: exact-one-section
// enforcement, exact-path matching against the declared path (the path is
// also taught in the assembled context — ContextManager), facilitator role
// ceiling (ROLE_OUTPUT_PATHS.facilitator already allows exactly this path),
// filesystem materialization, honest artifacts_written, and D.1 provenance.
export const CYCLE_CHARTER_OUTPUT: DeclaredOutputArtifact = {
  type: 'cycle-charter',
  ref: 'doc:cycle-charter',
  path: 'docs/cycle-charter.md',
};

// E21 — the frozen experimental threshold for the two-phase convergence
// gate (turns 1..18 investigation with repository read tools; from turn 19
// the read tools are withdrawn and the remaining turns are reserved for
// synthesis). An experimental setting, frozen before testing — deliberately
// NOT a measured optimum — and deliberately NOT accompanied by any change
// to MAX_AGENT_TURNS or the repair budgets: a successful run must attribute
// its success to the synthesis gate, not to extra capacity.
export const SYNTHESIS_GATE_TURNS = 18;

// E21 — applied ONLY to full-build's broad-access artifact-production steps
// (scoping/design/plan/test). define-work and BUILD are deliberately
// unchanged: BUILD has different tool and workspace-mutation requirements
// and needs separate assessment.
// E23 — preregistered synthesis read-result budget (bytes), from the
// zero-model replay of the A10 attempt-13 test-step history: 12 read_file
// calls totaling 274,736 bytes (~68.7k tokens) left the synthesis request
// without completion headroom (live cut at 27,984 chars under a
// probe-verified 65,536-token request). A 49,152-byte newest-first budget
// retains 9/12 payloads spanning investigation turns 3–18 (including ALL
// turn-18 evidence), elides the 3 largest oldest reads, cuts the read
// payload by 83%, and frees ~57k tokens of request headroom. Frozen for the
// attempt-14 live comparison; do not tune from live outcomes.
export const SYNTHESIS_READ_RESULT_BUDGET_BYTES = 49152;

function synthesisGate(): { thresholdTurns: number; readResultBudgetBytes: number } {
  return { thresholdTurns: SYNTHESIS_GATE_TURNS, readResultBudgetBytes: SYNTHESIS_READ_RESULT_BUDGET_BYTES };
}

// full-build: the canonical 15-stage pipeline expressed as a WorkflowDefinition.
// Step graph is the DAG_SEQUENCE from dag-runner.ts, now declarative (DDR-031 §Table 1).
//
// The three checkpoint steps replace the former three boolean flags:
//   awaiting_scoping         → scoping.checkpoint
//   awaiting_sharding_approval → sharding_approval
//   awaiting_confirmation    → confirm
//
// HISTORY folds into SNAPSHOT via logs_decision: true (DDR-031).
// DEBUG is not a standalone kind — it's a 'produce' step on the failure path of
// VALIDATION_GATE's on_fail routing (DDR-031 §"DEBUG is not a 7th kind").

export const FULL_BUILD: WorkflowDefinition = {
  id: 'full-build',
  label: 'Full Build',
  steps: [
    // ── SCOPING: gather → produce → checkpoint ─────────────────────────────
    {
      id: 'scoping.gather',
      kind: 'gather',
      label: 'SCOPING gather',
    },
    {
      id: 'scoping.produce',
      kind: 'produce',
      label: 'SCOPING produce',
      agentRole: 'facilitator',
      templateId: 'scoping',
      outputArtifact: CYCLE_CHARTER_OUTPUT,
      synthesisGate: synthesisGate(),
      // V3 — one bounded structural repair turn on deterministic rejection.
      structuralRepair: true,
    },
    {
      id: 'scoping.checkpoint',
      kind: 'checkpoint',
      label: 'SCOPING checkpoint',
    },

    // ── DESIGN ────────────────────────────────────────────────────────────
    {
      id: 'design',
      kind: 'produce',
      label: 'DESIGN',
      agentRole: 'designer',
      templateId: 'design',
      // E26 — the producer contract: PLAN and BUILD consume the published
      // requirements and architecture from these paths (artifact-registry
      // document references already point here).
      authorizedOutputs: ['docs/requirements.md', 'docs/architecture.md'],
      synthesisGate: synthesisGate(),
      // V3 — one bounded structural repair turn on deterministic rejection.
      structuralRepair: true,
    },

    // ── CRITIQUE (conditional: deep | research only) ───────────────────────
    {
      id: 'critique',
      kind: 'review',
      label: 'CRITIQUE',
      skip_if: (ctx) => {
        const d = ctx.workflowParameters?.['planning_depth'] as string | undefined;
        return d !== 'deep' && d !== 'research';
      },
      on_fail: { target_step_id: 'design' },
    },

    // ── PLAN ──────────────────────────────────────────────────────────────
    {
      id: 'plan',
      kind: 'produce',
      label: 'PLAN',
      agentRole: 'planner',
      templateId: 'plan',
      // E26 — TEST and BUILD receive the published plans from these paths.
      authorizedOutputs: ['docs/plan.md', 'docs/test-plan.md'],
      synthesisGate: synthesisGate(),
      // V3 — one bounded structural repair turn on deterministic rejection.
      structuralRepair: true,
    },

    // ── TEST ──────────────────────────────────────────────────────────────
    {
      id: 'test',
      kind: 'produce',
      label: 'TEST',
      agentRole: 'tester',
      templateId: 'test',
      // E26 — the executable-test destination, resolved explicitly: the
      // intended regression tests must exist in the repository tree where
      // EXEC/validation run them. The step contract authorizes exactly this
      // directory (at least one file) without globally widening the tester
      // role ceiling. Writing another plan document does NOT satisfy this.
      authorizedOutputs: ['apps/ai-server/tests/'],
      synthesisGate: synthesisGate(),
    },

    // ── SHARDING_APPROVAL (conditional: only if a sharding proposal exists) ─
    {
      id: 'sharding_approval',
      kind: 'checkpoint',
      label: 'SHARDING_APPROVAL',
      skip_if: (_ctx) => false, // engine checks for proposal file; step handles its own skip
    },

    // ── CONFIRM ───────────────────────────────────────────────────────────
    {
      id: 'confirm',
      kind: 'checkpoint',
      label: 'CONFIRM',
    },

    // ── BUILD ─────────────────────────────────────────────────────────────
    {
      id: 'build',
      kind: 'produce',
      label: 'BUILD',
      agentRole: 'builder',
      templateId: 'build',
      // E24 — BUILD gets the already-qualified synthesis gate (E21 threshold
      // + E23 read-result compaction). It runs the same AgentLoop with the
      // same repository-read tools as every other produce step, and its
      // failure signature (exploration without transition to production) is
      // the one the gate was qualified for. It still declares NO
      // outputArtifact: multiple code sections materialize from the final
      // artifact response.
      // E27r (merge review) — source-edit authorization is deliberately NOT
      // declared here: issue-specific edit scope (allowed/required paths,
      // e.g. the pilot's worker main.py) is task configuration carried by
      // the dispatching WorkItem's workflowParameters.editPolicy — frozen
      // per run and enforced by the publication boundary. FULL_BUILD must
      // stay project-agnostic.
      synthesisGate: synthesisGate(),
    },

    // ── EXEC ──────────────────────────────────────────────────────────────
    {
      id: 'exec',
      kind: 'execute',
      label: 'EXEC',
    },

    // ── VALIDATION_GATE ───────────────────────────────────────────────────
    {
      id: 'validation_gate',
      kind: 'review',
      label: 'VALIDATION_GATE',
      is_iteration_gate: true,
      // on_pass: jump over debug (which lives between validation_gate and evaluate)
      on_pass: { target_step_id: 'evaluate' },
      on_fail: {
        target_step_id: 'debug',
        // iteration_loop removed: iteration increment happens via the debug step
        // returning _iterate:true after it completes (DDR-031 validation recovery).
      },
    },

    // ── DEBUG (failure path of VALIDATION_GATE) ───────────────────────────
    {
      id: 'debug',
      kind: 'produce',
      label: 'DEBUG',
      agentRole: 'debugger',
      templateId: 'debug',
    },

    // ── EVALUATE ──────────────────────────────────────────────────────────
    {
      id: 'evaluate',
      kind: 'produce',
      label: 'EVALUATE',
      agentRole: 'evaluator',
      templateId: 'evaluate',
    },

    // ── SUMMARISE ─────────────────────────────────────────────────────────
    {
      id: 'summarise',
      kind: 'produce',
      label: 'SUMMARISE',
      agentRole: 'historian',
      templateId: 'summarise',
    },

    // ── SNAPSHOT (commit; logs_decision folds in former HISTORY step) ─────
    {
      id: 'snapshot',
      kind: 'commit',
      label: 'SNAPSHOT',
      logs_decision: true,
    },
  ],
};
