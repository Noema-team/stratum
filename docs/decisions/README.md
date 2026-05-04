# Decisions

Architectural Decision Records — why we chose X over Y.

| Doc | Description |
|-----|-------------|
| [ddr-001-package-location.md](ddr-001-package-location.md) | sle/ directory placement |
| [ddr-002-rule-files-seven.md](ddr-002-rule-files-seven.md) | 7 rule files including agents.yaml |
| [ddr-003-llm-provider.md](ddr-003-llm-provider.md) | Agnostic LLM provider with two implementations |
| [ddr-004-platform-layers.md](ddr-004-platform-layers.md) | SLE at Layer 3, delegates to Layer 2 |
| [ddr-005-cognee-integration.md](ddr-005-cognee-integration.md) | Optional Layer 3 REST API container |
| [ddr-006-security-deferred.md](ddr-006-security-deferred.md) | Security validation post-MVP |
| [ddr-007-tester-agent.md](ddr-007-tester-agent.md) | Separate Tester agent, hybrid TDD |
| [ddr-008-isolated-container.md](ddr-008-isolated-container.md) | Fresh Docker container per validation cycle |
| [ddr-009-static-analysis.md](ddr-009-static-analysis.md) | Lint, typecheck, complexity as validation sub-phases |
| [ddr-010-hybrid-tdd.md](ddr-010-hybrid-tdd.md) | Tests designed before build, verified after |
| [ddr-011-plan-modification.md](ddr-011-plan-modification.md) | User can modify plan at CONFIRM gate |
| [ddr-012-lifecycle-layers.md](ddr-012-lifecycle-layers.md) | Baseline 8 layers + custom extensions |
| [ddr-013-document-node-split.md](ddr-013-document-node-split.md) | Nodes have group scope, documents have project scope |
| [ddr-014-modular-dashboard.md](ddr-014-modular-dashboard.md) | System proposes widgets, user controls layout |
| [ddr-015-computed-backlinks.md](ddr-015-computed-backlinks.md) | Computed backlinks, not injected frontmatter |
| [ddr-016-resolver-mode.md](ddr-016-resolver-mode.md) | Resolver mode for declared tasks |
| [ddr-017-pre-execution-pipeline.md](ddr-017-pre-execution-pipeline.md) | Coherence gate + sharding as prerequisite |
| [ddr-018-link-index-agent-memory.md](ddr-018-link-index-agent-memory.md) | Link index as shared agent working memory |
| [ddr-019-designer-planner-ownership.md](ddr-019-designer-planner-ownership.md) | Designer owns requirements.md |
| [ddr-020-state-machine-chat.md](ddr-020-state-machine-chat.md) | Chat orthogonal to system state, Facilitator with two modes |
| [ddr-021-confirming-substate.md](ddr-021-confirming-substate.md) | Confirming is a flag on cycle record, not a state |
| [ddr-022-critic-timing.md](ddr-022-critic-timing.md) | Critic reviews at DESIGN node |
| [ddr-023-explore-trigger.md](ddr-023-explore-trigger.md) | User-initiated EXPLORE separate from automatic gap detection |
| [ddr-024-beads-required-or-optional.md](ddr-024-beads-required-or-optional.md) | Local task fallback when Beads unavailable |
| [ddr-025-artifact-slice-references.md](ddr-025-artifact-slice-references.md) | Typed prefix: doc:{key} and node:{group}:{key} |
| [ddr-026-sharding-approval-ui.md](ddr-026-sharding-approval-ui.md) | Sharding approval as separate step before CONFIRM |
| [ddr-027-product-naming.md](ddr-027-product-naming.md) | Product renamed from SLE/sdk-orchestrator to **Stratum** |
| [ddr-028-cycle-scoping-redesign.md](ddr-028-cycle-scoping-redesign.md) | Pre-cycle discussion + guided Phase 1, replaces INTENT/CONTEXT_ASSEMBLY/EXPLORE with SCOPING |
| [ddr-029-agent-output-contracts.md](ddr-029-agent-output-contracts.md) | Typed AgentOutput discriminated union, BuilderOutput declarative file operations schema, per-role output schemas |
| [ddr-030-agent-runtime-environment.md](ddr-030-agent-runtime-environment.md) | Agent runner, LLM provider interface, multi-turn read-request mechanism, per-role read permissions, turn budgets |
