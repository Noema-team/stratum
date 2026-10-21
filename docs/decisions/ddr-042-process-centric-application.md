# DDR-042: Process-Centric Stratum Application

**Status:** accepted (2026-10-21)
**Supersedes:** DDR-035's deferral of the usable application / Era III as a product-priority decision; kernel execution and evidence contracts remain in force.

## Context

The user has identified the lack of a durable, project-centered place to understand and advance ongoing work as the greatest source of friction in their day-to-day work. A Process-centric application is therefore a deliberate product priority, not an architecture inferred from a clean pilot or a request to expand the engineering kernel.

The application design in `docs/product/process-centric-product-model-v0.1.md` develops this direction and its user journeys. It remains a product-design draft; DDR-042 accepts the strategic direction and scoped initial increment, not every detail or future feature in the draft. The initial increment should make project intent and iterative work usable before adding an agent runtime.

## Decision

Build Stratum as a usable, Process-centric application in small end-to-end increments, in the existing repository and initially as a modular monolith.

The application layer may add its own project views, Processes, activity/review history, and host-runtime integration. Processes are durable efforts toward an outcome. They may optionally link to an existing Objective. They are not executable WorkItems.

The first application increment will provide project selection, project/repository linking, Process creation and lifecycle, a Project Overview, and a Process detail/history view. It will support multiple projects and explicit many-to-many project/repository associations while preserving existing repository identity. The acceptance proof is two projects that can reference one repository while retaining separate Process histories, and a Process that can survive multiple proposal/review rounds and restart.

Keep the existing dashboard available during this increment. A new React/TypeScript UI may be built alongside it and served by the current application server. Do not refactor the scheduler, WorkService, WorkflowEngine, or their persistence contracts to implement the product model.

## Invariants

- Process lifecycle and review actions do not create, ready, dispatch, complete, or otherwise mutate kernel WorkItems or WorkflowRuns.
- Existing kernel authority, evidence provenance, fail-closed validation, and accepted DDR contracts remain unchanged.
- A project owns its Process history and permissions. Sharing a repository shares code, not Processes, decisions, sessions, or private context.
- Repository IDs remain stable. Project membership is an explicit association, not an inferred consequence of a shared remote.
- UI summaries and lifecycle labels reflect persisted application records; agent prose or session state is not acceptance authority.
- New runtime capabilities, especially writable agent execution, require their own bounded authorization and isolation design.

## Delivery rule

Each increment must demonstrate an end-to-end user capability and a clear acceptance gate. Expand from observed use and failed gates. Defer multi-agent scheduling, distributed hosts, multi-user RBAC, autonomous merge/deploy, and generic orchestration until a concrete product need and bounded design exist.

This decision changes product priority. It does not ratify every feature or schema sketch in the product design document, and it does not claim the Goose experiment qualifies a production runtime.
