# DDR-017 — Pre-execution pipeline — coherence gate + sharding as prerequisite

**Date:** 2026-04-13 · **Status:** accepted
**Resolves:** SLE-019

## Context
Before jobs can be dispatched by the job system (SLE-020), the system needs to ensure documents are coherent and tasks have explicit context declarations. A decision was needed on the pipeline order and whether this is a prerequisite.

## Options considered
| Option | Pros | Cons |
|--------|------|------|
| Full intake pipeline (document intake → coherence gate → sharding → Beads creation → link index) before job dispatch | Prevents incoherent tasks; ensures context declarations exist; blocking findings caught early | More upfront work before any job runs |
| Skip coherence check, go straight to sharding | Faster to start | Tasks derived from contradictory documents inherit contradictions; mid-cycle failures are expensive to diagnose |
| Skip sharding, create Beads directly | Simpler pipeline | Context manager falls back to inference mode; loses precision guarantees |

## Decision
Before any job is dispatched, the system must pass through the SLE-019 intake pipeline: document intake → coherence gate → sharding → Beads creation → link index update.

## Consequences
- The pipeline is a prerequisite for the job system (SLE-020)
- Coherence gate runs before sharding — sharding assumes the document set is internally consistent
- Sharding runs before Beads creation — issues without explicit context declarations cannot be reliably dispatched
- Blocking coherence findings halt the pipeline until the user resolves them
- A job system built on incoherent or undeclared tasks will fail faster and more expensively
