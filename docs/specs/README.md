# Specs

Primary build reference — what to implement.

| Doc | Description |
|-----|-------------|
| [state-machine.md](state-machine.md) | System states, transitions, orthogonal chat |
| [dag-execution.md](dag-execution.md) | DAG flow, iteration rules, scheduling |
| [dag-node-reference.md](dag-node-reference.md) | Per-node definitions for all 17 DAG nodes (split from dag-execution.md) |
| [validation.md](validation.md) | static-check, llm-check, exec-check, gates |
| [context-manager.md](context-manager.md) | Assembly algorithm, slices per role, budgets |
| [rule-files.md](rule-files.md) | All 7 YAML schemas (including agents.yaml) |
| [daemon-api.md](daemon-api.md) | Overview — architecture, constraints, auth, WebSocket events; see [daemon-api-endpoints.md](daemon-api-endpoints.md) for endpoints |
| [daemon-api-endpoints.md](daemon-api-endpoints.md) | All 85 REST endpoint definitions (split from daemon-api.md) |
| [init-and-discovery.md](init-and-discovery.md) | sle init + sle discover |
| [intake-and-sharding.md](intake-and-sharding.md) | Document intake, coherence gate, task sharding |
| [job-dispatch.md](job-dispatch.md) | Worker pool, lifecycle, context passing |
| [document-linking.md](document-linking.md) | Doc/node split, wikilinks, backlinks, link index |
| [content-modules.md](content-modules.md) | Node content store, layer module system, triggers |
| [knowledge-engine.md](knowledge-engine.md) | Cognee integration, vector search, metadata |
| [beads-integration.md](beads-integration.md) | Beads/Dolt bridge, task tracking, resolveExit |
| [run-artifacts.md](run-artifacts.md) | Run directory, manifest.json, context-pack |
| [prompt-templates.md](prompt-templates.md) | System prompts per role (all 10) |
| [conversation.md](conversation.md) | Chat mode, Facilitator, decision capture |
| [ui-shell.md](ui-shell.md) | Three-page navigation shell, gate overlays, component model |
| [tasks-dashboard.md](tasks-dashboard.md) | Widget-based dashboard, 3-level task system, Kanban, quick-write |
| [project-overview.md](project-overview.md) | Project graph with 8 lifecycle layers, groups, hosting planner |
| [backlog-system.md](backlog-system.md) | Markdown-first backlog system with Beads promotion (post-MVP) |
| [user-flow.md](user-flow.md) | End-to-end user flows, gate interactions, resolves G2/G3 |
| [validation-prompts.md](validation-prompts.md) | Validation prompt templates for llm-check sub-phase — 3 core, 8 stubs, meta-template, project-local overrides |
