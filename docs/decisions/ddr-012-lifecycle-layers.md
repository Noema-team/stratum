# DDR-012 — Layer extensibility — baseline 8 + custom layers

**Date:** 2026-04-13 · **Status:** accepted
**Resolves:** —

## Context
Groups have 8 standard layers (Research, Spikes, Design, Plans, Implementation, Code, Notes, Hosting). Users may need additional layers. A decision was needed on the extensibility model.

## Options considered
| Option | Pros | Cons |
|--------|------|------|
| Fixed baseline 8 + per-project custom layers | Uniform layer completion strip; all groups share same shape; simple data model | Less granular per-group customization |
| Fixed baseline 8 + per-group custom layers | Maximum flexibility per group | Breaks layer completion strip; variable group heights |
| Fully custom layers (no baseline) | Maximum flexibility | No consistency across projects; breaks UI conventions |
| Fixed 8 layers only, no extensibility | Simplest | Cannot accommodate project-specific needs |

## Decision
The 8 baseline layers are fixed for every group. Users can add custom layers per-project (not per-group), which appear after Hosting in the group stack.

## Consequences
- Custom layer names must be unique — no collisions with the baseline 8
- Custom layers are per-project, not per-group — keeps the data model simple and the layer completion strip uniform
- UI must handle variable group height when custom layers are present
- AI can suggest custom layers but user must approve
- Layer status (`filled` / `partial` / `empty` / `not_applicable`) applies to custom layers too
