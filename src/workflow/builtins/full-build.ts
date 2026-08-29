import type { WorkflowDefinition } from '../types.js';

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
  max_iterations: 3,
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
    },

    // ── CRITIQUE (conditional: deep | research only) ───────────────────────
    {
      id: 'critique',
      kind: 'review',
      label: 'CRITIQUE',
      skip_if: (ctx) =>
        ctx.planningDepth !== 'deep' && ctx.planningDepth !== 'research',
      on_fail: { target_step_id: 'design' },
    },

    // ── PLAN ──────────────────────────────────────────────────────────────
    {
      id: 'plan',
      kind: 'produce',
      label: 'PLAN',
      agentRole: 'planner',
      templateId: 'plan',
    },

    // ── TEST ──────────────────────────────────────────────────────────────
    {
      id: 'test',
      kind: 'produce',
      label: 'TEST',
      agentRole: 'tester',
      templateId: 'test',
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
      on_fail: {
        target_step_id: 'debug',
        iteration_loop: true,     // increment iteration counter before routing
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
