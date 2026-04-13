# DDR-002 — Rule files — 7 files, not 6

**Date:** 2026-04-13 · **Status:** accepted
**Resolves:** —

## Context
The MVP implementation plan used different file names that diverged from the vision spec. A decision was needed on which file names and count to ship.

## Options considered
| Option | Pros | Cons |
|--------|------|------|
| Keep the vision's 6 files and add `agents.yaml` as 7th | Clean mapping to distinct cycle concerns; agent config gets a data-driven home | Diverges from MVP plan file names |
| Use the MVP plan's file names (`project.yaml`, `behaviors.yaml`, `errors.yaml`, etc.) | Consistent with MVP plan | Mixes concerns (project config vs rules); `errors.yaml` is implementation constants not data-driven config |
| Strict 6 files from vision (no `agents.yaml`) | Matches vision exactly | Agent system prompts and LLM config have no data-driven home |

## Decision
Follow the vision's 6 files and add `agents.yaml` as a 7th: `planning.yaml`, `validation.yaml`, `artifacts.yaml`, `exit.yaml`, `user_validation.yaml`, `summary.yaml`, `agents.yaml`.

## Consequences
- 7 rule files with clear separation of concerns
- `agents.yaml` provides a data-driven home for agent role definitions, system prompts, and LLM config
- Discarded from MVP plan: `project.yaml` (becomes project-level config), `behaviors.yaml` (folds into `exit.yaml`), `errors.yaml` (implementation constants, not data-driven config)
- Vision file names are authoritative over the MVP plan's names
