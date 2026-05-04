# Hermes Agent — Official Documentation Research

**Status:** research · v1.0
**Date:** 2026-04-23
**Purpose:** Findings from Hermes official docs. How to configure, customize, and operate Hermes for building SLE/Stratum autonomously.
**Related docs:**
- `./hermes-agent.md` — development plan and Hermes technical profile
- `../research/hermes-agent-architecture.md` — architecture deep dive
- `../research/browser-harness-architecture.md` — browser harness analysis

---

## Table of Contents

1. [Agent Loop Internals](#1-agent-loop-internals)
2. [Prompt Assembly](#2-prompt-assembly)
3. [Context Engine Plugin System](#3-context-engine-plugin-system)
4. [Platform Adapters](#4-platform-adapters)
5. [Tips & Best Practices](#5-tips--best-practices)
6. [MCP Integration](#6-mcp-integration)
7. [Cron Automation](#7-cron-automation)
8. [Godmode Skill (for reference)](#8-godmode-skill-for-reference)
9. [SLE Build Setup — Proposed Configuration](#9-sle-build-setup--proposed-configuration)
10. [Open Discussion Points](#10-open-discussion-points)

---

## 1. Agent Loop Internals

**Source:** `https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop/`
**Primary file:** `run_agent.py` — `AIAgent` class (~10,700 lines)

### Core responsibilities

`AIAgent` handles:
- Assembling the effective system prompt and tool schemas via `prompt_builder.py`
- Selecting the correct provider/API mode
- Making interruptible model calls with cancellation support
- Executing tool calls (sequentially or concurrently via thread pool)
- Maintaining conversation history in OpenAI message format
- Handling compression, retries, and fallback model switching
- Tracking iteration budgets across parent and child agents
- Flushing persistent memory before context is lost

### Two entry points

```python
# Simple interface — returns final response string
response = agent.chat("Fix the bug in main.py")

# Full interface — returns dict with messages, metadata, usage stats
result = agent.run_conversation(
    user_message="Fix the bug in main.py",
    system_message=None,
    conversation_history=None,
    task_id="task_abc123"
)
```

`chat()` is a thin wrapper around `run_conversation()` that extracts the `final_response` field.

### API modes

| API mode | Used for | Client type |
|---|---|---|
| `chat_completions` | OpenAI-compatible endpoints (OpenRouter, custom, most providers) | `openai.OpenAI` |
| `codex_responses` | OpenAI Codex / Responses API | `openai.OpenAI` with Responses format |
| `anthropic_messages` | Native Anthropic Messages API | `anthropic.Anthropic` via adapter |
| `bedrock_converse` | AWS Bedrock (non-Anthropic models) | AWS SDK |

Mode resolution order:
1. Explicit `api_mode` constructor arg (highest priority)
2. Provider-specific detection (e.g., `anthropic` provider → `anthropic_messages`)
3. Base URL heuristics (e.g., `api.anthropic.com` → `anthropic_messages`)
4. Default: `chat_completions`

### Turn lifecycle

```
run_conversation()
  1. Generate task_id if not provided
  2. Append user message to conversation history
  3. Build or reuse cached system prompt (prompt_builder.py)
  4. Check if preflight compression is needed (>50% context)
  5. Build API messages from conversation history
     - chat_completions: OpenAI format as-is
     - codex_responses: convert to Responses API input items
     - anthropic_messages: convert via anthropic_adapter.py
  6. Inject ephemeral prompt layers (budget warnings, context pressure)
  7. Apply prompt caching markers if on Anthropic
  8. Make interruptible API call (_interruptible_api_call)
  9. Parse response:
     - If tool_calls: execute them, append results, loop back to step 5
     - If text response: persist session, flush memory if needed, return
```

### Message format

All messages use OpenAI-compatible format internally:

```python
{"role": "system", "content": "..."}
{"role": "user", "content": "..."}
{"role": "assistant", "content": "...", "tool_calls": [...]}
{"role": "tool", "tool_call_id": "...", "content": "..."}
```

Reasoning content (from models that support extended thinking) is stored in `assistant_msg["reasoning"]`.

**Message alternation rules:**
- After system: `User → Assistant → User → Assistant → ...`
- During tool calling: `Assistant (with tool_calls) → Tool → Tool → ... → Assistant`
- Never two assistant messages in a row
- Never two user messages in a row
- Only `tool` role can have consecutive entries (parallel tool results)

### Interruptible API calls

API requests run in a background thread while main thread monitors:
- response ready → return result
- interrupt event (user sends new message, `/stop`, signal) → abandon API thread
- timeout → return error

No partial response is ever injected into conversation history.

### Tool execution

**Sequential vs Concurrent:**
- Single tool call → executed directly in main thread
- Multiple tool calls → concurrent via `ThreadPoolExecutor`
  - Exception: `clarify` (interactive) forces sequential
  - Results reinserted in original tool call order regardless of completion order

**Execution flow per tool call:**
```
1. Resolve handler from tools/registry.py
2. Fire pre_tool_call plugin hook
3. Check if dangerous command (tools/approval.py)
   - If dangerous: invoke approval_callback, wait for user
4. Execute handler with args + task_id
5. Fire post_tool_call plugin hook
6. Append {"role": "tool", "content": result} to history
```

**Agent-level tools** (intercepted before reaching `handle_function_call()`):

| Tool | Why intercepted |
|---|---|
| `todo` | Reads/writes agent-local task state |
| `memory` | Writes to persistent memory files with character limits |
| `session_search` | Queries session history via the agent's session DB |
| `delegate_task` | Spawns subagent(s) with isolated context |

### Callback surfaces

| Callback | When fired | Used by |
|---|---|---|
| `tool_progress_callback` | Before/after each tool execution | CLI spinner, gateway progress |
| `thinking_callback` | When model starts/stops thinking | CLI "thinking..." indicator |
| `reasoning_callback` | When model returns reasoning content | CLI reasoning display |
| `clarify_callback` | When `clarify` tool is called | CLI input prompt |
| `step_callback` | After each complete agent turn | Gateway step tracking |
| `stream_delta_callback` | Each streaming token | CLI streaming display |
| `tool_gen_callback` | When tool call parsed from stream | CLI tool preview |
| `status_callback` | State changes | ACP status updates |

### Budget and fallback

**Iteration budget:**
- Default: 90 iterations (configurable via `agent.max_turns`)
- Subagents get independent budgets capped at `delegation.max_iterations` (default 50)
- At 100%, agent stops and returns a summary of work done

**Fallback model:**
When primary fails (429, 5xx, 401/403):
1. Check `fallback_providers` list in config
2. Try each fallback in order
3. On success, continue with new provider
4. On 401/403, attempt credential refresh before failing over

Auxiliary tasks (vision, compression, web extraction, session search) each have their own fallback chain via `auxiliary.*` config.

### Compression and persistence

**When compression triggers:**
- **Preflight** (before API call): conversation exceeds 50% of context window
- **Gateway auto-compression**: conversation exceeds 85%

**What happens during compression:**
1. Memory flushed to disk first (preventing data loss)
2. Middle conversation turns summarized into compact summary
3. Last N messages preserved intact (`compression.protect_last_n`, default 20)
4. Tool call/result pairs kept together (never split)
5. New session lineage ID generated (child session)

**Session persistence:** After each turn, messages saved to SQLite via `hermes_state.py`. Session resumable via `/resume` or `hermes chat --resume`.

### Key source files

| File | Purpose |
|---|---|
| `run_agent.py` | AIAgent class — complete agent loop (~10,700 lines) |
| `agent/prompt_builder.py` | System prompt assembly |
| `agent/context_engine.py` | ContextEngine ABC — pluggable context management |
| `agent/context_compressor.py` | Default engine — lossy summarization |
| `agent/prompt_caching.py` | Anthropic prompt caching markers |
| `agent/auxiliary_client.py` | Auxiliary LLM client |
| `model_tools.py` | Tool schema collection, dispatch |

---

## 2. Prompt Assembly

**Source:** `https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly/`

Hermes deliberately separates **cached system prompt state** from **ephemeral API-call-time additions**. This affects token usage, prompt caching effectiveness, session continuity, and memory correctness.

### Cached system prompt layers (in order)

```
1.  Agent identity        — SOUL.md from HERMES_HOME (or DEFAULT_AGENT_IDENTITY)
2.  Tool-aware guidance   — behavior instructions for tool use
3.  Honcho static block   — when active
4.  Optional system msg   — from config or API
5.  Frozen MEMORY         — MEMORY.md snapshot (frozen at session start)
6.  Frozen USER profile   — USER.md snapshot (frozen at session start)
7.  Skills index          — compact listing of available skills (~3k tokens)
8.  Context files         — AGENTS.md, .hermes.md, CLAUDE.md, .cursorrules
9.  Timestamp/session ID
10. Platform hint         — per-platform rendering guidance
```

### Concrete example: assembled system prompt

```
# Layer 1: Agent Identity (from ~/.hermes/SOUL.md)
You are Hermes, an AI assistant created by Nous Research.
You are an expert software engineer and researcher.
You value correctness, clarity, and efficiency.
...

# Layer 2: Tool-aware behavior guidance
You have persistent memory across sessions. Save durable facts using
the memory tool: user preferences, environment details, tool quirks,
and stable conventions. Memory is injected into every turn, so keep
it compact and focused on facts that will still matter later.
...
When the user references something from a past conversation or you
suspect relevant cross-session context exists, use session_search
to recall it before asking them to repeat themselves.

# Layer 3: Honcho static block (when active)
[Honcho personality/context data]

# Layer 4: Optional system message (from config or API)
[User-configured system message override]

# Layer 5: Frozen MEMORY snapshot
## Persistent Memory
- User prefers Python 3.12, uses pyproject.toml
- Default editor is nvim
- Working on project "atlas" in ~/code/atlas
- Timezone: US/Pacific

# Layer 6: Frozen USER profile snapshot
## User Profile
- Name: Alice
- GitHub: alice-dev

# Layer 7: Skills index
## Skills (mandatory)
Before replying, scan the skills below. If one clearly matches
your task, load it with skill_view(name) and follow its instructions.
...
<available_skills>
  software-development:
    - code-review: Structured code review workflow
    - test-driven-development: TDD methodology
  research:
    - arxiv: Search and summarize arXiv papers
</available_skills>

# Layer 8: Context files (from project directory)
# Project Context
The following project context files have been loaded and should be followed:

## AGENTS.md
This is the atlas project. Use pytest for testing. The main
entry point is src/atlas/main.py. Always run `make lint` before
committing.

# Layer 9: Timestamp + session
Current time: 2026-03-30T14:30:00-07:00
Session: abc123

# Layer 10: Platform hint
You are a CLI AI Agent. Try not to use markdown but simple text
renderable inside a terminal.
```

### SOUL.md loading

`SOUL.md` lives at `~/.hermes/SOUL.md`. When present, it replaces the hardcoded default identity. The loader:

```python
def load_soul_md() -> Optional[str]:
    soul_path = get_hermes_home() / "SOUL.md"
    if not soul_path.exists():
        return None
    content = soul_path.read_text(encoding="utf-8").strip()
    content = _scan_context_content(content, "SOUL.md")  # Security scan
    content = _truncate_content(content, "SOUL.md")       # Cap at 20k chars
    return content
```

When SOUL.md loads successfully, `build_context_files_prompt(skip_soul=True)` prevents it from appearing twice.

**Default identity (when SOUL.md absent):**
```
You are Hermes Agent, an intelligent AI assistant created by Nous Research.
You are helpful, knowledgeable, and direct. You assist users with a wide
range of tasks including answering questions, writing and editing code,
analyzing information, creative work, and executing actions via your tools.
You communicate clearly, admit uncertainty when appropriate, and prioritize
being genuinely useful over being verbose unless otherwise directed below.
Be targeted and efficient in your exploration and investigations.
```

### Context file priority system

Only ONE project context type is loaded (first match wins):

| Priority | Files | Search scope | Notes |
|---|---|---|---|
| 1 | `.hermes.md`, `HERMES.md` | CWD up to git root | Hermes-native project config |
| 2 | `AGENTS.md` | CWD only (subdirs discovered lazily) | Common agent instruction file |
| 3 | `CLAUDE.md` | CWD only | Claude Code compatibility |
| 4 | `.cursorrules`, `.cursor/rules/*.mdc` | CWD only | Cursor compatibility |

All context files:
- **Security scanned** — checked for prompt injection patterns
- **Truncated** — capped at 20,000 characters using 70/20 head/tail ratio
- **YAML frontmatter stripped** — `.hermes.md` frontmatter removed

### Ephemeral API-call-time layers

NOT persisted as part of cached system prompt:
- `ephemeral_system_prompt`
- Prefill messages
- Gateway-derived session context overlays
- Later-turn Honcho recall injected into current-turn user message

This separation keeps the stable prefix stable for caching.

### Memory snapshots

Memory and user profile injected as **frozen snapshots** at session start. Mid-session writes update disk but **do not mutate** the already-built system prompt until new session or forced rebuild.

**Implication for SLE building:** If you need something to persist across compression events within a session, put it in a file (AGENTS.md, plan.md) not in memory. Memory is only guaranteed fresh at session start.

---

## 3. Context Engine Plugin System

**Source:** `https://hermes-agent.nousresearch.com/docs/developer-guide/context-engine-plugin/`

### What it is

Context engine plugins replace the built-in `ContextCompressor` with an alternative strategy for managing conversation context. The built-in compressor does lossy summarization. A plugin could do anything: lossless compression, knowledge DAG, structured state tracking, etc.

Only **one** context engine can be active at a time. Selection is config-driven:

```yaml
# config.yaml
context:
  engine: "compressor"    # default built-in
  engine: "lcm"           # activates a plugin engine named "lcm"
```

Plugin engines are **never auto-activated** — user must explicitly set `context.engine`.

### Directory structure

```
plugins/context_engine/<name>/
├── __init__.py      # exports the ContextEngine subclass
├── plugin.yaml      # metadata (name, description, version)
└── ...              # any other modules
```

### The ContextEngine ABC

**Required methods:**

```python
from agent.context_engine import ContextEngine

class LCMEngine(ContextEngine):

    @property
    def name(self) -> str:
        """Short identifier, must match config.yaml value."""
        return "lcm"

    def update_from_response(self, usage: dict) -> None:
        """Called after every LLM call with usage dict."""

    def should_compress(self, prompt_tokens: int = None) -> bool:
        """Return True if compaction should fire this turn."""

    def compress(self, messages: list, current_tokens: int = None) -> list:
        """Compact message list, return valid OpenAI-format sequence."""
```

**Class attributes the agent reads directly:**

```python
last_prompt_tokens: int = 0
last_completion_tokens: int = 0
last_total_tokens: int = 0
threshold_tokens: int = 0
context_length: int = 0
compression_count: int = 0
```

**Optional methods:**

| Method | Default | Override when |
|---|---|---|
| `on_session_start(session_id, **kwargs)` | No-op | Load persisted state (DAG, DB) |
| `on_session_end(session_id, messages)` | No-op | Flush state, close connections |
| `on_session_reset()` | Resets token counters | Per-session state to clear |
| `update_model(model, context_length, ...)` | Updates context_length + threshold | Recalculate budgets on model switch |
| `get_tool_schemas()` | Returns `[]` | Engine provides agent-callable tools |
| `handle_tool_call(name, args, **kwargs)` | Returns error JSON | Implement tool handlers |
| `should_compress_preflight(messages)` | Returns `False` | Cheap pre-API-call estimate |
| `get_status()` | Standard token/threshold dict | Custom metrics |

### Engine tools

Context engines can expose tools the agent calls directly. Return schemas from `get_tool_schemas()` and handle calls in `handle_tool_call()`. Engine tools are injected into the agent's tool list at startup and dispatched automatically.

```python
def get_tool_schemas(self):
    return [{
        "name": "lcm_grep",
        "description": "Search the context knowledge graph",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"}
            },
            "required": ["query"],
        },
    }]

def handle_tool_call(self, name, args, **kwargs):
    if name == "lcm_grep":
        results = self._search_dag(args["query"])
        return json.dumps({"results": results})
    return json.dumps({"error": f"Unknown tool: {name}"})
```

### Registration

**Via directory (recommended):** Place in `plugins/context_engine/<name>/`. Auto-discovered.

**Via general plugin:** Register through `ctx.register_context_engine(engine)`. Only one engine allowed — second registration rejected with warning.

### Lifecycle

```
1. Engine instantiated (plugin load or directory discovery)
2. on_session_start() — conversation begins
3. update_from_response() — after each API call
4. should_compress() — checked each turn
5. compress() — called when should_compress() returns True
6. on_session_end() — session boundary (CLI exit, /reset, gateway expiry)
```

`on_session_reset()` called on `/new` or `/reset` to clear per-session state.

### Relevance to SLE building

A custom context engine could:
- Maintain structured build state instead of doing lossy summarization
- Track what's been built, what's in progress, what's verified
- Expose tools like `build_status()`, `next_task()`, `what_failed_last()`
- Preserve build context across compression events
- This is the mechanism to add the "structured planning" that Hermes lacks natively

**However**, building a custom context engine is significant additional work. The simpler approach (Option C in Section 9) uses the built-in compressor plus file-based state tracking enforced through skill instructions.

---

## 4. Platform Adapters

**Source:** `https://hermes-agent.nousresearch.com/docs/developer-guide/adding-platform-adapters/`

### Relevance to SLE

Platform adapters are for connecting Hermes to messaging platforms (Telegram, Discord, etc.). **Not directly relevant for SLE building** — we use the CLI interface. Included for completeness.

### Architecture

```
User ↔ Messaging Platform ↔ Platform Adapter ↔ Gateway Runner ↔ AIAgent
```

Every adapter extends `BasePlatformAdapter` and implements:
- `connect()` — establish connection
- `disconnect()` — clean shutdown
- `send()` — send text to chat
- `send_typing()` — typing indicator (optional)
- `get_chat_info()` — chat metadata

Adding a new platform touches 20+ files across code, config, and docs. Not worth the effort for SLE building unless we want Hermes to deliver build reports via Telegram/Discord.

**Potential use case:** Set up a Telegram adapter so Hermes can deliver cron job reports (nightly verification results) to your phone. This is a nice-to-have, not a requirement.

---

## 5. Tips & Best Practices

**Source:** `https://hermes-agent.nousresearch.com/docs/guides/tips`

### Getting the best results

- **Be specific.** "Fix the TypeError in `api/handlers.py` on line 47" beats "fix the code." More context = fewer iterations.
- **Provide context up front.** Front-load relevant details. One well-crafted message beats three rounds of clarification.
- **Use context files for recurring instructions.** AGENTS.md is loaded automatically every session — zero effort after setup.
- **Let the agent use its tools.** "Find and fix the failing test" rather than hand-holding every step.
- **Use skills for complex workflows.** Check if a skill exists before writing a long prompt.

### CLI power user tips

- **Multi-line input:** Alt+Enter or Ctrl+J for newlines without sending
- **Paste detection:** Auto-detects multi-line pastes, sends as one message
- **Interrupt and redirect:** Ctrl+C once to interrupt, new message to redirect. Double Ctrl+C to force exit.
- **Resume sessions:** `hermes -c` to resume last session, `hermes -r "title"` by title
- **Clipboard image paste:** Ctrl+V to paste images directly
- **Slash command autocomplete:** `/` then Tab for all commands

### Context files

- **AGENTS.md:** Project's brain. Architecture decisions, coding conventions, project-specific instructions. Automatically injected every session.
- **SOUL.md:** Agent personality. `~/.hermes/SOUL.md`. Durable personality, set once.
- **Memory is a frozen snapshot.** Changes made during a session don't appear in the system prompt until next session. The agent writes to disk immediately, but prompt cache isn't invalidated mid-session.
- **Keep context files concise.** Every character counts against token budget since they're injected into every message.
- **Subdirectory AGENTS.md files** are discovered lazily during tool calls, not loaded upfront.

### Memory vs Skills

- **Memory** is for facts: environment, preferences, project locations. Bounded (~2,200 chars MEMORY.md, ~1,375 chars USER.md).
- **Skills** are for procedures: multi-step workflows, tool-specific instructions, reusable recipes.
- Memory = "what", Skills = "how".

### Performance & cost

- **Don't break the prompt cache.** Keep system prompt stable (same context files, same memory) for cheaper cache hits.
- **Use `/compress` before hitting limits.** Run `/usage` to check where you stand.
- **Delegate for parallel work.** `delegate_task` with parallel subtasks. Each subagent runs independently.
- **Use `execute_code` for batch operations.** Write a Python script instead of running terminal commands one at a time.
- **Choose the right model.** Frontier models (Claude Opus, GPT-4o) for complex reasoning. Faster models for simple tasks.
- **Run `/usage` periodically.** Run `/insights` for 30-day usage patterns.

### Security

- **Use Docker for untrusted code.** `TERMINAL_BACKEND=docker` in `.env`.
- **Review before choosing "always."** Dangerous command approval: start with "session" until comfortable.
- **Dangerous command checks are skipped in container backends** — container is the security boundary.

---

## 6. MCP Integration

**Source:** `https://hermes-agent.nousresearch.com/docs/guides/use-mcp-with-hermes`

### When to use MCP

**Use MCP when:**
- A tool already exists in MCP form
- You want fine-grained per-server exposure control
- You want to connect to internal APIs/databases without modifying Hermes core

**Do NOT use MCP when:**
- A built-in Hermes tool already solves the job
- You only need one narrow integration (native tool is simpler)

### Configuration format

```yaml
mcp_servers:
  github:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "***"
    tools:
      include: [list_issues, create_issue, search_code]
      prompts: false
      resources: false
```

### Tool filtering

- `tools.include` — whitelist only these tools
- `tools.exclude` — blacklist specific tools
- `tools.prompts: false` — disable prompt utility wrappers
- `tools.resources: false` — disable resource utility wrappers

### Useful patterns for SLE

**GitHub integration:**
```yaml
mcp_servers:
  github:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "***"
    tools:
      include: [list_issues, create_issue, update_issue, search_code]
      prompts: false
      resources: false
```

**Filesystem (scoped to project):**
```yaml
mcp_servers:
  fs:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/sle-project"]
```

**Git (scoped to repo):**
```yaml
mcp_servers:
  git:
    command: "uvx"
    args: ["mcp-server-git", "--repository", "/home/user/sle-project"]
```

### Reload after config changes

```
/reload-mcp
```

### Relevance to SLE building

MCP could connect Hermes to:
- GitHub for issue/PR management during building
- Filesystem for scoped access
- Git for version control integration
- Custom MCP server for SLE-specific tooling (later)

Not essential for MVP but useful for a polished workflow. The built-in terminal + file tools are sufficient for most of the build work.

---

## 7. Cron Automation

**Source:** `https://hermes-agent.nousresearch.com/docs/guides/automate-with-cron`

### Key concept

> Cron jobs run in **fresh agent sessions** with **no memory** of your current chat. Prompts must be **completely self-contained** — include everything the agent needs to know.

### Basic usage

```
/cron add "every 1h" "Task description here" --name "My job" --deliver telegram
```

### The `--script` parameter

A Python script runs before each execution. Its stdout becomes context for the agent. Script does mechanical work (fetching, diffing, state tracking), agent does reasoning.

```python
# ~/.hermes/scripts/watch.py
import hashlib, json, os, urllib.request

URL = "https://example.com"
STATE_FILE = os.path.expanduser("~/.hermes/scripts/.state.json")

content = urllib.request.urlopen(URL, timeout=30).read().decode()
current_hash = hashlib.sha256(content.encode()).hexdigest()

prev_hash = None
if os.path.exists(STATE_FILE):
    with open(STATE_FILE) as f:
        prev_hash = json.load(f).get("hash")

with open(STATE_FILE, "w") as f:
    json.dump({"hash": current_hash}, f)

if prev_hash and prev_hash != current_hash:
    print(f"CHANGE DETECTED on {URL}")
    print(f"Current content (first 2000 chars):\n{content[:2000]}")
else:
    print("NO_CHANGE")
```

### The `[SILENT]` trick

When the agent's final response contains `[SILENT]`, delivery is suppressed. Only get notified when something actually happens.

### Multi-skill workflows

Chain skills together for complex scheduled tasks:

```
/cron add "0 8 * * *" "Search arXiv for papers..." \
  --skill arxiv \
  --skill obsidian \
  --name "Paper digest"
```

Skills load in order before the prompt executes.

### Management commands

```
/cron list                    # list all active jobs
/cron run <job_id>            # trigger immediately (for testing)
/cron pause <job_id>          # pause without deleting
/cron edit <job_id> --schedule "every 4h"
/cron edit <job_id> --prompt "Updated description"
/cron edit <job_id> --skill arxiv --skill obsidian
/cron remove <job_id>         # delete permanently
```

### Delivery targets

| Target | Example | Use case |
|---|---|---|
| origin | `--deliver origin` | Same chat that created the job (default) |
| local | `--deliver local` | Save to local file only |
| telegram | `--deliver telegram` | Telegram home channel |
| discord | `--deliver discord` | Discord home channel |
| slack | `--deliver slack` | Slack home channel |
| Specific chat | `--deliver telegram:-1001234567890` | Specific group |
| Threaded | `--deliver telegram:-1001234567890:17585` | Specific thread |

### Schedule expressions

Supported: relative delays (`30m`), intervals (`every 2h`), standard cron (`0 9 * * *`), ISO timestamps (`2025-06-15T09:00:00`). Natural language NOT supported.

### SLE cron patterns

**Nightly verification:**
```
/cron add "0 3 * * *" "Load skill sle-builder. Read plan.md.
Run: npm run test && npm run lint && npm run typecheck
If anything fails, write a detailed report to .sle-build/nightly-report.md.
If everything passes, respond with [SILENT]." \
  --name "Nightly verification" \
  --deliver local
```

**Weekly progress report:**
```
/cron add "0 9 * * 1" "Read plan.md and .sle-build/session-log.md.
Summarize: tasks completed this week, tasks remaining, blockers, ambiguities.
Write summary to .sle-build/weekly-report.md." \
  --name "Weekly progress" \
  --deliver local
```

---

## 8. Godmode Skill (for reference)

**Source:** `https://hermes-agent.nousresearch.com/docs/user-guide/skills/godmode`

### What it is

Bypass safety filters on API-served LLMs using techniques from G0DM0D3 and L1B3RT4S by Pliny the Prompter. Operates at prompt/API level — works on any model accessible via API.

### Why it's documented here

Not relevant for SLE building directly, but demonstrates:
1. **How skills can integrate deeply with Hermes config** — the skill writes to `config.yaml` (`agent.system_prompt`) and creates `prefill.json`
2. **How `execute_code` is used for complex skill logic** — auto_jailbreak() runs as Python in the sandbox
3. **The `--script` pattern** — scripts do mechanical work, agent does reasoning
4. **Multi-model racing via OpenRouter** — querying many models in parallel and scoring responses

### Integration mechanisms used

- **Ephemeral system prompt:** `agent.system_prompt` in `config.yaml` — appended after Hermes's own system prompt
- **Prefill messages:** `agent.prefill_messages_file` — injected at start of every API call, ephemeral (never saved to sessions)
- **`execute_code` for automation:** complex logic runs as Python scripts in the sandbox

---

## 9. SLE Build Setup — Proposed Configuration

### 9.1 SOUL.md — Engineer Identity

Path: `~/.hermes/SOUL.md`

```
You are a senior software engineer specializing in autonomous systems.
You build software methodically and systematically.

Core principles:
- Read specifications before writing code
- Plan before implementing
- Test before committing
- Document all decisions
- Flag ambiguities — never silently assume
- Work in small, verifiable increments
- When stuck for 3 attempts, stop and ask for help
- After every task, reflect on what was learned
```

This is Layer 1 in the system prompt. Sets behavioral expectations before any task-specific instructions load.

### 9.2 AGENTS.md — Always-Loaded Project Context

Path: `<project-root>/AGENTS.md`

20,000 char budget. Loaded every turn. This is the primary control surface for project-level instructions.

Should contain:
- Project overview (what is SLE/Stratum)
- Architecture summary (monorepo, packages, key patterns)
- Tech stack (TypeScript strict, Zod, YAML, WebSocket, REST, Tauri)
- Directory structure
- Build/test/lint commands
- File naming conventions
- What NOT to touch
- Current phase focus (updated as phases progress)
- Reference to the build loop skill

**Critical insight from docs:** AGENTS.md is loaded from CWD only at session start. Subdirectory AGENTS.md files are discovered lazily during tool calls, not loaded into the system prompt. So put everything important in the root AGENTS.md.

**Critical insight from docs:** AGENTS.md is truncated at 20,000 chars with 70/20 head/tail ratio. Keep it under this limit.

### 9.3 Skill (`sle-builder`) — Build Loop Procedure

Path: `~/.hermes/skills/sle-builder/SKILL.md`

Loaded on demand via `skill_view("sle-builder")`. Contains the 6-step build loop, rules, file conventions, spec loading instructions, and verification commands.

Not loaded into every turn (saves tokens) — only loaded when the task matches or when explicitly requested via the session start ritual.

### 9.4 plan.md — Persistent Task Tracking

Path: `<project-root>/plan.md`

Living document, checked into git. Replaces Hermes's in-memory `todo` tool with something persistent across sessions and compression events.

**Critical insight from docs:** Memory is frozen per session and doesn't update mid-session even when written to disk. plan.md is read via `read_file` tool, so it always shows current state regardless of session freezes.

### 9.5 .sle-build/ — Build State Directory

```
.sle-build/
├── current-task.md      # Active task plan, files, acceptance criteria, progress
├── decisions.md         # Implementation decisions log
├── ambiguities.md       # Spec ambiguities found, assumptions made
├── gotchas.md           # Technical gotchas and lessons learned
└── session-log.md       # Per-session summary of what was done
```

These files survive context compression, session resets, and system restarts.

### 9.6 MEMORY.md — Agent Notes

Path: `~/.hermes/MEMORY.md`

2,200 char limit. Should contain high-level project facts:

```
- SLE/Stratum is a TypeScript monorepo in packages/
- Build commands: npm run test/lint/typecheck/build
- Spec docs in docs/apps/sdk-orchestrator/v2/
- Always follow the 6-step build loop from sle-builder skill
- plan.md is source of truth for task status — read it every session start
- Git commit after every completed task
- Zod for runtime validation, strict TypeScript
- 7 YAML rule files in .sle/rules/
- Daemon runs on port 7700 (REST + WebSocket)
```

**Important:** Memory is frozen at session start. Writes update disk but don't appear in prompt until next session. This means MEMORY.md is good for cross-session facts, but within a session, use file-based state (plan.md, .sle-build/) for things that need to survive compression.

### 9.7 Context engine strategy

Three options, ranked by complexity:

**Option A: Built-in compressor only (simplest)**
- Use Hermes's default lossy summarization
- Risk: after compression, Hermes may lose track of build state
- Works for short sessions, risky for long autonomous runs

**Option B: Custom context engine plugin (most powerful)**
- Build a plugin that maintains structured build state
- Exposes tools like `build_status()`, `next_task()`, `what_failed_last()`
- Preserves build context across compression events
- Significant additional development effort
- Would need: `plugins/context_engine/sle-build/__init__.py`, `plugin.yaml`

**Option C: Built-in compressor + file-based state tracking (recommended for now)**
- Use the default compressor
- Enforce that Hermes writes state to files before any critical operation
- After compression, session start ritual has Hermes re-read state files
- File-based state survives compression because it's external to the message history
- Simpler than Option B, more reliable than Option A
- The discipline comes from skill instructions and AGENTS.md, not custom code

**Recommendation:** Start with Option C. If Hermes consistently loses track after compression events, escalate to Option B.

### 9.8 Cron jobs for SLE

**Nightly verification:**
```
/cron add "0 3 * * *" "Load skill sle-builder. Read plan.md. Read .sle-build/current-task.md.
Run: npm run test && npm run lint && npm run typecheck
If anything fails, write a detailed report to .sle-build/nightly-report.md with the failure details, the failing test names, and the error output.
If everything passes, respond with [SILENT]." \
  --name "SLE nightly verification" \
  --deliver local
```

**Weekly progress:**
```
/cron add "0 9 * * 1" "Read plan.md and .sle-build/session-log.md.
Summarize:
1. Tasks completed this week
2. Tasks remaining (in order)
3. Blockers or ambiguities
4. Gotchas discovered
Write to .sle-build/weekly-report.md." \
  --name "SLE weekly progress" \
  --deliver local
```

**Note:** Cron prompts must be self-contained — no memory of previous conversations.

### 9.9 MCP configuration (optional)

```yaml
mcp_servers:
  github:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}"
    tools:
      include: [list_issues, create_issue, update_issue, search_code]
      prompts: false
      resources: false
```

Not essential for MVP. Hermes's built-in terminal (`git`, `gh` commands) handles most version control needs.

### 9.10 Session start ritual

Every Hermes session starts with this prompt:

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

### 9.11 Session flow diagram

```
Session start:
  1. Hermes loads SOUL.md → "you are a senior engineer" (Layer 1)
  2. Hermes loads AGENTS.md → project context, conventions (Layer 8)
  3. Hermes loads skills index → sees sle-builder skill (Layer 7)
  4. User sends start ritual → "load sle-builder, read plan.md, begin"
  5. Hermes calls skill_view("sle-builder") → loads full build loop
  6. Hermes reads plan.md → knows what's next
  7. Hermes reads .sle-build/ → knows recent history, gotchas, ambiguities

During session:
  - Follows 6-step loop from sle-builder skill
  - Writes state to .sle-build/ files after each task
  - Commits to git after each task
  - If context fills → compression fires → middle turns summarized
    - .sle-build/ files survive because they're external to messages
    - Next tool call reads fresh state from files
  - Can delegate independent sub-tasks to subagents
  - Can use execute_code for batch operations

Session end:
  - Hermes reflects on what was accomplished
  - Updates plan.md (mark tasks done)
  - Updates .sle-build/session-log.md
  - Updates .sle-build/gotchas.md if new gotchas found
  - Final git commit
  - Human reviews between sessions:
    - git log --oneline --since="2 hours ago"
    - plan.md progress
    - .sle-build/ files
    - npm run test && npm run lint && npm run typecheck
```

### 9.12 Handling context compression

**The problem:** When Hermes's context fills up, the built-in compressor summarizes middle conversation turns. This can lose important build state — what files were modified, what decisions were made, what tests passed/failed.

**The solution (Option C):**

1. **Write state early and often.** The sle-builder skill enforces writing to `.sle-build/` files after every step.
2. **State is in files, not messages.** plan.md, current-task.md, decisions.md, gotchas.md are on disk. They survive compression because they're outside the message history.
3. **Re-read after compression.** The skill instructions tell Hermes: "After any context compression event, re-read plan.md and .sle-build/current-task.md before continuing."
4. **Session start ritual re-reads everything.** Even if compression happened mid-session, the next session starts fresh with full file reads.

### 9.13 Model selection

For SLE building:
- **Complex reasoning** (architecture, planning, debugging): Claude Opus or GPT-4o via OpenRouter
- **Implementation work** (writing code, creating files): Claude Sonnet (good balance of cost/quality)
- **Mechanical tasks** (renaming, formatting, boilerplate): Faster/cheaper models

Switch mid-session with `/model`.

---

## 10. Open Discussion Points

These questions need resolution before implementation begins.

### 10.1 Context engine: custom plugin or file-based state?

- **Option B (custom plugin):** More reliable, preserves structured state across compression, but significant additional development work
- **Option C (file-based):** Simpler, uses Hermes as-is, discipline enforced through skills. Risk: Hermes may not consistently re-read state files after compression

**Question:** Do we invest in a custom context engine, or trust the skill-based file discipline?

### 10.2 Session autonomy level

- **Conservative:** Hermes completes 3-5 tasks per session, then stops for human review
- **Moderate:** Hermes runs for 90 minutes, completes as many tasks as it can, then stops
- **Aggressive:** Hermes runs a full phase (many sessions), stops only on blockers

**Question:** How much autonomy per session? What's the right balance of speed vs. oversight?

### 10.3 Phase delivery format

When Hermes completes a phase, what should it produce for human review?
- Updated plan.md with all tasks marked done
- `.sle-build/phase-report.md` with summary, decisions, known issues
- Git tag for the phase (e.g., `phase-1-complete`)
- Test results and coverage report
- List of files created/modified
- List of spec ambiguities encountered
- List of things that need manual testing

**Question:** What's the minimum viable handoff document between Hermes completing a phase and human approval?

### 10.4 MCP usage

- Connect GitHub MCP for issue tracking during building?
- Connect filesystem MCP for scoped access?
- Build custom MCP server for SLE-specific operations (later)?
- Or rely entirely on built-in terminal + file tools?

**Question:** Is MCP worth the setup effort, or are built-in tools sufficient?

### 10.5 Browser harness for testing

- Use browser harness for automated testing of the web UI (Phase 8)?
- Use for visual verification during development?
- Or defer browser testing to manual human review?

**Question:** When and how to integrate browser harness into the build loop?

### 10.6 Verification strictness

The sle-builder skill defines acceptance criteria per task. How strict should verification be?
- **Strict:** Every task must pass all tests, lint, typecheck before committing
- **Moderate:** Code must compile and pass existing tests; new tests can be written in a follow-up task
- **Lenient:** Code must compile; tests and lint can be deferred

**Question:** What level of verification is appropriate for each phase?

### 10.7 Delegation strategy

- Delegate test writing to subagents while main agent implements?
- Delegate independent package work (types, schemas) to separate subagents?
- Or keep everything in the main agent's context for coherence?

**Question:** When is delegation worth the coordination overhead vs. keeping work in a single context?
