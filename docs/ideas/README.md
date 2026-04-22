# Ideas Index

Research and analysis documents for patterns worth considering in Stratum.

| Doc | Description |
|-----|-------------|
| [hermes-agent-architecture.md](hermes-agent-architecture.md) | Full architecture deep-dive of Hermes agent (agent loop, skills, memory, tools) |
| [browser-harness-architecture.md](browser-harness-architecture.md) | Architecture of browser-harness (~592 lines, CDP-based browser control) |
| [stratum-comparative-analysis.md](stratum-comparative-analysis.md) | Hermes vs Stratum comparison, gaps identified, skills layer proposal, browser integration plan |

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
