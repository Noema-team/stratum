# Specs

Primary build reference — what to implement.

| Doc | Description |
|-----|-------------|
| [state-machine.md](state-machine.md) | System states, transitions, orthogonal chat |
| [dag-execution.md](dag-execution.md) | All 15+ DAG nodes, flow, iteration rules |
| [validation.md](validation.md) | static-check, llm-check, exec-check, gates |
| [context-manager.md](context-manager.md) | Assembly algorithm, slices per role, budgets |
| [rule-files.md](rule-files.md) | All 7 YAML schemas (including agents.yaml) |
| [daemon-api.md](daemon-api.md) | REST endpoints + WebSocket events |
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
| [ui-shell.md](ui-shell.md) | Navigation, pages, component model |
| [tasks-dashboard.md](tasks-dashboard.md) | Modular widgets, AI assistant, scratchpad |
| [project-overview.md](project-overview.md) | Knowledge graph, lifecycle layers, groups |
| [backlog-system.md](backlog-system.md) | Backlog extraction, auto-grouping, promotion |
| [user-flow.md](user-flow.md) | First-open states, entry points, session flow |
