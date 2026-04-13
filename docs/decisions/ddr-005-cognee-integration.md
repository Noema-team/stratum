# DDR-005 — Knowledge engine — Cognee integration

**Date:** 2026-04-13 · **Status:** accepted
**Resolves:** SLE-014

## Context
SLE needs optional knowledge graph and vector search capabilities. Cognee provides LLM-powered knowledge graph construction and a vector store, but is Python-based while SLE daemon is TypeScript.

## Options considered
| Option | Pros | Cons |
|--------|------|------|
| Cognee as optional Layer 3 REST API container | Clean separation; toggleable via Docker Compose profile; no shared runtime issues | Additional container to manage |
| Cognee as a library embedded in SLE daemon | Lower latency | TypeScript/Python runtime mismatch; breaks platform boundary rule |
| No knowledge engine | Simplest | Lacks semantic search and knowledge graph capabilities |

## Decision
Cognee runs as an optional Layer 3 REST API container. SLE daemon communicates via HTTP through a `KnowledgeProvider` interface. Disabled by default; enabled via Docker Compose profile (`--profile knowledge`).

## Consequences
- 1 new container (cognee FastAPI on port 8001)
- 1 PostgreSQL extension (pgvector) on the existing PG16 instance
- Zero new database servers (uses shared PostgreSQL + file-based KuzuDB for graph)
- `KnowledgeProvider` interface has a `NoopProvider` — when disabled, SLE operates exactly as specified in SLE-001 through SLE-013
- Cognee uses the same ZhipuAI API key as the platform via LiteLLM `zai/` prefix
- Local-first platforms are not required to run heavy infra
