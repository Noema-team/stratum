# Hermes Agent — Software Development Skills & Tools Research

**Status:** research · v1.0
**Date:** 2026-04-23
**Purpose:** Detailed findings from Hermes tools runtime, tools reference, skills catalog (software-development), and tools features. These built-in skills dramatically simplify the SLE build approach — Hermes already has the structured development loop we were planning to build.
**Related docs:**
- `./hermes-agent.md` — development plan and Hermes technical profile
- `./hermes-official-docs-research.md` — agent loop, prompt assembly, context engine, MCP, cron
- `../ideas/hermes-agent-architecture.md` — architecture deep dive

---

## Table of Contents

1. [Tools Runtime](#1-tools-runtime)
2. [Built-in Tools Reference (53 tools)](#2-built-in-tools-reference-53-tools)
3. [Software Development Skills](#3-software-development-skills)
4. [Tools & Toolsets Features](#4-tools--toolsets-features)
5. [Full Skills Catalog — Categories](#5-full-skills-catalog--categories)
6. [Revised SLE Build Approach](#6-revised-sle-build-approach)
7. [Impact on Previous Plans](#7-impact-on-previous-plans)

---

## 1. Tools Runtime

**Source:** https://hermes-agent.nousresearch.com/docs/developer-guide/tools-runtime

### Tool registration model

Every tool file in `tools/` calls `registry.register()` at module level. Auto-discovered via AST parsing — no manual import list.

```python
registry.register(
    name="terminal",
    toolset="terminal",
    schema={...},
    handler=handle_terminal,
    check_fn=check_terminal,       # Optional: returns True/False for availability
    requires_env=["SOME_VAR"],     # Optional: env vars needed
    is_async=False,
    description="Run commands",
    emoji="💻",
)
```

### Discovery flow

1. `discover_builtin_tools()` scans `tools/*.py` for top-level `registry.register()` calls
2. After core tools, MCP tools discovered via `tools.mcp_tool.discover_mcp_tools()`
3. Plugin tools discovered via `hermes_cli.plugins.discover_plugins()`
4. New tool files picked up automatically — no manual list to maintain
5. Errors in optional tools (e.g., missing dependency) caught and logged — don't prevent other tools from loading

### Tool availability checking (`check_fn`)

Each tool optionally provides a `check_fn` — callable returning `True`/`False`. Typical checks:
- API key present (e.g., `SERP_API_KEY` for web search)
- Service running
- Binary installed (e.g., `playwright` for browser)

When building the schema list for the model, unavailable tools are **skipped entirely** — the model never sees them.

### Toolset resolution

Toolsets are named bundles of tools. Resolved through:
- Explicit enabled/disabled toolset lists
- Platform presets (`hermes-cli`, `hermes-telegram`, etc.)
- Dynamic MCP toolsets

Main entry point: `model_tools.get_tool_definitions(enabled_toolsets, disabled_toolsets, quiet_mode)`

Dynamic schema patching: after filtering, `execute_code` and `browser_navigate` schemas are adjusted to only reference tools that passed filtering (prevents model hallucination of unavailable tools).

### Dispatch flow

```
Model response with tool_call
    → run_agent.py agent loop
    → model_tools.handle_function_call(name, args, task_id, user_task)
    → [Agent-loop tools?] → handled directly (todo, memory, session_search, delegate_task)
    → [Plugin pre-hook] → invoke_hook("pre_tool_call", ...)
    → registry.dispatch(name, args, **kwargs)
    → Look up ToolEntry by name
    → [Async handler?] → bridge via _run_async()
    → [Sync handler?] → call directly
    → Return result string (or JSON error)
    → [Plugin post-hook] → invoke_hook("post_tool_call", ...)
```

Agent-level tools intercepted before registry dispatch: `todo`, `memory`, `session_search`, `delegate_task`. Their schemas are still registered (for `get_tool_definitions`), but handlers return stub error if dispatch reaches them directly.

### Dangerous command approval

`DANGEROUS_PATTERNS` in `tools/approval.py` — list of `(regex, description)` tuples:
- Recursive deletes (`rm -rf`)
- Filesystem formatting (`mkfs`, `dd`)
- SQL destructive operations (`DROP TABLE`, `DELETE FROM` without `WHERE`)
- System config overwrites (`> /etc/`)
- Service manipulation (`systemctl stop`)
- Remote code execution (`curl | sh`)
- Fork bombs, process kills

Detection → approval prompt:
- **CLI mode:** interactive prompt (once / session / always / deny)
- **Gateway mode:** async approval callback to messaging platform
- **Smart approval:** auxiliary LLM can auto-approve low-risk matches (e.g., `rm -rf node_modules/`)

Session state tracked — approve once for session, subsequent matches don't re-prompt. "Always" writes to `config.yaml` `command_allowlist`.

---

## 2. Built-in Tools Reference (53 tools)

**Source:** https://hermes-agent.nousresearch.com/docs/reference/tools-reference

53 built-in tools across 21 toolsets.

### `browser` toolset (11 tools)

| Tool | Description |
|---|---|
| `browser_back` | Navigate back in browser history |
| `browser_cdp` | Send raw CDP command (escape hatch) |
| `browser_click` | Click element by ref ID (e.g., `@e5`) |
| `browser_console` | Get console output and JS errors |
| `browser_get_images` | List all images with URLs and alt text |
| `browser_navigate` | Navigate to URL, initializes session |
| `browser_press` | Press keyboard key (Enter, Tab, shortcuts) |
| `browser_scroll` | Scroll page in direction |
| `browser_snapshot` | Text-based accessibility tree snapshot with ref IDs |
| `browser_type` | Type text into input field by ref ID |
| `browser_vision` | Screenshot + vision AI analysis |

### `file` toolset (4 tools)

| Tool | Description |
|---|---|
| `patch` | Targeted find-and-replace edits with fuzzy matching (9 strategies). Returns unified diff. Auto-runs syntax checks. |
| `read_file` | Read text file with line numbers and pagination. Format: `LINE_NUM\|CONTENT`. Suggests similar filenames if not found. |
| `search_files` | Ripgrep-backed search. Content search (regex) or filename search. Multiple output modes. |
| `write_file` | Write content to file, completely replacing. Creates parent dirs automatically. Use `patch` for targeted edits. |

### `terminal` toolset (2 tools)

| Tool | Description |
|---|---|
| `terminal` | Execute shell commands. Filesystem persists between calls. `background=true` for long-running. `notify_on_complete=true` for auto-notification. Do NOT use cat/head/tail/grep/rg/find — use file tools instead. |
| `process` | Manage background processes: `list`, `poll`, `wait`, `log`, `kill`, `write` (send input). |

### `delegation` toolset (1 tool)

| Tool | Description |
|---|---|
| `delegate_task` | Spawn 1+ subagents with isolated contexts. Each gets own conversation, terminal, toolset. Only final summary returned. Max concurrent children: 3. Depth cap: 1 (configurable to 3). |

### `code_execution` toolset (1 tool)

| Tool | Description |
|---|---|
| `execute_code` | Run Python script that can call Hermes tools programmatically. Collapses 3+ tool calls into one turn. Use for batch operations, conditional logic, filtering large outputs. |

### `skills` toolset (3 tools)

| Tool | Description |
|---|---|
| `skills_list` | List available skills (name + description) |
| `skill_view` | Load full skill content or specific reference files |
| `skill_manage` | Create, patch, edit, delete skills |

### `todo` toolset (1 tool)

| Tool | Description |
|---|---|
| `todo` | In-memory task list for current session. Use for 3+ step tasks. `merge=true` to add items without replacing. |

### Other toolsets

| Toolset | Tools | Notes |
|---|---|---|
| `web` (2) | `web_search`, `web_extract` | Requires API key (Exa, Parallel, Firecrawl, or Tavily) |
| `vision` (1) | `vision_analyze` | AI image analysis |
| `image_gen` (1) | `image_generate` | FAL.ai, requires `FAL_KEY` |
| `tts` (1) | `text_to_speech` | Edge TTS (free), ElevenLabs, OpenAI, xAI |
| `memory` (1) | `memory` | Persistent memory (MEMORY.md, USER.md) |
| `session_search` (1) | `session_search` | FTS5 search across past sessions |
| `clarify` (1) | `clarify` | Ask user multiple-choice questions |
| `cronjob` (1) | `cronjob` | Create, list, update, pause, resume, run, remove |
| `messaging` (1) | `send_message` | Cross-platform message delivery |
| `moa` (1) | `mixture_of_agents` | Route through multiple LLMs collaboratively. 5 API calls. Use sparingly. |
| `homeassistant` (4) | `ha_list_entities`, `ha_get_state`, `ha_list_services`, `ha_call_service` | Smart home control |
| `rl` (10) | Training run management | Tinker-Atropos RL environments |

---

## 3. Software Development Skills

**Source:** https://hermes-agent.nousresearch.com/docs/reference/skills-catalog#software-development

These 6 built-in skills form a **complete structured development workflow**. They are the most significant finding for SLE building.

### 3.1 `plan` — Plan-Only Mode

**Category:** software-development (💻)
**Path:** `software-development/plan`
**Tags:** planning, plan-mode, implementation, workflow

**What it does:** Enters plan-only mode. Inspects context, writes a markdown plan into `.hermes/plans/`, does NOT execute.

**Core behavior:**
- Do not implement code
- Do not edit project files except the plan markdown
- Do not run mutating terminal commands, commit, push, or external actions
- May inspect the repo with read-only commands
- Deliverable: markdown plan saved to `.hermes/plans/YYYY-MM-DD_HHMMSS-<slug>.md`

**Plan includes (when relevant):**
- Goal
- Current context / assumptions
- Proposed approach
- Step-by-step plan
- Files likely to change
- Tests / validation
- Risks, tradeoffs, and open questions

**For SLE:** Use this to generate phase implementation plans from the spec docs. Hermes reads the specs, explores the codebase, and outputs a detailed plan without writing any code.

---

### 3.2 `writing-plans` — Comprehensive Implementation Plans

**Category:** software-development (💻)
**Path:** `software-development/writing-plans`
**Version:** 1.1.0
**Author:** Hermes Agent (adapted from obra/superpowers)
**Tags:** planning, design, implementation, workflow, documentation

**What it does:** Creates comprehensive implementation plans with bite-sized tasks, exact file paths, and complete code examples. Assumes the implementer has zero context for the codebase.

**Core principle:** A good plan makes implementation obvious. If someone has to guess, the plan is incomplete.

**When to use:**
- Before implementing multi-step features
- Breaking down complex requirements
- Before delegating to subagents via `subagent-driven-development`

**Task granularity:** Each task = 2-5 minutes of focused work.

**Plan document structure:**

```markdown
# [Feature Name] Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** [One sentence]
**Architecture:** [2-3 sentences]
**Tech Stack:** [Key technologies]

---

### Task N: [Descriptive Name]

**Objective:** What this task accomplishes (one sentence)

**Files:**
- Create: `exact/path/to/new_file.py`
- Modify: `exact/path/to/existing.py:45-67`
- Test: `tests/path/to/test_file.py`

**Step 1: Write failing test**
[Complete test code]

**Step 2: Run test to verify failure**
Run: `pytest tests/path/test.py::test_specific_behavior -v`
Expected: FAIL -- "function not defined"

**Step 3: Write minimal implementation**
[Complete implementation code]

**Step 4: Run test to verify pass**
Run: `pytest tests/path/test.py::test_specific_behavior -v`
Expected: PASS

**Step 5: Commit**
```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```
```

**Writing process:**
1. Understand requirements
2. Explore the codebase (search_files, read_file)
3. Design approach
4. Write tasks (setup → core TDD → edge cases → integration → cleanup)
5. Add complete details (exact paths, complete code, exact commands, verification steps)
6. Review the plan
7. Save to `docs/plans/YYYY-MM-DD-feature-name.md` and commit

**Principles enforced:** DRY, YAGNI, TDD, frequent commits.

**Execution handoff:** After saving, offers to execute using `subagent-driven-development`.

**For SLE:** This is how we convert SLE spec docs into actionable task-by-task plans. Feed it a phase's worth of specs, get back a detailed implementation plan with every file, every test, every command.

---

### 3.3 `subagent-driven-development` — Execute Plans with Two-Stage Review

**Category:** software-development (💻)
**Path:** `software-development/subagent-driven-development`
**Version:** 1.1.0
**Author:** Hermes Agent (adapted from obra/superpowers)
**Tags:** delegation, subagent, implementation, workflow, parallel

**What it does:** Executes implementation plans by dispatching fresh `delegate_task` per task with systematic two-stage review (spec compliance then code quality).

**Core principle:** Fresh subagent per task + two-stage review (spec then quality) = high quality, fast iteration.

**This is the most important skill for SLE building.** It provides the structured execution loop that Hermes otherwise lacks.

#### The process:

**Step 1: Read and parse plan**
Read the plan file. Extract ALL tasks with full text. Create a todo list. Read the plan ONCE — don't make subagents read the plan file.

**Step 2: Per-task workflow (for EACH task):**

1. **Dispatch implementer subagent** via `delegate_task` with complete context:
```python
delegate_task(
    goal="Implement Task 1: Create User model with email and password_hash fields",
    context="""
    TASK FROM PLAN:
    - Create: src/models/user.py
    - Add User class with email (str) and password_hash (str) fields
    - Use bcrypt for password hashing
    - Include __repr__ for debugging

    FOLLOW TDD:
    1. Write failing test
    2. Run: pytest tests/models/test_user.py -v (verify FAIL)
    3. Write minimal implementation
    4. Run: pytest tests/models/test_user.py -v (verify PASS)
    5. Run: pytest tests/ -q (verify no regressions)
    6. Commit: git add -A && git commit -m "feat: add User model"

    PROJECT CONTEXT:
    - Python 3.11, Flask app in src/app.py
    - Existing models in src/models/
    - Tests use pytest, run from project root
    """,
    toolsets=['terminal', 'file']
)
```

2. **Dispatch spec compliance reviewer:**
```python
delegate_task(
    goal="Review if implementation matches the spec from the plan",
    context="""
    ORIGINAL TASK SPEC:
    - Create src/models/user.py with User class
    - Fields: email (str), password_hash (str)
    - Use bcrypt for password hashing
    - Include __repr__

    CHECK:
    - All requirements from spec implemented?
    - File paths match spec?
    - Function signatures match spec?
    - Behavior matches expected?
    - Nothing extra added (no scope creep)?

    OUTPUT: PASS or list of specific spec gaps to fix.
    """,
    toolsets=['file']
)
```

3. **Dispatch code quality reviewer** (after spec passes):
```python
delegate_task(
    goal="Review code quality for Task 1 implementation",
    context="""
    FILES TO REVIEW:
    - src/models/user.py
    - tests/models/test_user.py

    CHECK:
    - Follows project conventions and style?
    - Proper error handling?
    - Clear variable/function names?
    - Adequate test coverage?
    - No obvious bugs or missed edge cases?
    - No security issues?

    OUTPUT FORMAT:
    - Critical Issues: [must fix]
    - Important Issues: [should fix]
    - Minor Issues: [optional]
    - Verdict: APPROVED or REQUEST_CHANGES
    """,
    toolsets=['file']
)
```

4. **Mark complete** via `todo`

**Step 3: Final integration review** — after ALL tasks complete, dispatch a final reviewer checking that all components work together.

**Step 4: Verify and commit** — run full test suite, review all changes, final commit.

#### Key rules:

- **Fresh subagent per task** — prevents context pollution from accumulated state
- **Two-stage review every time** — spec compliance FIRST, code quality SECOND
- **Never skip reviews**
- **Never proceed with unfixed critical/important issues**
- **Never dispatch multiple subagents for tasks touching the same files**
- **Provide full task text in context** — don't make subagents read the plan file
- **If subagent asks questions** — answer clearly before they proceed
- **If reviewer finds issues** — fix, then re-review. Don't skip the re-review.

#### Integration with other skills:

- **With `writing-plans`:** `writing-plans` creates the plan, `subagent-driven-development` executes it
- **With `test-driven-development`:** Include TDD instructions in every implementer context
- **With `requesting-code-review`:** The two-stage review IS the code review
- **With `systematic-debugging`:** If subagent encounters bugs, follow systematic debugging

---

### 3.4 `test-driven-development` — RED-GREEN-REFACTOR

**Category:** software-development (💻)
**Path:** `software-development/test-driven-development`
**Version:** 1.1.0
**Author:** Hermes Agent (adapted from obra/superpowers)
**Tags:** testing, tdd, development, quality, red-green-refactor

**What it does:** Enforces strict TDD — no production code without a failing test first.

**The Iron Law:**
```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Write code before the test? Delete it. Start over. No exceptions.

#### RED-GREEN-REFACTOR cycle:

**RED — Write failing test:**
- One behavior per test
- Clear descriptive name ("and" in name? Split it)
- Real code, not mocks (unless truly unavoidable)
- Name describes behavior, not implementation

**Verify RED — Watch it fail (MANDATORY):**
```bash
pytest tests/test_feature.py::test_specific_behavior -v
```
Confirm: test fails (not errors from typos), failure message is expected, fails because feature is missing.

**GREEN — Minimal code:**
Write simplest code to pass. Nothing more. Cheating is OK in GREEN (hardcode, copy-paste, duplicate). Fix in REFACTOR.

**Verify GREEN — Watch it pass (MANDATORY):**
```bash
pytest tests/test_feature.py::test_specific_behavior -v
pytest tests/ -q  # check for regressions
```

**REFACTOR — Clean up:**
Remove duplication, improve names, extract helpers. Keep tests green throughout. If tests fail during refactor: undo immediately.

#### Common rationalizations the skill rejects:

| Excuse | Reality |
|---|---|
| "Too simple to test" | Simple code breaks. Test takes 30 seconds. |
| "I'll test after" | Tests passing immediately prove nothing. |
| "Already manually tested" | Ad-hoc != systematic. No record, can't re-run. |
| "TDD will slow me down" | TDD faster than debugging. |
| "Keep as reference, write tests first" | You'll adapt it. Delete means delete. |

#### Verification checklist:
- [ ] Every new function/method has a test
- [ ] Watched each test fail before implementing
- [ ] Each test failed for expected reason (feature missing, not typo)
- [ ] Wrote minimal code to pass each test
- [ ] All tests pass
- [ ] Output pristine (no errors, warnings)
- [ ] Tests use real code (mocks only if unavoidable)
- [ ] Edge cases and errors covered

#### With `delegate_task`:
```python
delegate_task(
    goal="Implement [feature] using strict TDD",
    context="""
    Follow test-driven-development skill:
    1. Write failing test FIRST
    2. Run test to verify it fails
    3. Write minimal code to pass
    4. Run test to verify it passes
    5. Refactor if needed
    6. Commit

    Project test command: npm run test
    """,
    toolsets=['terminal', 'file']
)
```

**For SLE:** Every implementer subagent dispatched by `subagent-driven-development` should include TDD instructions. This ensures test coverage from the start.

---

### 3.5 `requesting-code-review` — Pre-Commit Verification Pipeline

**Category:** software-development (💻)
**Path:** `software-development/requesting-code-review`
**Version:** 2.0.0
**Author:** Hermes Agent (adapted from obra/superpowers + MorAlekss)
**Tags:** code-review, security, verification, quality, pre-commit, auto-fix

**What it does:** Full pre-commit verification pipeline — static security scan, baseline-aware quality gates, independent reviewer subagent, and auto-fix loop. Use after code changes and before committing.

#### The 8-step pipeline:

**Step 1: Get the diff**
```bash
git diff --cached
```
If empty, try `git diff` then `git diff HEAD~1 HEAD`. If diff > 15,000 chars, split by file.

**Step 2: Static security scan**
Scan added lines only for:
- Hardcoded secrets (`api_key`, `secret`, `password`, `token`)
- Shell injection (`os.system(`, `subprocess.*shell=True`)
- Dangerous eval/exec (`eval(`, `exec(`)
- Unsafe deserialization (`pickle.loads(`)
- SQL injection (`execute(f"`, `.format(.*SELECT`)

**Step 3: Baseline tests and linting**
Detect project language, run appropriate tools. Capture failure count BEFORE changes as **baseline_failures** (stash, run, pop). Only NEW failures block the commit.

Test frameworks auto-detected: pytest, npm test, cargo test, go test.
Linting: ruff, mypy, eslint, tsc, clippy, go vet.

**Step 4: Self-review checklist**
Quick scan: no hardcoded secrets, input validation, parameterized SQL, path validation, error handling, no debug prints, no commented-out code, new code has tests.

**Step 5: Independent reviewer subagent**
Dispatch `delegate_task` with ONLY the diff and static scan results. No shared context. Fail-closed: unparseable response = fail.

Reviewer returns JSON:
```json
{
  "passed": true or false,
  "security_concerns": [],
  "logic_errors": [],
  "suggestions": [],
  "summary": "one sentence verdict"
}
```

**Step 6: Evaluate results**
All passed → Step 8 (commit). Any failures → Step 7 (auto-fix).

**Step 7: Auto-fix loop (max 2 cycles)**
Spawn a THIRD agent context (not implementer, not reviewer). Fixes ONLY reported issues. After fix, re-run full verification (Steps 1-6).

- Passed → Step 8
- Failed and attempts < 2 → repeat Step 7
- Failed after 2 attempts → escalate to user, suggest `git stash` or `git reset`

**Step 8: Commit**
```bash
git add -A && git commit -m "[verified] <description>"
```

**For SLE:** This runs automatically when `subagent-driven-development` includes it in the task workflow. Every commit gets security-scanned, tested, linted, and independently reviewed.

---

### 3.6 `systematic-debugging` — 4-Phase Root Cause Investigation

**Category:** software-development (💻)
**Path:** `software-development/systematic-debugging`
**Version:** 1.1.0
**Author:** Hermes Agent (adapted from obra/superpowers)
**Tags:** debugging, troubleshooting, problem-solving, root-cause

**What it does:** Enforces systematic root cause investigation. NO fixes without understanding the problem first.

**The Iron Law:**
```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

#### The four phases:

**Phase 1: Root Cause Investigation**
1. Read error messages carefully (don't skip)
2. Reproduce consistently
3. Check recent changes (git log, git diff)
4. Gather evidence in multi-component systems (log at each component boundary)
5. Trace data flow upstream to source

Completion checklist: error read, reproduced, recent changes identified, evidence gathered, problem isolated, root cause hypothesis formed.

**Phase 2: Pattern Analysis**
1. Find working examples in same codebase
2. Compare against reference implementations (read EVERY line, don't skim)
3. Identify differences (every difference, however small)
4. Understand dependencies

**Phase 3: Hypothesis and Testing**
1. Form a single hypothesis — be specific
2. Test minimally — one variable at a time
3. Verify before continuing
4. When you don't know — say "I don't understand X"

**Phase 4: Implementation**
1. Create failing test case (regression test)
2. Implement single fix (address root cause, not symptom)
3. Verify fix
4. **Rule of Three:** if 3+ fixes failed, STOP and question the architecture

**Red flags — STOP and follow process:**
- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "Add multiple changes, run tests"
- "One more fix attempt" (when already tried 2+)
- Each fix reveals a new problem in a different place

**For SLE:** When subagents encounter test failures or bugs during implementation, they follow this process instead of guessing.

---

### 3.7 `dogfood` — Systematic Exploratory QA Testing

**Category:** dogfood
**Path:** `dogfood/dogfood`
**Tags:** qa, testing, browser, web

**What it does:** Systematic exploratory QA testing of web applications using browser tools. Navigates, interacts, captures evidence, generates structured bug reports.

#### 5-phase workflow:

**Phase 1: Plan**
Create output directory. Build rough sitemap of pages/features to test.

**Phase 2: Explore**
For each page/feature:
1. Navigate to page
2. Take snapshot (accessibility tree)
3. Check console for JS errors
4. Take annotated screenshot (numbered labels on interactive elements)
5. Test interactive elements systematically (click, type, keyboard, scroll)
6. After each interaction: check console, visual changes, expected vs actual

**Phase 3: Collect Evidence**
For every issue: screenshot, URL, steps to reproduce, expected behavior, actual behavior, console errors.

**Phase 4: Categorize**
De-duplicate, assign severity (Critical/High/Medium/Low) and category (Functional/Visual/Accessibility/Console/UX/Content).

**Phase 5: Report**
Generate structured bug report with executive summary and per-issue sections.

**For SLE:** Use during Phase 8 (Web UI) to systematically test the dashboard, chat page, and graph page. Could be run as a cron job after UI changes.

### 3.8 `adversarial-ux-test` — Hostile User UX Testing

**Category:** Optional (⭐)
**Source:** https://hermes-agent.nousresearch.com/docs/skills

**What it does:** Roleplays the most difficult, tech-resistant user for your product. Browses the app as that persona, finds every UX pain point, then filters complaints through a pragmatism layer to separate real problems from noise. Creates actionable tickets from genuine issues only.

**Comparison with `dogfood`:**

| | `dogfood` | `adversarial-ux-test` |
|---|---|---|
| **Focus** | Bugs, errors, broken functionality | UX pain points, usability |
| **Persona** | Systematic tester | Hostile/incompetent user |
| **Output** | Bug report with severity | Actionable tickets filtered by pragmatism |
| **Finds** | JS errors, broken links, visual issues, form validation | Confusing flows, missing affordances, edge-case frustration |
| **Tier** | Built-in (always available) | Optional (explicit install) |

**Recommended approach — use both in sequence:**
1. `dogfood` first — catch functional bugs, console errors, broken elements
2. `adversarial-ux-test` second — catch usability issues that only appear when someone "uses it wrong"

**For SLE:** Start with `dogfood` (built-in) during Phase 8. Add `adversarial-ux-test` later for polish — it will catch the UX problems that functional testing misses (confusing flows, unclear labels, error messages that don't help, missing affordances).

---

## 4. Tools & Toolsets Features

**Source:** https://hermes-agent.nousresearch.com/docs/user-guide/features/tools

### Tool categories

| Category | Tools | Description |
|---|---|---|
| Web | `web_search`, `web_extract` | Search web and extract page content |
| Terminal & Files | `terminal`, `process`, `read_file`, `patch` | Execute commands and manipulate files |
| Browser | `browser_navigate`, `browser_snapshot`, `browser_vision` | Interactive browser automation |
| Media | `vision_analyze`, `image_generate`, `text_to_speech` | Multimodal analysis and generation |
| Agent orchestration | `todo`, `clarify`, `execute_code`, `delegate_task` | Planning, clarification, delegation |
| Memory & recall | `memory`, `session_search` | Persistent memory and session search |
| Automation & delivery | `cronjob`, `send_message` | Scheduled tasks and messaging |
| Integrations | `ha_*`, MCP tools, `rl_*` | Home Assistant, MCP, RL training |

### Toolset usage

```bash
# Use specific toolsets
hermes chat --toolsets "web,terminal"

# See all available tools
hermes tools

# Configure tools per platform (interactive)
hermes tools
```

### Terminal backends

| Backend | Description | Use Case |
|---|---|---|
| `local` | Run on your machine (default) | Development, trusted tasks |
| `docker` | Isolated containers | Security, reproducibility |
| `ssh` | Remote server | Sandboxing, keep agent away from own code |
| `singularity` | HPC containers | Cluster computing, rootless |
| `modal` | Cloud execution | Serverless, scale |
| `daytona` | Cloud sandbox workspace | Persistent remote dev environments |

Configuration:
```yaml
terminal:
  backend: local
  cwd: "."
  timeout: 180
```

Container resources:
```yaml
terminal:
  backend: docker
  container_cpu: 1
  container_memory: 5120
  container_disk: 51200
  container_persistent: true
```

Container security: read-only root filesystem, all capabilities dropped, no privilege escalation, PID limits, full namespace isolation.

### Background process management

```python
terminal(command="pytest -v tests/", background=true)
# Returns: {"session_id": "proc_abc123", "pid": 12345}

process(action="poll", session_id="proc_abc123")   # Check status
process(action="wait", session_id="proc_abc123")   # Block until done
process(action="log", session_id="proc_abc123")    # Full output
process(action="kill", session_id="proc_abc123")   # Terminate
process(action="write", session_id="proc_abc123", data="y")  # Send input
```

PTY mode (`pty=true`) enables interactive CLI tools.

---

## 5. Full Skills Catalog — Categories

**Source:** https://hermes-agent.nousresearch.com/docs/skills

The skills catalog is organized by category with three tiers:

### Tier markers

| Marker | Meaning |
|---|---|
| ✓ Built-in | Installed with Hermes, always available |
| ⭐ Optional | Official optional skill, explicit install needed |
| ○ LobeHub | Community skill from LobeHub marketplace |
| ◆ Anthropic | Anthropic-provided skill |
| 🧪 | ML/research skill |
| 💻 | Software development skill |
| 📦 | General skill |

### Skills relevant to SLE building

**Built-in software development (💻):**
- `plan` — plan-only mode, no execution
- `writing-plans` — comprehensive implementation plans
- `subagent-driven-development` — execute plans with two-stage review
- `test-driven-development` — RED-GREEN-REFACTOR enforcement
- `requesting-code-review` — pre-commit verification pipeline
- `systematic-debugging` — 4-phase root cause investigation

**Built-in general:**
- `dogfood` — systematic exploratory QA testing
- `obsidian` — read, search, create notes in Obsidian vault
- `native-mcp` — MCP client for external tool integration
- `webhook-subscriptions` — event-driven agent activation

**Optional software development:**
- `one-three-one-rule` — structured decision-making (1 problem, 3 options, 1 recommendation). Useful for architectural decisions during SLE building.
- `docker-management` — manage Docker containers, images, volumes. Useful if running SLE daemon in Docker.
- `fastmcp` — build, test, deploy MCP servers. Useful for building SLE-specific MCP integration.
- `page-agent` — embed in-page GUI agent in web apps. Potentially useful for SLE's web UI.

**Optional research/data:**
- `chroma` — embedding database. Relevant if building Cognee integration.
- `faiss` — vector similarity search. Relevant for knowledge engine.

---

## 6. Revised SLE Build Approach

### What changed

Previous plan (in `hermes-agent.md`): We were going to build a custom `sle-builder` skill from scratch with a manual 6-step build loop (analyze → plan → implement → verify → reflect → repeat), enforced through AGENTS.md and skill instructions.

**New approach:** Hermes already has the structured development workflow. We don't need to build it.

### The revised workflow

```
1. PHASE PLANNING
   User: "Read the SLE spec docs for Phase 1. Use writing-plans to create
          an implementation plan."
   → Hermes uses `writing-plans` skill
   → Reads relevant spec docs
   → Explores codebase
   → Outputs detailed plan to .hermes/plans/ or docs/plans/
   → Plan has bite-sized tasks with exact files, complete code, test commands

2. PLAN REVIEW
   User reviews the plan
   → Adjust task ordering if needed
   → Add/remove tasks
   → Approve plan

3. PLAN EXECUTION
   User: "Execute the plan using subagent-driven-development."
   → Hermes uses `subagent-driven-development` skill
   → For EACH task:
     a. Dispatch implementer subagent (fresh context, TDD enforced)
     b. Dispatch spec compliance reviewer (matches spec?)
     c. Dispatch code quality reviewer (well-built?)
     d. If issues: fix and re-review
     e. Mark complete
   → After ALL tasks: final integration review
   → Full test suite, final commit

4. PHASE REVIEW
   → User reviews:
     - git log for the phase
     - Test results
     - .sle-build/ state (decisions, ambiguities, gotchas)
   → User approves or requests changes
   → Move to next phase
```

### What we still need to build/configure

**Still needed (from previous plan):**
- SOUL.md — engineer identity
- AGENTS.md — project context (architecture, conventions, build commands)
- plan.md — cross-phase task tracking (Hermes `todo` is session-scoped only)
- .sle-build/ — cross-session state (decisions, ambiguities, gotchas, session log)
- MEMORY.md — cross-session project facts

**No longer needed:**
- Custom `sle-builder` skill — replaced by the 6 built-in dev skills
- Custom 6-step build loop — replaced by `subagent-driven-development`
- Custom review/validation step — replaced by `requesting-code-review`
- Custom debugging guidelines — replaced by `systematic-debugging`

### How the built-in skills chain together

```
writing-plans
  ↓ creates plan
subagent-driven-development
  ↓ per task:
  ├── implementer subagent (with TDD instructions)
  │   └── test-driven-development enforced
  ├── spec compliance reviewer
  ├── code quality reviewer
  │   └── requesting-code-review pipeline
  └── if bugs: systematic-debugging
  ↓ after all tasks:
  final integration review
  ↓
dogfood (for web UI testing in Phase 8)
```

### Session start ritual (simplified)

```
Read plan.md. Read .sle-build/session-log.md.

Tell me:
1. Where we left off (last completed task)
2. What task is next
3. Any unresolved ambiguities or gotchas

Then use subagent-driven-development to execute the next task(s).
```

No need to "load skill sle-builder" — the built-in dev skills are always available.

### Cron jobs (unchanged)

Nightly verification and weekly progress cron jobs still apply (see `hermes-official-docs-research.md` Section 9.8).

---

## 7. Impact on Previous Plans

### Documents that need updating

| Document | What changes |
|---|---|
| `hermes-agent.md` Section 4 (The Build Loop) | Replace custom 6-step loop with `subagent-driven-development` workflow |
| `hermes-agent.md` Section 5 (Enforcing Structure) | Remove custom skill, simplify to SOUL.md + AGENTS.md + plan.md |
| `hermes-agent.md` Section 6 (Phased Plan) | Keep phases, but each phase uses `writing-plans` then `subagent-driven-development` |
| `hermes-agent.md` Section 9 (Risk Assessment) | Lower risk — built-in skills are tested and battle-hardened |
| `hermes-agent.md` Section 10 (What NOT to Do) | Add: don't reinvent what the built-in dev skills already do |

### Timeline impact

The built-in skills reduce risk significantly:
- Structured planning: handled by `writing-plans`
- Structured execution: handled by `subagent-driven-development`
- Test coverage: enforced by `test-driven-development`
- Code quality: verified by `requesting-code-review`
- Debugging: systematic by `systematic-debugging`

**Estimated time reduction:** 10-20% faster due to not building custom tooling. But the bigger win is **reliability** — these skills are tested and used by thousands of developers, not custom instructions we hope the model follows.

### Context engine decision

With `subagent-driven-development`, each task runs in a **fresh subagent context**. Context compression is less of a concern because:
- Each subagent starts fresh (no accumulated context)
- The parent agent only sees summaries
- The plan and .sle-build/ files are the persistent state

This makes **Option C (built-in compressor + file-based state)** even more appropriate. A custom context engine plugin is unnecessary — subagent isolation solves the context pollution problem structurally.
