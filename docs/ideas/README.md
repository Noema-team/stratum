# Ideas Index

Research and analysis documents for patterns worth considering in Stratum.

| Doc | Description |
|-----|-------------|
| [hermes-agent-architecture.md](hermes-agent-architecture.md) | Full architecture deep-dive of Hermes agent (agent loop, skills, memory, tools) |
| [browser-harness-architecture.md](browser-harness-architecture.md) | Architecture of browser-harness (~592 lines, CDP-based browser control) |
| [stratum-comparative-analysis.md](stratum-comparative-analysis.md) | Hermes vs Stratum comparison, gaps identified, skills layer proposal, browser integration plan |
| [hermes-stratum-integration.md](hermes-stratum-integration.md) | Naming discussion, 3-level Hermes integration analysis (borrow concepts, custom skill, deep runtime integration) |
| [platform-flexibility-vision.md](platform-flexibility-vision.md) | Open-source roadmap: opinionated dev tool → configurable workflow platform |
| [space-agent-research.md](space-agent-research.md) | Space Agent (agent0ai) research — browser-first agent runtime, prompt includes, L0/L1/L2 layers, borrowing analysis |
| [ideal-state-and-validation-vision.md](ideal-state-and-validation-vision.md) | Full system vision, validation model assessment, dynamic category selection, optimization/telemetry system proposal |

## Key takeaways

### From Hermes
- **Self-improving skills system** is the core innovation — agent writes SKILL.md files after complex tasks, loads them on demand in future
- **Progressive disclosure** keeps context small (skill names only, content loaded on demand)
- **Bounded memory** (MEMORY.md + USER.md, ~1,300 tokens total) complements larger retrieval systems
- **Session search** (SQLite + FTS5) provides episodic memory across all past conversations

### From Browser Harness
- **~592 lines** of clean, framework-free CDP control — proves you don't need a framework
- **Screenshot-first** interaction: `screenshot() → click(x,y) → screenshot() → verify`
- **Domain skills** capture per-website gotchas, selectors, API patterns
- **Self-healing**: agent edits helpers.py mid-task to add missing functions

### Proposed for Stratum
1. **Skills layer** integrated with content store and context manager (not a parallel system)
2. **Progressive disclosure** via skill index in context assembly (~2k tokens)
3. **Gotcha persistence** from validation failures → skill entries → auto-loaded in future cycles
4. **Bounded project memory** (~1,500 tokens) always in context, complementing Cognee
5. **Browser validation node** using browser-harness as a DAG node type for UI testing

### From Hermes Integration Analysis
1. **Hermes skill for Stratum** — zero-cost integration, teaches Hermes the Stratum workflow via SKILL.md
2. **Hermes as agent runtime** — replace raw LLM calls with `delegate_task` per DAG node, restricted toolsets per role
3. **Self-improving prompts** — agents propose prompt tweaks, humans approve (unlike Hermes where agents modify freely)
4. **AgentRuntime interface** — pluggable: `DirectLLMRuntime` (raw API) or `HermesRuntime` (subagent dispatch)

### From Space Agent
1. **Prompt includes** — `*.system.include.md` / `*.transient.include.md` files injected into prompt pipeline; agent writes to its own prompt over time
2. **Self-writing memory** — agent writes behavioral notes to prompt includes, creating continuous self-prompt-tuning
3. **L0/L1/L2 layered filesystem** — immutable firmware → group → user overrides applied to entire filesystem, not just config
4. **Git-backed artifact history** — adaptive debounced commits with Time Travel UI for all user data
5. **Transient context layer** — volatile state (`_____transient`) not persisted to history, assembled fresh every call

### Ideal State & Validation Vision
1. **Intent-driven category rules** — keywords in user intent auto-suggest validation categories
2. **Progressive activation** — categories activate automatically as codebase matures (maintainability after 5 cycles, observability after 10)
3. **Optimization category** — bottleneck reports, flamegraphs, benchmark suites, cross-cycle regression tracking
4. **Telemetry builder** — Builder mode that generates instrumentation code and benchmark suites for performance-critical systems
5. **Self-improving validation** — learned validation rules persisted as prompt includes, improving accuracy over cycles
