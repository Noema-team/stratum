# Stratum v2 — Refined Architecture

Post-vision architecture docs. These refine, override, and prepare-for-implementation the original vision specs in `../vision/`. **This is the canonical build reference.**

## Directories

| Dir | Purpose | Start here |
|-----|---------|------------|
| [overview/](overview/) | Entry-point mental models | `overview/README.md` |
| [specs/](specs/) | Primary build reference — what to implement | `specs/README.md` |
| [decisions/](decisions/) | Architectural Decision Records (DDR-001..028) | `decisions/README.md` |
| [guides/](guides/) | How-to guides | — |
| [reference/](reference/) | Quick-reference tables and type schemas | — |
| [research/](research/) | External system architecture deep dives | — |
| [ideas/](ideas/) | Proposals and integration analysis | `ideas/README.md` |
| [developmentPlan/](developmentPlan/) | Phased build plans and post-MVP roadmap | `developmentPlan/post-mvp-roadmap.md` |

## Reading order

1. `overview/` — build mental models (`what-is-sle.md` → `architecture.md` → `cycle-model.md` → `agent-roles.md`)
2. `decisions/DECISION-BRIEFS.md` — understand key decisions (archival pre-session material)
3. `specs/` — implementation reference
4. `research/` — external system architecture deep dives (Hermes, browser-harness, Space Agent)
5. `ideas/` — proposals and integration analysis built on research
6. `developmentPlan/` — phased build plan and post-MVP roadmap

## Key decisions

- **DDR-028** — Cycle scoping redesign: pre-cycle discussion + guided Phase 1, replaces INTENT/CONTEXT_ASSEMBLY/EXPLORE with SCOPING
- **DDR-027** — Product renamed from SLE/sdk-orchestrator to **Stratum**
- **DDR-012** — Lifecycle layers (baseline 8 + custom extensions)
- **DDR-017** — Pre-execution pipeline (coherence gate + sharding)

## External research

- `research/` — raw external-system architecture deep dives (Hermes agent, browser harness, Space Agent)
- `ideas/` — synthesis proposals built on research (Stratum integration analysis, platform flexibility vision, comparative analysis)
