# Hermes Agent — SLE/Stratum Development Plan

**Status:** planning · v1.0
**Date:** 2026-04-23
**Purpose:** Assess Hermes agent as the autonomous builder for SLE/Stratum, define the build loop, and outline a phased implementation plan.
**Related docs:**
- `../ideas/hermes-agent-architecture.md` — Hermes architecture deep dive
- `../ideas/browser-harness-architecture.md` — Browser harness analysis
- `../specs/` — Primary build reference
- `../overview/` — Architecture mental models

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Hermes Agent — Full Technical Profile](#2-hermes-agent--full-technical-profile)
3. [Gap Analysis: Hermes vs SLE Build Requirements](#3-gap-analysis-hermes-vs-sle-build-requirements)
4. [The Build Loop](#4-the-build-loop)
5. [Enforcing Structure Through Hermes's Existing Systems](#5-enforcing-structure-through-hermess-existing-systems)
6. [Phased Implementation Plan](#6-phased-implementation-plan)
7. [Project Files and Conventions](#7-project-files-and-conventions)
8. [Session Workflow](#8-session-workflow)
9. [Risk Assessment](#9-risk-assessment)
10. [What NOT to Do](#10-what-not-to-do)
11. [Browser Harness Integration](#11-browser-harness-integration)
12. [Monetization Context](#12-monetization-context)

---

## 1. Executive Summary

**Question:** Can Hermes agent autonomously build the SLE/Stratum system from the existing detailed specification docs?

**Answer:** Partially. Hermes excels at implementation work (writing code, running tests, debugging, file operations) but lacks structured planning, persistent task tracking, and a built-in review/validation loop. The strategy is to **use Hermes as the builder** and enforce the structure SLE needs through its existing extensibility features (skills, AGENTS.md, memory, delegation).

**Approach:** Define a strict 6-step build loop (Analyze → Plan → Implement → Verify → Reflect → Repeat), encode it into Hermes's skill system, and drive execution from a persistent `plan.md` file that tracks all tasks across sessions.

**Realistic timeline:** 3-4 months to a usable v0.1 with Hermes doing ~80% of coding under active human guidance. This is not "press go and come back in 2 months" — human review and course correction between sessions is essential.

---

## 2. Hermes Agent — Full Technical Profile

### 2.1 Architecture Overview

Hermes is a monolithic Python agent (~87.5% Python, 8.5% TypeScript) built by Nous Research. Fork/evolution of OpenClaw (itself a fork of OpenHands/Codex). Version 0.10.0, 5,556 commits, 615 contributors.

**Core data flow:**
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

**Key files:**
```
hermes-agent/
├── run_agent.py              # AIAgent — core loop (~10,700 lines)
├── cli.py                    # HermesCLI — terminal UI (~10,000 lines)
├── model_tools.py            # Tool discovery, schema, dispatch
├── toolsets.py               # Tool groupings and platform presets
├── hermes_state.py           # SQLite session/state with FTS5
├── agent/
│   ├── prompt_builder.py     # System prompt assembly
│   ├── context_engine.py     # ContextEngine ABC (pluggable)
│   ├── context_compressor.py # Lossy summarization
│   ├── prompt_caching.py     # Anthropic cache breakpoints
│   ├── auxiliary_client.py   # Side-task LLM (vision, summarization)
│   ├── memory_manager.py     # Memory orchestration
│   └── memory_provider.py    # Memory provider ABC
├── tools/
│   ├── registry.py           # Central tool registry (47 tools)
│   ├── terminal_tool.py      # Terminal orchestration
│   ├── browser_tool.py       # Browser automation
│   ├── delegate_tool.py      # Subagent delegation
│   ├── mcp_tool.py           # MCP client (~2,200 lines)
│   └── environments/         # 6 terminal backends
├── skills/                   # Bundled skills (always available)
├── optional-skills/          # Official optional skills
└── gateway/                  # 18 messaging platform adapters
```

### 2.2 Agent Loop

```
1. Build system prompt (prompt_builder)
2. Add memory context (MEMORY.md, USER.md)
3. Prepend conversation history
4. Call LLM via appropriate transport
5. If response has tool_calls:
   a. Execute tools (parallel when safe)
   b. Append tool results to messages
   c. Loop back to step 4
6. If response is text only:
   a. Return final response
   b. Save to SessionDB
```

**Iteration budget:** 90 turns default (configurable via `agent.max_turns`). Subagents get 50. `execute_code` iterations are refunded (collapse multi-step pipelines into one turn).

**API modes (3 transports):**
| Mode | When Used |
|---|---|
| `chat_completions` | Default OpenAI-compatible endpoints |
| `codex_responses` | OpenAI Codex/GPT-5, xAI |
| `anthropic_messages` | Native Anthropic, Bedrock, MiniMax |
| `bedrock_converse` | AWS Bedrock (non-Anthropic models) |

Auto-detection based on provider name and base URL.

**Parallel tool execution:**
- Never parallel: `clarify` (interactive)
- Always safe: read-only tools (session_search, web_search, read_file, etc.)
- Path-scoped: file tools on independent paths run concurrently
- Destructive detection: regex patterns detect `rm`, `sed -i`, etc., force sequential
- Max 8 concurrent worker threads

**Error handling:** Jittered exponential backoff, error classification, failover between providers (credential pool rotation), tool call argument JSON repair, surrogate character sanitization, stale-call detection.

### 2.3 Skills System (Procedural Memory)

**The core innovation of Hermes.** Skills are procedural memory — reusable markdown documents containing specialized knowledge, API endpoints, tool-specific commands, and proven workflows. They are NOT code; they are instructions the LLM loads and follows.

**SKILL.md format:**
```yaml
---
name: my-skill
description: Brief description
version: 1.0.0
author: Hermes Agent
metadata:
  hermes:
    tags: [python, automation]
    category: devops
    related_skills: [other-skill]
    requires_toolsets: [terminal]
    fallback_for_toolsets: [web]
---

# Skill Title
## When to Use — trigger conditions
## Procedure — step-by-step
## Pitfalls — known failure modes
## Verification — how to confirm success
```

**Skill loading:**
1. Skills scanned from `~/.hermes/skills/` and configured `skills.external_dirs`
2. Two-layer cache prevents re-scanning: in-process LRU + disk snapshot
3. Skill index injected into system prompt as compact listing (~3k tokens)
4. When a skill matches a task, agent calls `skill_view(name)` to load full content
5. Progressive disclosure: `skills_list()` → `skill_view(name)` → `skill_view(name, path)`

**Self-teaching / self-improving loop:**
1. Every N tool-calling iterations (configurable, default 15), agent is reminded to consider saving a skill
2. After complex tasks (5+ tool calls), fixing tricky errors, or discovering workflows, agent autonomously creates skills via `skill_manage(action='create')`
3. When using a skill and finding it outdated/wrong, agent patches it via `skill_manage(action='patch')`
4. Compatible with agentskills.io open standard for sharing

**Bundled skills (20+ categories):** apple, autonomous-ai-agents, creative, data-science, diagramming, dogfood, domain, email, feeds, gaming, gifs, github, inference-sh, media, mlops, note-taking, productivity, research, smart-home, social-media, software-development

### 2.4 Context Management

**System prompt assembly (built by `agent/prompt_builder.py`):**

1. **Identity** (SOUL.md from `~/.hermes/SOUL.md` or default)
2. **Platform hints** (formatting per platform)
3. **Environment hints** (WSL detection, etc.)
4. **Memory context** (MEMORY.md + USER.md, wrapped in `<memory-context>` fences)
5. **Skills index** (compact listing of available skills by category)
6. **Context files** (priority: `.hermes.md` > `AGENTS.md` > `CLAUDE.md` > `.cursorrules`)
7. **Tool-use enforcement guidance** (model-specific)
8. **Nous subscription prompt** (when applicable)

Each context file capped at 20,000 characters with head/tail truncation. Content scanned for prompt injection patterns before injection.

**Context compression (when `prompt_tokens >= threshold%` of context_length, default 50%):**

1. Cheap pre-pass: prune old tool results, replace with 1-line summaries
2. Deduplicate identical tool results (keep newest)
3. Protect head: system prompt + first 3 exchanges
4. Protect tail: token-budget-based (~20% of threshold)
5. Summarize middle: LLM generates structured summary with sections:
   - Active Task, Goal, Completed Actions, Active State
   - In Progress, Blocked, Key Decisions, Resolved Questions
   - Pending User Asks, Relevant Files, Remaining Work, Critical Context
6. Iterative updates: on subsequent compression, previous summary is updated rather than regenerated
7. Anti-thrashing: if two consecutive compressions save <10% each, compression is skipped

**Prompt caching:** Anthropic prompt caching auto-enabled for Claude models. `system_and_3` strategy (4 cache breakpoints). 5-minute TTL default.

### 2.5 Memory / State Persistence

**SQLite database** at `~/.hermes/state.db` (WAL mode for concurrent access):

| Table | Purpose |
|---|---|
| `sessions` | id, source, model, system_prompt, token counts, cost tracking, title, parent_session_id |
| `messages` | role, content, tool_calls, reasoning fields, timestamps |
| `messages_fts` | FTS5 virtual table for full-text search across all messages |

**Session lineage:** Compression splits create parent/child chains. `get_compression_tip()` walks forward to find latest continuation.

**Persistent memory stores:**

| Store | File | Purpose | Default Limit |
|---|---|---|---|
| Agent notes | `~/.hermes/MEMORY.md` | Environment facts, conventions, tool quirks | 2,200 chars (~800 tokens) |
| User profile | `~/.hermes/USER.md` | Preferences, communication style | 1,375 chars (~500 tokens) |

**Memory management:**
- Periodic memory nudges (every 10 user turns)
- Memory flush on session exit/reset
- Agent-curated: writes declarative facts, NOT instructions to itself
- Cross-session recall via `session_search` (FTS5 + summarization)

### 2.6 Built-in Tools (47 tools, 19 toolsets)

| Category | Tools |
|---|---|
| **Web** | `web_search`, `web_extract` (4 backend providers) |
| **Terminal** | `terminal` (6 backends: local, Docker, SSH, Daytona, Modal, Singularity), `process` |
| **File** | `read_file`, `write_file`, `patch` (fuzzy matching), `search_files` |
| **Browser** | 11 tools: navigate, snapshot, click, type, scroll, back, press, get_images, vision, console, CDP |
| **Vision** | `vision_analyze` |
| **Image Gen** | `image_generate` |
| **Skills** | `skills_list`, `skill_view`, `skill_manage` |
| **Memory** | `memory` (read/write MEMORY.md and USER.md) |
| **Planning** | `todo` (in-memory task tracking — NOT persistent) |
| **Session** | `session_search` (FTS5 + summarization) |
| **Code Execution** | `execute_code` (Python sandbox with RPC tool calling) |
| **Delegation** | `delegate_task` (spawn subagents) |
| **TTS** | `text_to_s_speech` (Edge TTS free, ElevenLabs, OpenAI, xAI) |
| **Cron** | `cronjob` (create/list/update/pause/resume/remove) |
| **Messaging** | `send_message` (cross-platform delivery) |
| **Clarify** | `clarify` (ask user multiple-choice questions) |
| **Home Assistant** | entity listing, state, services, calls |
| **RL Training** | 10 tools for Tinker-Atropos environments |
| **MCP** | Dynamic tool registration from MCP servers |

**Tool registry:** Tools self-register at import time via `tools/registry.py`. Auto-discovery. No manual import list needed.

**Tool availability gating:**
- Per-platform toolsets: CLI, Telegram, Discord, etc. each have curated tool presets
- `check_fn` gating: some tools only activate when their API key is present
- Tool approval: dangerous terminal commands require user approval (configurable allowlist)

**Subagent delegation (`delegate_task`):**
- Fresh conversation (no parent history)
- Own terminal session, own file operation cache
- Restricted toolset (blocks: `delegate_task`, `clarify`, `memory`, `send_message`, `execute_code`)
- Configurable max iterations (default: 50)
- Max concurrent children (default: 3)
- Depth cap (default: 1 = flat, configurable to 3 for nested orchestration)
- Orchestrator role enables children to spawn their own workers
- Parent sees only summary result, never intermediate tool calls
- Heartbeat mechanism prevents gateway timeout during delegation

### 2.7 Configuration

**Config file:** `~/.hermes/config.yaml`

Major sections:
- `model` — provider, model name, base_url, context_length, max_tokens
- `terminal` — backend (local/ssh/docker/modal/daytona/singularity), timeout, resource limits
- `compression` — enabled, threshold (50%), target_ratio (20%), protect_last_n
- `memory` — char limits, nudge interval, flush settings
- `session_reset` — mode (both/idle/daily/none), idle timeout, daily hour
- `skills` — creation nudge interval, external directories
- `agent` — max_turns, reasoning_effort, personalities
- `platform_toolsets` — per-platform tool configuration
- `mcp_servers` — MCP server connections (stdio or HTTP)
- `delegation` — max_iterations, max_concurrent_children, max_spawn_depth, model override
- `display` — tool_progress, streaming, skins
- `hooks` — shell-script hooks for pre/post tool/LLM events
- `auxiliary` — models for vision, web_extract, session_search, compression
- `privacy` — PII redaction

**Provider support:** 18+ providers including OpenRouter (200+ models), Nous Portal, Anthropic, OpenAI Codex, GitHub Copilot, Google Gemini, z.ai/GLM, Kimi/Moonshot, MiniMax, NVIDIA NIM, Xiaomi MiMo, Arcee, Hugging Face, Ollama Cloud, KiloCode, Vercel AI Gateway. Local servers: LM Studio, Ollama, vLLM, llama.cpp. AWS Bedrock.

### 2.8 Extensibility

**Adding custom tools:** Create a file in `tools/` that calls `registry.register()` at import time. Auto-discovered.

**Adding custom skills:** Drop a directory with `SKILL.md` into `~/.hermes/skills/`. No code needed — just markdown instructions.

**Plugin system:** Three discovery sources (`~/.hermes/plugins/`, `.hermes/plugins/`, pip entry points). Plugins can register tools, hooks, CLI commands, memory providers, context engines.

**MCP integration:** Connect any MCP server via stdio or HTTP. Tools auto-discovered and registered.

**Shell hooks:** Register shell scripts as plugin-hook callbacks for pre/post tool/LLM events.

**Custom terminal backends:** 6 built-in (local, Docker, SSH, Daytona, Modal, Singularity). Each sandboxed environment can have resource limits and persistent filesystems.

### 2.9 Task Specification

Tasks are free-form natural language. No special format required.

Entry points:
- **CLI:** `hermes` → interactive conversation
- **Messaging:** Telegram, Discord, Slack, WhatsApp, Signal
- **Cron:** `cronjob create "natural language task"` for automated recurring tasks
- **Batch runner:** `python batch_runner.py --config=config.yaml` for programmatic execution
- **API server:** OpenAI-compatible API

In-conversation slash commands: `/new`, `/model`, `/compress`, `/skills`, `/personality`, `/retry`, `/undo`, `/usage`, `/stop`

### 2.10 Validation / Review Mechanisms

**No explicit review loop.** Hermes does NOT have a built-in review/validation loop where the agent self-critiques its output before delivery.

**Safety mechanisms (not structural review):**
- Tool approval: dangerous terminal commands require user approval
- Context file scanning for prompt injection
- PII redaction
- Secret redaction during compression
- Path security validation
- URL safety validation
- OSV vulnerability scanning
- Tirith integration for pre-exec command security scanning

**Verification is model-guided (prompt-level only):**
- System prompt includes verification guidance ("Correctness: does the output satisfy every stated requirement?")
- Particularly strong for GPT/Codex models with dedicated execution discipline prompts
- Not a structural mechanism — depends entirely on model capability

---

## 3. Gap Analysis: Hermes vs SLE Build Requirements

### What Hermes does well for building SLE

| SLE Need | Hermes Capability |
|---|---|
| Writing TypeScript code | Terminal + file tools, strong code generation |
| Running tests/linters | Terminal tool with 6 backends |
| Reading spec docs | File reading tools, context file loading |
| File operations | read_file, write_file, patch (fuzzy matching) |
| Debugging | Terminal execution, error logs, search |
| Self-improvement | Skills auto-created and auto-patched |
| Cross-session memory | MEMORY.md, USER.md, session_search (FTS5) |
| Parallel work | Subagent delegation (up to 3 concurrent) |
| Model flexibility | 18+ providers, easy switching |

### Critical gaps (what Hermes lacks)

| SLE Need | Gap | Severity | Mitigation |
|---|---|---|---|
| Structured planning | No plan-then-execute decomposition. Relies on LLM's internal planning. | **High** | External `plan.md` + skill instructions |
| Persistent task tracking | `todo` tool is in-memory only, lost on session reset | **High** | Use `plan.md` as source of truth, checked into git |
| Review/validation loop | No structural review mechanism. Verification is prompt-level only. | **High** | Build review step into skill instructions; human review between sessions |
| Multi-agent roles | Delegation exists but no shared state between parent/children | **Medium** | Use file-based coordination (shared docs in repo) |
| Checkpoint/rollback | No built-in undo for file operations | **Medium** | Git commits after every task (enforce in skill) |
| Spec comprehension | Hermes doesn't automatically ingest 20+ spec docs | **Medium** | AGENTS.md for always-loaded context; skill for loading specific specs on demand |

### Strengths/weaknesses assessment for autonomous large-scale software construction

**Strengths:**
1. Self-improving loop: skills auto-created and auto-patched, memory persists, session search provides cross-session recall
2. Subagent delegation: parallel workstreams with isolated context, orchestrator pattern for decomposition
3. Flexible model routing: 18+ providers, easy switching, credential pooling for rate limit rotation
4. Rich tool ecosystem: 47 tools covering terminal, file, web, browser, code execution, MCP
5. Context management: sophisticated compression with structured summaries, iterative updates, anti-thrashing
6. Extensible: plugins, MCP, custom tools, custom skills, shell hooks
7. Cron scheduling: autonomous recurring tasks
8. Browser harness integration: web automation for testing

**Weaknesses:**
1. Monolithic core: `run_agent.py` is ~10,700 lines — deep customization difficult without forking
2. No structured planning: relies on LLM's internal planning
3. No built-in review loop: verification is prompt-guided, not structural
4. Token-limited memory: MEMORY.md at 2,200 chars and USER.md at 1,375 chars are small for complex projects
5. No persistent TODO across sessions
6. Python-centric code execution
7. Skills are prompt-level: compliance depends on model capability
8. Single-agent-with-delegation: not a true multi-agent system with shared state
9. No checkpoint/rollback for file operations

---

## 4. The Build Loop

### 4.1 The 6-Step Loop

The core execution loop that Hermes must follow for every task:

```
┌─────────────────────────────────────────────────────┐
│  THE BUILD LOOP                                      │
│                                                       │
│  1. ANALYZE                                          │
│     Read plan.md + current code state                 │
│     Identify next incomplete task                     │
│     Check for blockers or ambiguities                 │
│     Review any unresolved reflections from last task  │
│                                                       │
│  2. PLAN (scoped to ONE task)                         │
│     Break the task into concrete file changes         │
│     List files to create/modify                       │
│     Define acceptance criteria                        │
│     Identify which spec docs are relevant              │
│     Write plan to .sle-build/current-task.md          │
│                                                       │
│  3. IMPLEMENT                                         │
│     Execute the plan for that ONE task                │
│     Write code, create files                          │
│     Follow project conventions from AGENTS.md         │
│     Update progress in current-task.md                │
│                                                       │
│  4. VERIFY                                            │
│     Run tests, linter, typecheck                      │
│     Check against acceptance criteria                 │
│     If fail → fix and re-verify (max 3 retries)       │
│     If pass after fixes → document what was wrong      │
│     If pass first try → continue                      │
│                                                       │
│  5. REFLECT                                           │
│     What was learned during implementation?            │
│     Any ambiguities found in the spec?                │
│     Any decisions made?                               │
│     Any gotchas for future tasks?                     │
│     Update .sle-build/decisions.md                    │
│     Update .sle-build/ambiguities.md                  │
│     Update .sle-build/gotchas.md                      │
│     Update plan.md (mark task done, adjust estimates)  │
│     Git commit with descriptive message               │
│     Optionally: create Hermes skill for learned patterns│
│                                                       │
│  6. REPEAT → go to step 1                            │
└─────────────────────────────────────────────────────┘
```

### 4.2 Loop rules

1. **One task at a time.** Never work on two tasks simultaneously unless delegating to a subagent.
2. **Never skip steps.** Every task goes through all 6 steps. No exceptions.
3. **Verify before committing.** A task is not done until tests and lint pass.
4. **Reflect after every task.** Even if nothing was learned, explicitly state that.
5. **Update plan.md after every task.** Mark tasks done, add new tasks discovered during implementation.
6. **Git commit after every completed task.** This provides rollback and audit trail.
7. **Stop after 90 minutes of continuous work.** Present a summary to the user for review.
8. **If stuck for 3 retries on the same issue, stop and ask for help.** Don't spiral.
9. **If a spec ambiguity is found, log it in ambiguities.md and make a reasonable assumption.** Note the assumption in the commit message.
10. **If a task requires changes to already-completed tasks, finish the current task first, then create a follow-up task in plan.md.**

### 4.3 When to delegate to subagents

Delegate when:
- A task has two independent sub-tasks that can run in parallel (e.g., implement types + write tests)
- A task requires researching external documentation (e.g., reading a library's API docs)
- A task is mechanical and doesn't require creative judgment (e.g., converting YAML schemas to Zod)

Do NOT delegate when:
- The task touches multiple interdependent files
- The task requires understanding of the overall architecture
- The task involves decisions that affect future tasks

---

## 5. Enforcing Structure Through Hermes's Existing Systems

**Key insight:** Do NOT modify Hermes. Use its existing features to enforce the build loop.

### 5.1 Project Skill (`sle-builder`)

Create `~/.hermes/skills/sle-builder/SKILL.md`:

```yaml
---
name: sle-builder
description: Build loop for SLE/Stratum autonomous construction
version: 1.0.0
metadata:
  hermes:
    tags: [sle, stratum, build-loop, autonomous]
    category: software-development
    requires_toolsets: [terminal, file]
---

# SLE Builder — Autonomous Build Loop

## When to Use
When building the SLE/Stratum system. Always active during SLE development sessions.

## The Build Loop
[Full 6-step loop from Section 4.1 above]

## Rules
[Full rules from Section 4.2 above]

## Project Files
- `plan.md` — master task list and progress tracking (NEVER delete tasks, mark as done)
- `.sle-build/current-task.md` — active task details and acceptance criteria
- `.sle-build/decisions.md` — implementation decisions made during building
- `.sle-build/ambiguities.md` — spec ambiguities found, assumptions made
- `.sle-build/gotchas.md` — technical gotchas for future reference
- `AGENTS.md` — always-loaded project context (read automatically)

## Spec Loading
When starting a task, identify which spec docs are relevant and load them:
- Types/schemas → `init-specs/01-types.md`, `init-specs/06-zod-schemas.md`
- Daemon → `v2/specs/daemon-api.md`, `v2/specs/state-machine.md`
- DAG → `v2/specs/dag-execution.md`, `v2/specs/dag-node-reference.md`
- CLI → `v2/specs/init-and-discovery.md`
- Validation → `v2/specs/validation.md`
- Rules → `v2/specs/rule-files.md`, `v2/reference/rule-file-defaults.md`
- Context → `v2/specs/context-manager.md`, `v2/specs/prompt-templates.md`
- Graph → `v2/specs/knowledge-engine.md`, `v2/specs/content-modules.md`

## Conventions
- TypeScript with strict mode
- No comments unless explicitly asked
- Follow existing patterns in neighboring files
- Use Zod for all runtime validation
- All errors follow SLE-010 taxonomy (v2/reference/error-codes.md)

## Verification Commands
- `npm run test` — run test suite
- `npm run lint` — lint check
- `npm run typecheck` — TypeScript type checking
- `npm run build` — production build
```

### 5.2 AGENTS.md (always loaded)

Hermes reads `AGENTS.md` from the project root on every turn. This is where project-level context lives:

```markdown
# SLE/Stratum — Agent Instructions

## Project Overview
SLE (Software Lifecycle Engine) / Stratum is a closed-loop autonomous system
that transforms intent into working, validated software.

## Architecture
[Key architectural decisions — link to DDRs]

## Tech Stack
- TypeScript (strict mode)
- Node.js for daemon
- Zod for validation
- YAML for rule files
- WebSocket + REST API
- Tauri + web for dashboard

## File Conventions
- Source code in `packages/` (monorepo)
- Specs in `docs/apps/sdk-orchestrator/v2/specs/`
- Types in `packages/types/src/`
- Rule schemas in `packages/rules/src/`
- Daemon in `packages/daemon/src/`
- CLI in `packages/cli/src/`

## What NOT to Touch
- `docs/` — do not modify documentation files
- `.sle/` — do not modify SLE config files
- `dist/`, `node_modules/` — generated directories

## Current Phase
[Update this section as phases progress]

## Build & Test Commands
- `npm run test` — run all tests
- `npm run lint` — lint all packages
- `npm run typecheck` — type check all packages
- `npm run build` — build all packages
```

### 5.3 plan.md (source of truth)

```markdown
# SLE Build Plan

## Legend
- [ ] Not started
- [~] In progress
- [x] Complete
- [!] Blocked (see ambiguities.md)

## Phase 1: Foundation (Types & Schemas)
- [ ] 1.1 TypeScript type definitions
  - Source: `init-specs/01-types.md`, `v2/reference/types.md`
  - Acceptance: all types defined, typecheck passes
- [ ] 1.2 Zod validation schemas
  - Source: `init-specs/06-zod-schemas.md`
  - Acceptance: all rule files parseable, invalid input rejected
- [ ] 1.3 Rule file YAML schemas
  - Source: `init-specs/02-rule-files.md`, `v2/specs/rule-files.md`
  - Acceptance: all 7 rule files loadable

## Phase 2: Daemon Core
- [ ] 2.1 Rule loader
  - Source: `v2/specs/rule-files.md`
  - Acceptance: loads all 7 rule files, merges into RuntimeConfig
- [ ] 2.2 Map.yaml reader/writer
  - Source: `v2/reference/map-yaml-schema.md`
  - Acceptance: read/write roundtrip preserves all fields
- [ ] 2.3 Artifact store (read/write/append/diff)
  - Source: `v2/specs/dag-execution.md`, `v2/reference/artifact-registry.md`
  - Acceptance: CRUD operations work, diff produces valid output
- [ ] 2.4 State machine
  - Source: `v2/specs/state-machine.md`
  - Acceptance: all states and transitions valid, invalid transitions rejected
- [ ] 2.5 Daemon server (REST + WebSocket)
  - Source: `v2/specs/daemon-api.md`, `v2/reference/websocket-events.md`
  - Acceptance: all endpoints respond, events broadcast

## Phase 3: DAG Runner
- [ ] 3.1 DAG node types and registry
  - Source: `v2/specs/dag-node-reference.md`
  - Acceptance: all node types loadable, dependency resolution works
- [ ] 3.2 DAG executor
  - Source: `v2/specs/dag-execution.md`
  - Acceptance: nodes execute in order, cycles detected and rejected
- [ ] 3.3 Context manager
  - Source: `v2/specs/context-manager.md`
  - Acceptance: assembles context for each agent role within token budget
- [ ] 3.4 Prompt templates
  - Source: `v2/specs/prompt-templates.md`
  - Acceptance: all templates render with correct variables

## Phase 4: CLI
- [ ] 4.1 `sle daemon start/stop/status`
  - Source: `v2/specs/daemon-api.md`
  - Acceptance: daemon starts, stops, reports status
- [ ] 4.2 `sle init` (10-step sequence)
  - Source: `v2/specs/init-and-discovery.md`, `init-specs/07-init-state.md`
  - Acceptance: all 10 steps complete, state persists
- [ ] 4.3 `sle start` / `sle halt` / `sle status`
  - Source: `v2/specs/daemon-api.md`
  - Acceptance: cycle starts, halts, status reports correctly
- [ ] 4.4 `sle approve` / `sle reject`
  - Source: `v2/specs/daemon-api.md`
  - Acceptance: approval gates work

## Phase 5: Validation System
- [ ] 5.1 Validation engine
  - Source: `v2/specs/validation.md`
  - Acceptance: dual-phase (LLM + executable) runs
- [ ] 5.2 Gate logic
  - Source: `v2/specs/validation.md`
  - Acceptance: deterministic boolean on all categories
- [ ] 5.3 Failure reports
  - Source: `v2/specs/validation.md`, `v2/reference/error-codes.md`
  - Acceptance: reports generated with correct error codes

## Phase 6: Discovery & Init
- [ ] 6.1 Discovery flow (simplified 2-round solo mode)
  - Source: `v2/specs/init-and-discovery.md`, `vision/SLE-011-project-discovery.md`
  - Acceptance: guided Q&A produces product brief and constraints
- [ ] 6.2 Init sequence
  - Source: `init-specs/` (all 7 docs)
  - Acceptance: fresh project sets up all files, validation passes

## Phase 7: Agent Roles
- [ ] 7.1 Planner agent
  - Source: `v2/specs/prompt-templates.md`, `v2/overview/agent-roles.md`
  - Acceptance: produces plan from intent + context
- [ ] 7.2 Builder agent
  - Source: `v2/specs/prompt-templates.md`, `v2/overview/agent-roles.md`
  - Acceptance: executes plan, produces code changes
- [ ] 7.3 Evaluator agent
  - Source: `v2/specs/prompt-templates.md`, `v2/overview/agent-roles.md`
  - Acceptance: validates output against criteria
- [ ] 7.4 Critic agent
  - Source: `v2/specs/prompt-templates.md`, `v2/overview/agent-roles.md`
  - Acceptance: identifies issues missed by evaluator

## Phase 8: Web UI
- [ ] 8.1 Dashboard shell (Overview page)
  - Source: `vision/SLE-020-ui-shell-navigation.md`
  - Acceptance: shows cycle state, active tasks, pending actions
- [ ] 8.2 Chat page (Facilitator UI)
  - Source: `vision/SLE-012-conversation-mode.md`, `vision/SLE-020-ui-shell-navigation.md`
  - Acceptance: free-form conversation with Facilitator
- [ ] 8.3 Graph page (project visualization)
  - Source: `vision/SLE-013-graph-dashboard.md`, `vision/SLE-016-project-overview.md`
  - Acceptance: renders project graph with interactive nodes

## Phase 9: Integrations
- [ ] 9.1 Beads/Dolt bridge
  - Source: `v2/specs/beads-integration.md`
  - Acceptance: create, claim, close tasks
- [ ] 9.2 Knowledge engine (Cognee)
  - Source: `v2/specs/knowledge-engine.md`
  - Acceptance: vector search over project artifacts
- [ ] 9.3 Content modules
  - Source: `v2/specs/content-modules.md`
  - Acceptance: per-layer data processors work

## Phase 10: Polish & Error Handling
- [ ] 10.1 Error taxonomy (E001-E043 + E050-E062)
  - Source: `v2/reference/error-codes.md`
  - Acceptance: all errors produce correct codes and messages
- [ ] 10.2 Edge cases and recovery flows
  - Source: `v2/specs/state-machine.md`, `vision/SLE-010-error-handling.md`
  - Acceptance: crash recovery, state restoration, graceful degradation
- [ ] 10.3 Documentation and examples
  - Acceptance: README, getting started guide, example project
```

### 5.4 .sle-build/ directory structure

```
.sle-build/
├── current-task.md      # Active task: plan, files, acceptance criteria, progress
├── decisions.md         # Implementation decisions log
├── ambiguities.md       # Spec ambiguities found, assumptions made
├── gotchas.md           # Technical gotchas and lessons learned
└── session-log.md       # Summary of what was done each session
```

**current-task.md format:**
```markdown
# Current Task: [task-id] — [title]

## Source Specs
- `path/to/spec.md` (sections X-Y)

## Plan
1. [step 1]
2. [step 2]
...

## Files to Create/Modify
- `packages/types/src/foo.ts` (create)
- `packages/daemon/src/bar.ts` (modify: add X, change Y)

## Acceptance Criteria
- [ ] [criterion 1]
- [ ] [criterion 2]

## Progress
- [x] Step 1: done
- [~] Step 2: in progress
- [ ] Step 3: not started

## Issues Encountered
- [any issues during implementation]
```

**decisions.md format:**
```markdown
# Implementation Decisions

## DEC-001 — [title]
**Date:** YYYY-MM-DD
**Task:** [task-id]
**Decision:** [what was decided]
**Rationale:** [why]
**Alternatives considered:** [what else was considered]
**Impact:** [what this affects going forward]
```

**ambiguities.md format:**
```markdown
# Spec Ambiguities

## AMB-001 — [title]
**Spec:** `path/to/spec.md` section X
**Ambiguity:** [what is unclear]
**Assumption made:** [what we assumed]
**Risk:** [what happens if assumption is wrong]
**Resolution needed by:** [which phase/task]
```

**gotchas.md format:**
```markdown
# Technical Gotchas

## GOT-001 — [title]
**Discovered during:** [task-id]
**Gotcha:** [what the issue is]
**Symptom:** [what goes wrong]
**Fix:** [how to avoid/fix it]
**Applies to:** [which files/patterns]
```

### 5.5 MEMORY.md entries

Hermes's MEMORY.md (2,200 char limit) should contain high-level project facts that survive across sessions:

```
- SLE/Stratum is a TypeScript monorepo in packages/
- Build commands: npm run test/lint/typecheck/build
- Spec docs in docs/apps/sdk-orchestrator/v2/
- Always follow the 6-step build loop from sle-builder skill
- plan.md is source of truth for task status
- Git commit after every completed task
- Zod for runtime validation, strict TypeScript
- 7 YAML rule files in .sle/rules/
- Daemon runs on port 7700 (REST + WebSocket)
```

### 5.6 Session start ritual

Every Hermes session starts with this prompt (or a variation):

```
Load skill sle-builder. Read plan.md. Read .sle-build/current-task.md if it exists.
Read .sle-build/ambiguities.md and .sle-build/gotchas.md.

Tell me:
1. What task is next in plan.md
2. Any unresolved ambiguities or gotchas that affect it
3. Your plan for this session (how many tasks you expect to complete)

Then begin the build loop. Execute tasks one at a time through the full
6-step cycle (analyze → plan → implement → verify → reflect → repeat).

After each task completion, git commit and update plan.md.

Stop and ask me if:
- You encounter a spec ambiguity that blocks progress
- You've retried a failing test 3 times
- You've been running for 90 minutes
- You discover that a completed task needs to be revised
```

---

## 6. Phased Implementation Plan

### Phase 1: Foundation — Types & Schemas (2-3 weeks)

**Why first:** Everything depends on types and validation schemas. Pure mechanical translation from spec docs — Hermes will crush this.

**Tasks:**
1.1 TypeScript type definitions (from `init-specs/01-types.md`, `v2/reference/types.md`)
1.2 Zod validation schemas (from `init-specs/06-zod-schemas.md`)
1.3 Rule file YAML schemas (from `init-specs/02-rule-files.md`, `v2/specs/rule-files.md`)

**Deliverable:** `@sle/types` and `@sle/rules` packages that compile, pass tests, and can load/validate all rule files.

**Risk:** Low. Mechanical work, well-specified.

### Phase 2: Daemon Core (3-4 weeks)

**Why next:** The daemon is the heart of the system. Everything connects to it.

**Tasks:**
2.1 Rule loader — loads all 7 rule files, merges into RuntimeConfig
2.2 Map.yaml reader/writer — YAML roundtrip with schema validation
2.3 Artifact store — file-based CRUD with diff support
2.4 State machine — cycle states and transitions
2.5 Daemon server — REST endpoints + WebSocket event broadcasting

**Deliverable:** A running daemon that starts, loads config, serves API endpoints, and broadcasts events.

**Risk:** Medium. State machine and WebSocket need careful design. WebSocket event ordering matters.

### Phase 3: DAG Runner (3-4 weeks)

**Why next:** The DAG runner is the execution engine that drives cycles.

**Tasks:**
3.1 DAG node types and registry
3.2 DAG executor (topological sort, parallel execution where possible)
3.3 Context manager (token budgets, role-specific context assembly)
3.4 Prompt templates (Planner, Builder, Evaluator, Critic roles)

**Deliverable:** A DAG runner that can execute a sequence of agent roles with proper context injection.

**Risk:** High. Context management and token budgets require tuning. Prompt engineering is iterative.

### Phase 4: CLI (2-3 weeks)

**Why next:** CLI is the primary user interface and the easiest way to test the system.

**Tasks:**
4.1 `sle daemon start/stop/status`
4.2 `sle init` (10-step setup sequence)
4.3 `sle start` / `sle halt` / `sle status`
4.4 `sle approve` / `sle reject`

**Deliverable:** Working CLI that can initialize a project, start the daemon, and run a basic cycle.

**Risk:** Medium. Depends on daemon core and DAG runner being stable.

### Phase 5: Validation System (2-3 weeks)

**Why next:** Validation is what makes SLE more than a code generator.

**Tasks:**
5.1 Validation engine (dual-phase: LLM reasoning + executable scripts)
5.2 Gate logic (deterministic boolean on all categories)
5.3 Failure reports (structured output with error codes)

**Deliverable:** Validation system that runs checks, produces gate decisions, and generates reports.

**Risk:** Medium. Dual-phase validation (LLM + executable) is novel and needs testing.

### Phase 6: Discovery & Init (2-3 weeks)

**Why next:** Discovery is the onboarding experience.

**Tasks:**
6.1 Discovery flow (start with simplified 2-round solo mode from SLE-011)
6.2 Init sequence (full 10-step setup from SLE-009)

**Deliverable:** `sle discover` produces foundational docs; `sle init` sets up a new project.

**Risk:** Low-Medium. Discovery is mostly prompt engineering. Init is mechanical.

### Phase 7: Agent Roles (2-3 weeks)

**Why next:** The agents need proper prompt templates and role-specific behavior.

**Tasks:**
7.1 Planner agent
7.2 Builder agent
7.3 Evaluator agent
7.4 Critic agent

**Deliverable:** Four distinct agent roles with tested prompt templates.

**Risk:** High. Prompt engineering is iterative and model-dependent. Requires significant testing.

### Phase 8: Web UI (3-4 weeks)

**Why next:** Visual interface for monitoring and mobile use.

**Tasks:**
8.1 Dashboard shell (Overview page)
8.2 Chat page (Facilitator UI)
8.3 Graph page (project visualization)

**Deliverable:** Web UI served by daemon at localhost:7700/ui.

**Risk:** Medium. Tauri + web stack. Graph visualization needs a library (Sigma.js or similar).

### Phase 9: Integrations (2-3 weeks)

**Why next:** Beads, Cognee, content modules extend the core.

**Tasks:**
9.1 Beads/Dolt bridge
9.2 Knowledge engine (Cognee integration)
9.3 Content modules (per-layer data processors)

**Deliverable:** Working integrations with issue tracking and knowledge search.

**Risk:** Medium. External dependencies (Cognee, Dolt) add complexity.

### Phase 10: Polish & Error Handling (2-3 weeks)

**Why last:** Error handling and edge cases should be hardened after the core works.

**Tasks:**
10.1 Error taxonomy (E001-E043 + E050-E062)
10.2 Edge cases and recovery flows
10.3 Documentation and examples

**Deliverable:** Production-ready error handling, crash recovery, and user-facing docs.

**Risk:** Low. Mostly mechanical, but requires thorough testing of edge cases.

### Timeline Summary

| Phase | Duration | Cumulative |
|---|---|---|
| Phase 1: Foundation | 2-3 weeks | 2-3 weeks |
| Phase 2: Daemon Core | 3-4 weeks | 5-7 weeks |
| Phase 3: DAG Runner | 3-4 weeks | 8-11 weeks |
| Phase 4: CLI | 2-3 weeks | 10-14 weeks |
| Phase 5: Validation | 2-3 weeks | 12-17 weeks |
| Phase 6: Discovery & Init | 2-3 weeks | 14-20 weeks |
| Phase 7: Agent Roles | 2-3 weeks | 16-23 weeks |
| Phase 8: Web UI | 3-4 weeks | 19-27 weeks |
| Phase 9: Integrations | 2-3 weeks | 21-30 weeks |
| Phase 10: Polish | 2-3 weeks | 23-33 weeks |

**Realistic total: 6-8 months for full system.** Phases 1-4 (MVP: daemon + CLI) achievable in **3-4 months**.

### MVP vs Full Build

**MVP (Phases 1-4):** Types, schemas, daemon, DAG runner, CLI. This is the smallest useful unit — a developer can `sle init` a project and `sle start` a basic cycle.

**Full (Phases 1-10):** Complete system with validation, discovery, agent roles, web UI, integrations, and error handling.

**Recommendation:** Build MVP first, use it on the game project to dogfood, then grow from there.

---

## 7. Project Files and Conventions

### 7.1 Monorepo structure

```
packages/
├── types/          # Shared TypeScript types
├── rules/          # Rule file loader + Zod schemas
├── daemon/         # SDK daemon (REST + WebSocket server)
├── dag/            # DAG runner and node registry
├── context/        # Context manager (token budgets, role assembly)
├── prompts/        # Prompt templates per agent role
├── cli/            # @sle/cli — terminal interface
├── validation/     # Validation engine + gate logic
├── discovery/      # Discovery flow (Facilitator Q&A)
├── agents/         # Agent role implementations
├── web/            # @sle/web — dashboard UI
├── integrations/   # Beads, Cognee, content modules
└── error/          # Error taxonomy and handling
```

### 7.2 Build files

```
.sle-build/
├── current-task.md      # Active task details
├── decisions.md         # Implementation decisions log
├── ambiguities.md       # Spec ambiguities found
├── gotchas.md           # Technical gotchas
└── session-log.md       # Per-session summary
```

### 7.3 Hermes configuration files

```
~/.hermes/
├── config.yaml          # Hermes config (model, tools, compression)
├── .env                 # API keys
├── SOUL.md              # Agent identity (customize for SLE building)
├── MEMORY.md            # Agent's persistent notes (~2,200 chars)
├── USER.md              # User preferences (~1,375 chars)
└── skills/
    └── sle-builder/
        └── SKILL.md     # The build loop skill
```

### 7.4 Project-level Hermes files

```
AGENTS.md                # Always loaded by Hermes — project conventions
.hermes.md               # Alternative context file (higher priority than AGENTS.md)
.hermes/
└── plugins/             # Project-level Hermes plugins
```

---

## 8. Session Workflow

### 8.1 Starting a session

1. Open terminal, navigate to project root
2. Run `hermes`
3. Paste the session start ritual prompt (Section 5.6)
4. Review Hermes's assessment of next tasks
5. Confirm or adjust the plan
6. Let Hermes execute

### 8.2 During a session

- **Monitor output** — Hermes streams tool calls in real time
- **Approve dangerous commands** — terminal commands like `rm` require approval
- **Check in periodically** — review progress every 30-60 minutes
- **Don't micro-manage** — let the build loop run. Intervene only on:
  - Spec ambiguity questions
  - 3x retry failures
  - 90-minute checkpoint
  - Completed-task revisions

### 8.3 Ending a session

1. Ask Hermes for a session summary
2. Review `.sle-build/session-log.md`
3. Review any new entries in `decisions.md`, `ambiguities.md`, `gotchas.md`
4. Review git log for the session: `git log --oneline --since="2 hours ago"`
5. Verify all tests pass: `npm run test && npm run lint && npm run typecheck`
6. If anything looks wrong, fix it now or add a task to `plan.md`

### 8.4 Between sessions

- Review plan.md progress
- Resolve any ambiguities (update `ambiguities.md` with resolutions)
- Update AGENTS.md if conventions changed
- Update the session start ritual if the focus shifted
- Push to remote: `git push`

---

## 9. Risk Assessment

### High risks

| Risk | Impact | Mitigation |
|---|---|---|
| Hermes goes in circles on complex tasks | Wastes tokens and time | 3-retry limit per issue, then stop and ask. Git commits provide rollback. |
| Spec ambiguity causes wrong implementation | Rework | `ambiguities.md` logging. Conservative assumptions documented. Human review between sessions. |
| Context window too small for complex tasks | Hermes loses track | Context compression handles this. Break tasks small enough to complete within one context window. Use delegation for independent sub-tasks. |
| Hermes doesn't follow the build loop consistently | Skips verify/reflect steps | Skill instructions + session start ritual. Human spot-checking. |

### Medium risks

| Risk | Impact | Mitigation |
|---|---|---|
| Monorepo setup issues (TypeScript project references, etc.) | Blocks early progress | Set up monorepo scaffolding manually before Hermes starts. Include package.json configs in AGENTS.md. |
| Model quality varies across providers | Inconsistent output | Stick to one strong model (Claude Opus / GPT-4) for critical tasks. Use cheaper models for mechanical work. |
| Hermes overwrites files carelessly | Lost work | Git commits after every task. File-level review between sessions. |
| Dependency version conflicts | Build failures | Pin all dependencies. Document working versions in AGENTS.md. |

### Low risks

| Risk | Impact | Mitigation |
|---|---|---|
| API costs too high | Budget overruns | Set spending limits on OpenRouter. Monitor usage. Use cheaper models for simple tasks. |
| Hermes creates too many skills | Skills directory clutter | Periodically review and clean up skills. |
| Session search returns irrelevant results | Wasted context | Be specific in session_search queries. |

---

## 10. What NOT to Do

### 10.1 Don't try to make Hermes into SLE while building SLE

That's circular. Use Hermes as the builder (external tool), not as the architecture. The build loop is enforced through files and skills, not by modifying Hermes's code.

### 10.2 Don't build the full spec at once

Build MVP first (Phases 1-4). Use it. Learn from it. Then grow.

### 10.3 Don't let Hermes run unsupervised for hours

Hermes is powerful but not reliable enough for fully autonomous multi-hour sessions. Check in every 30-60 minutes. Review every commit.

### 10.4 Don't skip the reflect step

The reflect step (Step 5 in the build loop) is where knowledge accumulates. Skipping it means Hermes makes the same mistakes repeatedly and doesn't learn from ambiguities.

### 10.5 Don't build features Hermes can't test

If Hermes can't verify a feature works (no tests, no lint, no typecheck), it shouldn't build it. Every task must have acceptance criteria that Hermes can check programmatically.

### 10.6 Don't modify the Hermes codebase

Use skills, AGENTS.md, MEMORY.md, and plugins. Forking Hermes creates a maintenance burden that distracts from building SLE.

---

## 11. Browser Harness Integration

### 11.1 What browser harness adds

Browser harness (~592 lines) provides screenshot-driven browser automation via CDP (Chrome DevTools Protocol). It can:
- Navigate to any URL
- Click, type, scroll using coordinate-based input
- Take screenshots for visual verification
- Extract data from DOM and JavaScript
- Self-heal: edits helpers.py mid-task to add missing functions
- Self-improve: creates domain-specific playbooks after tasks

### 11.2 How it helps build SLE

1. **Testing the web UI (Phase 8):** After building the dashboard, use browser harness to navigate to localhost:7700/ui, screenshot each page, verify layout matches specs
2. **Testing the daemon API visually:** Navigate to endpoints, verify JSON responses render correctly
3. **Documentation screenshots:** Automated screenshots for README and docs
4. **Cross-browser testing:** Verify the web UI works in different browsers

### 11.3 Setup for SLE development

```bash
# Install browser harness (from Hermes environment)
git clone https://github.com/browser-use/browser-harness.git
cd browser-harness
uv tool install .

# Configure for Browser Use cloud (free tier)
export BROWSER_USE_API_KEY=<key>

# Or use headless Chrome on VPS (installed by Hermes installer)
```

### 11.4 Limitations

- Security: full CDP access to running Chrome — only use in development
- LLM screenshot analysis is slow — batch verification when possible
- Browser state (cookies, auth) persists across sessions — reset between tests
- ~592 lines is minimal — the agent edits helpers.py freely, which can introduce instability

---

## 12. Monetization Context

This section captures the business context discussed during planning. It is NOT part of the technical build plan, but informs prioritization decisions.

### 12.1 Target: Open core model

- Core SLE/Stratum: open source (MIT or Apache 2.0)
- Paid tier: team features, cloud hosting, enterprise integrations
- Revenue target: $500-5k/month within 12 months of launch

### 12.2 Consulting angle

- Use SLE as portfolio piece for consulting work
- Offer: "I'll set up autonomous development workflows for your team" ($150-300/hr)
- SLE as proof of expertise in AI-assisted software development

### 12.3 Priority allocation

Given that the developer also has a game project as main priority:
- SLE development: focused sessions with Hermes (2-4 hours/day, 4-5 days/week)
- Game development: primary creative focus
- The two feed each other: SLE improves game development speed, game provides dogfooding for SLE

### 12.4 Phase prioritization for monetization

Build order should maximize demonstrable value early:
1. **Phases 1-4 (MVP)** → usable tool that proves the concept
2. **Phase 6 (Discovery)** → impressive demo for consulting clients
3. **Phase 8 (Web UI)** → visual showcase for GitHub/marketing
4. **Phases 5, 7 (Validation, Agents)** → depth that justifies paid tiers
5. **Phases 9, 10 (Integrations, Polish)** → enterprise readiness

---

## Appendix A — Hermes Design Principles (for reference)

| Principle | What it means |
|---|---|
| Prompt stability | System prompt doesn't change mid-conversation |
| Observable execution | Every tool call visible to user |
| Interruptible | API calls and tool execution cancellable mid-flight |
| Platform-agnostic core | One AIAgent class serves CLI, gateway, ACP, batch, API |
| Loose coupling | Optional subsystems use registry patterns, not hard deps |
| Profile isolation | Each profile gets own home, config, memory, sessions |

## Appendix B — Hermes Self-Improvement Loop (for reference)

```
encounter problem → solve it → write skill/playbook
→ next encounter → load skill → solve faster → update skill
→ repeat, accumulating domain knowledge over time
```

This loop is what makes Hermes effective for long-running projects like SLE. The more it builds, the faster it gets at building — as long as the reflect step captures learnings.

## Appendix C — Comparison: Hermes Loop vs SLE Cycle

| Aspect | Hermes Loop | SLE Cycle |
|---|---|---|
| Purpose | General task completion | Software lifecycle management |
| Planning | LLM's internal planning | Dedicated Planner agent |
| Validation | Prompt-guided (no structure) | Dual-phase (LLM + executable) + gate |
| Roles | Single agent (with delegation) | 5 distinct roles (Planner, Builder, Historian, Evaluator, Critic) |
| Memory | Bounded MEMORY.md + session search | Full artifact store + Cognee knowledge engine |
| Persistence | SQLite sessions | map.yaml + artifact files |
| Self-improvement | Skills auto-created | Not applicable (SLE IS the system) |
| User interaction | Free-form chat | Structured gates + discovery + chat |

The key insight: **use Hermes's self-improvement to build SLE's structured improvement.** Hermes learns to build better; SLE learns to develop better. They're complementary.
