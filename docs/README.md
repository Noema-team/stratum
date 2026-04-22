# Stratum v2 — Refined Architecture

Post-vision architecture docs. These refine, override, and prepare-for-implementation the original vision specs in `../vision/`.

## Directories

| Dir | Purpose | Start here |
|-----|---------|------------|
| [overview/](overview/) | Entry-point mental models | `overview/README.md` |
| [specs/](specs/) | Primary build reference — what to implement | `specs/README.md` |
| [decisions/](decisions/) | Architectural Decision Records (DDR-001..027) | `decisions/README.md` |
| [guides/](guides/) | How-to guides | — |
| [ideas/](ideas/) | Research & analysis from external projects | `ideas/README.md` |
| [reference/](reference/) | Quick-reference tables | — |

## Reading order

1. `overview/` — build mental models
2. `decisions/DECISION-BRIEFS.md` — understand key decisions
3. `specs/` — implementation reference
4. `ideas/` — external research and proposals (Hermes, browser-harness, comparative analysis)

## Key decisions

- **DDR-027** — Product renamed from SLE/sdk-orchestrator to **Stratum**
- **DDR-012** — Lifecycle layers (baseline 8 + custom extensions)
- **DDR-017** — Pre-execution pipeline (coherence gate + sharding)

## External research

The `ideas/` directory contains analysis of external tools and patterns:

- **Hermes agent** — self-improving AI agent with skill system and bounded memory
- **Browser harness** — ~592-line CDP-based browser control with domain skill persistence
- **Comparative analysis** — Hermes vs Stratum, identified gaps, skills layer proposal
