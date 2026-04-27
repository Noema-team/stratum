# Hermes Agent — Architecture Deep Dive

**Source:** github.com/nousresearch/hermes-agent (110k stars, Nous Research, MIT, Python 87.7%)
**Date analyzed:** 2026-04-22
**Purpose:** Understand Hermes' core method to identify patterns worth adopting or avoiding in Stratum.

---

## Core Architecture

Hermes is a **single-agent loop** with three self-improvement mechanisms layered on top.

### Agent Loop (`run_agent.py`, ~10,700 lines)

```
user message → build system prompt → API call → parse response
  → if tool_calls: execute tools, append results, loop
  → if text: done → persist session, flush memory
```

- `AIAgent` class handles: prompt assembly, provider selection, tool execution, retries, fallback, compression, persistence
- 3 API modes: `chat_completions` (OpenAI-compatible), `codex_responses` (OpenAI Codex), `anthropic_messages` (native Anthropic)
- **Interruptible API calls**: HTTP call in background thread, main thread monitors interrupt event
- **Iteration budget**: 90 turns default; subagents get 50
- **Fallback chain**: on provider failure (429/5xx/401), try each `fallback_providers` in order
- **Compression**: at 50% context (preflight), 85% (gateway auto) — middle turns summarized, last 20 preserved

### Data Flow

```
User input
  → HermesCLI.process_input()
  → AIAgent.run_conversation()
    → prompt_builder.build_system_prompt()
    → runtime_provider.resolve_runtime_provider()
    → API call (chat_completions / codex_responses / anthropic_messages)
    → tool_calls? → model_tools.handle_function_call() → loop
    → final response → display → save to SessionDB
```

### Directory Structure (key files)

```
hermes-agent/
├── run_agent.py              # AIAgent — core loop (~10,700 lines)
├── cli.py                    # HermesCLI — terminal UI (~10,000 lines)
├── model_tools.py            # Tool discovery, schema, dispatch
├── toolsets.py               # Tool groupings and platform presets
├── hermes_state.py           # SQLite session/state with FTS5
│
├── agent/
│   ├── prompt_builder.py     # System prompt assembly
│   ├── context_engine.py     # ContextEngine ABC (pluggable)
│   ├── context_compressor.py # Lossy summarization
│   ├── prompt_caching.py     # Anthropic cache breakpoints
│   ├── auxiliary_client.py   # Side-task LLM (vision, summarization)
│   ├── memory_manager.py     # Memory orchestration
│   └── memory_provider.py    # Memory provider ABC
│
├── tools/
│   ├── registry.py           # Central tool registry (47 tools)
│   ├── terminal_tool.py      # Terminal orchestration
│   ├── browser_tool.py       # Browser automation
│   ├── delegate_tool.py      # Subagent delegation
│   ├── mcp_tool.py           # MCP client (~2,200 lines)
│   └── environments/         # 6 terminal backends
│
├── skills/                   # Bundled skills (always available)
├── optional-skills/          # Official optional skills
└── gateway/                  # 18 messaging platform adapters
```

---

## Self-Improvement Mechanisms

### 1. Skills System (Procedural Memory) — THE CORE INNOVATION

After completing a complex task (5+ tool calls), the agent **writes a SKILL.md file** capturing the approach. Next time it encounters a similar task, it loads the skill instead of figuring it out from scratch.

**Progressive disclosure:**
```
Level 0: skills_list()           → [{name, description, category}, ...]   (~3k tokens)
Level 1: skill_view(name)        → Full content + metadata
Level 2: skill_view(name, path)  → Specific reference file
```

**SKILL.md format:**
```yaml
---
name: my-skill
description: Brief description
version: 1.0.0
platforms: [macos, linux]
metadata:
  hermes:
    tags: [python, automation]
    category: devops
    fallback_for_toolsets: [web]    # show ONLY when web toolset unavailable
    requires_toolsets: [terminal]   # show ONLY when terminal available
---
# Skill Title
## When to Use — trigger conditions
## Procedure — step-by-step
## Pitfalls — known failure modes
## Verification — how to confirm success
```

**Agent-managed via `skill_manage` tool:**
- `create` — new skill from scratch
- `patch` — targeted fixes (preferred, more token-efficient)
- `edit` — full structural rewrites
- `delete` — remove entirely
- `write_file` / `remove_file` — supporting files

**Skills Hub ecosystem:**
- Install from: official, skills.sh, well-known endpoints, GitHub, ClawHub, LobeHub
- Security scanning on install
- Update lifecycle: `hermes skills check/update`

**External skill directories:**
- `~/.hermes/skills/` is primary (read-write)
- `external_dirs` in config adds read-only scan paths
- Local precedence on name collision

### 2. Persistent Memory (Declarative Memory)

Two tiny, bounded, curated files:

| File | Purpose | Limit |
|------|---------|-------|
| MEMORY.md | Agent's personal notes — env facts, conventions, lessons | 2,200 chars (~800 tokens) |
| USER.md | User profile — preferences, communication style | 1,375 chars (~500 tokens) |

- Frozen snapshot in system prompt at session start (never mutates mid-session for cache stability)
- Agent manages via `memory` tool: `add`, `replace`, `remove` (substring matching)
- When full: consolidate or remove before adding new
- Security scanning: blocks injection/exfiltration patterns in memory entries

### 3. Session Search (Episodic Memory)

- SQLite + FTS5 full-text search across all past sessions
- `session_search` tool: query past conversations, LLM summarization of results
- Complements bounded memory (for "did we discuss X last week?" queries)

### The Self-Improvement Loop

```
encounter problem → solve it → write skill/playbook
→ next encounter → load skill → solve faster → update skill
→ repeat, accumulating domain knowledge over time
```

---

## Tool System

- 47 tools, 19 toolsets, self-registering at import time
- Sequential for single calls, ThreadPoolExecutor for parallel
- Agent-level tools intercepted before registry: `todo`, `memory`, `session_search`, `delegate_task`
- 6 terminal backends: local, Docker, SSH, Daytona, Modal, Singularity
- Dangerous command detection with user approval callback

---

## Design Principles (from Hermes team)

| Principle | What it means |
|-----------|---------------|
| Prompt stability | System prompt doesn't change mid-conversation |
| Observable execution | Every tool call visible to user |
| Interruptible | API calls and tool execution cancellable mid-flight |
| Platform-agnostic core | One AIAgent class serves CLI, gateway, ACP, batch, API |
| Loose coupling | Optional subsystems use registry patterns, not hard deps |
| Profile isolation | Each profile gets own home, config, memory, sessions |

---

## What Stratum Can Learn

### Patterns worth studying

1. **Progressive disclosure of knowledge** — skill index in prompt (~3k tokens), full content loaded on demand. Reduces context pressure.
2. **Agent-managed knowledge capture** — after complex tasks, agent writes procedures/gotchas as skill files. Self-improving without human authoring.
3. **Bounded curated memory** — small always-in-context block (~1,300 tokens total) complements larger retrieval systems.
4. **Gotcha/quirk persistence** — domain-specific trap logging that survives across sessions.

### Patterns NOT suited for Stratum

1. **Single-agent loop** — Stratum's multi-role DAG is more appropriate for structured software lifecycle.
2. **SKILL.md as flat files** — Stratum already has content store + link index + Cognee. Don't create a parallel knowledge system.
3. **General-purpose messaging gateway** — out of scope for Stratum's lifecycle focus.
4. **47-tool kitchen sink** — Stratum needs a focused toolset for build/validate/evolve, not general automation.
