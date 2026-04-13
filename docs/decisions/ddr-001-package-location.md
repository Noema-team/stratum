# DDR-001 — Package location

**Date:** 2026-04-13 · **Status:** accepted
**Resolves:** —

## Context
SLE needs a home in the monorepo that is consistent with the platform's existing layout and allows for future growth (CLI, web UI packages).

## Options considered
| Option | Pros | Cons |
|--------|------|------|
| New top-level `sle/` directory alongside `bmad/`, `executor/`, `core/` | Consistent with one-directory-per-application pattern; `packages/` nesting allows additional packages later | Adds a new top-level directory |
| Place inside an existing directory (e.g., `core/`) | No new top-level dir | Breaks the one-app-per-directory convention |

## Decision
SLE lives in `sle/packages/sle/` — a new top-level `sle/` directory alongside `bmad/`, `executor/`, and `core/`.

## Consequences
- Platform layout gains a new top-level `sle/` directory with `docker-compose.yml`, `Dockerfile`, and `packages/sle/` (the `@sle/sdk` TypeScript package)
- Additional packages (CLI, web UI) can be added under `sle/packages/` without restructuring
- Follows the established one-directory-per-application convention
