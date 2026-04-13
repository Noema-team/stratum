# DDR-018 — Link index as shared agent working memory

**Date:** 2026-04-13 · **Status:** accepted
**Resolves:** SLE-019 (Part 6), SLE-014 (Cognee integration)

## Context
Agents have narrow context windows and need a way to learn about prior work, existing nodes, and related documents before starting a task. A decision was needed on how agents access this information.

## Options considered
| Option | Pros | Cons |
|--------|------|------|
| Link index serves dual role (UI feature + agent working memory) | Single index serves both purposes; agents stay coherent; prevents duplicate research | Link index must support agent query patterns |
| Separate agent memory store | Specialized for agent needs | Duplicated data; synchronization complexity |
| No shared agent memory | Simplest | Agents may produce duplicate research, contradictory decisions, or conflicting implementations |
| Cognee as sole agent memory | Rich semantic search | Cognee is optional; cannot be a hard dependency |

## Decision
The link index (SLE-017 backlink engine) serves a dual role: UI feature (backlink panels, hover previews, wikilink navigation) and agent working memory (queryable by agents before starting work).

## Consequences
- Before starting a task, agents query the link index to learn about prior cycles, existing nodes, ancestor documents, descendant builds, and referenced source files
- Keeps small, focused agents coherent without requiring large context windows
- Prevents duplicate research, contradictory decisions, and conflicting implementations
- Cognee (SLE-014) is an optional semantic enrichment layer on top of the link index — adds embedding-based fuzzy search and clustering
- Cognee is pluggable and must not become a hard dependency of the link index or the agent query interface
