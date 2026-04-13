# DDR-014 — Modular dashboard — system proposes widgets, user controls layout, AI assistant integrated

**Date:** 2026-04-13 · **Status:** accepted
**Resolves:** SLE-018

## Context
The project dashboard (extending SLE-016) needs an architecture. The question is how much control the system vs. the user has over widget placement, and whether an AI assistant should be integrated.

## Options considered
| Option | Pros | Cons |
|--------|------|------|
| System proposes widgets, user controls layout, AI assistant as first-class widget | User has full control; AI is contextual and requires confirmation; responsive design | More complex UI |
| Fixed dashboard layout | Simpler to implement | No user customization; less useful |
| AI-controlled layout | Automatically optimized | User loses control; may not match preferences |
| Dashboard without AI assistant | Simpler | Loses contextual project awareness and action capabilities |

## Decision
The project dashboard uses a modular widget architecture where the system auto-generates widget suggestions based on project state, the user has full control over placement/sizing/visibility, and an AI assistant panel is integrated as a first-class widget.

## Consequences
- System proposes, user decides — auto-generated widgets are suggested, not forced
- Modular drag-and-drop layout with resizable panels, persisted per-user/per-project
- AI assistant reads the SLE-016 graph, tasks, documents, and recent cycles; actions require user confirmation
- Quick-write scratchpad for capturing ideas and routing them to nodes, documents, tasks, or pinned notes
- Responsive: 4-column desktop, 2-column tablet, 1-column phone with auto-collapsed widgets
